'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkRepo, parseFrontmatter, isInlineScalar, findDashes } = require('../scripts/check-skill.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-skill.js');
const EM = '\u2014';
const EN = '\u2013';

function write(root, rel, content) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function goodRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  write(root, '.claude-plugin/plugin.json', JSON.stringify({
    name: 'x', version: '0.1.0', skills: ['./skills/'], commands: ['./commands/'],
  }));
  write(root, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: Use when testing.\n---\n# Demo\n');
  write(root, 'commands/go.md', '---\ndescription: Go somewhere.\nargument-hint: "[x]"\n---\n# Go\n');
  write(root, 'agents/helper.md', '---\nname: helper\ndescription: Helps.\ntools: Read, Grep\nmodel: sonnet\n---\nBody\n');
  return root;
}

test('good repo passes', () => {
  const r = checkRepo(goodRepo());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('skill name must match directory', () => {
  const root = goodRepo();
  write(root, 'skills/demo/SKILL.md', '---\nname: other\ndescription: Use when testing.\n---\n');
  const r = checkRepo(root);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /does not match directory/);
});

test('multi-line skill description fails', () => {
  const root = goodRepo();
  write(root, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: >\n  Folded text.\n---\n');
  assert.match(checkRepo(root).errors.join('\n'), /inline single-line/);
  write(root, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: first line\n  second line\n---\n');
  assert.match(checkRepo(root).errors.join('\n'), /inline single-line/);
});

test('command without description fails', () => {
  const root = goodRepo();
  write(root, 'commands/go.md', '---\nargument-hint: "[x]"\n---\n');
  assert.match(checkRepo(root).errors.join('\n'), /commands\/go\.md/);
});

test('agent tools as a list fails', () => {
  const root = goodRepo();
  write(root, 'agents/helper.md', '---\nname: helper\ndescription: Helps.\ntools: [Read, Grep]\n---\n');
  assert.match(checkRepo(root).errors.join('\n'), /tools must be/);
  write(root, 'agents/helper.md', '---\nname: helper\ndescription: Helps.\ntools:\n  - Read\n---\n');
  assert.match(checkRepo(root).errors.join('\n'), /tools must be/);
});

test('plugin.json rules', () => {
  const root = goodRepo();
  write(root, '.claude-plugin/plugin.json', JSON.stringify({
    name: 'x', skills: './skills/', commands: ['./commands/'], agents: ['./agents/'], hooks: './hooks/hooks.json',
  }));
  const msg = checkRepo(root).errors.join('\n');
  assert.match(msg, /version is required/);
  assert.match(msg, /skills must be an array/);
  assert.match(msg, /"agents"/);
  assert.match(msg, /"hooks"/);
});

test('em dash anywhere fails, vendor and node_modules are skipped', () => {
  const root = goodRepo();
  write(root, 'vendor/mermaid/mermaid.min.js', `a${EM}b`);
  write(root, 'node_modules/x/index.js', `a${EM}b`);
  assert.equal(checkRepo(root).ok, true);
  write(root, 'docs/notes.md', `line one\nsome text ${EM} more\n`);
  const r = checkRepo(root);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /docs\/notes\.md:2: em dash/);
});

test('en dash as a dash fails, en dash in a range passes', () => {
  assert.equal(findDashes(`pages 1${EN}5`).length, 0);
  assert.equal(findDashes(`this ${EN} that`).length, 1);
  assert.equal(findDashes(`this${EN} that`).length, 1);
});

test('parseFrontmatter handles CRLF and quotes', () => {
  const fm = parseFrontmatter('---\r\nname: "demo"\r\ndescription: x\r\n---\r\n');
  assert.equal(fm.name.value, '"demo"');
  assert.equal(isInlineScalar(fm.description), true);
  assert.equal(parseFrontmatter('no frontmatter'), null);
});

test('CLI exits 1 on failure and 0 on success', () => {
  const good = goodRepo();
  assert.equal(spawnSync(process.execPath, [SCRIPT, good]).status, 0);
  write(good, 'README.md', `bad ${EM} dash`);
  assert.equal(spawnSync(process.execPath, [SCRIPT, good]).status, 1);
});
