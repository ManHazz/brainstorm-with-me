'use strict';

// Config for brainstorm-with-me. Lives in BWC_HOME (or ~/.claude/brainstorm-with-me).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  vaultPath: null,
  folder: 'Brainstorm',
  exportMermaidNote: false,
  port: 4527,
  criticWeb: true,
});

function homeDir() {
  return process.env.BWC_HOME || path.join(os.homedir(), '.claude', 'brainstorm-with-me');
}

function configFile() {
  return path.join(homeDir(), 'config.json');
}

function readFileConfig() {
  const file = configFile();
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`config file is not valid JSON: ${file} (${err.message})`);
  }
}

// Used when neither BWC_VAULT nor config.vaultPath is set. Works without Obsidian:
// it is just a folder of markdown files.
function defaultVaultPath() {
  return path.join(os.homedir(), 'Documents', 'brainstorm-vault');
}

function loadConfig() {
  const cfg = Object.assign({}, DEFAULTS, readFileConfig());
  if (process.env.BWC_VAULT) cfg.vaultPath = process.env.BWC_VAULT;
  cfg.vaultIsDefault = !cfg.vaultPath;
  if (!cfg.vaultPath) cfg.vaultPath = defaultVaultPath();
  return cfg;
}

function saveConfig(partial) {
  const current = readFileConfig();
  const next = Object.assign({}, current);
  for (const [k, v] of Object.entries(partial || {})) {
    if (v === undefined) continue;
    next[k] = v;
  }
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return loadConfig();
}

function requireVault(cfg) {
  // Never throws for a missing folder: the vault (default or custom) is created on demand.
  const c = cfg || loadConfig();
  const vault = c.vaultPath || defaultVaultPath();
  fs.mkdirSync(vault, { recursive: true });
  return vault;
}

function slug(name) {
  const s = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (!s) throw new Error(`cannot make a slug from "${name}"`);
  // Windows refuses these as file or folder names, so never produce them.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(s)) return `${s}-project`;
  return s;
}

function projectDir(project) {
  const cfg = loadConfig();
  const vault = requireVault(cfg);
  return path.join(vault, cfg.folder || DEFAULTS.folder, slug(project));
}

function stateDir(project) {
  return path.join(homeDir(), 'state', slug(project));
}

module.exports = {
  DEFAULTS,
  homeDir,
  defaultVaultPath,
  configFile,
  loadConfig,
  saveConfig,
  requireVault,
  slug,
  projectDir,
  stateDir,
};
