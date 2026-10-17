'use strict';
// Merge a Claude draw spec into the board without touching anything the user owns.

const { clone, isProtected, ID_RE, COLOR_RE } = require('./board-model');

const NODE_FIELDS = ['type', 'x', 'y', 'width', 'height', 'color', 'text', 'file', 'subpath', 'url', 'label', 'background', 'backgroundStyle'];
const EDGE_FIELDS = ['fromNode', 'toNode', 'fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label'];
const MERMAID_FENCE = /^\s*```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/;

function mermaidSource(text) {
  if (typeof text !== 'string') return null;
  const m = MERMAID_FENCE.exec(text);
  return m ? m[1] : null;
}

function specFromMermaid(text, opts = {}) {
  let src = String(text || '').replace(/^﻿/, '');
  const inner = mermaidSource(src);
  if (inner !== null) src = inner;
  const node = {
    id: opts.id || 'diagram-1',
    type: 'text',
    text: '```mermaid\n' + src.trim() + '\n```',
    width: opts.width || 520,
    height: opts.height || 400,
    meta: { kind: 'diagram' },
  };
  if (opts.x !== undefined) node.x = Math.round(Number(opts.x));
  if (opts.y !== undefined) node.y = Math.round(Number(opts.y));
  return { nodes: [node], edges: [] };
}

function pick(item, fields) {
  const out = {};
  for (const f of fields) if (item[f] !== undefined) out[f] = item[f];
  return out;
}

function sameFields(a, b, fields) {
  return fields.every((f) => b[f] === undefined || JSON.stringify(a[f]) === JSON.stringify(b[f]));
}

function inferKind(node) {
  if (node.meta && node.meta.kind) return node.meta.kind;
  return mermaidSource(node.text) !== null ? 'diagram' : 'note';
}

// spot below everything on the board for nodes drawn without coordinates
function nextSlot(board) {
  if (!board.nodes.length) return { x: 0, y: 0 };
  let maxY = -Infinity;
  let minX = Infinity;
  for (const n of board.nodes) {
    maxY = Math.max(maxY, (n.y || 0) + (n.height || 0));
    minX = Math.min(minX, n.x || 0);
  }
  return { x: minX, y: maxY + 60 };
}

function describe(fields) {
  if (typeof fields.text === 'string') return fields.text;
  if (typeof fields.label === 'string') return `label: ${fields.label}`;
  return JSON.stringify(fields);
}

function mergeDraw(input, spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  const board = clone(input);
  const rev = board.rev + 1;
  const report = { added: [], updated: [], skippedLocked: [], skippedDeleted: [], suggestions: [], removed: [] };
  // ids the user deleted stay deleted unless Claude explicitly restores them
  const deleted = new Set(Array.isArray(board.deleted) ? board.deleted : []);
  const restore = (item) => {
    if (!(item.meta && item.meta.restore === true)) return false;
    deleted.delete(item.id);
    board.deleted = [...deleted];
    return true;
  };
  const touched = new Set();
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(board.edges.map((e) => [e.id, e]));

  for (const sn of nodes) {
    if (!sn || typeof sn.id !== 'string' || !ID_RE.test(sn.id)) throw new Error(`bad node id: ${sn && sn.id}`);
    const fields = pick(sn, NODE_FIELDS);
    for (const k of ['x', 'y', 'width', 'height']) if (fields[k] !== undefined) fields[k] = Math.round(Number(fields[k]));
    const cur = byId.get(sn.id) || (edgeById.has(sn.id) ? edgeById.get(sn.id) : null);
    if (cur && edgeById.has(sn.id)) throw new Error(`id used by an edge: ${sn.id}`);

    if (!cur && deleted.has(sn.id) && !restore(sn)) {
      report.skippedDeleted.push(sn.id);
      continue;
    }
    if (!cur) {
      const n = Object.assign({ id: sn.id, type: 'text', width: 260, height: 120 }, fields);
      if (n.x === undefined || n.y === undefined) {
        const slot = nextSlot(board);
        if (n.x === undefined) n.x = slot.x;
        if (n.y === undefined) n.y = slot.y;
      }
      n.meta = { owner: 'claude', locked: false, rev, kind: inferKind(sn) };
      if (sn.meta && sn.meta.suggestsFor) n.meta.suggestsFor = sn.meta.suggestsFor;
      board.nodes.push(n);
      byId.set(n.id, n);
      report.added.push(n.id);
      touched.add(n.id);
      continue;
    }

    if (isProtected(cur)) {
      if (!sameFields(cur, fields, NODE_FIELDS.filter((f) => !['x', 'y', 'width', 'height'].includes(f)))) {
        addSuggestion(board, byId, cur, describe(fields), rev, report, touched);
      }
      report.skippedLocked.push(cur.id);
      continue;
    }

    if (!sameFields(cur, fields, NODE_FIELDS) || (sn.meta && sn.meta.kind && sn.meta.kind !== cur.meta.kind)) {
      Object.assign(cur, fields);
      cur.meta = Object.assign({}, cur.meta, { owner: 'claude', locked: false, rev, kind: inferKind(Object.assign({}, cur, { meta: sn.meta || {} })) });
      report.updated.push(cur.id);
      touched.add(cur.id);
    }
  }

  for (const se of edges) {
    if (!se || typeof se.id !== 'string' || !ID_RE.test(se.id)) throw new Error(`bad edge id: ${se && se.id}`);
    if (byId.has(se.id)) throw new Error(`id used by a node: ${se.id}`);
    const fields = pick(se, EDGE_FIELDS);
    const cur = edgeById.get(se.id);
    if (!cur && deleted.has(se.id) && !restore(se)) {
      report.skippedDeleted.push(se.id);
      continue;
    }
    if (!cur && (!byId.has(se.fromNode) || !byId.has(se.toNode)) && (deleted.has(se.fromNode) || deleted.has(se.toNode))) {
      // its node was deleted by the user, so the edge goes too
      report.skippedDeleted.push(se.id);
      continue;
    }
    if (!cur) {
      const e = Object.assign({ id: se.id }, fields);
      e.meta = { owner: 'claude', locked: false, rev, kind: (se.meta && se.meta.kind) || 'note' };
      board.edges.push(e);
      edgeById.set(e.id, e);
      report.added.push(e.id);
      touched.add(e.id);
      continue;
    }
    if (isProtected(cur)) {
      if (!sameFields(cur, fields, EDGE_FIELDS)) {
        const target = byId.get(cur.fromNode);
        if (target) addSuggestion(board, byId, target, `Edge ${cur.id}: ${describe(fields)}`, rev, report, touched, cur.id);
      }
      report.skippedLocked.push(cur.id);
      continue;
    }
    if (!sameFields(cur, fields, EDGE_FIELDS)) {
      Object.assign(cur, fields);
      cur.meta = Object.assign({}, cur.meta, { owner: 'claude', locked: false, rev });
      report.updated.push(cur.id);
      touched.add(cur.id);
    }
  }

  // optional: spec.remove lists ids Claude wants gone (only its own unlocked items)
  for (const id of Array.isArray(spec.remove) ? spec.remove : []) {
    const n = byId.get(id);
    const e = edgeById.get(id);
    const item = n || e;
    if (!item) continue;
    if (isProtected(item)) { report.skippedLocked.push(id); continue; }
    if (n) {
      const hasUserEdge = board.edges.some((x) => (x.fromNode === id || x.toNode === id) && isProtected(x));
      if (hasUserEdge) { report.skippedLocked.push(id); continue; }
      board.nodes = board.nodes.filter((x) => x.id !== id);
      board.edges = board.edges.filter((x) => x.fromNode !== id && x.toNode !== id);
      byId.delete(id);
    } else {
      board.edges = board.edges.filter((x) => x.id !== id);
    }
    edgeById.delete(id);
    report.removed.push(id);
    touched.add(id);
  }

  if (touched.size) {
    board.rev = rev;
    syncBaseline(board, touched);
  }
  return { board, report };
}

function addSuggestion(board, byId, target, text, rev, report, touched, forId) {
  const sid = `sugg-${forId || target.id}`.slice(0, 80);
  const body = `Suggestion for ${forId || target.id}:\n${text}`;
  let s = byId.get(sid);
  if (s && isProtected(s)) return;
  if (!s && Array.isArray(board.deleted) && board.deleted.includes(sid)) return; // user threw it away // user already took over the suggestion itself
  if (s) {
    if (s.text === body) return;
    s.text = body;
    s.meta.rev = rev;
    report.updated.push(sid);
  } else {
    s = {
      id: sid, type: 'text',
      x: (target.x || 0) + (target.width || 260) + 60, y: target.y || 0,
      width: 260, height: 140, color: '5', text: body,
      meta: { owner: 'claude', locked: false, rev, kind: 'suggestion', suggestsFor: forId || target.id },
    };
    board.nodes.push(s);
    byId.set(sid, s);
    const eid = `${sid}-e`.slice(0, 80);
    if (!board.edges.some((e) => e.id === eid)) {
      board.edges.push({ id: eid, fromNode: sid, toNode: target.id, toEnd: 'arrow', label: 'suggestion',
        meta: { owner: 'claude', locked: false, rev, kind: 'suggestion' } });
      touched.add(eid);
    }
  }
  report.suggestions.push(sid);
  touched.add(sid);
}

// keep Claude's own changes out of the next user diff
function syncBaseline(board, ids) {
  if (!board.baseline) return;
  const base = board.baseline;
  for (const id of ids) {
    const n = board.nodes.find((x) => x.id === id);
    const e = board.edges.find((x) => x.id === id);
    base.nodes = base.nodes.filter((x) => x.id !== id);
    base.edges = base.edges.filter((x) => x.id !== id);
    if (n) base.nodes.push(clone(n));
    if (e) base.edges.push(clone(e));
  }
  // edges removed together with a node
  const nodeIds = new Set(board.nodes.map((n) => n.id));
  base.edges = base.edges.filter((e) => nodeIds.has(e.fromNode) || !ids.has(e.fromNode));
  base.edges = base.edges.filter((e) => nodeIds.has(e.toNode) || !ids.has(e.toNode));
}

// Validate a spec against the board before accepting it. Uses the shared
// validator modules when they are installed.
function validateDraw(board, spec) {
  const errors = [];
  const warnings = [];
  let merged;
  try {
    merged = mergeDraw(board, spec).board;
  } catch (err) {
    return { ok: false, errors: [{ path: 'spec', message: err.message }], warnings };
  }
  let validateCanvas = null;
  let lintMermaid = null;
  try { ({ validateCanvas } = require('./canvas-validate')); } catch (_) { warnings.push({ path: 'validator', message: 'canvas-validate not installed, basic checks only' }); }
  try { ({ lintMermaid } = require('./mermaid-lint')); } catch (_) { warnings.push({ path: 'validator', message: 'mermaid-lint not installed, skipped' }); }

  if (validateCanvas) {
    const view = { version: 1, project: merged.project, rev: merged.rev, deliveredRev: merged.deliveredRev,
      events: [], nodes: merged.nodes, edges: merged.edges };
    const r = validateCanvas(view, { allowBoardExtras: true });
    errors.push(...(r.errors || []));
    warnings.push(...(r.warnings || []));
  } else {
    const ids = new Set(merged.nodes.map((n) => n.id));
    merged.edges.forEach((e, i) => {
      if (!ids.has(e.fromNode) || !ids.has(e.toNode)) errors.push({ path: `edges[${i}]`, message: `edge ${e.id} points at a missing node` });
    });
    merged.nodes.forEach((n, i) => {
      if (n.color !== undefined && !COLOR_RE.test(String(n.color))) errors.push({ path: `nodes[${i}].color`, message: 'bad color' });
    });
  }
  (Array.isArray(spec.nodes) ? spec.nodes : []).forEach((n, i) => {
    const src = mermaidSource(n && n.text);
    if (src === null || !lintMermaid) return;
    const r = lintMermaid(src);
    for (const e of r.errors || []) errors.push({ path: `nodes[${i}] (${n.id}) line ${e.line}`, message: e.message });
    for (const w of r.warnings || []) warnings.push({ path: `nodes[${i}] (${n.id}) line ${w.line}`, message: w.message });
  });
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { mergeDraw, specFromMermaid, validateDraw, mermaidSource };
