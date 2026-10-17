'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toCanvas, toMermaidNote, fromCanvas } = require('../scripts/lib/canvas-export');

const validatePath = path.join(__dirname, '..', 'scripts', 'lib', 'canvas-validate.js');

function meta(kind = 'note', owner = 'claude') {
  return { owner, locked: owner === 'user', rev: 1, kind };
}

function sampleBoard() {
  return {
    version: 1,
    project: 'demo',
    rev: 5,
    deliveredRev: 4,
    events: [],
    nodes: [
      { id: 'n1', type: 'text', x: 10.6, y: -20.2, width: 250.5, height: 60, text: 'A sticky\nwith two lines', color: '4', meta: meta() },
      { id: 'd1', type: 'text', x: 300, y: 0, width: 400, height: 300, text: '```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```', meta: meta('diagram') },
      { id: 'q1', type: 'text', x: 0, y: 200, width: 200, height: 80, text: 'Which phone?', meta: meta('question') },
      { id: 'g1', type: 'group', x: -50, y: -50, width: 800, height: 500, label: 'Ideas', meta: meta() },
      { id: 'l1', type: 'link', x: 0, y: 400, width: 200, height: 80, url: 'https://example.com', meta: meta() },
    ],
    edges: [
      { id: 'e1', fromNode: 'n1', toNode: 'd1', fromSide: 'right', toSide: 'left', toEnd: 'arrow', label: 'leads to', meta: meta() },
      { id: 'e2', fromNode: 'n1', toNode: 'missing', meta: meta() },
    ],
  };
}

test('toCanvas strips meta and board extras, rounds geometry', () => {
  const c = toCanvas(sampleBoard());
  assert.deepEqual(Object.keys(c).sort(), ['edges', 'nodes']);
  const s = JSON.stringify(c);
  assert.ok(!s.includes('"meta"'));
  assert.ok(!s.includes('deliveredRev'));
  const n1 = c.nodes.find((n) => n.id === 'n1');
  assert.deepEqual(n1, { id: 'n1', type: 'text', x: 11, y: -20, width: 251, height: 60, color: '4', text: 'A sticky\nwith two lines' });
  for (const n of c.nodes) for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(n[k]));
  assert.deepEqual(c.nodes.find((n) => n.id === 'g1'), { id: 'g1', type: 'group', x: -50, y: -50, width: 800, height: 500, label: 'Ideas' });
  assert.equal(c.edges.length, 1, 'edge to a missing node is dropped');
});

test('toCanvas output passes validateCanvas when the validator exists', { skip: !fs.existsSync(validatePath) && 'canvas-validate.js not built yet' }, () => {
  const { validateCanvas } = require(validatePath);
  const res = validateCanvas(toCanvas(sampleBoard()));
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('toMermaidNote lists diagrams as fences and stickies as bullets', () => {
  const md = toMermaidNote(sampleBoard());
  assert.match(md, /^---\nproject: demo\nrev: 5\n/);
  assert.match(md, /## Diagram d1\n\n```mermaid\nflowchart TD\n {2}A\[Start\] --> B\[End\]\n```/);
  assert.match(md, /- A sticky with two lines\n/);
  assert.match(md, /- question: Which phone\?/);
  assert.ok(!md.includes(String.fromCharCode(0x2014)), "no em dash");
});

test('round trip with no edits changes nothing', () => {
  const b = sampleBoard();
  const back = fromCanvas(toCanvas(b), b);
  assert.equal(back.rev, 5);
  assert.deepEqual(back.events, []);
});

test('fromCanvas marks edited and new items as user locked, keeps others', () => {
  const b = sampleBoard();
  const exported = toCanvas(b);
  const c = JSON.parse(JSON.stringify(exported));
  c.nodes.find((n) => n.id === 'n1').text = 'Edited in Obsidian';
  c.nodes.find((n) => n.id === 'q1').x = 999;
  c.nodes.push({ id: 'u1', type: 'text', x: 5, y: 5, width: 100, height: 40, text: 'User note' });
  c.edges.push({ id: 'ue1', fromNode: 'u1', toNode: 'n1' });
  c.nodes = c.nodes.filter((n) => n.id !== 'l1');

  const next = fromCanvas(c, b, { baseCanvas: exported });
  assert.equal(next.rev, 6);
  const n1 = next.nodes.find((n) => n.id === 'n1');
  assert.equal(n1.text, 'Edited in Obsidian');
  assert.deepEqual([n1.meta.owner, n1.meta.locked, n1.meta.rev], ['user', true, 6]);
  const q1 = next.nodes.find((n) => n.id === 'q1');
  assert.equal(q1.x, 999);
  assert.equal(q1.meta.locked, true);
  assert.equal(q1.meta.kind, 'question');
  const d1 = next.nodes.find((n) => n.id === 'd1');
  assert.deepEqual([d1.meta.owner, d1.meta.locked], ['claude', false]);
  const u1 = next.nodes.find((n) => n.id === 'u1');
  assert.deepEqual([u1.meta.owner, u1.meta.locked], ['user', true]);
  assert.ok(next.edges.find((e) => e.id === 'ue1').meta.locked);
  assert.equal(next.nodes.find((n) => n.id === 'l1'), undefined, 'deleted in canvas, was in base');
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].type, 'edit');
  assert.equal(b.nodes.find((n) => n.id === 'n1').text, 'A sticky\nwith two lines', 'input board not mutated');
});

test('fromCanvas without baseCanvas never deletes', () => {
  const b = sampleBoard();
  const c = toCanvas(b);
  c.nodes = c.nodes.filter((n) => n.id !== 'l1');
  const next = fromCanvas(c, b);
  assert.ok(next.nodes.find((n) => n.id === 'l1'));
  assert.equal(next.rev, 5);
});
