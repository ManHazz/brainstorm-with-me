'use strict';

// Vault commands for scripts/bwc.js. Each command takes parsed args and returns a
// JSON-able result. Args may be an object ({ project, text, ... }) or a raw argv array.

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const vault = require('./vault');
const sw = require('./safe-write');

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function norm(args) {
  const raw = Array.isArray(args) ? parseArgv(args) : Object.assign({}, args || {});
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

function need(a, key) {
  const v = a[key];
  if (v === undefined || v === true || String(v).trim() === '') throw new Error(`missing --${key}`);
  return String(v);
}

function project(a) {
  return config.slug(need(a, 'project'));
}

function readInput(a) {
  const file = path.resolve(need(a, 'file'));
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function loadBoardModel() {
  try {
    return require('./board-model');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /board-model/.test(err.message)) return null;
    throw err;
  }
}

const commands = {
  async init(args) {
    const a = norm(args);
    return vault.initProject(need(a, 'project'), { objective: a.objective === true ? undefined : a.objective });
  },

  async brief(args) {
    const a = norm(args);
    const p = project(a);
    if (a.status !== undefined) return vault.setBriefStatus(p, String(a.status));
    if (a.section !== undefined) {
      if (a.text === undefined) throw new Error('missing --text');
      return vault.updateBriefSection(p, String(a.section), a.text === true ? '' : String(a.text));
    }
    return vault.readBrief(p);
  },

  async decide(args) {
    const a = norm(args);
    return vault.addDecision(project(a), need(a, 'text'));
  },

  async question(args) {
    const a = norm(args);
    return vault.addOpenQuestion(project(a), need(a, 'text'));
  },

  async resolve(args) {
    const a = norm(args);
    return vault.resolveQuestion(project(a), need(a, 'id'), a.note === true ? '' : a.note);
  },

  async reject(args) {
    const a = norm(args);
    return vault.addRejected(project(a), need(a, 'text'), need(a, 'reason'));
  },

  async 'critique-save'(args) {
    const a = norm(args);
    return vault.saveCritique(project(a), need(a, 'idea'), readInput(a));
  },

  async wrap(args) {
    const a = norm(args);
    return vault.writeWrap(project(a), readInput(a));
  },

  async pickup(args) {
    const a = norm(args);
    const p = project(a);
    const brief = vault.readBrief(p);
    const st = vault.status(p);
    return {
      project: p,
      brief: brief.raw,
      latestWrap: vault.latestWrap(p),
      openQuestions: vault.listEntries(p, 'questions').filter((q) => !q.done),
      status: st,
      unsetSections: brief.unset,
    };
  },

  async export(args) {
    const a = norm(args);
    const p = project(a);
    const file = path.join(config.stateDir(p), 'board.json');
    if (!fs.existsSync(file)) throw new Error(`no board yet for project "${p}": open the board and draw something first`);
    // a live server owns the board in memory: export there so canvas edits are not lost
    const live = await require('./cli-board').exportViaServer(p, { mermaid: a.mermaid === true || a.mermaid === 'true' });
    if (live) return live;
    const model = loadBoardModel();
    const board = model && model.loadBoard ? model.loadBoard(file, p) : JSON.parse(fs.readFileSync(file, 'utf8'));
    const res = vault.exportBoard(p, board, { mermaid: a.mermaid === true || a.mermaid === 'true' });
    if (res.boardChanged) {
      if (model && model.saveBoard) model.saveBoard(file, res.board);
      else sw.atomicWrite(file, JSON.stringify(res.board, null, 2) + '\n');
    }
    return { project: p, boardChanged: res.boardChanged, rev: res.board.rev, canvas: res.canvas, note: res.note };
  },

  async status(args) {
    const a = norm(args);
    if (a.project && a.project !== true) return vault.status(project(a));
    const projects = vault.listProjects().map((p) => vault.status(p));
    return { projects };
  },

  async config(args) {
    const a = norm(args);
    const partial = {};
    if (a.vault !== undefined && a.vault !== true) partial.vaultPath = path.resolve(String(a.vault));
    if (a.folder !== undefined && a.folder !== true) partial.folder = String(a.folder);
    if (Object.keys(partial).length) {
      if (partial.vaultPath && !fs.existsSync(partial.vaultPath)) {
        if (a.create !== true && a.create !== 'true') {
          throw new Error(`vault folder does not exist: ${partial.vaultPath} (pass --create to make it)`);
        }
        fs.mkdirSync(partial.vaultPath, { recursive: true });
      }
      return Object.assign({ saved: true, file: config.configFile() }, config.saveConfig(partial));
    }
    return Object.assign({ file: config.configFile() }, config.loadConfig());
  },
};

module.exports = { commands, parseArgv };
