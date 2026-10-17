'use strict';

// Safe writes into the vault. We remember a hash of what we last wrote (manifest)
// plus a copy of that content (base, in .bwc-base/) so we can tell when the user
// edited a file and do a 3-way merge. User edits are never overwritten silently.
//
// Every read-modify-write runs under a per-project lock file so parallel bwc
// processes cannot lose appends or clobber the manifest. We never write through a
// symlink or junction, and we keep the file's line endings (CRLF stays CRLF).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST = '.bwc-manifest.json';
const BASE_DIR = '.bwc-base';
const LOCK = '.bwc-lock';
const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 8000;

function normalize(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function hashContent(text) {
  return crypto.createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

function eolOf(raw) {
  return /\r\n/.test(raw) ? '\r\n' : '\n';
}

function withEol(text, eol) {
  const t = normalize(text);
  return eol === '\r\n' ? t.replace(/\n/g, '\r\n') : t;
}

function relKey(relPath) {
  return String(relPath).split(/[\\/]+/).filter(Boolean).join('/');
}

function resolveInside(projectDir, relPath) {
  const root = path.resolve(projectDir);
  const full = path.resolve(root, ...relKey(relPath).split('/'));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`path escapes project folder: ${relPath}`);
  }
  return full;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Returns the first symlink or junction found on the way from `full` up to and
// including projectDir, or null. Missing components are fine (they get created).
function findLink(projectDir, full) {
  const root = path.resolve(projectDir);
  let p = path.resolve(full);
  for (;;) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return p;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (p === root) return null;
    const parent = path.dirname(p);
    if (parent === p || !p.startsWith(root)) return null;
    p = parent;
  }
}

function assertNoLink(projectDir, full) {
  const link = findLink(projectDir, full);
  if (link) {
    const err = new Error(`refusing to write through a symlink or junction: ${link}`);
    err.code = 'BWC_SYMLINK';
    err.link = link;
    throw err;
  }
}

// Write to a tmp file in the same folder, then rename over the target.
// Windows can refuse the rename while another process (Obsidian, sync) holds the
// file, so retry a few times and then fall back to unlink + rename.
function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(err.code)) break;
      sleepMs(25 * (i + 1));
    }
  }
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(tmp, file);
    return;
  } catch (err) {
    lastErr = err;
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* tmp already gone */ }
  throw lastErr;
}

// Atomic write inside a project, refusing links on the way.
function projectWrite(projectDir, full, content) {
  assertNoLink(projectDir, full);
  atomicWrite(full, content);
}

// ---------- locking ----------

const held = new Map(); // lock path -> depth (re-entrant inside one process)

function withLock(projectDir, fn) {
  const root = path.resolve(projectDir);
  const lockPath = path.join(root, LOCK);
  const depth = held.get(lockPath) || 0;
  if (depth > 0) {
    held.set(lockPath, depth + 1);
    try { return fn(); } finally { held.set(lockPath, held.get(lockPath) - 1); }
  }
  fs.mkdirSync(root, { recursive: true });
  assertNoLink(root, lockPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let wait = 5;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { fs.closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (_) { /* lock vanished between calls, just retry */ }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
      sleepMs(wait + Math.floor(Math.random() * 10));
      wait = Math.min(wait * 2, 100);
    }
  }
  held.set(lockPath, 1);
  try {
    return fn();
  } finally {
    held.delete(lockPath);
    try { fs.unlinkSync(lockPath); } catch (_) { /* already gone */ }
  }
}

// ---------- manifest and base copies ----------

function readManifest(projectDir) {
  const file = path.join(projectDir, MANIFEST);
  if (!fs.existsSync(file)) return { files: {} };
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') return { files: {} };
    return m;
  } catch (_) {
    // A broken manifest means we no longer know what we wrote: treat every file as user owned.
    return { files: {} };
  }
}

function writeManifest(projectDir, manifest) {
  projectWrite(projectDir, path.join(projectDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

function readBase(projectDir, relPath) {
  const file = path.join(projectDir, BASE_DIR, ...relKey(relPath).split('/'));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Remember that `content` is what we (now) consider the agreed version of relPath.
function record(projectDir, relPath, content) {
  withLock(projectDir, () => {
    const key = relKey(relPath);
    const full = resolveInside(projectDir, key);
    const manifest = readManifest(projectDir);
    manifest.files[key] = { sha256: hashContent(content), mtimeMs: Math.round(fs.statSync(full).mtimeMs) };
    writeManifest(projectDir, manifest);
    projectWrite(projectDir, path.join(projectDir, BASE_DIR, ...key.split('/')), normalize(content));
  });
}

// True when the file exists and differs from what we last wrote (or we never wrote it).
function isUserEdited(projectDir, relPath) {
  const full = resolveInside(projectDir, relPath);
  if (!fs.existsSync(full)) return false;
  const entry = readManifest(projectDir).files[relKey(relPath)];
  if (!entry) return true;
  return entry.sha256 !== hashContent(fs.readFileSync(full, 'utf8'));
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function conflictPathFor(full) {
  const ext = path.extname(full) || '.md';
  const base = full.slice(0, full.length - path.extname(full).length);
  let candidate = `${base}.conflict-${stamp()}${ext}`;
  let n = 2;
  while (fs.existsSync(candidate)) candidate = `${base}.conflict-${stamp()}-${n++}${ext}`;
  return candidate;
}

function refused(full, err) {
  if (err && err.code === 'BWC_SYMLINK') return { status: 'refused', path: full, error: err.message };
  throw err;
}

// safeWrite(projectDir, relPath, content, { merge }) where
// merge(currentOnDisk, ours, base) returns a string (merged) or null (conflict).
// Status: written | merged | conflict | unchanged | refused (symlink on the path).
function safeWrite(projectDir, relPath, content, opts = {}) {
  const full = resolveInside(projectDir, relPath);
  try {
    assertNoLink(projectDir, full);
    return withLock(projectDir, () => safeWriteLocked(projectDir, relPath, full, content, opts));
  } catch (err) {
    return refused(full, err);
  }
}

function safeWriteLocked(projectDir, relPath, full, content, opts) {
  const ours = normalize(content);

  if (!fs.existsSync(full)) {
    projectWrite(projectDir, full, ours);
    record(projectDir, relPath, ours);
    return { status: 'written', path: full };
  }

  const raw = fs.readFileSync(full, 'utf8');
  const eol = eolOf(raw);
  const current = normalize(raw);
  const curHash = hashContent(current);
  if (curHash === hashContent(ours)) {
    record(projectDir, relPath, current);
    return { status: 'unchanged', path: full };
  }

  const entry = readManifest(projectDir).files[relKey(relPath)];
  if (entry && entry.sha256 === curHash) {
    projectWrite(projectDir, full, withEol(ours, eol));
    record(projectDir, relPath, ours);
    return { status: 'written', path: full };
  }

  // The user edited the file since our last write.
  let merged = null;
  if (typeof opts.merge === 'function') {
    merged = opts.merge(current, ours, readBase(projectDir, relPath));
  }
  if (typeof merged === 'string') {
    merged = normalize(merged);
    if (hashContent(merged) !== curHash) projectWrite(projectDir, full, withEol(merged, eol));
    record(projectDir, relPath, merged);
    return { status: 'merged', path: full };
  }

  const conflictPath = conflictPathFor(full);
  projectWrite(projectDir, conflictPath, withEol(ours, eol));
  return { status: 'conflict', path: full, conflictPath };
}

// Append-only lists. Appending never destroys anything, so even when the user
// edited the file we append to their version and adopt the result.
function appendEntry(projectDir, relPath, entryMarkdown) {
  const full = resolveInside(projectDir, relPath);
  try {
    assertNoLink(projectDir, full);
    return withLock(projectDir, () => {
      const userEdited = isUserEdited(projectDir, relPath);
      const raw = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      const eol = raw ? eolOf(raw) : '\n';
      let current = normalize(raw);
      if (current && !current.endsWith('\n')) current += '\n';
      const next = current + normalize(entryMarkdown).replace(/\n+$/, '') + '\n';
      projectWrite(projectDir, full, withEol(next, eol));
      record(projectDir, relPath, next);
      return { status: 'appended', path: full, userEdited };
    });
  } catch (err) {
    return refused(full, err);
  }
}

module.exports = {
  MANIFEST,
  BASE_DIR,
  LOCK,
  normalize,
  hashContent,
  atomicWrite,
  withLock,
  findLink,
  readManifest,
  readBase,
  record,
  isUserEdited,
  safeWrite,
  appendEntry,
};
