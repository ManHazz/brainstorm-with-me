'use strict';

// Obsidian vault memory for one brainstorm project:
// <vault>/<folder>/<project>/ brief.md, decisions.md, open-questions.md, rejected-ideas.md,
// board.canvas, board-diagrams.md, critiques/, sessions/, scratch/.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const sw = require('./safe-write');
const canvasExport = require('./canvas-export');

const PLACEHOLDER = '_not set yet_';
const SECTIONS = ['Objective', 'Scope', 'Non-goals', 'Success metric', 'Kill criterion', 'Decision log'];
const STATUSES = ['exploring', 'committed', 'parked', 'killed'];
const LISTS = {
  decisions: { file: 'decisions.md', title: 'Decisions', type: 'bwc-decisions' },
  questions: { file: 'open-questions.md', title: 'Open questions', type: 'bwc-open-questions' },
  rejected: { file: 'rejected-ideas.md', title: 'Rejected ideas', type: 'bwc-rejected-ideas' },
};
const BLOCK_ID = /\s\^bwc-([0-9a-f]{6})\s*$/;

// ---------- small helpers ----------

function pad(n) { return String(n).padStart(2, '0'); }
function today(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hhmm(d = new Date()) { return `${pad(d.getHours())}${pad(d.getMinutes())}`; }

function oneLine(text) {
  return String(text == null ? '' : text)
    .replace(/\s*\^bwc-[0-9a-f]{6}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normId(id) {
  const m = /([0-9a-f]{6})\s*$/.exec(String(id || '').trim().toLowerCase());
  if (!m) throw new Error(`bad entry id "${id}": expected something like bwc-a1b2c3`);
  return m[1];
}

function dirFor(project) {
  return config.projectDir(project);
}

function readText(file) {
  return fs.existsSync(file) ? sw.normalize(fs.readFileSync(file, 'utf8')) : null;
}

function requireProject(project) {
  const dir = dirFor(project);
  if (!fs.existsSync(path.join(dir, 'brief.md'))) {
    throw new Error(`project "${config.slug(project)}" not set up yet: run \`bwc init --project ${config.slug(project)}\``);
  }
  return dir;
}

// ---------- frontmatter (kept as raw lines so user YAML survives) ----------

function splitFrontmatter(text) {
  const t = sw.normalize(text);
  if (!t.startsWith('---\n')) return { fm: null, body: t };
  const end = t.indexOf('\n---', 3);
  if (end === -1) return { fm: null, body: t };
  const after = t.indexOf('\n', end + 1);
  const fm = t.slice(4, end).split('\n');
  const body = after === -1 ? '' : t.slice(after + 1);
  return { fm, body };
}

function fmGet(lines, key) {
  if (!lines) return undefined;
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1].trim();
  }
  return undefined;
}

function fmSet(lines, key, value) {
  const re = new RegExp(`^${key}:`);
  const i = lines.findIndex((l) => re.test(l));
  if (i === -1) lines.push(`${key}: ${value}`);
  else lines[i] = `${key}: ${value}`;
  return lines;
}

function fmKeys(lines) {
  return (lines || []).map((l) => /^([A-Za-z0-9_-]+):/.exec(l)).filter(Boolean).map((m) => m[1]);
}

function withFrontmatter(markdown, fields) {
  const t = sw.normalize(markdown);
  if (t.startsWith('---\n')) return t;
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n${t.replace(/^\n+/, '')}`;
}

// ---------- brief ----------

function parseBrief(text) {
  const { fm, body } = splitFrontmatter(text);
  const sections = [];
  const pre = [];
  let cur = null;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^## (.+?)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], lines: [] };
      sections.push(cur);
      continue;
    }
    (cur ? cur.lines : pre).push(line);
  }
  return {
    fm: fm || [],
    preamble: pre.join('\n').trim(),
    sections: sections.map((s) => ({ name: s.name, body: s.lines.join('\n').trim() })),
  };
}

function renderBrief(b) {
  let out = `---\n${b.fm.join('\n')}\n---\n\n`;
  if (b.preamble) out += `${b.preamble}\n\n`;
  for (const s of b.sections) out += `## ${s.name}\n\n${s.body || PLACEHOLDER}\n\n`;
  return out.replace(/\n+$/, '\n');
}

function sectionKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalSection(name, parsed) {
  const key = sectionKey(name);
  const found = (parsed ? parsed.sections.map((s) => s.name) : []).concat(SECTIONS)
    .find((s) => sectionKey(s) === key);
  if (!found) throw new Error(`unknown brief section "${name}": use one of ${SECTIONS.join(', ')}`);
  return found;
}

function isUnset(body) {
  const b = (body || '').trim();
  return !b || b === PLACEHOLDER;
}

function newBrief(project, title, objective) {
  const d = today();
  return renderBrief({
    fm: [`project: ${project}`, `created: ${d}`, `updated: ${d}`, 'status: exploring'],
    preamble: `# ${title}`,
    sections: SECTIONS.map((name) => ({ name, body: name === 'Objective' && objective ? String(objective).trim() : PLACEHOLDER })),
  });
}

// Section-wise 3-way merge. Returns null when the user and we both changed the same section.
function mergeBrief(disk, ours, base) {
  const D = parseBrief(disk);
  const O = parseBrief(ours);
  const B = base == null ? null : parseBrief(base);

  const fm = D.fm.slice();
  for (const k of fmKeys(O.fm)) {
    const o = fmGet(O.fm, k);
    const d = fmGet(D.fm, k);
    if (o === d) continue;
    const userChanged = B ? d !== fmGet(B.fm, k) : d !== undefined;
    if (k === 'updated' || !userChanged) fmSet(fm, k, o);
  }

  let preamble = D.preamble;
  if (B && D.preamble === B.preamble) preamble = O.preamble;

  const get = (doc, name) => {
    if (!doc) return undefined;
    const s = doc.sections.find((x) => x.name === name);
    return s ? s.body : undefined;
  };
  const names = D.sections.map((s) => s.name);
  for (const s of O.sections) if (!names.includes(s.name)) names.push(s.name);

  const sections = [];
  for (const name of names) {
    const d = get(D, name);
    const o = get(O, name);
    let pick;
    if (d === o) {
      pick = d;
    } else {
      const b = get(B, name);
      const userChanged = B ? d !== b : true;
      const oursChanged = B ? o !== b : true;
      if (userChanged && oursChanged) return null;
      pick = userChanged ? d : o;
    }
    if (pick !== undefined) sections.push({ name, body: pick });
  }
  return renderBrief({ fm, preamble, sections });
}

function readBrief(project) {
  const dir = requireProject(project);
  const file = path.join(dir, 'brief.md');
  const raw = readText(file);
  const parsed = parseBrief(raw);
  const sections = {};
  for (const s of parsed.sections) sections[s.name] = isUnset(s.body) ? '' : s.body;
  const frontmatter = {};
  for (const k of fmKeys(parsed.fm)) frontmatter[k] = fmGet(parsed.fm, k);
  return {
    path: file,
    raw,
    frontmatter,
    status: frontmatter.status || 'exploring',
    sections,
    unset: SECTIONS.filter((n) => isUnset(sections[n])),
  };
}

function editBriefUnlocked(project, edit) {
  const dir = requireProject(project);
  const parsed = parseBrief(readText(path.join(dir, 'brief.md')));
  edit(parsed);
  fmSet(parsed.fm, 'updated', today());
  return sw.safeWrite(dir, 'brief.md', renderBrief(parsed), { merge: mergeBrief });
}

function updateBriefSection(project, section, text) {
  let name;
  const res = editBrief(project, (parsed) => {
    name = canonicalSection(section, parsed);
    const body = String(text == null ? '' : text).trim() || PLACEHOLDER;
    const s = parsed.sections.find((x) => x.name === name);
    if (s) s.body = body;
    else parsed.sections.push({ name, body });
  });
  return Object.assign({ section: name }, res);
}

function setBriefStatus(project, status) {
  if (!STATUSES.includes(status)) throw new Error(`bad status "${status}": use one of ${STATUSES.join(', ')}`);
  return editBrief(project, (parsed) => fmSet(parsed.fm, 'status', status));
}

// ---------- list files ----------

function parseList(text) {
  const { fm, body } = splitFrontmatter(text);
  const items = [];
  if (fm) items.push({ kind: 'line', text: `---\n${fm.join('\n')}\n---` });
  let cur = null;
  for (const line of body.split('\n')) {
    if (/^- /.test(line)) {
      cur = { kind: 'entry', lines: [line] };
      items.push(cur);
    } else if (cur && /^\s+\S/.test(line)) {
      cur.lines.push(line);
    } else {
      cur = null;
      items.push({ kind: 'line', text: line });
    }
  }
  for (const it of items) {
    if (it.kind !== 'entry') continue;
    it.text = it.lines.join('\n');
    delete it.lines;
    const m = BLOCK_ID.exec(it.text);
    it.id = m ? m[1] : null;
  }
  return items;
}

function renderList(items) {
  return items.map((i) => i.text).join('\n').replace(/\n*$/, '\n');
}

function entriesById(items) {
  const map = new Map();
  for (const i of items) if (i.kind === 'entry' && i.id) map.set(i.id, i.text);
  return map;
}

// Union by block id. The user's version wins for any entry they changed, unless the id
// is in opts.preferOurs (an entry we deliberately changed, like resolving a question).
function mergeLists(disk, ours, base, opts = {}) {
  const D = parseList(disk);
  const O = entriesById(parseList(ours));
  const B = base == null ? null : entriesById(parseList(base));
  const prefer = new Set(opts.preferOurs || []);

  const out = D.map((item) => {
    if (item.kind !== 'entry' || !item.id || !O.has(item.id)) return item;
    const o = O.get(item.id);
    if (o === item.text) return item;
    if (prefer.has(item.id)) return Object.assign({}, item, { text: o });
    const userChanged = !B || !B.has(item.id) || B.get(item.id) !== item.text;
    return userChanged ? item : Object.assign({}, item, { text: o });
  });

  const present = new Set(D.filter((i) => i.kind === 'entry').map((i) => i.id));
  const extra = [];
  for (const [id, text] of O) {
    if (present.has(id)) continue;
    if (B && B.has(id) && B.get(id) === text && !prefer.has(id)) continue; // user deleted it
    extra.push({ kind: 'entry', id, text });
  }
  if (extra.length) {
    let at = -1;
    out.forEach((i, idx) => { if (i.kind === 'entry') at = idx; });
    if (at === -1) {
      while (out.length && out[out.length - 1].kind === 'line' && !out[out.length - 1].text.trim()) out.pop();
      out.push({ kind: 'line', text: '' });
      out.push(...extra);
    } else {
      out.splice(at + 1, 0, ...extra);
    }
  }
  return renderList(out);
}

function newList(kind, project) {
  const l = LISTS[kind];
  return `---\nproject: ${project}\ntype: ${l.type}\n---\n\n# ${l.title}\n\n`;
}

function newId(dir) {
  const taken = new Set();
  for (const l of Object.values(LISTS)) {
    const t = readText(path.join(dir, l.file));
    if (t) for (const m of t.matchAll(/\^bwc-([0-9a-f]{6})/g)) taken.add(m[1]);
  }
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (taken.has(id));
  return id;
}

function ensureList(dir, project, kind) {
  const file = path.join(dir, LISTS[kind].file);
  if (!fs.existsSync(file)) sw.safeWrite(dir, LISTS[kind].file, newList(kind, project));
}

function addEntryUnlocked(project, kind, line) {
  const dir = requireProject(project);
  ensureList(dir, config.slug(project), kind);
  const id = newId(dir);
  const entry = `${line} ^bwc-${id}`;
  const res = sw.appendEntry(dir, LISTS[kind].file, entry);
  return { id: `bwc-${id}`, entry, file: res };
}

function addDecision(project, text) {
  const t = oneLine(text);
  if (!t) throw new Error('decision text is empty');
  const out = addEntry(project, 'decisions', `- ${today()}: ${t}`);
  const summary = t.length > 100 ? t.slice(0, 97) + '...' : t;
  const link = `- [[decisions#^${out.id}]] ${summary}`;
  if (out.file.status === 'refused') return out;
  out.brief = editBrief(project, (parsed) => {
    let s = parsed.sections.find((x) => x.name === 'Decision log');
    if (!s) { s = { name: 'Decision log', body: '' }; parsed.sections.push(s); }
    s.body = isUnset(s.body) ? link : `${s.body}\n${link}`;
  });
  return out;
}

function addOpenQuestion(project, text) {
  const t = oneLine(text);
  if (!t) throw new Error('question text is empty');
  return addEntry(project, 'questions', `- [ ] ${t}`);
}

function addRejected(project, text, reason) {
  const t = oneLine(text);
  const r = oneLine(reason);
  if (!t) throw new Error('rejected idea text is empty');
  if (!r) throw new Error('a reason is required for a rejected idea');
  const sep = /[.!?]$/.test(t) ? '' : '.';
  return addEntry(project, 'rejected', `- ${today()}: ${t}${sep} reason: ${r}`);
}

function resolveQuestionUnlocked(project, id, note) {
  const dir = requireProject(project);
  const hex = normId(id);
  const rel = LISTS.questions.file;
  const items = parseList(readText(path.join(dir, rel)) || '');
  const item = items.find((i) => i.kind === 'entry' && i.id === hex);
  if (!item) throw new Error(`no open question with id bwc-${hex}`);
  if (/^- \[[xX]\]/.test(item.text)) {
    return { id: `bwc-${hex}`, status: 'unchanged', already: true, path: path.join(dir, rel) };
  }
  const n = oneLine(note);
  const tag = n ? `(resolved ${today()}: ${n})` : `(resolved ${today()})`;
  item.text = item.text
    .replace(/^- \[ \]/, '- [x]')
    .replace(BLOCK_ID, ` ${tag} ^bwc-${hex}`);
  if (!/^- \[x\]/.test(item.text)) item.text = item.text.replace(/^- /, '- [x] ');
  const res = sw.safeWrite(dir, rel, renderList(items), {
    merge: (d, o, b) => mergeLists(d, o, b, { preferOurs: [hex] }),
  });
  return Object.assign({ id: `bwc-${hex}` }, res);
}

function listEntries(project, kind) {
  const dir = dirFor(project);
  const text = readText(path.join(dir, LISTS[kind].file));
  if (!text) return [];
  return parseList(text).filter((i) => i.kind === 'entry').map((i) => {
    const e = { id: i.id ? `bwc-${i.id}` : null, text: i.text.replace(BLOCK_ID, '').replace(/^- /, '').trim() };
    if (kind === 'questions') {
      const m = /^\[([ xX])\]\s*/.exec(e.text);
      e.done = !!m && m[1] !== ' ';
      if (m) e.text = e.text.slice(m[0].length);
    }
    return e;
  });
}

// ---------- critiques and wraps ----------

function uniqueName(dir, stem, ext) {
  let name = `${stem}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${stem}-${n++}${ext}`;
  return name;
}

function saveCritiqueUnlocked(project, idea, markdown) {
  const dir = requireProject(project);
  const sub = path.join(dir, 'critiques');
  fs.mkdirSync(sub, { recursive: true });
  const d = today();
  const name = uniqueName(sub, `${d}-${config.slug(idea)}`, '.md');
  const content = withFrontmatter(markdown, { project: config.slug(project), type: 'critique', idea: oneLine(idea), date: d });
  const res = sw.safeWrite(dir, `critiques/${name}`, content);
  return Object.assign({ file: name }, res);
}

function writeWrapUnlocked(project, markdown, now = new Date()) {
  const dir = requireProject(project);
  const sub = path.join(dir, 'sessions');
  fs.mkdirSync(sub, { recursive: true });
  const name = uniqueName(sub, `${today(now)}-${hhmm(now)}-wrap`, '.md');
  const content = withFrontmatter(markdown, { project: config.slug(project), type: 'wrap', date: today(now) });
  const res = sw.safeWrite(dir, `sessions/${name}`, content);
  return Object.assign({ file: name }, res);
}

function wrapSortKey(name) {
  const m = /^(\d{4}-\d{2}-\d{2}-\d{4})-wrap(?:-(\d+))?\.md$/.exec(name);
  return m ? `${m[1]}#${String(m[2] || 1).padStart(6, '0')}` : null;
}

function wrapFiles(dir) {
  const sub = path.join(dir, 'sessions');
  if (!fs.existsSync(sub)) return [];
  return fs.readdirSync(sub)
    .filter((n) => wrapSortKey(n))
    .sort((a, b) => (wrapSortKey(a) < wrapSortKey(b) ? -1 : 1));
}

function latestWrap(project) {
  const dir = dirFor(project);
  const files = wrapFiles(dir);
  if (!files.length) return null;
  const file = files[files.length - 1];
  const full = path.join(dir, 'sessions', file);
  return { file, path: full, content: readText(full) };
}

// ---------- board export ----------

function exportBoardUnlocked(project, board, opts = {}) {
  const dir = dirFor(project);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = config.loadConfig();
  let next = board;
  let canvasMerge = null;

  if (sw.isUserEdited(dir, 'board.canvas')) {
    let edited = null;
    try { edited = JSON.parse(readText(path.join(dir, 'board.canvas'))); } catch (_) { edited = null; }
    if (edited && typeof edited === 'object') {
      let baseCanvas = null;
      try { baseCanvas = JSON.parse(sw.readBase(dir, 'board.canvas')); } catch (_) { baseCanvas = null; }
      next = canvasExport.fromCanvas(edited, board, { baseCanvas });
      canvasMerge = (d, o) => o; // their edits are now in the board, so ours includes them
    }
  }

  const canvasText = JSON.stringify(canvasExport.toCanvas(next), null, '\t') + '\n';
  const canvas = sw.safeWrite(dir, 'board.canvas', canvasText, { merge: canvasMerge || (() => null) });
  let note = null;
  if (opts.mermaid || cfg.exportMermaidNote) {
    note = sw.safeWrite(dir, 'board-diagrams.md', canvasExport.toMermaidNote(next), { merge: () => null });
  }
  return { board: next, boardChanged: next !== board && next.rev !== board.rev, canvas, note };
}

// ---------- project setup and status ----------

function scratchReadme(project) {
  return [
    '---',
    `project: ${project}`,
    'type: scratch',
    '---',
    '',
    '# Scratch',
    '',
    'Experiments only. Throwaway code and quick tests from brainstorm sessions go here.',
    'Nothing in this folder is production code.',
    '',
  ].join('\n');
}

function initProjectUnlocked(project, opts = {}) {
  const name = config.slug(project);
  const dir = dirFor(name);
  const created = [];
  for (const sub of ['critiques', 'sessions', 'scratch']) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); created.push(`${sub}/`); }
  }
  const files = [
    ['brief.md', () => newBrief(name, String(project).trim(), opts.objective)],
    [LISTS.decisions.file, () => newList('decisions', name)],
    [LISTS.questions.file, () => newList('questions', name)],
    [LISTS.rejected.file, () => newList('rejected', name)],
    ['scratch/README.md', () => scratchReadme(name)],
  ];
  let briefExisted = true;
  for (const [rel, make] of files) {
    if (fs.existsSync(path.join(dir, ...rel.split('/')))) continue;
    if (rel === 'brief.md') briefExisted = false;
    sw.safeWrite(dir, rel, make());
    created.push(rel);
  }
  let objective = !briefExisted && opts.objective ? String(opts.objective).trim() : null;
  if (briefExisted && opts.objective && readBrief(name).unset.includes('Objective')) {
    objective = updateBriefSection(name, 'Objective', opts.objective);
  }
  return { project: name, dir, created, objective };
}


// ---------- locked entry points (one project lock around each read-modify-write) ----------

function editBrief(project, edit) {
  requireProject(project);
  return sw.withLock(dirFor(project), () => editBriefUnlocked(project, edit));
}

function addEntry(project, kind, line) {
  requireProject(project);
  return sw.withLock(dirFor(project), () => addEntryUnlocked(project, kind, line));
}

function resolveQuestion(project, id, note) {
  requireProject(project);
  return sw.withLock(dirFor(project), () => resolveQuestionUnlocked(project, id, note));
}

function saveCritique(project, idea, markdown) {
  requireProject(project);
  return sw.withLock(dirFor(project), () => saveCritiqueUnlocked(project, idea, markdown));
}

function writeWrap(project, markdown, now = new Date()) {
  requireProject(project);
  return sw.withLock(dirFor(project), () => writeWrapUnlocked(project, markdown, now));
}

function initProject(project, opts = {}) {
  return sw.withLock(dirFor(project), () => initProjectUnlocked(project, opts));
}

function exportBoard(project, board, opts = {}) {
  return sw.withLock(dirFor(project), () => exportBoardUnlocked(project, board, opts));
}

function status(project) {
  const dir = requireProject(project);
  const brief = readBrief(project);
  const questions = listEntries(project, 'questions');
  const countMd = (sub) => {
    const p = path.join(dir, sub);
    return fs.existsSync(p) ? fs.readdirSync(p).filter((n) => n.endsWith('.md')).length : 0;
  };
  const wraps = wrapFiles(dir);
  return {
    project: config.slug(project),
    dir,
    briefStatus: brief.status,
    unsetSections: brief.unset,
    decisions: listEntries(project, 'decisions').length,
    openQuestions: questions.filter((q) => !q.done).length,
    resolvedQuestions: questions.filter((q) => q.done).length,
    rejected: listEntries(project, 'rejected').length,
    critiques: countMd('critiques'),
    sessions: wraps.length,
    latestWrap: wraps.length ? wraps[wraps.length - 1] : null,
  };
}

function listProjects() {
  const cfg = config.loadConfig();
  const root = path.join(config.requireVault(cfg), cfg.folder || 'Brainstorm');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'brief.md')))
    .map((d) => d.name)
    .sort();
}

module.exports = {
  PLACEHOLDER,
  SECTIONS,
  STATUSES,
  initProject,
  readBrief,
  updateBriefSection,
  setBriefStatus,
  addDecision,
  addOpenQuestion,
  resolveQuestion,
  addRejected,
  listEntries,
  saveCritique,
  writeWrap,
  latestWrap,
  exportBoard,
  status,
  listProjects,
  // exposed for tests and other modules
  parseBrief,
  renderBrief,
  mergeBrief,
  parseList,
  mergeLists,
};
