'use strict';

// Real mermaid.parse in Node, using the vendored browser bundle inside a vm context.
// Only parsing, never rendering, so a handful of DOM stubs is enough. Anything that
// goes wrong while loading or shimming is reported as "unavailable" so callers can
// fall back to the structural lint.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, '..', '..', 'vendor', 'mermaid', 'mermaid.min.js');
const LOAD_TIMEOUT_MS = 30000;
const PARSE_TIMEOUT_MS = 5000;

let cached = null; // { ok, mermaid?, ctx?, reason? }

function makeSandbox() {
  const noop = () => {};
  const el = () => ({
    style: {}, childNodes: [], children: [],
    setAttribute: noop, getAttribute: () => null, appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
  });
  const document = {
    nodeType: 9, // DOMPurify wants this to set up its hooks; it stays in pass-through mode
    readyState: 'complete',
    createElement: el, createElementNS: el, createTextNode: el,
    documentElement: el(), body: el(), head: el(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
  };
  const quiet = { log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop };
  const sb = {
    console: quiet, document,
    navigator: { userAgent: 'node' },
    location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost' },
    addEventListener: noop, removeEventListener: noop,
    Element: function Element() {},
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
    URL, TextEncoder, TextDecoder,
  };
  // no fetch, XMLHttpRequest or require in here: the bundle gets no network or fs
  sb.window = sb;
  sb.self = sb;
  sb.globalThis = sb;
  return sb;
}

// Path is resolved per call and the cache is keyed on path + mtime + size,
// so a re-vendored bundle gets picked up without restarting.
function loadDeep(opts) {
  const o = opts || {};
  const file = o.bundlePath || process.env.BWC_MERMAID_BUNDLE || BUNDLE;
  let key = file + '|missing';
  try {
    const st = fs.statSync(file);
    key = `${file}|${st.mtimeMs}|${st.size}`;
  } catch (e) { /* handled below */ }
  if (cached && cached.key === key) return cached;
  cached = loadFrom(file, o);
  cached.key = key;
  return cached;
}

function loadFrom(file, o) {
  try {
    if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} not found`);
    const code = fs.readFileSync(file, 'utf8');
    const ctx = vm.createContext(makeSandbox());
    vm.runInContext(code, ctx, { timeout: o.timeoutMs || LOAD_TIMEOUT_MS, filename: 'mermaid.min.js' });
    const mermaid = ctx.mermaid;
    if (!mermaid || typeof mermaid.parse !== 'function') throw new Error('bundle did not expose mermaid.parse');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return { ok: true, mermaid, ctx };
  } catch (e) {
    return { ok: false, reason: oneLine(e && e.message ? e.message : String(e)) };
  }
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Parser errors look like "Parse error on line 2:\n<context>\n----^\nExpecting 'A', 'B', got 'C'".
// Keep it short: what it got plus the first few expected tokens.
function cleanParseMessage(msg) {
  const text = String(msg);
  const m = /Expecting ((?:'[^']*'(?:, )?)+), got '([^']*)'/.exec(text);
  if (m) {
    const list = m[1].split(/,\s*/).filter(Boolean);
    const more = list.length > 5 ? ', ...' : '';
    return `unexpected '${m[2]}' (expected ${list.slice(0, 5).join(', ')}${more})`;
  }
  const first = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'parse failed';
  return first.replace(/^Parse error on line \d+:\s*/, '').replace(/\s+/g, ' ').slice(0, 300);
}

// mermaid drops frontmatter, %% lines and leading blank lines before parsing,
// so its line numbers count only what is left. Map back to the original text.
function mapLine(text, n) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  let i = 0;
  // directives like %%{init}%% may come before the frontmatter
  while (i < lines.length && (lines[i].trim() === '' || /^\s*%%/.test(lines[i]))) i++;
  if (i < lines.length && lines[i].trim() === '---') {
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j < lines.length) i = j + 1;
  }
  for (; i < lines.length; i++) {
    if (/^\s*%%/.test(lines[i])) continue;
    if (!kept.length && lines[i].trim() === '') continue;
    kept.push(i + 1);
  }
  if (!kept.length) return 1;
  return kept[Math.min(Math.max(n, 1), kept.length) - 1];
}

function isParseFailure(e) {
  const name = e && (e.name || (e.constructor && e.constructor.name));
  const msg = String(e && e.message);
  return name === 'MermaidParseError' || name === 'UnknownDiagramError' ||
    /Parse error|Lexical error|Parsing failed|No diagram type detected/i.test(msg);
}

// -> { status: 'ok' } | { status: 'error', line, message } | { status: 'unavailable', reason }
async function deepParse(text, opts) {
  const o = opts || {};
  const inst = loadDeep(o);
  if (!inst.ok) return { status: 'unavailable', reason: inst.reason };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'parse timed out' }), o.timeoutMs || PARSE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  const work = (async () => {
    try {
      await inst.mermaid.parse(String(text));
      return { status: 'ok' };
    } catch (e) {
      if (!isParseFailure(e)) return { status: 'unavailable', reason: oneLine(e && e.message ? e.message : String(e)) };
      const m = /line (\d+)/i.exec(String(e.message));
      return { status: 'error', line: mapLine(text, m ? Number(m[1]) : 1), message: cleanParseMessage(e.message) };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// test hook
function resetDeepCache() {
  cached = null;
}

module.exports = { loadDeep, deepParse, resetDeepCache, mapLine, BUNDLE };
