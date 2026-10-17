'use strict';

// JSON Canvas 1.0 validator (jsoncanvas.org/spec/1.0).
// Hard spec violations are errors; unknown keys and layout oddities are warnings.

const { lintMermaid, extractMermaidBlocks } = require('./mermaid-lint');

const NODE_TYPES = ['text', 'file', 'link', 'group'];
const SIDES = ['top', 'right', 'bottom', 'left'];
const ENDS = ['none', 'arrow'];
const BG_STYLES = ['cover', 'ratio', 'repeat'];

const NODE_BASE_KEYS = ['id', 'type', 'x', 'y', 'width', 'height', 'color'];
const NODE_TYPE_KEYS = {
  text: ['text'],
  file: ['file', 'subpath'],
  link: ['url'],
  group: ['label', 'background', 'backgroundStyle'],
};
const EDGE_KEYS = ['id', 'fromNode', 'toNode', 'fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label'];
const TOP_KEYS = ['nodes', 'edges'];
const BOARD_TOP_EXTRAS = ['version', 'project', 'rev', 'deliveredRev', 'events'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isColor(v) {
  return typeof v === 'string' && (/^[1-6]$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v));
}

function validateCanvas(obj, opts) {
  const options = opts || {};
  const extras = !!options.allowBoardExtras;
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const done = () => ({ ok: errors.length === 0, errors, warnings });

  if (!isPlainObject(obj)) {
    err('', 'canvas must be a JSON object');
    return done();
  }

  for (const k of Object.keys(obj)) {
    if (TOP_KEYS.includes(k)) continue;
    if (extras && BOARD_TOP_EXTRAS.includes(k)) continue;
    warn(k, `unknown top-level key "${k}"`);
  }

  let nodes = [];
  let edges = [];
  if (obj.nodes !== undefined) {
    if (Array.isArray(obj.nodes)) nodes = obj.nodes;
    else err('nodes', 'nodes must be an array');
  }
  if (obj.edges !== undefined) {
    if (Array.isArray(obj.edges)) edges = obj.edges;
    else err('edges', 'edges must be an array');
  }

  const seen = new Map(); // id -> path of first use
  const nodeIds = new Set();
  const checkId = (item, p) => {
    if (typeof item.id !== 'string' || item.id === '') {
      err(`${p}.id`, 'id is required and must be a non-empty string');
      return;
    }
    if (seen.has(item.id)) err(`${p}.id`, `duplicate id "${item.id}" (first used at ${seen.get(item.id)})`);
    else seen.set(item.id, p);
  };
  const checkColor = (item, p) => {
    if (item.color !== undefined && !isColor(item.color)) {
      err(`${p}.color`, 'color must be "1" to "6" or a hex color like #FF0000');
    }
  };
  const checkUnknown = (item, p, allowed) => {
    for (const k of Object.keys(item)) {
      if (allowed.includes(k)) continue;
      if (extras && k === 'meta') continue;
      warn(`${p}.${k}`, `unknown key "${k}"`);
    }
  };
  const optString = (item, key, p) => {
    if (item[key] !== undefined && typeof item[key] !== 'string') err(`${p}.${key}`, `${key} must be a string`);
  };

  nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (!isPlainObject(n)) { err(p, 'node must be an object'); return; }
    checkId(n, p);
    if (typeof n.id === 'string' && n.id) nodeIds.add(n.id);

    const typeOk = NODE_TYPES.includes(n.type);
    if (!typeOk) err(`${p}.type`, `type must be one of ${NODE_TYPES.join(', ')}`);

    for (const k of ['x', 'y', 'width', 'height']) {
      if (n[k] === undefined) err(`${p}.${k}`, `${k} is required`);
      else if (!Number.isInteger(n[k])) err(`${p}.${k}`, `${k} must be an integer`);
    }
    for (const k of ['width', 'height']) {
      if (Number.isInteger(n[k]) && n[k] <= 0) warn(`${p}.${k}`, `${k} should be positive`);
    }
    checkColor(n, p);
    checkUnknown(n, p, NODE_BASE_KEYS.concat(typeOk ? NODE_TYPE_KEYS[n.type] : []));
    if (!typeOk) return;

    if (n.type === 'text') {
      if (typeof n.text !== 'string') {
        err(`${p}.text`, 'text node needs a "text" string');
      } else {
        for (const b of extractMermaidBlocks(n.text)) {
          const r = lintMermaid(b.text);
          for (const e of r.errors) warn(`${p}.text`, `mermaid line ${b.line + e.line - 1}: error: ${e.message}`);
          for (const w of r.warnings) warn(`${p}.text`, `mermaid line ${b.line + w.line - 1}: ${w.message}`);
        }
      }
    } else if (n.type === 'file') {
      if (typeof n.file !== 'string' || n.file === '') err(`${p}.file`, 'file node needs a "file" string');
      if (n.subpath !== undefined && (typeof n.subpath !== 'string' || !n.subpath.startsWith('#'))) {
        err(`${p}.subpath`, 'subpath must be a string starting with "#"');
      }
    } else if (n.type === 'link') {
      if (typeof n.url !== 'string' || n.url === '') err(`${p}.url`, 'link node needs a "url" string');
    } else if (n.type === 'group') {
      optString(n, 'label', p);
      optString(n, 'background', p);
      if (n.backgroundStyle !== undefined && !BG_STYLES.includes(n.backgroundStyle)) {
        err(`${p}.backgroundStyle`, `backgroundStyle must be one of ${BG_STYLES.join(', ')}`);
      }
    }
  });

  edges.forEach((e, i) => {
    const p = `edges[${i}]`;
    if (!isPlainObject(e)) { err(p, 'edge must be an object'); return; }
    checkId(e, p);
    for (const k of ['fromNode', 'toNode']) {
      if (typeof e[k] !== 'string' || e[k] === '') err(`${p}.${k}`, `${k} is required and must be a string`);
      else if (!nodeIds.has(e[k])) err(`${p}.${k}`, `${k} "${e[k]}" does not match any node id`);
    }
    for (const k of ['fromSide', 'toSide']) {
      if (e[k] !== undefined && !SIDES.includes(e[k])) err(`${p}.${k}`, `${k} must be one of ${SIDES.join(', ')}`);
    }
    for (const k of ['fromEnd', 'toEnd']) {
      if (e[k] !== undefined && !ENDS.includes(e[k])) err(`${p}.${k}`, `${k} must be one of ${ENDS.join(', ')}`);
    }
    checkColor(e, p);
    optString(e, 'label', p);
    checkUnknown(e, p, EDGE_KEYS);
  });

  checkGroupOverlap(nodes, warn);
  return done();
}

// Warn when a node straddles a group border: partly in, partly out.
// Fully inside means nested, fully outside means unrelated; both are fine.
function checkGroupOverlap(nodes, warn) {
  const boxes = [];
  nodes.forEach((n, i) => {
    if (!isPlainObject(n)) return;
    if (!['x', 'y', 'width', 'height'].every((k) => Number.isInteger(n[k]))) return;
    if (n.width <= 0 || n.height <= 0) return;
    boxes.push({ i, n, x1: n.x, y1: n.y, x2: n.x + n.width, y2: n.y + n.height });
  });
  const inside = (a, b) => a.x1 >= b.x1 && a.y1 >= b.y1 && a.x2 <= b.x2 && a.y2 <= b.y2;
  const hits = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  for (const g of boxes) {
    if (g.n.type !== 'group') continue;
    for (const o of boxes) {
      if (o === g) continue;
      if (!hits(o, g) || inside(o, g) || inside(g, o)) continue;
      // two overlapping groups would be reported twice; keep one
      if (o.n.type === 'group' && o.i < g.i) continue;
      warn(`nodes[${o.i}]`, `node "${o.n.id}" partly overlaps group "${g.n.id}" (neither inside nor outside it)`);
    }
  }
}

module.exports = { validateCanvas };
