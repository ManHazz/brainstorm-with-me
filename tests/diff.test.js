'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../scripts/lib/board-model');
const { mergeDraw } = require('../scripts/lib/merge');
const { semanticDiff } = require('../scripts/lib/diff');

function base() {
  const { board } = mergeDraw(m.emptyBoard('p'), {
    nodes: [
      { id: 'a', text: 'A', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', text: 'B', x: 200, y: 0, width: 100, height: 50 },
      { id: 'q', text: 'Who is it for?', x: 0, y: 200, width: 100, height: 50, meta: { kind: 'question' } },
    ],
    edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
  });
  return m.markDelivered(board);
}

test('reports each op and collapses geometry', () => {
  const b = base();
  m.applyUserEdit(b, { op: 'edit_text', id: 'a', text: 'A!' });
  m.applyUserEdit(b, { op: 'add_note', id: 'u-1', text: 'new idea' });
  m.applyUserEdit(b, { op: 'connect', id: 'ue-1', from: 'u-1', to: 'b', label: 'feeds' });
  m.applyUserEdit(b, { op: 'disconnect', id: 'ab' });
  m.applyUserEdit(b, { op: 'answer', question_id: 'q', text: 'students' });
  m.applyUserEdit(b, { op: 'move', id: 'b', x: 300, y: 10 });
  m.applyUserEdit(b, { op: 'resize', id: 'b', width: 150, height: 60 });
  m.applyUserEdit(b, { op: 'render_error', id: 'a', message: 'Parse error' });
  const d = semanticDiff(b.baseline, b);
  const ops = d.changes.map((c) => c.op).sort();
  assert.deepEqual(ops, ['add_note', 'answer', 'connect', 'disconnect', 'edit_text', 'render_error']);
  assert.deepEqual(d.changes.find((c) => c.op === 'edit_text'), { op: 'edit_text', id: 'a', before: 'A', after: 'A!' });
  assert.deepEqual(d.changes.find((c) => c.op === 'answer'), { op: 'answer', question_id: 'q', id: 'ans-q', text: 'students' });
  assert.match(d.summary, /moved 1 item/);
  assert.match(d.summary, /resized 1 item/);
  assert.equal(d.from_rev, 1);
  assert.equal(d.to_rev, b.rev);
});

test('delete hides the edges that went with the node', () => {
  const b = base();
  m.applyUserEdit(b, { op: 'delete', id: 'a' });
  const d = semanticDiff(b.baseline, b);
  assert.deepEqual(d.changes, [{ op: 'delete', id: 'a', text: 'A' }]);
});

test('caps long text', () => {
  const b = base();
  m.applyUserEdit(b, { op: 'edit_text', id: 'a', text: 'x'.repeat(5000) });
  const c = semanticDiff(b.baseline, b).changes[0];
  assert.ok(c.after.length < 2100);
  assert.match(c.after, /truncated/);
});

test('no changes', () => {
  const b = base();
  assert.equal(semanticDiff(b.baseline, b).summary, 'no board changes');
});
