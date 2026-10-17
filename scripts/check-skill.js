#!/usr/bin/env node
'use strict';

// Structural checks for the plugin: skills, commands, agents, plugin.json,
// and a repo-wide scan for long dashes. Usage: node scripts/check-skill.js [root]
// Exits 0 when everything passes, 1 otherwise.

const fs = require('node:fs');
const path = require('node:path');

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git']);
const TEXT_EXT = new Set([
  '.md', '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.mmd', '.canvas',
  '.txt', '.yml', '.yaml', '',
]);

function parseFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end === -1) return null;
  const lines = src.slice(4, end).split('\n');
  const fields = {};
  let current = null;
  for (const line of lines) {
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (m) {
      current = m[1];
      fields[current] = { value: m[2].trim(), continuation: [] };
    } else if (current && line.trim() !== '') {
      fields[current].continuation.push(line);
    }
  }
  return fields;
}

function unquote(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// An inline single-line scalar: has a value on the key line, is not a block
// scalar (| or >), and has no indented continuation lines.
function isInlineScalar(field) {
  if (!field) return false;
  const v = field.value;
  if (!v) return false;
  if (/^[|>][+-]?\d*$/.test(v)) return false;
  if (v.startsWith('[') || v.startsWith('{')) return false;
  if (field.continuation.length > 0) return false;
  return unquote(v).trim().length > 0;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function checkSkills(root, errors) {
  const skillsDir = path.join(root, 'skills');
  for (const ent of listDir(skillsDir)) {
    if (!ent.isDirectory()) continue;
    const file = path.join(skillsDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(file)) {
      errors.push(`${rel(root, file)}: missing SKILL.md`);
      continue;
    }
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!fm) {
      errors.push(`${rel(root, file)}: missing frontmatter`);
      continue;
    }
    const name = fm.name ? unquote(fm.name.value) : '';
    if (name !== ent.name) {
      errors.push(`${rel(root, file)}: frontmatter name "${name}" does not match directory "${ent.name}"`);
    }
    if (!isInlineScalar(fm.description)) {
      errors.push(`${rel(root, file)}: description must be an inline single-line value`);
    }
  }
}

function checkCommands(root, errors) {
  const dir = path.join(root, 'commands');
  for (const ent of listDir(dir)) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const file = path.join(dir, ent.name);
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!fm) {
      errors.push(`${rel(root, file)}: missing frontmatter`);
    } else if (!isInlineScalar(fm.description)) {
      errors.push(`${rel(root, file)}: missing or multi-line description`);
    }
  }
}

function checkAgents(root, errors) {
  const dir = path.join(root, 'agents');
  for (const ent of listDir(dir)) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const file = path.join(dir, ent.name);
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!fm) {
      errors.push(`${rel(root, file)}: missing frontmatter`);
      continue;
    }
    if (!isInlineScalar(fm.name)) errors.push(`${rel(root, file)}: missing name`);
    if (!isInlineScalar(fm.description)) errors.push(`${rel(root, file)}: missing or multi-line description`);
    if (!isInlineScalar(fm.tools)) {
      errors.push(`${rel(root, file)}: tools must be a comma-separated scalar, not a list`);
    }
  }
}

function checkPluginJson(root, errors) {
  const file = path.join(root, '.claude-plugin', 'plugin.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push(`.claude-plugin/plugin.json: cannot read or parse (${err.message})`);
    return;
  }
  if (typeof data.version !== 'string' || !data.version) {
    errors.push('.claude-plugin/plugin.json: version is required');
  }
  for (const key of ['skills', 'commands']) {
    if (!Array.isArray(data[key])) errors.push(`.claude-plugin/plugin.json: ${key} must be an array`);
  }
  for (const key of ['agents', 'hooks']) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      errors.push(`.claude-plugin/plugin.json: remove the "${key}" key (auto-discovered)`);
    }
  }
}

// En dash used as punctuation: whitespace on at least one side. Ranges like
// 1\u20135 (no spaces) are allowed.
function findDashes(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(EM_DASH)) hits.push({ line: i + 1, kind: 'em dash' });
    for (let j = line.indexOf(EN_DASH); j !== -1; j = line.indexOf(EN_DASH, j + 1)) {
      const before = j === 0 ? ' ' : line[j - 1];
      const after = j === line.length - 1 ? ' ' : line[j + 1];
      if (/\s/.test(before) || /\s/.test(after)) {
        hits.push({ line: i + 1, kind: 'en dash used as a dash' });
        break;
      }
    }
  });
  return hits;
}

function walk(dir, out) {
  for (const ent of listDir(dir)) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.isFile()) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

function checkDashes(root, errors) {
  for (const file of walk(root, [])) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      const buf = fs.readFileSync(file);
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    for (const hit of findDashes(text)) {
      errors.push(`${rel(root, file)}:${hit.line}: ${hit.kind}`);
    }
  }
}

function checkRepo(root) {
  const errors = [];
  checkPluginJson(root, errors);
  checkSkills(root, errors);
  checkCommands(root, errors);
  checkAgents(root, errors);
  checkDashes(root, errors);
  return { ok: errors.length === 0, errors };
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const result = checkRepo(root);
  if (result.ok) {
    process.stdout.write('check-skill: ok\n');
    return 0;
  }
  for (const e of result.errors) process.stderr.write(`check-skill: ${e}\n`);
  process.stderr.write(`check-skill: ${result.errors.length} problem(s)\n`);
  return 1;
}

module.exports = { checkRepo, parseFrontmatter, isInlineScalar, findDashes };

if (require.main === module) {
  process.exitCode = main();
}
