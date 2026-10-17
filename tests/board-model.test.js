'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../scripts/lib/board-model');

function boardWithNote() {
  const b = m.emptyBoard('p');
  b.nodes.push({ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'hi', meta: { owner: 'claude', locked: false, rev: 1, kind: 'note' } });
  b.nodes.push({ id: 'q1', type: 'text', x: 0, y: 200, width: 200, height: 100, text: 'why?', meta: { owner: 'claude', locked: false, rev: 1, kind: 'question' } });
  b.rev = 1;
  return b;
}

test('save and load round trip, path with spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc- spaced '));
  const file = path.join(dir, 'state dir', 'board.json');
  const b = boardWithNote();
  m.saveBoard(file, b);
  const back = m.loadBoard(file, 'p');
  assert.equal(back.nodes.length, 2);
  assert.equal(back.rev, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['board.json']);
  assert.equal(m.loadBoard(path.join(dir, 'nope.json'), 'x').project, 'x');
});

test('user edit locks the item and bumps rev', () => {
  const b = boardWithNote();
  m.applyUserEdit(b, { op: 'edit_text', id: 'n1', text: 'changed' });
  const n = m.findNode(b, 'n1');
  assert.equal(n.text, 'changed');
  assert.equal(n.meta.owner, 'user');
  assert.equal(n.meta.locked, true);
  assert.equal(b.rev, 2);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].type, 'edit');
});

test('moves lock but do not create events', () => {
  const b = boardWithNote();
  m.applyUserEdit(b, { op: 'move', id: 'n1', x: 10.4, y: 20 });
  assert.equal(m.findNode(b, 'n1').x, 10);
  assert.equal(m.findNode(b, 'n1').meta.locked, true);
  assert.equal(b.events.length, 0);
});

test('add note, connect, answer, delete, unlock', () => {
  const b = boardWithNote();
  m.applyUserEdit(b, { op: 'add_note', id: 'u-1', x: 5, y: 5, text: 'mine' });
  m.applyUserEdit(b, { op: 'connect', id: 'ue-1', from: 'u-1', to: 'n1' });
  m.applyUserEdit(b, { op: 'answer', question_id: 'q1', text: 'because' });
  const ans = m.findNode(b, 'ans-q1');
  assert.equal(ans.meta.kind, 'answer');
  assert.equal(ans.meta.answerFor, 'q1');
  m.applyUserEdit(b, { op: 'delete', id: 'n1' });
  assert.equal(m.findNode(b, 'n1'), undefined);
  assert.equal(m.findEdge(b, 'ue-1'), undefined);
  m.unlock(b, 'u-1');
  assert.equal(m.findNode(b, 'u-1').meta.locked, false);
  assert.equal(m.findNode(b, 'u-1').meta.owner, 'claude');
});

test('bad edits are rejected', () => {
  const b = boardWithNote();
  assert.throws(() => m.applyUserEdit(b, { op: 'nope' }));
  assert.throws(() => m.applyUserEdit(b, { op: 'move', id: '../x', x: 1, y: 1 }));
  assert.throws(() => m.applyUserEdit(b, { op: 'edit_text', id: 'missing', text: 'x' }));
  assert.throws(() => m.applyUserEdit(b, { op: 'connect', from: 'n1', to: 'n1' }));
});

test('say and markDelivered', () => {
  const b = boardWithNote();
  m.userSay(b, '  hello there  ');
  assert.equal(b.events[0].text, 'hello there');
  assert.equal(b.chat[0].who, 'user');
  m.markDelivered(b);
  assert.equal(b.events.length, 0);
  assert.equal(b.deliveredRev, b.rev);
  assert.equal(b.baseline.nodes.length, 2);
});

test('edit events coalesce and the event list is capped', () => {
  const b = boardWithNote();
  m.applyUserEdit(b, { op: 'edit_text', id: 'n1', text: 'one' });
  m.applyUserEdit(b, { op: 'edit_text', id: 'n1', text: 'two' });
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].count, 2);
  for (let i = 0; i < 600; i++) m.userSay(b, `msg ${i}`);
  assert.ok(b.events.length <= 500);
  assert.equal(b.events[b.events.length - 1].text, 'msg 599');
  assert.equal(b.events.some((e) => e.type === 'edit'), false); // edits go first
});

test('bad values never half-apply', () => {
  const b = boardWithNote();
  assert.throws(() => m.applyUserEdit(b, { op: 'move', id: 'n1', x: 50, y: 'nope' }));
  assert.equal(m.findNode(b, 'n1').x, 0);
  assert.throws(() => m.applyUserEdit(b, { op: 'resize', id: 'n1', width: 300, height: {} }));
  assert.equal(m.findNode(b, 'n1').width, 200);
});

test('delivery snapshot keeps events that arrive later', () => {
  const b = boardWithNote();
  m.userSay(b, 'first');
  const snap = m.deliverySnapshot(b);
  m.userSay(b, 'second');
  m.markDelivered(b, snap);
  assert.deepEqual(b.events.map((e) => e.text), ['second']);
});

test('delete leaves a tombstone', () => {
  const b = boardWithNote();
  m.applyUserEdit(b, { op: 'connect', id: 'e1', from: 'n1', to: 'q1' });
  m.applyUserEdit(b, { op: 'delete', id: 'n1' });
  assert.deepEqual(b.deleted.sort(), ['e1', 'n1']);
});
