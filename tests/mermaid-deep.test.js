'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { deepParse, loadDeep, resetDeepCache, mapLine } = require('../scripts/lib/mermaid-deep');
const { lintMermaid } = require('../scripts/lib/mermaid-lint');
const { run } = require('../scripts/validate');

const MER = path.join(__dirname, 'fixtures', 'mermaid');
const deepWorks = () => loadDeep().ok;

test('good flowchart parses, or deep parse reports unavailable', async () => {
  const r = await deepParse('flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C');
  assert.ok(r.status === 'ok' || r.status === 'unavailable', JSON.stringify(r));
  if (r.status === 'unavailable') assert.equal(typeof r.reason, 'string');
});

test('broken flowchart the structural lint misses is a deep error', async (t) => {
  if (!deepWorks()) return t.skip(`deep parse unavailable: ${loadDeep().reason}`);
  const src = 'flowchart LR\n A --> --> B';
  assert.equal(lintMermaid(src).ok, true, 'structural lint should not catch this one');
  const r = await deepParse(src);
  assert.equal(r.status, 'error');
  assert.equal(r.line, 2);
  assert.match(r.message, /unexpected/);
});

test('deep parse covers other diagram types', async (t) => {
  if (!deepWorks()) return t.skip('deep parse unavailable');
  const good = [
    'sequenceDiagram\n  A->>B: hi',
    'classDiagram\n  class A {\n    +run()\n  }',
    'erDiagram\n  A ||--o{ B : has',
    'stateDiagram-v2\n  [*] --> Idle',
    'mindmap\n  root((x))\n    A',
    'pie\n  "a" : 1',
    'gantt\n  title x\n  section s\n  t :a1, 2024-01-01, 3d',
  ];
  for (const s of good) assert.equal((await deepParse(s)).status, 'ok', s);
  assert.equal((await deepParse('sequenceDiagram\n  loop x\n  A->>B: y')).status, 'error');
  assert.equal((await deepParse('nonsense\n  x')).status, 'error');
});

test('error lines map back past frontmatter and comments', async (t) => {
  assert.equal(mapLine('---\ntitle: x\n---\nflowchart LR\n  A --> --> B', 2), 5);
  assert.equal(mapLine('%% c\n\nflowchart LR\n  %% mid\n  A --> B\n  A --> --> B', 3), 6);
  assert.equal(mapLine('flowchart LR\n  A', 9), 2);
  if (!deepWorks()) return t.skip('deep parse unavailable');
  const r = await deepParse('%%{init: {"theme": "dark"}}%%\n---\ntitle: x\n---\nflowchart LR\n  A --> --> B');
  assert.equal(r.status, 'error');
  assert.equal(r.line, 6);
});

test('loaded instance is cached', () => {
  assert.equal(loadDeep(), loadDeep());
});

test('missing bundle reports unavailable instead of throwing', async () => {
  resetDeepCache();
  try {
    const opts = { bundlePath: path.join(os.tmpdir(), 'bwc-missing-mermaid.js') };
    const inst = loadDeep(opts);
    assert.equal(inst.ok, false);
    const r = await deepParse('flowchart LR\n  A --> B', opts);
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /not found/);
  } finally {
    resetDeepCache();
  }
});

test('validate --deep flags the broken flowchart with file line numbers', async (t) => {
  if (!deepWorks()) return t.skip('deep parse unavailable');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  try {
    const f = path.join(dir, 'broken.md');
    fs.writeFileSync(f, '# x\n\n```mermaid\nflowchart LR\n A --> --> B\n```\n');
    const plain = await run([f]);
    assert.equal(plain.code, 0, plain.stdout);
    const deep = await run(['--deep', f]);
    assert.equal(deep.code, 1);
    assert.ok(deep.stdout.includes(`${f}:5: error: mermaid parse:`), deep.stdout);
    const good = await run(['--deep', path.join(MER, 'good-flowchart.mmd'), path.join(MER, 'good-er.mmd')]);
    assert.equal(good.code, 0, good.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
