'use strict';

// Offline structural lint for mermaid sources. Not a parser. The board page runs
// the real mermaid.parse; this just catches the obvious stuff early.
// Rule of thumb: if valid mermaid could trip a check, it is a warning, not an error.

const KNOWN_HEADERS = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap',
  'timeline', 'quadrantChart', 'gitGraph', 'requirementDiagram', 'C4Context',
  'sankey-beta', 'xychart-beta', 'block-beta',
];

// real mermaid types we do not check deeply; accepted with a warning
const OTHER_HEADERS = [
  'classDiagram-v2', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
  'architecture-beta', 'packet-beta', 'kanban', 'radar-beta', 'treemap-beta', 'zenuml',
];

const DIRECTIONS = ['TB', 'TD', 'BT', 'RL', 'LR'];
const SEQ_OPENERS = ['loop', 'alt', 'opt', 'par', 'critical', 'break', 'rect', 'box'];
const SEQ_MIDDLES = { else: ['alt'], and: ['par'], option: ['critical'] };
const PAIRS = { ')': '(', ']': '[', '}': '{' };

function headerWord(line) {
  const m = /^([A-Za-z][\w-]*)/.exec(line);
  return m ? m[1] : '';
}

function lintMermaid(text) {
  const errors = [];
  const warnings = [];
  const err = (line, message) => errors.push({ line, message });
  const warn = (line, message) => warnings.push({ line, message });

  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');

  if (/<script/i.test(text || '') || /javascript:/i.test(text || '')) {
    lines.forEach((l, i) => {
      if (/<script/i.test(l)) err(i + 1, 'script tag is not allowed');
      if (/javascript:/i.test(l)) err(i + 1, 'javascript: URL is not allowed');
    });
  }

  // find header, skipping blanks, %% comments and a leading --- frontmatter block
  let i = 0;
  let seenContent = false;
  let headerIdx = -1;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('%%')) { i++; continue; }
    if (t === '---' && !seenContent) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '---') j++;
      if (j >= lines.length) {
        err(i + 1, 'frontmatter block is not closed with ---');
        return done();
      }
      i = j + 1;
      seenContent = true;
      continue;
    }
    headerIdx = i;
    break;
  }

  if (headerIdx < 0) {
    err(1, 'missing diagram type (no content)');
    return done();
  }

  const headerLine = lines[headerIdx].trim();
  const word = headerWord(headerLine);
  let type = '';
  let inlineBody = false;

  if (KNOWN_HEADERS.includes(word)) {
    type = word;
    let rest = headerLine.slice(word.length);
    if (type === 'flowchart' || type === 'graph') {
      const dm = /^\s+([^\s;]+)/.exec(rest);
      if (dm) {
        if (!DIRECTIONS.includes(dm[1])) warn(headerIdx + 1, `unexpected direction "${dm[1]}" (expected TB, TD, BT, RL or LR)`);
        rest = rest.slice(dm[0].length);
      }
      if (rest.replace(/^\s*;?/, '').trim() !== '') inlineBody = true;
    } else if (type === 'pie' || type === 'xychart-beta' || type === 'gitGraph') {
      // things like "pie showData" or "pie title X" are fine
      if (rest.trim() !== '' && /title/.test(rest)) inlineBody = true;
    }
  } else if (OTHER_HEADERS.includes(word)) {
    warn(headerIdx + 1, `diagram type "${word}" is only lightly checked`);
    type = word;
  } else {
    err(headerIdx + 1, `unknown diagram type "${word || headerLine.slice(0, 30)}"`);
    return done();
  }

  // body lines with their 1-based numbers
  const body = [];
  for (let k = headerIdx + 1; k < lines.length; k++) {
    const t = lines[k].trim();
    if (t === '' || t.startsWith('%%')) continue;
    body.push({ n: k + 1, raw: lines[k], t });
  }

  if (body.length === 0 && !inlineBody) warn(headerIdx + 1, 'diagram has no content after the header');

  const isFlow = type === 'flowchart' || type === 'graph';
  checkBalance(body, type, isFlow ? err : warn);

  if (isFlow) lintFlowchart(body, err, warn);
  if (type === 'sequenceDiagram') lintSequence(body, err, warn);

  return done();

  function done() {
    errors.sort((a, b) => a.line - b.line);
    warnings.sort((a, b) => a.line - b.line);
    return { ok: errors.length === 0, errors, warnings };
  }
}

// Bracket and quote balance. Tracks across lines so multi-line blocks like
// "class A {" ... "}" work. For non-flowchart types, free text after the first ':'
// on a line is skipped since it is usually a label or message.
function checkBalance(body, type, report) {
  const isFlow = type === 'flowchart' || type === 'graph';
  const stack = [];
  let reported = false;
  for (const { n, t } of body) {
    let s = t;
    if (!isFlow) {
      const c = s.indexOf(':');
      if (c >= 0) s = s.slice(0, c);
      // er cardinality markers like ||--o{ are not brackets
      if (type === 'erDiagram') s = s.replace(/[|}][o|](?:--|\.\.)[o|][|{]/g, '--');
    } else {
      s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
      // asymmetric shape A>text] opens with '>' right after an id char
      s = s.replace(/([A-Za-z0-9_])>/g, '$1[');
    }
    let inQuote = false;
    let quoteStart = 0;
    let inPipe = false;
    for (let p = 0; p < s.length; p++) {
      const ch = s[p];
      if (ch === '"') {
        inQuote = !inQuote;
        if (inQuote) quoteStart = p;
        continue;
      }
      if (inQuote) continue;
      if (isFlow && ch === '|') { inPipe = !inPipe; continue; }
      if (inPipe) continue;
      if (ch === '(' || ch === '[' || ch === '{') {
        stack.push({ ch, n });
      } else if (ch === ')' || ch === ']' || ch === '}') {
        const top = stack[stack.length - 1];
        if (!top) {
          report(n, `unmatched "${ch}"`);
          reported = true;
        } else if (top.ch !== PAIRS[ch]) {
          report(n, `"${ch}" does not match "${top.ch}" opened on line ${top.n}`);
          stack.pop();
          reported = true;
        } else {
          stack.pop();
        }
      }
    }
    if (inQuote) report(n, `unclosed double quote (column ${quoteStart + 1})`);
    // flowchart statements do not span lines, so leftovers are per line there
    if (isFlow && stack.length) {
      while (stack.length) {
        const o = stack.pop();
        report(o.n, `unclosed "${o.ch}"`);
      }
      reported = true;
    }
  }
  if (!reported) {
    for (const o of stack) report(o.n, `unclosed "${o.ch}"`);
  }
}

function stripQuotesAndLabels(t) {
  return t
    .replace(/"[^"]*"/g, '""')
    .replace(/\|[^|]*\|/g, '||')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/\([^)]*\)/g, '()')
    .replace(/\{[^}]*\}/g, '{}');
}

function lintFlowchart(body, err, warn) {
  const subgraphs = [];
  for (const { n, t } of body) {
    if (/^subgraph(\s|$)/.test(t)) {
      subgraphs.push(n);
      continue;
    }
    if (/^end\s*;?$/.test(t)) {
      if (!subgraphs.length) err(n, '"end" without a matching subgraph');
      else subgraphs.pop();
      continue;
    }
    const sk = stripQuotesAndLabels(t);
    if (/(?:^|[\s;&])end\s*(?:[[({>]|-->|---|-\.|==|~~~|$)/.test(sk) ||
        /(?:-->|---|==>|-\.->|\.->|~~~|&)\s*end\b/.test(sk)) {
      err(n, 'lowercase "end" cannot be a node id (use End or another id)');
    }
    const tags = t.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g) || [];
    for (const tag of tags) {
      if (/^<\/?br\s*\/?>$/i.test(tag) || /^<\/?script/i.test(tag)) continue;
      warn(n, `raw HTML tag ${tag.slice(0, 40)} in label`);
    }
  }
  for (const n of subgraphs) err(n, 'subgraph is not closed with "end"');
}

function lintSequence(body, err, warn) {
  const blocks = [];
  for (const { n, t } of body) {
    const w = headerWord(t);
    if (SEQ_OPENERS.includes(w)) {
      blocks.push({ w, n });
    } else if (w === 'end' && /^end\s*;?$/.test(t)) {
      if (!blocks.length) err(n, '"end" without a matching block');
      else blocks.pop();
    } else if (Object.prototype.hasOwnProperty.call(SEQ_MIDDLES, w)) {
      const top = blocks[blocks.length - 1];
      if (!top || !SEQ_MIDDLES[w].includes(top.w)) warn(n, `"${w}" outside of a ${SEQ_MIDDLES[w].join('/')} block`);
    }
  }
  for (const b of blocks) err(b.n, `"${b.w}" block is not closed with "end"`);
}

// Pull ```mermaid / ~~~mermaid fences out of markdown.
// line = 1-based line number of the first line inside the fence.
function extractMermaidBlocks(markdown) {
  const lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!m) { i++; continue; }
    const fence = m[1];
    const lang = m[2].toLowerCase();
    const start = i + 1;
    let j = start;
    const close = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
    while (j < lines.length && !close.test(lines[j])) j++;
    if (lang === 'mermaid') out.push({ text: lines.slice(start, j).join('\n'), line: start + 1 });
    i = j + 1;
  }
  return out;
}

module.exports = { lintMermaid, extractMermaidBlocks, KNOWN_HEADERS };
