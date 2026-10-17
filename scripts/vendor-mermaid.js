#!/usr/bin/env node
'use strict';
// Dev only. Pulls a pinned mermaid build into vendor/mermaid/ and records its sha256.
// Usage: node scripts/vendor-mermaid.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const VERSION = '11.17.2';
// npm registry "integrity" for mermaid@11.17.2; the packed tarball must match it
const INTEGRITY = 'sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg==';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'mermaid');

// minimal tar reader: returns Map of name -> Buffer for regular files
function readTar(buf) {
  const files = new Map();
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = str(156, 157) || '0';
    const magic = str(257, 263);
    if (magic.startsWith('ustar')) {
      const prefix = str(345, 500);
      if (prefix) name = prefix + '/' + name;
    }
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') files.set(name, Buffer.from(body));
  }
  return files;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function integrityOf(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-mermaid-'));
  try {
    const r = spawnSync('npm', ['pack', `mermaid@${VERSION}`, '--silent'], {
      cwd: tmp,
      shell: process.platform === 'win32',
      encoding: 'utf8',
    });
    if (r.error || r.status !== 0) {
      process.stderr.write(`npm pack failed: ${(r.error && r.error.message) || r.stderr}\n`);
      process.exit(1);
    }
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) { process.stderr.write('npm pack produced no tarball\n'); process.exit(1); }
    const tarball = fs.readFileSync(path.join(tmp, tgz));
    const got = integrityOf(tarball);
    if (got !== INTEGRITY) {
      process.stderr.write(`integrity mismatch for mermaid@${VERSION}
  expected ${INTEGRITY}
  got      ${got}
`);
      process.exit(1);
    }
    const files = readTar(zlib.gunzipSync(tarball));
    const js = files.get('package/dist/mermaid.min.js');
    const lic = files.get('package/LICENSE');
    if (!js || !lic) { process.stderr.write('mermaid.min.js or LICENSE missing in tarball\n'); process.exit(1); }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'mermaid.min.js'), js);
    fs.writeFileSync(path.join(OUT, 'LICENSE'), lic);
    fs.writeFileSync(path.join(OUT, 'VERSION'), VERSION + '\n');
    const hash = sha256(js);
    fs.writeFileSync(path.join(OUT, 'SHA256'), `${hash}  mermaid.min.js\n`);
    process.stdout.write(JSON.stringify({ version: VERSION, bytes: js.length, sha256: hash }) + '\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { readTar, sha256, integrityOf, VERSION, INTEGRITY };
