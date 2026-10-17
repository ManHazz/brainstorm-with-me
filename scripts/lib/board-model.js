'use strict';
// Board document: JSON Canvas nodes/edges plus meta, chat and undelivered user events.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT = 20000;
const MAX_ITEMS = 2000;
const MAX_CHAT = 200;
const MAX_EVENTS = 500;
const MAX_TOMBSTONES = 1000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const COLOR_RE = /^([1-6]|#[0-9a-fA-F]{6})$/;

function emptyBoard(project) {
  return {
    version: 1,
    id: crypto.randomBytes(8).toString('hex'),
    project,
    rev: 0,
    deliveredRev: 0,
    nodes: [],
    edges: [],
    events: [],
    eventSeq: 0,
    chat: [],
    pendingErrors: [],
    deleted: [],
    baseline: { rev: 0, nodes: [], edges: [] },
  };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function normalize(board, project) {
  const b = Object.assign(emptyBoard(project || board.project || 'default'), board);
  for (const k of ['nodes', 'edges', 'events', 'chat', 'pendingErrors', 'deleted']) {
    if (!Array.isArray(b[k])) b[k] = [];
  }
  if (!b.baseline || !Array.isArray(b.baseline.nodes)) {
    b.baseline = { rev: b.deliveredRev || 0, nodes: clone(b.nodes), edges: clone(b.edges) };
  }
  if (!Array.isArray(b.baseline.edges)) b.baseline.edges = [];
  // fromCanvas and friends may append events without touching eventSeq
  b.eventSeq = Math.max(typeof b.eventSeq === 'number' ? b.eventSeq : 0, b.events.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  return b;
}

function loadBoard(file, project) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyBoard(project || 'default');
    throw err;
  }
  return normalize(JSON.parse(raw), project);
}

function saveBoard(file, board) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n');
  // windows can briefly refuse the rename if a reader has the file open
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw err;
      }
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* short spin */ }
    }
  }
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function findNode(board, id) {
  return board.nodes.find((n) => n.id === id);
}

function findEdge(board, id) {
  return board.edges.find((e) => e.id === id);
}

function isProtected(item) {
  return !!(item && item.meta && (item.meta.locked || item.meta.owner === 'user'));
}

function int(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.round(n);
}

function str(v, name, max = MAX_TEXT) {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v.length > max ? v.slice(0, max) : v;
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('bad id');
  return id;
}

function lockToUser(item, rev) {
  item.meta = Object.assign({ kind: 'note' }, item.meta || {}, { owner: 'user', locked: true, rev });
}

function pushEvent(board, type, text) {
  board.eventSeq = (board.eventSeq || 0) + 1;
  const at = new Date().toISOString();
  const last = board.events[board.events.length - 1];
  // a run of edits collapses into one event; the diff carries the detail
  if (type === 'edit' && last && last.type === 'edit') {
    last.seq = board.eventSeq;
    last.at = at;
    last.rev = board.rev;
    last.count = (last.count || 1) + 1;
    last.text = `${last.count} board edits, latest: ${text || ''}`.trim();
    return last;
  }
  const ev = { seq: board.eventSeq, at, type, rev: board.rev };
  if (text !== undefined) ev.text = text;
  board.events.push(ev);
  while (board.events.length > MAX_EVENTS) {
    const i = board.events.findIndex((e) => e.type === 'edit');
    board.events.splice(i >= 0 ? i : 0, 1);
  }
  return ev;
}

function tombstone(board, ids) {
  for (const id of ids) if (!board.deleted.includes(id)) board.deleted.push(id);
  if (board.deleted.length > MAX_TOMBSTONES) board.deleted.splice(0, board.deleted.length - MAX_TOMBSTONES);
}

function addChat(board, who, text) {
  board.chat.push({ who, text, at: new Date().toISOString() });
  if (board.chat.length > MAX_CHAT) board.chat.splice(0, board.chat.length - MAX_CHAT);
}

// user typed something in the chat strip
function userSay(board, text) {
  const t = str(text, 'text').trim();
  if (!t) throw new Error('empty text');
  addChat(board, 'user', t);
  pushEvent(board, 'say', t);
  return board;
}

// Apply one edit from the page. Mutates and returns board. Throws on bad input.
function applyUserEdit(board, edit) {
  if (!edit || typeof edit !== 'object') throw new Error('edit must be an object');
  const op = edit.op;
  const next = board.rev + 1;
  let wake = true;

  switch (op) {
    case 'move': {
      const n = findNode(board, checkId(edit.id));
      if (!n) throw new Error('no such node');
      const x = int(edit.x, 'x');
      const y = int(edit.y, 'y');
      n.x = x;
      n.y = y;
      lockToUser(n, next);
      wake = false;
      break;
    }
    case 'resize': {
      const n = findNode(board, checkId(edit.id));
      if (!n) throw new Error('no such node');
      const w = Math.max(40, int(edit.width, 'width'));
      const h = Math.max(30, int(edit.height, 'height'));
      n.width = w;
      n.height = h;
      lockToUser(n, next);
      wake = false;
      break;
    }
    case 'edit_text': {
      const id = checkId(edit.id);
      const n = findNode(board, id);
      if (n) {
        if (n.type !== 'text') throw new Error('only text nodes have text');
        const text = str(edit.text, 'text');
        n.text = text;
        lockToUser(n, next);
        break;
      }
      const e = findEdge(board, id);
      if (!e) throw new Error('no such item');
      const label = str(edit.text, 'text', 500);
      e.label = label;
      lockToUser(e, next);
      break;
    }
    case 'add_note': {
      if (board.nodes.length >= MAX_ITEMS) throw new Error('board is full');
      const id = edit.id ? checkId(edit.id) : newId('u');
      if (findNode(board, id) || findEdge(board, id)) throw new Error('id taken');
      const n = {
        id, type: 'text',
        x: int(edit.x || 0, 'x'), y: int(edit.y || 0, 'y'),
        width: Math.max(40, int(edit.width || 220, 'width')),
        height: Math.max(30, int(edit.height || 100, 'height')),
        text: str(edit.text || '', 'text'),
        meta: { owner: 'user', locked: true, rev: next, kind: 'note' },
      };
      if (edit.color !== undefined && COLOR_RE.test(String(edit.color))) n.color = String(edit.color);
      board.nodes.push(n);
      break;
    }
    case 'delete':
    case 'disconnect': {
      const id = checkId(edit.id);
      const ni = board.nodes.findIndex((n) => n.id === id);
      if (ni >= 0 && op === 'delete') {
        const gone = board.edges.filter((e) => e.fromNode === id || e.toNode === id).map((e) => e.id);
        board.nodes.splice(ni, 1);
        board.edges = board.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
        tombstone(board, [id, ...gone]);
        break;
      }
      const ei = board.edges.findIndex((e) => e.id === id);
      if (ei < 0) throw new Error('no such item');
      board.edges.splice(ei, 1);
      tombstone(board, [id]);
      break;
    }
    case 'connect': {
      if (board.edges.length >= MAX_ITEMS) throw new Error('board is full');
      const from = checkId(edit.from);
      const to = checkId(edit.to);
      if (!findNode(board, from) || !findNode(board, to)) throw new Error('no such node');
      if (from === to) throw new Error('cannot connect a node to itself');
      const id = edit.id ? checkId(edit.id) : newId('ue');
      if (findNode(board, id) || findEdge(board, id)) throw new Error('id taken');
      const label = edit.label ? str(edit.label, 'label', 500) : '';
      const e = { id, fromNode: from, toNode: to, toEnd: 'arrow', meta: { owner: 'user', locked: true, rev: next, kind: 'note' } };
      if (label) e.label = label;
      board.edges.push(e);
      break;
    }
    case 'answer': {
      const qid = checkId(edit.question_id || edit.id);
      const q = findNode(board, qid);
      if (!q) throw new Error('no such question');
      const text = str(edit.text, 'text').trim();
      if (!text) throw new Error('empty answer');
      const aid = `ans-${qid}`.slice(0, 80);
      let a = findNode(board, aid);
      if (a) {
        a.text = text;
        lockToUser(a, next);
      } else {
        a = {
          id: aid, type: 'text', x: q.x, y: q.y + (q.height || 100) + 40,
          width: q.width || 260, height: 100, text,
          meta: { owner: 'user', locked: true, rev: next, kind: 'answer', answerFor: qid },
        };
        board.nodes.push(a);
        board.edges.push({ id: `${aid}-e`.slice(0, 80), fromNode: qid, toNode: aid, toEnd: 'arrow', label: 'answer',
          meta: { owner: 'user', locked: true, rev: next, kind: 'answer' } });
      }
      break;
    }
    case 'unlock':
      return unlock(board, checkId(edit.id));
    case 'render_error': {
      const id = checkId(edit.id);
      const message = str(edit.message || 'render failed', 'message', 2000);
      // one pending error per node is plenty
      board.pendingErrors = board.pendingErrors.filter((e) => e.id !== id);
      board.pendingErrors.push({ id, message });
      board.rev = next;
      pushEvent(board, 'edit', `render_error ${id}`);
      return board;
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }

  board.rev = next;
  if (wake) pushEvent(board, 'edit', `${op} ${edit.id || edit.question_id || edit.from || ''}`.trim());
  return board;
}

// "let Claude rearrange": hand the item back to Claude
function unlock(board, id) {
  const item = findNode(board, id) || findEdge(board, id);
  if (!item) throw new Error('no such item');
  board.rev += 1;
  item.meta = Object.assign({ kind: 'note' }, item.meta || {}, { owner: 'claude', locked: false, rev: board.rev });
  return board;
}

// Claude has now seen everything up to the current rev
function markDelivered(board, snap) {
  const s = snap || deliverySnapshot(board);
  board.deliveredRev = Math.max(board.deliveredRev || 0, s.rev);
  board.events = board.events.filter((e) => e.seq > s.seq);
  board.pendingErrors = board.pendingErrors.filter((e) => !s.errors.some((x) => x.id === e.id && x.message === e.message));
  board.baseline = { rev: s.rev, nodes: s.nodes, edges: s.edges };
  return board;
}

// state as handed to Claude; committed with markDelivered once it really arrived
function deliverySnapshot(board) {
  return {
    rev: board.rev,
    seq: board.events.reduce((m, e) => Math.max(m, e.seq || 0), 0),
    errors: clone(board.pendingErrors),
    nodes: clone(board.nodes),
    edges: clone(board.edges),
  };
}

// what the page gets: no internal bookkeeping
function publicView(board) {
  return {
    project: board.project,
    rev: board.rev,
    nodes: board.nodes,
    edges: board.edges,
    chat: board.chat,
  };
}

module.exports = {
  emptyBoard, loadBoard, saveBoard, normalize, applyUserEdit, unlock, userSay, addChat,
  markDelivered, deliverySnapshot, tombstone, publicView, isProtected, findNode, findEdge, newId, clone, ID_RE, COLOR_RE,
};
