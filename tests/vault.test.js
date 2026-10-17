'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vault = require('../scripts/lib/vault');
const sw = require('../scripts/lib/safe-write');
const { commands } = require('../scripts/lib/cli-vault');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  process.env.BWC_HOME = path.join(root, 'home dir');
  process.env.BWC_VAULT = path.join(root, 'My Vault');
  const init = vault.initProject('Phone Agent', { objective: 'Find out if a phone can act as a body for an agent' });
  return init.dir;
}

const read = (d, rel) => fs.readFileSync(path.join(d, rel), 'utf8');
const edit = (d, rel, fn) => fs.writeFileSync(path.join(d, rel), fn(read(d, rel)));

test('initProject creates the folder tree and files', () => {
  const dir = setup();
  assert.equal(dir, path.join(process.env.BWC_VAULT, 'Brainstorm', 'phone-agent'));
  for (const rel of ['brief.md', 'decisions.md', 'open-questions.md', 'rejected-ideas.md', 'scratch/README.md']) {
    assert.ok(fs.existsSync(path.join(dir, rel)), rel);
  }
  for (const sub of ['critiques', 'sessions', 'scratch']) assert.ok(fs.statSync(path.join(dir, sub)).isDirectory());
  assert.match(read(dir, 'scratch/README.md'), /Experiments only/);
  const brief = read(dir, 'brief.md');
  assert.match(brief, /^---\nproject: phone-agent\ncreated: \d{4}-\d{2}-\d{2}\nupdated: .*\nstatus: exploring\n---/);
  for (const s of vault.SECTIONS) assert.match(brief, new RegExp(`## ${s}\\n`));
  assert.match(brief, /## Objective\n\nFind out if a phone/);
  assert.match(brief, /## Scope\n\n_not set yet_/);
  // idempotent
  assert.deepEqual(vault.initProject('Phone Agent').created, []);
});

test('updateBriefSection replaces one section and keeps user edits elsewhere', () => {
  const dir = setup();
  edit(dir, 'brief.md', (t) => t.replace('## Scope\n\n_not set yet_', '## Scope\n\nUser wrote the scope.'));
  const r = vault.updateBriefSection('phone-agent', 'non goals', 'No app store release.');
  assert.equal(r.section, 'Non-goals');
  assert.equal(r.status, 'merged');
  const b = vault.readBrief('phone-agent');
  assert.equal(b.sections.Scope, 'User wrote the scope.');
  assert.equal(b.sections['Non-goals'], 'No app store release.');
  assert.match(b.sections.Objective, /phone can act/);
  // plain update when nothing was touched
  assert.equal(vault.updateBriefSection('phone-agent', 'Success metric', 'Demo works').status, 'written');
});

test('updateBriefSection on a section the user also changed gives a conflict file', () => {
  const dir = setup();
  edit(dir, 'brief.md', (t) => t.replace(/## Objective\n\n[^\n]+/, '## Objective\n\nUser objective'));
  const r = vault.updateBriefSection('phone-agent', 'Objective', 'Claude objective');
  assert.equal(r.status, 'conflict');
  assert.match(read(dir, 'brief.md'), /User objective/);
  assert.match(fs.readFileSync(r.conflictPath, 'utf8'), /Claude objective/);
  assert.throws(() => vault.updateBriefSection('phone-agent', 'Bogus', 'x'), /unknown brief section/);
});

test('decisions append, link in brief, merge with user edited file', () => {
  const dir = setup();
  const d1 = vault.addDecision('phone-agent', 'Use the phone camera as the main sensor');
  assert.match(d1.id, /^bwc-[0-9a-f]{6}$/);
  assert.match(read(dir, 'decisions.md'), new RegExp(`- \\d{4}-\\d{2}-\\d{2}: Use the phone camera as the main sensor \\^${d1.id}\\n`));
  assert.match(vault.readBrief('phone-agent').sections['Decision log'], new RegExp(`^- \\[\\[decisions#\\^${d1.id}\\]\\] Use the phone camera`));
  edit(dir, 'decisions.md', (t) => t.replace('main sensor', 'main sensor (user note)') + '- a loose user line\n');
  const d2 = vault.addDecision('phone-agent', 'Prototype on Android first');
  assert.equal(d2.file.userEdited, true);
  const text = read(dir, 'decisions.md');
  assert.match(text, /main sensor \(user note\)/);
  assert.match(text, /a loose user line/);
  assert.match(text, /Prototype on Android first/);
  assert.equal(vault.listEntries('phone-agent', 'decisions').length, 3);
  const log = vault.readBrief('phone-agent').sections['Decision log'].split('\n');
  assert.equal(log.length, 2);
});

test('mergeLists: union by id, user version wins, user deletions respected', () => {
  const head = '# D\n\n';
  const base = head + '- a ^bwc-000001\n- b ^bwc-000002\n';
  const disk = head + '- a changed by user ^bwc-000001\n';
  const ours = head + '- a ours ^bwc-000001\n- b ^bwc-000002\n- c ^bwc-000003\n';
  const merged = vault.mergeLists(disk, ours, base);
  assert.equal(merged, head + '- a changed by user ^bwc-000001\n- c ^bwc-000003\n');
});

test('resolveQuestion flips status and adds the note, never deletes', () => {
  const dir = setup();
  const q = vault.addOpenQuestion('phone-agent', 'Which phone?');
  vault.addOpenQuestion('phone-agent', 'Battery life?');
  edit(dir, 'open-questions.md', (t) => t.replace('Which phone?', 'Which phone? (user: maybe Pixel)'));
  const r = vault.resolveQuestion('phone-agent', q.id, 'Pixel 8, already owned');
  assert.equal(r.status, 'merged');
  const text = read(dir, 'open-questions.md');
  assert.match(text, new RegExp(`- \\[x\\] Which phone\\? \\(user: maybe Pixel\\) \\(resolved \\d{4}-\\d{2}-\\d{2}: Pixel 8, already owned\\) \\^${q.id}`));
  assert.match(text, /- \[ \] Battery life\?/);
  assert.equal(vault.resolveQuestion('phone-agent', q.id, 'again').status, 'unchanged');
  assert.throws(() => vault.resolveQuestion('phone-agent', 'bwc-ffffff', ''), /no open question/);
});

test('rejected ideas carry a reason', () => {
  const dir = setup();
  vault.addRejected('phone-agent', 'Build a custom robot body', 'too expensive for a student');
  assert.match(read(dir, 'rejected-ideas.md'), /- \d{4}-\d{2}-\d{2}: Build a custom robot body\. reason: too expensive for a student \^bwc-[0-9a-f]{6}\n/);
  assert.throws(() => vault.addRejected('phone-agent', 'x', ''), /reason/);
});

test('critiques never overwrite', () => {
  const dir = setup();
  const a = vault.saveCritique('phone-agent', 'Phone as body', '# Critique\n\nfirst\n');
  const b = vault.saveCritique('phone-agent', 'Phone as body', '# Critique\n\nsecond\n');
  const c = vault.saveCritique('phone-agent', 'Phone as body', '# Critique\n\nthird\n');
  assert.match(a.file, /^\d{4}-\d{2}-\d{2}-phone-as-body\.md$/);
  assert.equal(b.file, a.file.replace('.md', '-2.md'));
  assert.equal(c.file, a.file.replace('.md', '-3.md'));
  assert.match(read(dir, `critiques/${a.file}`), /^---\nproject: phone-agent\ntype: critique[\s\S]*first/);
  assert.match(read(dir, `critiques/${b.file}`), /second/);
});

test('wrap and latestWrap pick the newest by name', () => {
  setup();
  assert.equal(vault.latestWrap('phone-agent'), null);
  vault.writeWrap('phone-agent', '# Wrap\n\nold\n', new Date(2026, 9, 16, 9, 5));
  vault.writeWrap('phone-agent', '# Wrap\n\nnew\n', new Date(2026, 9, 17, 14, 30));
  const again = vault.writeWrap('phone-agent', '# Wrap\n\nnewest\n', new Date(2026, 9, 17, 14, 30));
  assert.equal(again.file, '2026-10-17-1430-wrap-2.md');
  const w = vault.latestWrap('phone-agent');
  assert.equal(w.file, '2026-10-17-1430-wrap-2.md');
  assert.match(w.content, /newest/);
});

test('status counts everything', () => {
  setup();
  vault.addDecision('phone-agent', 'd1');
  const q = vault.addOpenQuestion('phone-agent', 'q1');
  vault.addOpenQuestion('phone-agent', 'q2');
  vault.resolveQuestion('phone-agent', q.id, 'done');
  vault.addRejected('phone-agent', 'r1', 'why');
  vault.saveCritique('phone-agent', 'idea', 'text');
  vault.writeWrap('phone-agent', 'wrap', new Date(2026, 9, 17, 10, 0));
  const s = vault.status('phone-agent');
  assert.deepEqual(
    { ...s, dir: undefined },
    {
      project: 'phone-agent', dir: undefined, briefStatus: 'exploring',
      unsetSections: ['Scope', 'Non-goals', 'Success metric', 'Kill criterion'],
      decisions: 1, openQuestions: 1, resolvedQuestions: 1, rejected: 1,
      critiques: 1, sessions: 1, latestWrap: '2026-10-17-1000-wrap.md',
    },
  );
});

test('exportBoard writes canvas + note, pulls in user canvas edits', () => {
  const dir = setup();
  const board = {
    version: 1, project: 'phone-agent', rev: 3, deliveredRev: 3, events: [],
    nodes: [
      { id: 'n1', type: 'text', x: 0.4, y: 0, width: 200, height: 80, text: 'Sticky', meta: { owner: 'claude', locked: false, rev: 1, kind: 'note' } },
      { id: 'd1', type: 'text', x: 300, y: 0, width: 300, height: 200, text: '```mermaid\nflowchart LR\n  A --> B\n```', meta: { owner: 'claude', locked: false, rev: 2, kind: 'diagram' } },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'd1', meta: { owner: 'claude', locked: false, rev: 2, kind: 'note' } }],
  };
  const r1 = vault.exportBoard('phone-agent', board);
  assert.equal(r1.canvas.status, 'written');
  assert.equal(r1.boardChanged, false);
  assert.equal(r1.note, null);
  assert.equal(fs.existsSync(path.join(dir, 'board-diagrams.md')), false, 'no mermaid note by default');
  const r1b = vault.exportBoard('phone-agent', board, { mermaid: true });
  assert.equal(r1b.canvas.status, 'unchanged');
  assert.equal(r1b.note.status, 'written');
  const canvasText = read(dir, 'board.canvas');
  assert.match(canvasText, /\n\t"nodes"/);
  assert.ok(!canvasText.includes('meta'));
  assert.match(read(dir, 'board-diagrams.md'), /```mermaid\nflowchart LR\n {2}A --> B\n```/);

  // user edits the sticky in Obsidian
  const c = JSON.parse(canvasText);
  c.nodes[0].text = 'Sticky edited in Obsidian';
  fs.writeFileSync(path.join(dir, 'board.canvas'), JSON.stringify(c, null, '\t'));
  const r2 = vault.exportBoard('phone-agent', board);
  assert.equal(r2.boardChanged, true);
  assert.equal(r2.canvas.status, 'merged');
  const n1 = r2.board.nodes.find((n) => n.id === 'n1');
  assert.equal(n1.text, 'Sticky edited in Obsidian');
  assert.equal(n1.meta.owner, 'user');
  assert.equal(n1.meta.locked, true);
  assert.equal(r2.board.rev, 4);
  assert.match(read(dir, 'board.canvas'), /Sticky edited in Obsidian/);
});

test('no vault configured: initProject uses the default folder under home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-fake home-'));
  process.env.BWC_HOME = path.join(root, 'home');
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.BWC_VAULT;
  assert.equal(os.homedir(), root);
  const r = vault.initProject('No Setup');
  assert.equal(r.dir, path.join(root, 'Documents', 'brainstorm-vault', 'Brainstorm', 'no-setup'));
  assert.ok(fs.existsSync(path.join(r.dir, 'brief.md')));
});

test('config --vault refuses a missing folder unless --create', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  process.env.BWC_HOME = path.join(root, 'home');
  delete process.env.BWC_VAULT;
  const target = path.join(root, 'new vault');
  await assert.rejects(commands.config(['--vault', target]), /does not exist.*--create/);
  assert.equal(fs.existsSync(target), false);
  const res = await commands.config(['--vault', target, '--create']);
  assert.equal(res.vaultPath, target);
  assert.ok(fs.statSync(target).isDirectory());
});

test('cli-vault commands: init, decide, pickup, wrap, export, config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-'));
  process.env.BWC_HOME = path.join(root, 'home');
  process.env.BWC_VAULT = path.join(root, 'vault with space');
  fs.mkdirSync(process.env.BWC_VAULT);
  await commands.init(['--project', 'Cli Test', '--objective', 'Test the cli']);
  await commands.decide({ project: 'cli-test', text: 'Go with node' });
  await commands.question(['--project', 'cli-test', '--text', 'Is it fast?']);
  const wrapFile = path.join(root, 'wrap draft.md');
  fs.writeFileSync(wrapFile, '# Wrap\n\nNext step: ship it\n');
  const w = await commands.wrap(['--project', 'cli-test', '--file', wrapFile]);
  assert.equal(w.status, 'written');
  const p = await commands.pickup(['--project', 'cli-test']);
  assert.match(p.brief, /Test the cli/);
  assert.match(p.latestWrap.content, /ship it/);
  assert.equal(p.openQuestions.length, 1);
  assert.equal(p.openQuestions[0].text, 'Is it fast?');
  assert.ok(p.unsetSections.includes('Scope'));
  assert.equal(p.status.decisions, 1);

  await assert.rejects(commands.export(['--project', 'cli-test']), /no board yet/);
  const stateDir = path.join(process.env.BWC_HOME, 'state', 'cli-test');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'board.json'), JSON.stringify({
    version: 1, project: 'cli-test', rev: 1, deliveredRev: 1, events: [],
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi', meta: { owner: 'claude', locked: false, rev: 1, kind: 'note' } }],
    edges: [],
  }));
  const e = await commands.export(['--project', 'cli-test']);
  assert.equal(e.note, null);
  const e2 = await commands.export(['--project', 'cli-test', '--mermaid']);
  assert.equal(e2.note.status, 'written');
  assert.equal(e2.canvas.status, 'unchanged');
  assert.equal(e.canvas.status, 'written');

  const cfg = await commands.config([]);
  assert.equal(cfg.vaultPath, process.env.BWC_VAULT);
  const all = await commands.status([]);
  assert.equal(all.projects.length, 1);
  assert.equal(sw.isUserEdited(path.join(process.env.BWC_VAULT, 'Brainstorm', 'cli-test'), 'brief.md'), false);
});

test('parallel decide and question calls keep every entry with unique ids', async () => {
  const dir = setup();
  const { spawn } = require('node:child_process');
  const lib = path.join(__dirname, '..', 'scripts', 'lib', 'vault.js');
  const run = (p) => new Promise((resolve, reject) => {
    const code = `const v = require(${JSON.stringify(lib)});
      for (let i = 0; i < 5; i++) {
        v.addDecision('phone-agent', 'decision p${p} n' + i);
        v.addOpenQuestion('phone-agent', 'question p${p} n' + i);
      }`;
    const child = spawn(process.execPath, ['-e', code], { stdio: 'inherit', env: process.env });
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child failed ${c}`))));
  });
  await Promise.all([0, 1, 2, 3, 4].map(run));
  const decisions = vault.listEntries('phone-agent', 'decisions');
  const questions = vault.listEntries('phone-agent', 'questions');
  assert.equal(decisions.length, 25);
  assert.equal(questions.length, 25);
  const ids = decisions.concat(questions).map((e) => e.id);
  assert.equal(new Set(ids).size, 50);
  assert.equal(vault.readBrief('phone-agent').sections['Decision log'].split('\n').length, 25);
  assert.equal(sw.isUserEdited(dir, 'decisions.md'), false);
  assert.equal(sw.isUserEdited(dir, 'brief.md'), false);
});

test('a project named like a Windows device works', () => {
  setup();
  const r = vault.initProject('CON');
  assert.equal(r.project, 'con-project');
  assert.ok(fs.existsSync(path.join(r.dir, 'brief.md')));
});
