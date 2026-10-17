'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../scripts/lib/board-model');
const { mergeDraw, specFromMermaid, validateDraw } = require('../scripts/lib/merge');
const { semanticDiff } = require('../scripts/lib/diff');

const spec = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'A' },
    { id: 'b', type: 'text', x: 300, y: 0, width: 200, height: 100, text: 'B' },
  ],
  edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
};

test('adds then updates claude items', () => {
  let { board, report } = mergeDraw(m.emptyBoard('p'), spec);
  assert.deepEqual(report.added, ['a', 'b', 'ab']);
  assert.equal(board.rev, 1);
  assert.equal(m.findNode(board, 'a').meta.owner, 'claude');
  ({ board, report } = mergeDraw(board, { nodes: [{ id: 'a', text: 'A2' }] }));
  assert.deepEqual(report.updated, ['a']);
  assert.equal(m.findNode(board, 'a').text, 'A2');
  assert.equal(m.findNode(board, 'a').x, 0);
});

test('locked items are untouched and get a suggestion', () => {
  let { board } = mergeDraw(m.emptyBoard('p'), spec);
  m.applyUserEdit(board, { op: 'edit_text', id: 'a', text: 'user text' });
  m.applyUserEdit(board, { op: 'move', id: 'b', x: 50, y: 60 });
  const before = JSON.stringify(m.findNode(board, 'a'));
  const r = mergeDraw(board, { nodes: [{ id: 'a', text: 'claude wants this' }, { id: 'b', x: 999, y: 999 }] });
  assert.equal(JSON.stringify(m.findNode(r.board, 'a')), before);
  assert.equal(m.findNode(r.board, 'b').x, 50);
  assert.deepEqual(r.report.skippedLocked, ['a', 'b']);
  assert.deepEqual(r.report.suggestions, ['sugg-a']);
  const s = m.findNode(r.board, 'sugg-a');
  assert.equal(s.meta.kind, 'suggestion');
  assert.match(s.text, /claude wants this/);
  assert.ok(r.board.edges.some((e) => e.fromNode === 'sugg-a' && e.toNode === 'a'));
});

test('remove only drops claude items', () => {
  let { board } = mergeDraw(m.emptyBoard('p'), spec);
  m.applyUserEdit(board, { op: 'edit_text', id: 'a', text: 'mine' });
  const r = mergeDraw(board, { remove: ['a', 'b'] });
  assert.deepEqual(r.report.removed, ['b']);
  assert.deepEqual(r.report.skippedLocked, ['a']);
});

test('claude changes stay out of the user diff', () => {
  let { board } = mergeDraw(m.markDelivered(m.emptyBoard('p')), spec);
  assert.equal(semanticDiff(board.baseline, board).changes.length, 0);
});

test('specFromMermaid fences once', () => {
  const s1 = specFromMermaid('flowchart LR\n  A-->B\n', { id: 'd1', x: 5, y: 6 });
  assert.equal(s1.nodes[0].text, '```mermaid\nflowchart LR\n  A-->B\n```');
  assert.equal(s1.nodes[0].meta.kind, 'diagram');
  const s2 = specFromMermaid(s1.nodes[0].text, { id: 'd1' });
  assert.equal(s2.nodes[0].text, s1.nodes[0].text);
  const { board } = mergeDraw(m.emptyBoard('p'), s1);
  assert.equal(m.findNode(board, 'd1').meta.kind, 'diagram');
});

test('validateDraw catches dangling edges and bad mermaid', () => {
  const bad = validateDraw(m.emptyBoard('p'), { nodes: [], edges: [{ id: 'e', fromNode: 'x', toNode: 'y' }] });
  assert.equal(bad.ok, false);
  const badMmd = validateDraw(m.emptyBoard('p'), specFromMermaid('flowchart LR\n  A[open --> B', { id: 'd' }));
  assert.equal(badMmd.ok, false);
  const good = validateDraw(m.emptyBoard('p'), spec);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('user deletions are not undone by a redraw unless restored', () => {
  let { board } = mergeDraw(m.markDelivered(m.emptyBoard('p')), spec);
  board = m.markDelivered(board);
  m.applyUserEdit(board, { op: 'delete', id: 'a' });
  const r = mergeDraw(board, spec);
  assert.equal(m.findNode(r.board, 'a'), undefined);
  assert.deepEqual(r.report.skippedDeleted.sort(), ['a', 'ab']);
  assert.ok(semanticDiff(r.board.baseline, r.board).changes.some((c) => c.op === 'delete' && c.id === 'a'));
  const back = mergeDraw(r.board, { nodes: [Object.assign({}, spec.nodes[0], { meta: { restore: true } })] });
  assert.deepEqual(back.report.added, ['a']);
  assert.equal(back.board.deleted.includes('a'), false);
});
