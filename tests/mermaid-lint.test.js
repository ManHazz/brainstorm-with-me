'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lintMermaid, extractMermaidBlocks } = require('../scripts/lib/mermaid-lint');

const FIX = path.join(__dirname, 'fixtures', 'mermaid');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const msgs = (list) => list.map((x) => `${x.line}:${x.message}`).join('\n');

test('good fixtures lint clean', () => {
  for (const f of ['good-flowchart.mmd', 'good-sequence.mmd', 'good-er.mmd']) {
    const r = lintMermaid(read(f));
    assert.equal(r.ok, true, `${f}\n${msgs(r.errors)}`);
    assert.deepEqual(r.warnings, [], `${f}\n${msgs(r.warnings)}`);
  }
});

test('all known headers are accepted', () => {
  const headers = ['flowchart', 'flowchart LR', 'graph TD', 'sequenceDiagram', 'classDiagram',
    'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap',
    'timeline', 'quadrantChart', 'gitGraph', 'requirementDiagram', 'C4Context', 'sankey-beta',
    'xychart-beta', 'block-beta'];
  for (const h of headers) {
    const r = lintMermaid(`${h}\n  x`);
    assert.equal(r.ok, true, `${h}: ${msgs(r.errors)}`);
  }
});

test('unknown header is an error', () => {
  const r = lintMermaid(read('bad-header.mmd'));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].line, 1);
  assert.match(r.errors[0].message, /unknown diagram type "flowchartz"/);
});

test('missing header on empty text is an error', () => {
  assert.equal(lintMermaid('').ok, false);
  assert.equal(lintMermaid('%% only a comment\n\n').ok, false);
});

test('comments and frontmatter are skipped before the header', () => {
  const r = lintMermaid('%%{init: {"theme": "dark"}}%%\n---\ntitle: x\n---\n\nflowchart LR\n  A --> B');
  assert.equal(r.ok, true, msgs(r.errors));
});

test('unclosed frontmatter is an error', () => {
  const r = lintMermaid('---\ntitle: x\nflowchart LR\n  A --> B');
  assert.equal(r.ok, false);
});

test('header only is a warning, not an error', () => {
  const r = lintMermaid(read('empty.mmd'));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].line, 2);
});

test('odd flowchart direction is a warning', () => {
  const r = lintMermaid('flowchart XY\n  A --> B');
  assert.equal(r.ok, true);
  assert.match(r.warnings[0].message, /direction/);
});

test('bad flowchart reports each problem with its line', () => {
  const r = lintMermaid(read('bad-flowchart.mmd'));
  assert.equal(r.ok, false);
  const lines = r.errors.map((e) => e.line);
  assert.ok(lines.includes(2), 'bracket error on line 2');
  assert.ok(r.errors.some((e) => e.line === 3 && /subgraph/.test(e.message)));
  assert.ok(r.errors.some((e) => e.line === 4 && /"end"/.test(e.message)));
  assert.ok(r.errors.some((e) => e.line === 5 && /script/.test(e.message)));
});

test('stray end and mismatched brackets in flowchart', () => {
  assert.equal(lintMermaid('flowchart LR\n  A --> B\nend').ok, false);
  const r = lintMermaid('flowchart LR\n  A[x) --> B');
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /does not match/);
});

test('unbalanced quote in flowchart is an error', () => {
  const r = lintMermaid('flowchart LR\n  A["oops] --> B');
  assert.equal(r.ok, false);
  assert.match(msgs(r.errors), /quote/);
});

test('end as a node id variants', () => {
  assert.equal(lintMermaid('graph LR\n  end --> A').ok, false);
  assert.equal(lintMermaid('graph LR\n  A --> end').ok, false);
  assert.equal(lintMermaid('graph LR\n  end[Finish]').ok, false);
  assert.equal(lintMermaid('graph LR\n  A --> End').ok, true);
  assert.equal(lintMermaid('graph LR\n  A["the end"] --> B').ok, true);
  assert.equal(lintMermaid('graph LR\n  A -->|to the end| B').ok, true);
});

test('javascript: URL is an error anywhere', () => {
  const r = lintMermaid('flowchart LR\n  A --> B\n  click A "javascript:alert(1)"');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].line, 3);
  assert.equal(lintMermaid('pie\n  "a <script>" : 1').ok, false);
});

test('raw HTML in flowchart warns but br is fine', () => {
  const r = lintMermaid('flowchart LR\n  A["<b>bold</b>"] --> B[one<br>two]');
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 2);
});

test('sequence blocks must close', () => {
  const r = lintMermaid(read('bad-sequence.mmd'));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 3);
  assert.match(r.errors[0].message, /loop/);
});

test('sequence extra end is an error, else outside alt warns', () => {
  assert.equal(lintMermaid('sequenceDiagram\n  A->>B: x\n  end').ok, false);
  const r = lintMermaid('sequenceDiagram\n  loop x\n  else\n  end');
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('non-flowchart bracket problems are warnings only', () => {
  const r = lintMermaid('classDiagram\n  class A {\n    +run(x\n  }');
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 1);
});

test('multi-line blocks in class, state and er are fine', () => {
  const srcs = [
    'classDiagram\n  class Animal {\n    +String name\n    +eat(food) void\n  }\n  Animal <|-- Dog',
    'stateDiagram-v2\n  [*] --> Idle\n  state Busy {\n    [*] --> Work\n  }',
    'mindmap\n  root((Ideas))\n    A[One]\n    B(Two)',
  ];
  for (const s of srcs) {
    const r = lintMermaid(s);
    assert.equal(r.ok, true, msgs(r.errors));
    assert.deepEqual(r.warnings, [], msgs(r.warnings));
  }
});

test('CRLF input keeps line numbers', () => {
  const r = lintMermaid('flowchart LR\r\n  A --> B\r\n  C[oops --> D\r\n');
  assert.equal(r.errors[0].line, 3);
});

test('extractMermaidBlocks finds mermaid fences with start lines', () => {
  const blocks = extractMermaidBlocks(read('notes.md'));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].line, 6);
  assert.equal(blocks[0].text, 'flowchart LR\n  A --> B');
  assert.equal(blocks[1].line, 13);
});

test('extractMermaidBlocks handles tildes, longer fences and unclosed fences', () => {
  const md = '~~~mermaid\npie\n~~~\n\n````mermaid\ngraph LR\n```\nstill inside\n````\n```mermaid\ngantt';
  const blocks = extractMermaidBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, 'pie');
  assert.equal(blocks[1].text, 'graph LR\n```\nstill inside');
  assert.equal(blocks[2].text, 'gantt');
  assert.equal(blocks[2].line, 11);
  assert.deepEqual(extractMermaidBlocks('no fences'), []);
});
