'use strict';

// Board <-> JSON Canvas 1.0 (.canvas) and a markdown note with the mermaid diagrams.

const NODE_KEYS = {
  common: ['id', 'type', 'x', 'y', 'width', 'height', 'color'],
  text: ['text'],
  file: ['file', 'subpath'],
  link: ['url'],
  group: ['label', 'background', 'backgroundStyle'],
};
const GEOMETRY = ['x', 'y', 'width', 'height'];
const EDGE_KEYS = ['id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label'];

const MERMAID_FENCE = /```mermaid[^\n]*\n([\s\S]*?)```/;

function nodeKeys(type) {
  return NODE_KEYS.common.concat(NODE_KEYS[type] || []);
}

function plainNode(node) {
  const out = {};
  for (const k of nodeKeys(node.type)) {
    if (node[k] === undefined || node[k] === null) continue;
    out[k] = GEOMETRY.includes(k) ? Math.round(Number(node[k]) || 0) : node[k];
  }
  if (node.type === 'text' && typeof out.text !== 'string') out.text = '';
  return out;
}

function plainEdge(edge) {
  const out = {};
  for (const k of EDGE_KEYS) {
    if (edge[k] === undefined || edge[k] === null) continue;
    out[k] = edge[k];
  }
  return out;
}

function toCanvas(board) {
  const nodes = (board.nodes || []).map(plainNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (board.edges || [])
    .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
    .map(plainEdge);
  return { nodes, edges };
}

function isDiagram(node) {
  if (node.type !== 'text') return false;
  if (node.meta && node.meta.kind === 'diagram') return true;
  return MERMAID_FENCE.test(node.text || '');
}

function diagramSource(node) {
  const m = MERMAID_FENCE.exec(node.text || '');
  return (m ? m[1] : node.text || '').replace(/\s+$/, '');
}

function oneLine(text, max = 500) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function toMermaidNote(board) {
  const nodes = board.nodes || [];
  const diagrams = nodes.filter(isDiagram);
  const notes = nodes.filter((n) => n.type === 'text' && !isDiagram(n) && (n.text || '').trim());
  const lines = [
    '---',
    `project: ${board.project || ''}`,
    `rev: ${board.rev || 0}`,
    'generated: brainstorm-with-me',
    '---',
    '',
    `# ${board.project || 'Board'} diagrams`,
    '',
    '_Generated from board.canvas. Edit the canvas, not this note._',
    '',
  ];
  if (!diagrams.length) lines.push('_No diagrams yet._', '');
  for (const d of diagrams) {
    lines.push(`## Diagram ${d.id}`, '', '```mermaid', diagramSource(d), '```', '');
  }
  lines.push('## Notes', '');
  if (!notes.length) lines.push('_No notes yet._');
  for (const n of notes) {
    const kind = n.meta && n.meta.kind && n.meta.kind !== 'note' ? `${n.meta.kind}: ` : '';
    lines.push(`- ${kind}${oneLine(n.text)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

function userMeta(old, rev, kind) {
  return Object.assign({}, old || {}, { owner: 'user', locked: true, rev, kind: kind || (old && old.kind) || 'note' });
}

// Pull edits made to the .canvas (in Obsidian) back into the board. Changed or new
// items come back as user-owned and locked. Deletions only count when opts.baseCanvas
// (the canvas we last wrote) is given, so items Claude drew after the last export survive.
function fromCanvas(canvasObj, board, opts = {}) {
  const next = JSON.parse(JSON.stringify(board));
  next.nodes = next.nodes || [];
  next.edges = next.edges || [];
  next.events = next.events || [];
  const rev = (next.rev || 0) + 1;
  const touched = { edited: [], added: [], deleted: [] };

  const cNodes = Array.isArray(canvasObj && canvasObj.nodes) ? canvasObj.nodes : [];
  const cEdges = Array.isArray(canvasObj && canvasObj.edges) ? canvasObj.edges : [];

  const nodeById = new Map(next.nodes.map((n) => [n.id, n]));
  for (const cn of cNodes) {
    if (!cn || !cn.id || !cn.type) continue;
    const incoming = plainNode(cn);
    const existing = nodeById.get(cn.id);
    if (!existing) {
      const kind = cn.type === 'text' && MERMAID_FENCE.test(cn.text || '') ? 'diagram' : 'note';
      const node = Object.assign({}, incoming, { meta: userMeta(null, rev, kind) });
      next.nodes.push(node);
      nodeById.set(node.id, node);
      touched.added.push(node.id);
      continue;
    }
    if (sameJson(sortedObj(plainNode(existing)), sortedObj(incoming))) continue;
    for (const k of new Set(nodeKeys(existing.type).concat(nodeKeys(incoming.type)))) {
      if (k === 'id') continue;
      if (incoming[k] === undefined) delete existing[k];
      else existing[k] = incoming[k];
    }
    existing.meta = userMeta(existing.meta, rev);
    touched.edited.push(existing.id);
  }

  const edgeById = new Map(next.edges.map((e) => [e.id, e]));
  for (const ce of cEdges) {
    if (!ce || !ce.id || !ce.fromNode || !ce.toNode) continue;
    const incoming = plainEdge(ce);
    const existing = edgeById.get(ce.id);
    if (!existing) {
      const edge = Object.assign({}, incoming, { meta: userMeta(null, rev, 'note') });
      next.edges.push(edge);
      edgeById.set(edge.id, edge);
      touched.added.push(edge.id);
      continue;
    }
    if (sameJson(sortedObj(plainEdge(existing)), sortedObj(incoming))) continue;
    for (const k of EDGE_KEYS) {
      if (k === 'id') continue;
      if (incoming[k] === undefined) delete existing[k];
      else existing[k] = incoming[k];
    }
    existing.meta = userMeta(existing.meta, rev);
    touched.edited.push(existing.id);
  }

  if (opts.baseCanvas) {
    const inCanvas = new Set(cNodes.concat(cEdges).map((i) => i && i.id));
    const baseIds = new Set([]
      .concat(opts.baseCanvas.nodes || [], opts.baseCanvas.edges || [])
      .map((i) => i && i.id));
    const gone = (item) => baseIds.has(item.id) && !inCanvas.has(item.id);
    for (const n of next.nodes.filter(gone)) touched.deleted.push(n.id);
    for (const e of next.edges.filter(gone)) touched.deleted.push(e.id);
    next.nodes = next.nodes.filter((n) => !gone(n));
    next.edges = next.edges.filter((e) => !gone(e));
  }
  // Drop edges left pointing at nothing.
  const liveIds = new Set(next.nodes.map((n) => n.id));
  next.edges = next.edges.filter((e) => liveIds.has(e.fromNode) && liveIds.has(e.toNode));

  const count = touched.edited.length + touched.added.length + touched.deleted.length;
  if (count) {
    next.rev = rev;
    const seq = next.events.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
    const parts = [];
    if (touched.edited.length) parts.push(`edited ${touched.edited.join(', ')}`);
    if (touched.added.length) parts.push(`added ${touched.added.join(', ')}`);
    if (touched.deleted.length) parts.push(`deleted ${touched.deleted.join(', ')}`);
    next.events.push({ seq, at: new Date().toISOString(), type: 'edit', text: `Changed in Obsidian canvas: ${parts.join('; ')}`, rev });
  }
  return next;
}

module.exports = { toCanvas, toMermaidNote, fromCanvas, isDiagram, diagramSource };
