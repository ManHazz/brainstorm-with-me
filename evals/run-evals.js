#!/usr/bin/env node
'use strict';

// Behavior evals for the brainstorm-with-me skill, in the spirit of skill-comply.
//
//   node evals/run-evals.js              dry run: validate scenarios, print the plan
//   node evals/run-evals.js --run        run each scenario k times with `claude -p`
//   node evals/run-evals.js --run --only thinking-aloud --k 1
//
// Grading is code based (regex and state checks on the transcript and vault),
// so results are reproducible for a given transcript. Reports pass@k (at least
// one of k runs passed) and pass^k (all k runs passed).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCENARIO_DIR = path.join(__dirname, 'scenarios');
const BWC = path.join(ROOT, 'scripts', 'bwc.js');

const CHECK_TYPES = new Set([
  'regex', 'not_regex', 'question_count', 'not_tool', 'no_write_outside',
  'board_text', 'vault_contains', 'any',
]);
const SETUP_ACTIONS = new Set(['bwc', 'write_temp', 'user_edit', 'append_vault']);
// Bash is limited to the plugin CLI and the validator. Patterns use Claude
// Code permission rule wildcards and match both the raw command
// (node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" ...) and the expanded path.
const ALLOWED_TOOLS = [
  'Bash(node *scripts/bwc.js*)',
  'Bash(node *scripts/validate.js*)',
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Agent',
];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function parseArgs(argv) {
  const opts = { run: false, only: null, k: null, model: null, maxTurns: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') opts.run = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--k') opts.k = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--max-turns') opts.maxTurns = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

// ---------- scenario validation ----------

function validateCheck(check, where, errors) {
  if (!check || !CHECK_TYPES.has(check.type)) {
    errors.push(`${where}: unknown check type ${check && check.type}`);
    return;
  }
  const needsPattern = ['regex', 'not_regex', 'not_tool'];
  if (needsPattern.includes(check.type)) {
    try {
      new RegExp(check.pattern, check.flags || '');
    } catch (err) {
      errors.push(`${where}: bad pattern (${err.message})`);
    }
  }
  if (check.ignore) {
    try { new RegExp(check.ignore, 'i'); } catch (err) { errors.push(`${where}: bad ignore (${err.message})`); }
  }
  if (check.type === 'no_write_outside') {
    try { new RegExp(check.allow); } catch (err) { errors.push(`${where}: bad allow (${err.message})`); }
  }
  if (check.type === 'question_count' && check.min === undefined && check.max === undefined) {
    errors.push(`${where}: question_count needs min or max`);
  }
  if (check.type === 'board_text' && (!check.project || !check.id)) {
    errors.push(`${where}: board_text needs project and id`);
  }
  if (check.type === 'vault_contains' && (!check.project || !check.file || !check.text)) {
    errors.push(`${where}: vault_contains needs project, file, and text`);
  }
  if (check.type === 'any') {
    if (!Array.isArray(check.checks) || check.checks.length === 0) {
      errors.push(`${where}: any needs a non-empty checks array`);
    } else {
      check.checks.forEach((c, i) => validateCheck(c, `${where}.checks[${i}]`, errors));
    }
  }
}

function validateScenario(s, file) {
  const errors = [];
  const where = path.basename(file || 'scenario');
  if (!s || typeof s !== 'object') return [`${where}: not an object`];
  for (const key of ['id', 'description', 'prompt']) {
    if (typeof s[key] !== 'string' || !s[key].trim()) errors.push(`${where}: missing ${key}`);
  }
  if (!Number.isInteger(s.k) || s.k < 1) errors.push(`${where}: k must be a positive integer`);
  if (!s.setup || typeof s.setup.notes !== 'string') errors.push(`${where}: setup.notes required`);
  const steps = (s.setup && s.setup.steps) || [];
  if (!Array.isArray(steps)) errors.push(`${where}: setup.steps must be an array`);
  else steps.forEach((st, i) => {
    if (!st || !SETUP_ACTIONS.has(st.action)) errors.push(`${where}: setup.steps[${i}] unknown action`);
  });
  if (!Array.isArray(s.pass) || s.pass.length === 0) errors.push(`${where}: pass must be a non-empty array`);
  else s.pass.forEach((c, i) => validateCheck(c, `${where}: pass[${i}]`, errors));
  return errors;
}

function loadScenarios() {
  const files = fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  const errors = [];
  for (const f of files) {
    const file = path.join(SCENARIO_DIR, f);
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${f}: invalid JSON (${err.message})`);
      continue;
    }
    const errs = validateScenario(s, file);
    if (errs.length) errors.push(...errs);
    else out.push(s);
  }
  return { scenarios: out, errors };
}

// ---------- transcript parsing ----------

// Parses `claude -p --output-format stream-json --verbose` output.
function parseStream(stdout) {
  const t = { finalText: '', texts: [], toolUses: [], toolResults: [] };
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    if (ev.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'text') t.texts.push(c.text);
        if (c.type === 'tool_use') t.toolUses.push({ name: c.name, input: c.input || {} });
      }
    } else if (ev.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const body = Array.isArray(c.content)
          ? c.content.map((x) => x.text || '').join('\n')
          : String(c.content || '');
        t.toolResults.push(body);
      }
    } else if (ev.type === 'result' && typeof ev.result === 'string') {
      t.finalText = ev.result;
    }
  }
  if (!t.finalText && t.texts.length) t.finalText = t.texts[t.texts.length - 1];
  t.all = [
    ...t.texts,
    ...t.toolUses.map((u) => `${u.name} ${JSON.stringify(u.input)}`),
    ...t.toolResults,
  ].join('\n');
  return t;
}

// ---------- grading ----------

function countQuestions(text, ignore) {
  const noCode = String(text).replace(/```[\s\S]*?```/g, '');
  const qs = noCode.match(/[^.!?\n]*\?/g) || [];
  const re = ignore ? new RegExp(ignore, 'i') : null;
  return qs.filter((q) => !(re && re.test(q))).length;
}

function readBoardText(ctx, project, id) {
  const file = path.join(ctx.env.BWC_HOME, 'state', project, 'board.json');
  try {
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    const node = (board.nodes || []).find((n) => n.id === id);
    return node ? node.text : undefined;
  } catch {
    return undefined;
  }
}

function vaultFile(ctx, project, file) {
  return path.join(ctx.env.BWC_VAULT, 'Brainstorm', project, file);
}

function runCheck(check, t, ctx) {
  const target = check.target === 'transcript' ? t.all : t.finalText;
  switch (check.type) {
    case 'regex':
      return new RegExp(check.pattern, check.flags || '').test(target);
    case 'not_regex':
      return !new RegExp(check.pattern, check.flags || '').test(target);
    case 'question_count': {
      const n = countQuestions(target, check.ignore);
      if (check.min !== undefined && n < check.min) return false;
      if (check.max !== undefined && n > check.max) return false;
      return true;
    }
    case 'not_tool': {
      const re = new RegExp(check.pattern, check.flags || '');
      return !t.toolUses.some((u) => u.name === check.tool && re.test(JSON.stringify(u.input)));
    }
    case 'no_write_outside': {
      const allow = new RegExp(check.allow);
      return t.toolUses
        .filter((u) => WRITE_TOOLS.has(u.name))
        .every((u) => allow.test(String(u.input.file_path || u.input.notebook_path || '')));
    }
    case 'board_text':
      if (!ctx) return false;
      return readBoardText(ctx, check.project, check.id) === check.equals;
    case 'vault_contains':
      if (!ctx) return false;
      try {
        return fs.readFileSync(vaultFile(ctx, check.project, check.file), 'utf8').includes(check.text);
      } catch {
        return false;
      }
    case 'any':
      return check.checks.some((c) => runCheck(c, t, ctx));
    default:
      return false;
  }
}

function grade(scenario, transcript, ctx) {
  const results = scenario.pass.map((c) => ({
    type: c.type,
    why: c.why || '',
    ok: Boolean(runCheck(c, transcript, ctx)),
  }));
  return { ok: results.every((r) => r.ok), results };
}

// ---------- running ----------

function runBwc(args, ctx) {
  const r = spawnSync(process.execPath, [BWC, ...args], { env: ctx.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`bwc ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function runSetup(scenario, ctx) {
  for (const step of scenario.setup.steps || []) {
    if (step.action === 'bwc') {
      runBwc(step.args.map((a) => a.split('{temp}').join(ctx.temp)), ctx);
    } else if (step.action === 'write_temp') {
      fs.writeFileSync(path.join(ctx.temp, step.name), step.content);
    } else if (step.action === 'append_vault') {
      fs.appendFileSync(vaultFile(ctx, step.project, step.file), step.content);
    } else if (step.action === 'user_edit') {
      // Simulate a user edit through the board model in a child process, so the
      // env (BWC_HOME) applies to config resolution.
      const code = [
        "const path=require('node:path');",
        `const m=require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'board-model.js'))});`,
        `const c=require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'config.js'))});`,
        `const f=path.join(c.stateDir(${JSON.stringify(step.project)}),'board.json');`,
        'const b=m.loadBoard(f);',
        `const r=m.applyUserEdit(b, Object.assign({op:'edit_text'}, ${JSON.stringify(step.edit)}));`,
        'm.saveBoard(f, r && r.nodes ? r : b);',
      ].join('');
      const r = spawnSync(process.execPath, ['-e', code], { env: ctx.env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`user_edit failed: ${r.stderr}`);
    }
  }
}

function quoteWin(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function runClaude(scenario, ctx, opts) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--plugin-dir', ROOT,
    '--max-turns', String(opts.maxTurns),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...ALLOWED_TOOLS,
  ];
  if (opts.model) args.push('--model', opts.model);
  const win = process.platform === 'win32';
  const r = spawnSync('claude', win ? args.map(quoteWin) : args, {
    input: scenario.prompt,
    cwd: ctx.temp,
    env: ctx.env,
    encoding: 'utf8',
    shell: win,
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r.stdout || '';
}

// Only what node and claude need to run and authenticate. Nothing else from
// the caller's environment reaches the eval session.
const ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'windir',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM',
  'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR',
];

function minimalEnv(source = process.env) {
  const env = {};
  for (const k of ENV_KEYS) {
    if (source[k] !== undefined && source[k] !== '') env[k] = source[k];
  }
  return env;
}

function freshContext() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc-eval-'));
  const ctx = {
    base,
    temp: path.join(base, 'work'),
    env: {
      ...minimalEnv(),
      BWC_HOME: path.join(base, 'home'),
      BWC_VAULT: path.join(base, 'vault'),
      BWC_NO_BROWSER: '1',
    },
  };
  for (const d of [ctx.temp, ctx.env.BWC_HOME, ctx.env.BWC_VAULT]) fs.mkdirSync(d, { recursive: true });
  return ctx;
}

function printPlan(scenarios, opts) {
  console.log('Dry run. Scenarios are valid. Nothing was sent to the API.\n');
  for (const s of scenarios) {
    const k = opts.k || s.k;
    console.log(`${s.id}  (k=${k})`);
    console.log(`  ${s.description}`);
    console.log(`  setup: ${s.setup.notes} [${(s.setup.steps || []).length} step(s)]`);
    for (const c of s.pass) console.log(`  check: ${c.type}${c.why ? ` - ${c.why}` : ''}`);
  }
  console.log('\nRun for real with: node evals/run-evals.js --run');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node evals/run-evals.js [--run] [--only id] [--k n] [--model m] [--max-turns n]');
    return 0;
  }
  const { scenarios, errors } = loadScenarios();
  if (errors.length) {
    for (const e of errors) console.error(`scenario error: ${e}`);
    return 1;
  }
  const selected = opts.only ? scenarios.filter((s) => s.id === opts.only) : scenarios;
  if (selected.length === 0) {
    console.error(`no scenario matches ${opts.only}`);
    return 1;
  }
  if (!opts.run) {
    printPlan(selected, opts);
    return 0;
  }

  const report = [];
  for (const s of selected) {
    const k = opts.k || s.k;
    let passes = 0;
    const runs = [];
    for (let i = 0; i < k; i++) {
      const ctx = freshContext();
      let g;
      try {
        runSetup(s, ctx);
        const t = parseStream(runClaude(s, ctx, opts));
        g = grade(s, t, ctx);
      } catch (err) {
        g = { ok: false, results: [{ type: 'error', why: err.message, ok: false }] };
      }
      if (g.ok) passes++;
      runs.push(g);
      console.error(`${s.id} run ${i + 1}/${k}: ${g.ok ? 'pass' : 'fail'}`);
    }
    report.push({ id: s.id, k, passes, passAtK: passes > 0, passHatK: passes === k, runs });
  }

  console.log('\nscenario                 passes  pass@k  pass^k');
  for (const r of report) {
    console.log(`${r.id.padEnd(24)} ${`${r.passes}/${r.k}`.padEnd(7)} ${String(r.passAtK).padEnd(7)} ${r.passHatK}`);
    for (const [i, run] of r.runs.entries()) {
      for (const c of run.results.filter((x) => !x.ok)) console.log(`  run ${i + 1} failed: ${c.type} ${c.why}`);
    }
  }
  return report.every((r) => r.passAtK) ? 0 : 1;
}

module.exports = { minimalEnv, ALLOWED_TOOLS, validateScenario, loadScenarios, parseStream, countQuestions, grade, runCheck };

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
