#!/usr/bin/env node
'use strict';

// Validate .canvas, .mmd/.mermaid and .md (mermaid fences) files.
// Usage: node scripts/validate.js <files...> [--json] [--deep]
// Exit 0 when no errors, 1 when any file has errors, 2 on usage error.

const fs = require('node:fs');
const path = require('node:path');
const { validateCanvas } = require('./lib/canvas-validate');
const { lintMermaid, extractMermaidBlocks } = require('./lib/mermaid-lint');
const { deepParse } = require('./lib/mermaid-deep');

const USAGE = 'usage: node scripts/validate.js <files...> [--json] [--deep]\n' +
  '  .canvas            JSON Canvas 1.0 checks\n' +
  '  .mmd, .mermaid     mermaid structural lint\n' +
  '  .md                lint each ```mermaid fence\n' +
  '  --deep             also run the real mermaid parser from vendor/mermaid\n';

function lineOfOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function jsonErrorLine(text, e) {
  const msg = String(e && e.message);
  let m = /line (\d+)/i.exec(msg);
  if (m) return Number(m[1]);
  m = /position (\d+)/i.exec(msg);
  if (m) return lineOfOffset(text, Number(m[1]));
  return 1;
}

// best effort: find the line where the node or edge with this id is declared
function lineForPath(text, obj, p) {
  const m = /^(nodes|edges)\[(\d+)\]/.exec(p || '');
  if (!m || !obj || !Array.isArray(obj[m[1]])) return 1;
  const item = obj[m[1]][Number(m[2])];
  if (!item || typeof item.id !== 'string') return 1;
  const esc = JSON.stringify(item.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // duplicates: pick the matching occurrence (nodes come before edges in the file)
  let nth = obj[m[1]].slice(0, Number(m[2])).filter((x) => x && x.id === item.id).length;
  if (m[1] === 'edges' && Array.isArray(obj.nodes)) nth += obj.nodes.filter((x) => x && x.id === item.id).length;
  const re = new RegExp('"id"\\s*:\\s*' + esc, 'g');
  let last = null;
  for (let k = 0; k <= nth; k++) {
    const r = re.exec(text);
    if (!r) break;
    last = r;
  }
  return last ? lineOfOffset(text, last.index) : 1;
}

function checkFile(file) {
  return inspectFile(file).result;
}

// sources: mermaid texts found in the file, kept for the optional deep parse.
// line = file line where the text starts; soft = report problems as warnings (canvas).
function inspectFile(file) {
  const result = { path: file, ok: true, errors: [], warnings: [] };
  const sources = [];
  const finish = () => {
    result.ok = result.errors.length === 0;
    return { result, sources };
  };
  const ext = path.extname(file).toLowerCase();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    result.errors.push({ line: 0, message: `cannot read file: ${e.code || e.message}` });
    return finish();
  }

  if (ext === '.canvas') {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      result.errors.push({ line: jsonErrorLine(text, e), message: `invalid JSON: ${e.message}` });
      return finish();
    }
    const r = validateCanvas(obj);
    const conv = (x) => ({ line: lineForPath(text, obj, x.path), at: x.path, message: x.message });
    result.errors = r.errors.map(conv);
    result.warnings = r.warnings.map(conv);
    if (obj && Array.isArray(obj.nodes)) {
      obj.nodes.forEach((n, i) => {
        if (!n || n.type !== 'text' || typeof n.text !== 'string') return;
        const at = `nodes[${i}].text`;
        const line = lineForPath(text, obj, at);
        for (const b of extractMermaidBlocks(n.text)) sources.push({ text: b.text, line, at, blockLine: b.line, soft: true });
      });
    }
  } else if (ext === '.mmd' || ext === '.mermaid') {
    const r = lintMermaid(text);
    result.errors = r.errors;
    result.warnings = r.warnings;
    sources.push({ text, line: 1 });
  } else if (ext === '.md' || ext === '.markdown') {
    for (const b of extractMermaidBlocks(text)) {
      const r = lintMermaid(b.text);
      const shift = (x) => ({ line: b.line + x.line - 1, message: x.message });
      result.errors.push(...r.errors.map(shift));
      result.warnings.push(...r.warnings.map(shift));
      sources.push({ text: b.text, line: b.line });
    }
  } else {
    result.errors.push({ line: 0, message: `unsupported file type "${ext || '(none)'}" (expected .canvas, .mmd, .mermaid or .md)` });
  }
  return finish();
}

// Adds real parser results. If the parser cannot run, one warning per file and
// the structural lint result stands.
async function deepCheck(result, sources) {
  for (const src of sources) {
    const r = await deepParse(src.text);
    if (r.status === 'unavailable') {
      result.warnings.push({ line: src.line, message: `deep parse unavailable: ${r.reason}, used structural lint` });
      break;
    }
    if (r.status !== 'error') continue;
    if (src.soft) {
      const where = src.blockLine + r.line - 1;
      result.warnings.push({ line: src.line, at: src.at, message: `mermaid line ${where}: parse error: ${r.message}` });
    } else {
      result.errors.push({ line: src.line + r.line - 1, message: `mermaid parse: ${r.message}` });
    }
  }
  result.ok = result.errors.length === 0;
}

function formatText(results) {
  const out = [];
  for (const r of results) {
    const items = r.errors.map((e) => ['error', e]).concat(r.warnings.map((w) => ['warning', w]));
    items.sort((a, b) => a[1].line - b[1].line);
    for (const [level, x] of items) {
      const at = x.at ? `${x.at}: ` : '';
      out.push(`${r.path}:${x.line}: ${level}: ${at}${x.message}`);
    }
  }
  const errCount = results.reduce((s, r) => s + r.errors.length, 0);
  const warnCount = results.reduce((s, r) => s + r.warnings.length, 0);
  out.push(`${results.length} file(s) checked, ${errCount} error(s), ${warnCount} warning(s)`);
  return out.join('\n') + '\n';
}

// Resolves to { code, stdout, stderr } so tests can call it without spawning.
async function run(argv) {
  const files = [];
  let json = false;
  let deep = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a === '--deep') deep = true;
    else if (a === '-h' || a === '--help') return { code: 0, stdout: USAGE, stderr: '' };
    else if (a.startsWith('--')) return { code: 2, stdout: '', stderr: `unknown option ${a}\n${USAGE}` };
    else files.push(a);
  }
  if (!files.length) return { code: 2, stdout: '', stderr: USAGE };

  const results = [];
  for (const f of files) {
    const { result, sources } = inspectFile(f);
    if (deep && sources.length) await deepCheck(result, sources);
    results.push(result);
  }
  const ok = results.every((r) => r.ok);
  const stdout = json ? JSON.stringify({ files: results, ok }, null, 2) + '\n' : formatText(results);
  return { code: ok ? 0 : 1, stdout, stderr: '' };
}

module.exports = { run, checkFile };

if (require.main === module) {
  run(process.argv.slice(2)).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exitCode = r.code;
  }, (e) => {
    process.stderr.write(`validate failed: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 2;
  });
}
