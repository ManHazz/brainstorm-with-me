'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { readTar, VERSION } = require('../scripts/vendor-mermaid.js');

const DIR = path.join(__dirname, '..', 'vendor', 'mermaid');

test('vendored mermaid matches recorded sha256', () => {
  const js = fs.readFileSync(path.join(DIR, 'mermaid.min.js'));
  const recorded = fs.readFileSync(path.join(DIR, 'SHA256'), 'utf8').trim().split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(js).digest('hex'), recorded);
  assert.equal(fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(), VERSION);
  assert.ok(fs.existsSync(path.join(DIR, 'LICENSE')));
});

test('tar reader pulls a regular file', () => {
  const body = Buffer.from('hello');
  const hdr = Buffer.alloc(512);
  hdr.write('package/a.txt', 0);
  hdr.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  hdr.write('0', 156);
  hdr.write('ustar\0', 257);
  const pad = Buffer.alloc(512 - body.length);
  const tar = Buffer.concat([hdr, body, pad, Buffer.alloc(1024)]);
  const files = readTar(zlib.gunzipSync(zlib.gzipSync(tar)));
  assert.equal(files.get('package/a.txt').toString(), 'hello');
});

test('pinned version carries an npm integrity value', () => {
  const { INTEGRITY, integrityOf } = require('../scripts/vendor-mermaid.js');
  assert.equal(VERSION, '11.17.2');
  assert.match(INTEGRITY, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(integrityOf(Buffer.from('x')), 'sha512-' + crypto.createHash('sha512').update('x').digest('base64'));
});
