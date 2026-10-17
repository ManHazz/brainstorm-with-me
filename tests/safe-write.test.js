'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sw = require('../scripts/lib/safe-write');

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-safe write-'));
}

const read = (d, rel) => fs.readFileSync(path.join(d, rel), 'utf8');

test('fresh write creates file and manifest entry', () => {
  const d = dir();
  const r = sw.safeWrite(d, 'notes/a.md', 'hello\n');
  assert.equal(r.status, 'written');
  assert.equal(read(d, 'notes/a.md'), 'hello\n');
  const m = sw.readManifest(d);
  assert.equal(m.files['notes/a.md'].sha256, sw.hashContent('hello\n'));
  assert.equal(typeof m.files['notes/a.md'].mtimeMs, 'number');
  assert.equal(fs.readdirSync(path.join(d, 'notes')).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('same content is unchanged, our own previous write is overwritten', () => {
  const d = dir();
  sw.safeWrite(d, 'a.md', 'one\n');
  assert.equal(sw.safeWrite(d, 'a.md', 'one\n').status, 'unchanged');
  assert.equal(sw.safeWrite(d, 'a.md', 'two\n').status, 'written');
  assert.equal(read(d, 'a.md'), 'two\n');
});

test('user edit + mergeable: merge result written, merge gets base', () => {
  const d = dir();
  sw.safeWrite(d, 'a.md', 'base\n');
  fs.writeFileSync(path.join(d, 'a.md'), 'base\nuser line\n');
  let seen = null;
  const r = sw.safeWrite(d, 'a.md', 'base\nour line\n', {
    merge: (disk, ours, base) => { seen = { disk, ours, base }; return disk + 'our line\n'; },
  });
  assert.equal(r.status, 'merged');
  assert.deepEqual(seen, { disk: 'base\nuser line\n', ours: 'base\nour line\n', base: 'base\n' });
  assert.equal(read(d, 'a.md'), 'base\nuser line\nour line\n');
  assert.equal(sw.isUserEdited(d, 'a.md'), false);
});

test('user edit + conflict: user file untouched, conflict file beside it', () => {
  const d = dir();
  sw.safeWrite(d, 'brief.md', 'base\n');
  fs.writeFileSync(path.join(d, 'brief.md'), 'user version\n');
  const r = sw.safeWrite(d, 'brief.md', 'our version\n', { merge: () => null });
  assert.equal(r.status, 'conflict');
  assert.equal(read(d, 'brief.md'), 'user version\n');
  assert.match(path.basename(r.conflictPath), /^brief\.conflict-\d{8}-\d{6}(-\d+)?\.md$/);
  assert.equal(fs.readFileSync(r.conflictPath, 'utf8'), 'our version\n');
  // without a merge function it is also a conflict
  const r2 = sw.safeWrite(d, 'brief.md', 'again\n');
  assert.equal(r2.status, 'conflict');
  assert.notEqual(r2.conflictPath, r.conflictPath);
  assert.equal(read(d, 'brief.md'), 'user version\n');
});

test('file we never wrote counts as user owned', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'x.md'), 'theirs\n');
  assert.equal(sw.isUserEdited(d, 'x.md'), true);
  assert.equal(sw.safeWrite(d, 'x.md', 'ours\n').status, 'conflict');
  assert.equal(read(d, 'x.md'), 'theirs\n');
});

test('CRLF on disk with same text is not a user edit', () => {
  const d = dir();
  sw.safeWrite(d, 'a.md', 'line one\nline two\n');
  fs.writeFileSync(path.join(d, 'a.md'), 'line one\r\nline two\r\n');
  assert.equal(sw.isUserEdited(d, 'a.md'), false);
  assert.equal(sw.hashContent('a\r\nb'), sw.hashContent('a\nb'));
  const r = sw.safeWrite(d, 'a.md', 'line one\nline two\nline three\n');
  assert.equal(r.status, 'written');
});

test('path with spaces and nested folders', () => {
  const d = path.join(dir(), 'My Vault', 'Brain storm', 'proj one');
  const r = sw.safeWrite(d, 'sessions/2026-10-17-1200-wrap.md', 'wrap\n');
  assert.equal(r.status, 'written');
  assert.equal(read(d, path.join('sessions', '2026-10-17-1200-wrap.md')), 'wrap\n');
  assert.ok(sw.readManifest(d).files['sessions/2026-10-17-1200-wrap.md']);
});

test('appendEntry appends, also to a user edited file', () => {
  const d = dir();
  sw.safeWrite(d, 'decisions.md', '# Decisions\n\n');
  let r = sw.appendEntry(d, 'decisions.md', '- one ^bwc-aaaaaa');
  assert.equal(r.userEdited, false);
  fs.writeFileSync(path.join(d, 'decisions.md'), read(d, 'decisions.md') + '- user wrote this');
  r = sw.appendEntry(d, 'decisions.md', '- two ^bwc-bbbbbb');
  assert.equal(r.userEdited, true);
  assert.equal(read(d, 'decisions.md'), '# Decisions\n\n- one ^bwc-aaaaaa\n- user wrote this\n- two ^bwc-bbbbbb\n');
  assert.equal(sw.isUserEdited(d, 'decisions.md'), false);
});

test('paths cannot escape the project folder', () => {
  const d = dir();
  assert.throws(() => sw.safeWrite(d, '../evil.md', 'x'), /escapes/);
});

test('CRLF files are written back with CRLF', () => {
  const d = dir();
  sw.safeWrite(d, 'a.md', 'one\ntwo\n');
  fs.writeFileSync(path.join(d, 'a.md'), 'one\r\ntwo\r\n');
  assert.equal(sw.safeWrite(d, 'a.md', 'one\ntwo\nthree\n').status, 'written');
  assert.equal(read(d, 'a.md'), 'one\r\ntwo\r\nthree\r\n');
  sw.appendEntry(d, 'a.md', '- four ^bwc-000004');
  assert.equal(read(d, 'a.md'), 'one\r\ntwo\r\nthree\r\n- four ^bwc-000004\r\n');
  fs.writeFileSync(path.join(d, 'a.md'), read(d, 'a.md') + 'user\r\n');
  const r = sw.safeWrite(d, 'a.md', 'x\n', { merge: (disk) => disk + 'merged\n' });
  assert.equal(r.status, 'merged');
  assert.ok(!/[^\r]\n/.test(read(d, 'a.md')), 'only CRLF line endings');
  assert.match(read(d, 'a.md'), /user\r\nmerged\r\n$/);
  assert.equal(sw.isUserEdited(d, 'a.md'), false);
  // a new file is LF
  sw.safeWrite(d, 'b.md', 'x\ny\n');
  assert.equal(read(d, 'b.md'), 'x\ny\n');
});

test('refuses to write through a junction or symlinked folder', () => {
  const d = dir();
  const outside = dir();
  fs.symlinkSync(outside, path.join(d, 'linked'), 'junction');
  const r = sw.safeWrite(d, 'linked/a.md', 'x\n');
  assert.equal(r.status, 'refused');
  assert.match(r.error, /symlink or junction/);
  const a = sw.appendEntry(d, 'linked/list.md', '- x ^bwc-000001');
  assert.equal(a.status, 'refused');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('refuses to write through a file symlink', (t) => {
  const d = dir();
  const outside = path.join(dir(), 'target.md');
  fs.writeFileSync(outside, 'secret\n');
  try {
    fs.symlinkSync(outside, path.join(d, 'a.md'), 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('file symlinks need developer mode on Windows');
    throw err;
  }
  const r = sw.safeWrite(d, 'a.md', 'x\n');
  assert.equal(r.status, 'refused');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret\n');
});

test('parallel appends from many processes lose nothing', async () => {
  const d = dir();
  sw.safeWrite(d, 'list.md', '# L\n\n');
  const { spawn } = require('node:child_process');
  const lib = path.join(__dirname, '..', 'scripts', 'lib', 'safe-write.js');
  const run = (p) => new Promise((resolve, reject) => {
    const code = `const sw = require(${JSON.stringify(lib)});
      for (let i = 0; i < 10; i++) sw.appendEntry(process.argv[1], 'list.md', '- p${p} n' + i);`;
    const child = spawn(process.execPath, ['-e', code, d], { stdio: 'inherit' });
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child failed ${c}`))));
  });
  await Promise.all([0, 1, 2, 3, 4, 5].map(run));
  const lines = read(d, 'list.md').split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 60);
  assert.equal(new Set(lines).size, 60);
  assert.equal(sw.isUserEdited(d, 'list.md'), false);
  assert.equal(fs.existsSync(path.join(d, sw.LOCK)), false);
});

test('a stale lock gets broken', () => {
  const d = dir();
  const lock = path.join(d, sw.LOCK);
  fs.writeFileSync(lock, 'old');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(sw.safeWrite(d, 'a.md', 'x\n').status, 'written');
  assert.equal(fs.existsSync(lock), false);
});
