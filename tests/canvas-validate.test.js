'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCanvas } = require('../scripts/lib/canvas-validate');

const FIX = path.join(__dirname, 'fixtures', 'canvas');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const paths = (list) => list.map((x) => x.path);

const node = (extra) => Object.assign({ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }, extra);

test('valid-full fixture passes with no warnings', () => {
  const r = validateCanvas(load('valid-full.canvas'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('empty canvas and missing arrays are fine', () => {
  assert.equal(validateCanvas({}).ok, true);
  assert.equal(validateCanvas({ nodes: [] }).ok, true);
});

test('non-object input and non-array lists are errors', () => {
  assert.equal(validateCanvas(null).ok, false);
  assert.equal(validateCanvas([]).ok, false);
  assert.equal(validateCanvas({ nodes: {} }).ok, false);
  assert.equal(validateCanvas({ edges: 'x' }).ok, false);
});

test('broken fixtures each fail at the expected path', () => {
  const cases = {
    'dup-id.canvas': ['nodes[1].id'],
    'bad-edge-ref.canvas': ['edges[0].toNode'],
    'bad-color.canvas': ['nodes[0].color', 'nodes[1].color'],
    'non-integer-geometry.canvas': ['nodes[0].x', 'nodes[0].width'],
    'missing-text.canvas': ['nodes[0].text'],
    'bad-side.canvas': ['edges[0].fromSide', 'edges[0].toEnd'],
  };
  for (const [file, expected] of Object.entries(cases)) {
    const r = validateCanvas(load(file));
    assert.equal(r.ok, false, file);
    assert.deepEqual(paths(r.errors), expected, file);
  }
});

test('ids must be unique across nodes and edges', () => {
  const r = validateCanvas({
    nodes: [node({ id: 'a' }), node({ id: 'b', x: 200 })],
    edges: [{ id: 'a', fromNode: 'a', toNode: 'b' }],
  });
  assert.deepEqual(paths(r.errors), ['edges[0].id']);
});

test('missing id and bad type are errors', () => {
  const r = validateCanvas({ nodes: [{ type: 'blob', x: 0, y: 0, width: 1, height: 1 }] });
  assert.deepEqual(paths(r.errors), ['nodes[0].id', 'nodes[0].type']);
});

test('missing geometry is an error', () => {
  const r = validateCanvas({ nodes: [{ id: 'a', type: 'text', text: 'x' }] });
  assert.deepEqual(paths(r.errors), ['nodes[0].x', 'nodes[0].y', 'nodes[0].width', 'nodes[0].height']);
});

test('type specific required fields', () => {
  const r = validateCanvas({
    nodes: [
      { id: 'f', type: 'file', x: 0, y: 0, width: 10, height: 10 },
      { id: 'f2', type: 'file', x: 0, y: 20, width: 10, height: 10, file: 'a.md', subpath: 'Heading' },
      { id: 'l', type: 'link', x: 0, y: 40, width: 10, height: 10 },
      { id: 'g', type: 'group', x: 100, y: 0, width: 10, height: 10, label: 3, backgroundStyle: 'tile' },
    ],
  });
  assert.deepEqual(paths(r.errors), ['nodes[0].file', 'nodes[1].subpath', 'nodes[2].url', 'nodes[3].label', 'nodes[3].backgroundStyle']);
});

test('colors: presets and 6 digit hex only', () => {
  for (const c of ['1', '6', '#a1B2c3']) assert.equal(validateCanvas({ nodes: [node({ color: c })] }).ok, true, c);
  for (const c of ['0', '7', '#abc', 'blue', 3]) assert.equal(validateCanvas({ nodes: [node({ color: c })] }).ok, false, String(c));
});

test('edge with missing fromNode and bad label type', () => {
  const r = validateCanvas({ nodes: [node()], edges: [{ id: 'e', toNode: 'n1', label: 5 }] });
  assert.deepEqual(paths(r.errors), ['edges[0].fromNode', 'edges[0].label']);
});

test('unknown keys are warnings, not errors', () => {
  const r = validateCanvas({ nodes: [node({ foo: 1, url: 'x' })], extra: true });
  assert.equal(r.ok, true);
  assert.deepEqual(paths(r.warnings).sort(), ['extra', 'nodes[0].foo', 'nodes[0].url']);
});

test('allowBoardExtras ignores meta and board top-level keys', () => {
  const board = {
    version: 1, project: 'p', rev: 3, deliveredRev: 2, events: [],
    nodes: [node({ meta: { owner: 'claude', locked: false, rev: 1, kind: 'note' } })],
    edges: [],
  };
  const strict = validateCanvas(board);
  assert.equal(strict.ok, true);
  assert.equal(strict.warnings.length, 6);
  const loose = validateCanvas(board, { allowBoardExtras: true });
  assert.deepEqual(loose.warnings, []);
  // extras do not hide real errors
  board.nodes[0].x = 1.5;
  assert.equal(validateCanvas(board, { allowBoardExtras: true }).ok, false);
});

test('node partly overlapping a group warns', () => {
  const r = validateCanvas({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100 },
      node({ id: 'in', x: 10, y: 10, width: 20, height: 20 }),
      node({ id: 'half', x: 90, y: 10, width: 50, height: 20 }),
      node({ id: 'out', x: 300, y: 0, width: 20, height: 20 }),
      { id: 'g2', type: 'group', x: 50, y: 50, width: 100, height: 100 },
    ],
  });
  assert.equal(r.ok, true);
  const w = r.warnings.map((x) => x.message).join('\n');
  assert.match(w, /"half" partly overlaps group "g"/);
  assert.match(w, /"g2" partly overlaps group "g"/);
  assert.doesNotMatch(w, /"in"|"out"/);
  // g/g2 overlap reported once
  assert.equal((w.match(/"g2" partly overlaps group "g"|"g" partly overlaps group "g2"/g) || []).length, 1);
});

test('mermaid problems inside text nodes become warnings with the node path', () => {
  const r = validateCanvas({
    nodes: [node({ text: 'Intro\n\n```mermaid\nflowchart LR\n  A[open --> B\n```' })],
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].path, 'nodes[0].text');
  assert.match(r.warnings[0].message, /mermaid line 5: error: unclosed "\["/);
});
