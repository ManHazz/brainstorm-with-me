'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../scripts/validate');

const ROOT = path.join(__dirname, '..');
const CANVAS = path.join(__dirname, 'fixtures', 'canvas');
const MER = path.join(__dirname, 'fixtures', 'mermaid');

test('no files is a usage error', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/);
});

test('unknown option is a usage error', async () => {
  assert.equal((await run(['--nope', path.join(CANVAS, 'valid-full.canvas')])).code, 2);
});

test('--help exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage/);
});

test('valid files exit 0', async () => {
  const r = await run([
    path.join(CANVAS, 'valid-full.canvas'),
    path.join(MER, 'good-flowchart.mmd'),
    path.join(MER, 'good-sequence.mmd'),
  ]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /3 file\(s\) checked, 0 error\(s\)/);
});

test('broken canvas exits 1 with path:line: error lines', async () => {
  const file = path.join(CANVAS, 'dup-id.canvas');
  const r = await run([file]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes(`${file}:4: error: nodes[1].id: duplicate id "a"`), r.stdout);
});

test('JSON parse errors are reported with a line', async () => {
  const r = await run([path.join(CANVAS, 'bad-json.canvas'), '--json']);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.files[0].errors[0].line, 3);
  assert.match(out.files[0].errors[0].message, /invalid JSON/);
});

test('--json output shape', async () => {
  const good = path.join(MER, 'empty.mmd');
  const bad = path.join(MER, 'bad-header.mmd');
  const r = await run(['--json', good, bad]);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.files.length, 2);
  assert.deepEqual(Object.keys(out.files[0]).sort(), ['errors', 'ok', 'path', 'warnings']);
  assert.equal(out.files[0].path, good);
  assert.equal(out.files[0].ok, true);
  assert.equal(out.files[0].warnings.length, 1);
  assert.equal(out.files[1].ok, false);
});

test('markdown fences are linted with file line numbers', async () => {
  const file = path.join(MER, 'notes.md');
  const r = await run([file]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes(`${file}:14: error: unclosed "["`), r.stdout);
});

test('missing file and unsupported type are file errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  try {
    const txt = path.join(dir, 'a note.txt');
    fs.writeFileSync(txt, 'hi');
    const r = await run(['--json', path.join(dir, 'missing.canvas'), txt]);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.match(out.files[0].errors[0].message, /cannot read/);
    assert.match(out.files[1].errors[0].message, /unsupported/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BOM and .mermaid extension in a path with spaces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  try {
    const c = path.join(dir, 'my board.canvas');
    fs.writeFileSync(c, '\uFEFF{"nodes":[]}');
    const m = path.join(dir, 'x.mermaid');
    fs.writeFileSync(m, 'pie\n  "a" : 1\n');
    assert.equal((await run([c, m])).code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runs as a real process with matching exit codes', async () => {
  const script = path.join(ROOT, 'scripts', 'validate.js');
  const ok = spawnSync(process.execPath, [script, path.join(CANVAS, 'valid-full.canvas')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [script, path.join(CANVAS, 'bad-side.canvas'), '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

test('--deep keeps good files clean or falls back with one warning', async () => {
  const r = await run(['--deep', '--json', path.join(MER, 'good-flowchart.mmd'), path.join(MER, 'good-sequence.mmd')]);
  assert.equal(r.code, 0, r.stdout);
  for (const f of JSON.parse(r.stdout).files) {
    const deepWarn = f.warnings.filter((w) => /deep parse unavailable/.test(w.message));
    assert.ok(deepWarn.length <= 1);
  }
});

test('--deep with a missing bundle warns once per file and uses structural lint', () => {
  const script = path.join(ROOT, 'scripts', 'validate.js');
  const env = Object.assign({}, process.env, { BWC_MERMAID_BUNDLE: path.join(os.tmpdir(), 'bwc-no-such-bundle.js') });
  const p = spawnSync(process.execPath, [script, '--deep', '--json', path.join(MER, 'notes.md'), path.join(MER, 'good-er.mmd')], { encoding: 'utf8', env });
  assert.equal(p.status, 1, p.stderr);
  const out = JSON.parse(p.stdout);
  for (const f of out.files) {
    const w = f.warnings.filter((x) => /^deep parse unavailable: .*, used structural lint$/.test(x.message));
    assert.equal(w.length, 1, JSON.stringify(f));
  }
  assert.ok(out.files[0].errors.some((e) => e.line === 14 && /unclosed/.test(e.message)));
  assert.equal(out.files[1].ok, true);
});
