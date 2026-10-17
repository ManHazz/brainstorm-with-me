'use strict';
// Semantic diff between two boards: what the user actually changed, minus geometry noise.

const CAP = 2000;

function cap(s) {
  if (typeof s !== 'string') return s;
  return s.length > CAP ? s.slice(0, CAP) + ' ...[truncated]' : s;
}

function nodeText(n) {
  if (!n) return '';
  if (typeof n.text === 'string') return n.text;
  return n.label || n.file || n.url || '';
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function semanticDiff(oldBoard, newBoard) {
  const oldB = oldBoard || { rev: 0, nodes: [], edges: [] };
  const changes = [];
  const oldNodes = new Map((oldB.nodes || []).map((n) => [n.id, n]));
  const newNodes = new Map((newBoard.nodes || []).map((n) => [n.id, n]));
  const oldEdges = new Map((oldB.edges || []).map((e) => [e.id, e]));
  const newEdges = new Map((newBoard.edges || []).map((e) => [e.id, e]));
  let moved = 0;
  let resized = 0;

  for (const [id, n] of newNodes) {
    const o = oldNodes.get(id);
    const isAnswer = n.meta && n.meta.kind === 'answer';
    if (!o) {
      if (isAnswer) changes.push({ op: 'answer', question_id: n.meta.answerFor || null, id, text: cap(nodeText(n)) });
      else changes.push({ op: 'add_note', id, text: cap(nodeText(n)) });
      continue;
    }
    if (nodeText(o) !== nodeText(n)) {
      if (isAnswer) changes.push({ op: 'answer', question_id: n.meta.answerFor || null, id, text: cap(nodeText(n)) });
      else changes.push({ op: 'edit_text', id, before: cap(nodeText(o)), after: cap(nodeText(n)) });
    }
    if (o.x !== n.x || o.y !== n.y) moved++;
    if (o.width !== n.width || o.height !== n.height) resized++;
  }

  const deletedNodes = new Set();
  for (const [id, o] of oldNodes) {
    if (!newNodes.has(id)) {
      deletedNodes.add(id);
      changes.push({ op: 'delete', id, text: cap(nodeText(o)) });
    }
  }

  for (const [id, e] of newEdges) {
    const o = oldEdges.get(id);
    if (!o) {
      // answer links are implied by the answer op
      if (e.meta && e.meta.kind === 'answer') continue;
      changes.push({ op: 'connect', id, from: e.fromNode, to: e.toNode, label: e.label || '' });
      continue;
    }
    if ((o.label || '') !== (e.label || '')) changes.push({ op: 'edit_text', id, before: cap(o.label || ''), after: cap(e.label || '') });
  }
  for (const [id, o] of oldEdges) {
    if (newEdges.has(id)) continue;
    if (deletedNodes.has(o.fromNode) || deletedNodes.has(o.toNode)) continue;
    changes.push({ op: 'disconnect', id, from: o.fromNode, to: o.toNode });
  }

  for (const err of newBoard.pendingErrors || []) {
    changes.push({ op: 'render_error', id: err.id, message: cap(err.message) });
  }

  const parts = [];
  if (changes.length) parts.push(plural(changes.length, 'change'));
  if (moved) parts.push(`moved ${plural(moved, 'item')}`);
  if (resized) parts.push(`resized ${plural(resized, 'item')}`);
  return {
    from_rev: oldB.rev || 0,
    to_rev: newBoard.rev || 0,
    changes,
    summary: parts.length ? parts.join(', ') : 'no board changes',
  };
}

module.exports = { semanticDiff, CAP };
