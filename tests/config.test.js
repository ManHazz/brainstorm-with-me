'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../scripts/lib/config');

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-home with space-'));
  process.env.BWC_HOME = home;
  // fake home so the default vault never lands in the real Documents folder
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.BWC_VAULT;
  return home;
}

test('defaults when no config file', () => {
  fresh();
  const c = config.loadConfig();
  assert.equal(c.vaultPath, path.join(os.homedir(), 'Documents', 'brainstorm-vault'));
  assert.equal(c.vaultIsDefault, true);
  assert.equal(c.folder, 'Brainstorm');
  assert.equal(c.exportMermaidNote, false);
  assert.equal(c.port, 4527);
  assert.equal(c.criticWeb, true);
});

test('saveConfig merges and persists, BWC_VAULT overrides', () => {
  const home = fresh();
  config.saveConfig({ vaultPath: 'C:/some vault', port: 4600 });
  config.saveConfig({ folder: 'Ideas' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk, { vaultPath: 'C:/some vault', port: 4600, folder: 'Ideas' });
  assert.equal(config.loadConfig().vaultPath, 'C:/some vault');
  process.env.BWC_VAULT = path.join(home, 'other vault');
  assert.equal(config.loadConfig().vaultPath, path.join(home, 'other vault'));
  assert.equal(config.projectDir('My Project'), path.join(home, 'other vault', 'Ideas', 'my-project'));
  delete process.env.BWC_VAULT;
});

test('default vault is created on demand, no setup needed', () => {
  const home = fresh();
  assert.equal(os.homedir(), home);
  const def = path.join(home, 'Documents', 'brainstorm-vault');
  assert.equal(fs.existsSync(def), false);
  assert.equal(config.requireVault(), def);
  assert.ok(fs.statSync(def).isDirectory());
  assert.equal(config.projectDir('x'), path.join(def, 'Brainstorm', 'x'));
});

test('stateDir lives under BWC_HOME', () => {
  const home = fresh();
  assert.equal(config.stateDir('Phone Agent'), path.join(home, 'state', 'phone-agent'));
});

test('slug rules', () => {
  assert.equal(config.slug('Phone Embodied Agent!'), 'phone-embodied-agent');
  assert.equal(config.slug('  --a__b..c--  '), 'a-b-c');
  assert.equal(config.slug('../../etc/passwd'), 'etc-passwd');
  const long = config.slug('a'.repeat(59) + ' bcd');
  assert.ok(long.length <= 60);
  assert.ok(!long.endsWith('-'));
  assert.equal(config.slug('x'.repeat(100)).length, 60);
  assert.throws(() => config.slug('!!!'), /slug/);
  for (const r of ['CON', 'prn', 'Aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9', ' con ']) {
    assert.equal(config.slug(r), `${r.trim().toLowerCase()}-project`, r);
  }
  assert.equal(config.slug('console'), 'console');
  assert.equal(config.slug('com10'), 'com10');
  assert.equal(config.slug('con.txt'), 'con-txt');
  assert.throws(() => config.slug(''), /slug/);
});

test('broken config file gives a clear error', () => {
  const home = fresh();
  fs.writeFileSync(path.join(home, 'config.json'), '{nope');
  assert.throws(() => config.loadConfig(), /not valid JSON/);
});
