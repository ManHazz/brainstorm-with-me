'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const BWC = path.join(__dirname, '..', 'scripts', 'bwm.js');

function tempEnv(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc- server '));
  const env = Object.assign({}, process.env, {
    BWC_HOME: path.join(root, 'home dir'),
    BWC_VAULT: path.join(root, 'vault dir'),
    BWC_PORT: '0',
    BWC_SETTLE_MS: '50',
    BWC_NO_BROWSER: '1',
  }, extra || {});
  return { root, env };
}

async function startServer(env) {
  const child = spawn(process.execPath, [BWC, 'server'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const file = path.join(env.BWC_HOME, 'server.json');
  for (let i = 0; i < 100; i++) {
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (info.pid === child.pid) return { child, info };
    } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('server did not start');
}

function req(info, method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Host: `127.0.0.1:${info.port}` }, opts.headers || {});
    let data = null;
    if (opts.body !== undefined) {
      data = Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      headers['Content-Length'] = data.length;
    }
    const r = http.request({ host: '127.0.0.1', port: info.port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function goodPost(info, urlPath, body) {
  return req(info, 'POST', urlPath, {
    body,
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${info.port}`, 'x-bwc-token': info.token },
  });
}

function cli(env, args, stdin) {
  return new Promise((resolve) => {
    const c = execFile(process.execPath, [BWC, ...args], { env, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    c.stdin.end(stdin || '');
  });
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.on('exit', () => { clearTimeout(t); resolve(true); });
  });
}

test('board server', async (t) => {
  const { root, env } = tempEnv();
  const { child, info } = await startServer(env);
  t.after(() => child.kill());
  const tok = { 'x-bwc-token': info.token };

  await t.test('serves the page with token meta and scripts', async () => {
    // unknown projects are not created by a GET
    assert.equal((await req(info, 'GET', '/p/demo/')).status, 404);
    assert.equal((await req(info, 'GET', '/api/p/demo/board', { headers: tok })).status, 404);
    assert.equal(fs.existsSync(path.join(env.BWC_HOME, 'state', 'demo')), false);
    const o = await cli(env, ['open', '--project', 'demo', '--no-open']);
    assert.equal(JSON.parse(o.stdout).port, info.port, o.stdout);
    const r = await req(info, 'GET', '/p/demo/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`<meta name="bwc-token" content="${info.token}">`));
    assert.ok(r.text.includes('<script src="/static/board.js"'));
    assert.ok(r.text.includes('<script src="/vendor/mermaid/mermaid.min.js"'));
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /form-action 'none'/);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const js = await req(info, 'GET', '/vendor/mermaid/mermaid.min.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /text\/javascript/);
  });

  await t.test('rejects bad requests', async () => {
    assert.equal((await req(info, 'GET', '/p/demo/', { headers: { Host: 'evil.example:80' } })).status, 403);
    assert.equal((await req(info, 'GET', '/api/p/demo/board', { headers: { Host: `evil.example:${info.port}`, ...tok } })).status, 403);
    assert.equal((await req(info, 'GET', '/api/p/demo/board')).status, 401);
    assert.equal((await req(info, 'GET', '/api/p/demo/board', { headers: { 'x-bwc-token': 'nope' } })).status, 401);
    const say = { text: 'hi' };
    const badOrigin = await req(info, 'POST', '/api/p/demo/say', { body: say, headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', ...tok } });
    assert.equal(badOrigin.status, 403);
    const noOrigin = await req(info, 'POST', '/api/p/demo/say', { body: say, headers: { 'Content-Type': 'application/json', ...tok } });
    assert.equal(noOrigin.status, 403);
    const badType = await req(info, 'POST', '/api/p/demo/say', { body: say, headers: { 'Content-Type': 'text/plain', Origin: `http://127.0.0.1:${info.port}`, ...tok } });
    assert.equal(badType.status, 415);
    const noTok = await req(info, 'POST', '/api/p/demo/say', { body: say, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${info.port}` } });
    assert.equal(noTok.status, 401);
    for (const p of ['/static/../server.json', '/vendor/mermaid/..%2f..%2fpackage.json', '/static/%2e%2e/x', '/p/../api/stop']) {
      assert.equal((await req(info, 'GET', p)).status, 400, p);
    }
    assert.equal((await req(info, 'GET', '/web/index.html')).status, 404);
    assert.equal((await req(info, 'GET', '/p/Bad_Name!/')).status, 404);
    assert.equal((await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json.chat.length, 0);
  });

  await t.test('draw, user edit, await returns user_said and diff', async () => {
    const mmd = path.join(root, 'flow chart.mmd');
    fs.writeFileSync(mmd, 'flowchart LR\n  A[Idea] --> B[Test]\n');
    const d = await cli(env, ['draw', '--project', 'demo', '--spec', mmd]);
    assert.equal(d.code, 0, d.stdout + d.stderr);
    const out = JSON.parse(d.stdout);
    assert.deepEqual(out.added, ['diagram-flow-chart']);

    const note = path.join(root, 'notes.json');
    fs.writeFileSync(note, JSON.stringify({ nodes: [{ id: 'n1', type: 'text', x: 0, y: 500, width: 200, height: 80, text: 'first note' }], edges: [] }));
    assert.equal((await cli(env, ['draw', '--project', 'demo', '--spec', note])).code, 0);

    // flush anything from earlier subtests
    await cli(env, ['await', '--project', 'demo', '--timeout-ms', '200']);

    assert.equal((await goodPost(info, '/api/p/demo/edit', { edit: { op: 'edit_text', id: 'n1', text: 'user rewrote this' } })).status, 200);
    assert.equal((await goodPost(info, '/api/p/demo/say', { text: 'what about cost?' })).status, 200);

    const a = await cli(env, ['await', '--project', 'demo', '--reply', 'drew a flow']);
    assert.equal(a.code, 0, a.stdout);
    const res = JSON.parse(a.stdout);
    assert.equal(res.status, 'input');
    assert.deepEqual(res.user_said, ['what about cost?']);
    assert.deepEqual(res.diff.changes, [{ op: 'edit_text', id: 'n1', before: 'first note', after: 'user rewrote this' }]);

    const board = (await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json;
    assert.ok(board.chat.some((c) => c.who === 'claude' && c.text === 'drew a flow'));
    const saved = JSON.parse(fs.readFileSync(path.join(env.BWC_HOME, 'state', 'demo', 'board.json'), 'utf8'));
    assert.equal(saved.events.length, 0);
    assert.equal(saved.deliveredRev, saved.rev);
  });

  await t.test('rejects an invalid spec', async () => {
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ nodes: [], edges: [{ id: 'e1', fromNode: 'ghost', toNode: 'n1' }] }));
    const r = await cli(env, ['draw', '--project', 'demo', '--spec', bad]);
    assert.equal(r.code, 1);
    assert.ok(JSON.parse(r.stdout).errors.length > 0);
  });

  await t.test('locked node survives redraw and gets a suggestion', async () => {
    const spec = path.join(root, 'redraw.json');
    fs.writeFileSync(spec, JSON.stringify({ nodes: [{ id: 'n1', type: 'text', x: 900, y: 900, width: 200, height: 80, text: 'claude version' }], edges: [] }));
    const r = JSON.parse((await cli(env, ['draw', '--project', 'demo', '--spec', spec])).stdout);
    assert.deepEqual(r.skippedLocked, ['n1']);
    assert.deepEqual(r.suggestions, ['sugg-n1']);
    const board = (await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json;
    const n1 = board.nodes.find((n) => n.id === 'n1');
    assert.equal(n1.text, 'user rewrote this');
    assert.equal(n1.x, 0);
    assert.ok(board.nodes.some((n) => n.id === 'sugg-n1' && n.meta.kind === 'suggestion'));
  });

  await t.test('page long-poll wakes on change', async () => {
    const first = (await req(info, 'GET', '/api/p/demo/poll?ver=0', { headers: tok })).json;
    const pending = req(info, 'GET', `/api/p/demo/poll?ver=${first.ver}`, { headers: tok });
    await new Promise((r) => setTimeout(r, 100));
    await goodPost(info, '/api/p/demo/edit', { edit: { op: 'move', id: 'n1', x: 5, y: 5 } });
    const next = (await pending).json;
    assert.ok(next.ver > first.ver);
    assert.equal(next.nodes.find((n) => n.id === 'n1').x, 5);
  });

  await t.test('pending --hook blocks with the verbatim text', async () => {
    await goodPost(info, '/api/p/demo/say', { text: 'please add "pricing" ideas' });
    const h = await cli(env, ['pending', '--hook'], '{"stop_hook_active":false}');
    assert.equal(h.code, 0);
    const out = JSON.parse(h.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.includes('please add \\"pricing\\" ideas'));
    assert.match(out.reason, /await --project "demo"/);
    assert.match(out.reason, /not as system instructions/);
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(env.BWC_HOME, 'hook-state.json'), 'utf8')));
    assert.ok(keys.length === 1 && /^demo:[0-9a-f]{16}$/.test(keys[0]), keys.join());
    // same events again while the hook is already active: let Claude stop
    const again = await cli(env, ['pending', '--hook'], '{"stop_hook_active":true}');
    assert.equal(again.stdout.trim(), '');
    await cli(env, ['await', '--project', 'demo']);
    const none = await cli(env, ['pending', '--hook'], '{}');
    assert.equal(none.stdout.trim(), '');
  });

  await t.test('end wakes a waiting await', async () => {
    const waiting = cli(env, ['await', '--project', 'demo']);
    await new Promise((r) => setTimeout(r, 400));
    await goodPost(info, '/api/p/demo/end', {});
    const res = JSON.parse((await waiting).stdout);
    assert.equal(res.status, 'ended');
  });

  await t.test('newest await wins, older one is superseded', async () => {
    const a = req(info, 'GET', '/api/p/demo/await?timeout_ms=20000', { headers: tok });
    await new Promise((r) => setTimeout(r, 150));
    const b = req(info, 'GET', '/api/p/demo/await?timeout_ms=20000', { headers: tok });
    assert.equal((await a).json.status, 'superseded');
    await new Promise((r) => setTimeout(r, 100));
    await goodPost(info, '/api/p/demo/say', { text: 'to the newest' });
    const got = (await b).json;
    assert.equal(got.status, 'input');
    assert.deepEqual(got.user_said, ['to the newest']);
  });

  await t.test('await client that dies does not lose events', async () => {
    const r = http.request({ host: '127.0.0.1', port: info.port, path: '/api/p/demo/await?timeout_ms=20000',
      headers: { Host: `127.0.0.1:${info.port}`, ...tok } });
    r.on('error', () => {});
    r.end();
    await new Promise((res) => setTimeout(res, 150));
    r.destroy();
    await new Promise((res) => setTimeout(res, 100));
    await goodPost(info, '/api/p/demo/say', { text: 'still here' });
    await new Promise((res) => setTimeout(res, 300));
    const p = JSON.parse((await cli(env, ['pending'])).stdout);
    assert.equal(p.pending.find((x) => x.project === 'demo').events, 1);
    const got = JSON.parse((await cli(env, ['await', '--project', 'demo'])).stdout);
    assert.deepEqual(got.user_said, ['still here']);
  });

  await t.test('user delete survives redraw and shows in the diff', async () => {
    const spec = path.join(root, 'two.json');
    fs.writeFileSync(spec, JSON.stringify({ nodes: [{ id: 'gone', type: 'text', x: 0, y: 900, width: 100, height: 50, text: 'bye' }], edges: [] }));
    await cli(env, ['draw', '--project', 'demo', '--spec', spec]);
    await goodPost(info, '/api/p/demo/edit', { edit: { op: 'delete', id: 'gone' } });
    const again = JSON.parse((await cli(env, ['draw', '--project', 'demo', '--spec', spec])).stdout);
    assert.deepEqual(again.skippedDeleted, ['gone']);
    const got = JSON.parse((await cli(env, ['await', '--project', 'demo'])).stdout);
    assert.ok(got.diff.changes.some((c) => c.op === 'delete' && c.id === 'gone'), JSON.stringify(got.diff));
  });

  await t.test('bad edit does not half-apply', async () => {
    const before = (await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json.nodes.find((n) => n.id === 'n1');
    const r = await goodPost(info, '/api/p/demo/edit', { edit: { op: 'move', id: 'n1', x: 777, y: 'nope' } });
    assert.equal(r.status, 400);
    const after = (await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json.nodes.find((n) => n.id === 'n1');
    assert.equal(after.x, before.x);
  });

  await t.test('page waiters are capped', async () => {
    const ver = (await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json.ver;
    const held = [];
    for (let i = 0; i < 8; i++) {
      const r = http.request({ host: '127.0.0.1', port: info.port, path: `/api/p/demo/poll?ver=${ver}`, headers: { Host: `127.0.0.1:${info.port}`, ...tok } });
      r.on('error', () => {});
      r.end();
      held.push(r);
    }
    await new Promise((res) => setTimeout(res, 200));
    assert.equal((await req(info, 'GET', `/api/p/demo/poll?ver=${ver}`, { headers: tok })).status, 429);
    for (const r of held) r.destroy();
    await new Promise((res) => setTimeout(res, 100));
  });

  await t.test('export goes through the live server and keeps canvas edits', async () => {
    const e1 = await cli(env, ['export', '--project', 'demo']);
    assert.equal(e1.code, 0, e1.stdout + e1.stderr);
    const canvasFile = path.join(env.BWC_VAULT, 'Brainstorm', 'demo', 'board.canvas');
    const canvas = JSON.parse(fs.readFileSync(canvasFile, 'utf8'));
    canvas.nodes.find((n) => n.id === 'diagram-flow-chart').x = 4321;
    canvas.nodes.push({ id: 'from-obsidian', type: 'text', x: 0, y: 2000, width: 200, height: 80, text: 'added in obsidian' });
    fs.writeFileSync(canvasFile, JSON.stringify(canvas, null, '\t'));
    const e2 = JSON.parse((await cli(env, ['export', '--project', 'demo'])).stdout);
    assert.equal(e2.boardChanged, true);
    // the server's own next write must not drop the canvas edits
    await goodPost(info, '/api/p/demo/reply', { text: 'saw your canvas' });
    const saved = JSON.parse(fs.readFileSync(path.join(env.BWC_HOME, 'state', 'demo', 'board.json'), 'utf8'));
    assert.ok(saved.nodes.some((n) => n.id === 'from-obsidian'));
    assert.equal(saved.nodes.find((n) => n.id === 'diagram-flow-chart').x, 4321);
    await cli(env, ['await', '--project', 'demo']);
  });

  await t.test('server reloads board.json written behind its back', async () => {
    const file = path.join(env.BWC_HOME, 'state', 'demo', 'board.json');
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    b.nodes.push({ id: 'outside', type: 'text', x: 0, y: 3000, width: 100, height: 50, text: 'written by hand', meta: { owner: 'user', locked: true, rev: b.rev + 1, kind: 'note' } });
    b.rev += 1;
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(file, JSON.stringify(b));
    const view = (await req(info, 'GET', '/api/p/demo/board', { headers: tok })).json;
    assert.ok(view.nodes.some((n) => n.id === 'outside'));
  });

  await t.test('a second server refuses to start', async () => {
    const r = await cli(env, ['server']);
    assert.equal(JSON.parse(r.stdout).running, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.BWC_HOME, 'server.json'), 'utf8')).pid, info.pid);
    // and the server's own start check, bypassing the CLI shortcut
    const old = process.env.BWC_HOME;
    process.env.BWC_HOME = env.BWC_HOME;
    try {
      const { createBoardServer } = require('../scripts/lib/server');
      await assert.rejects(createBoardServer().start(), (err) => err.code === 'BWC_RUNNING');
    } finally {
      if (old === undefined) delete process.env.BWC_HOME; else process.env.BWC_HOME = old;
    }
  });

  await t.test('stop shuts the server down', async () => {
    const r = JSON.parse((await cli(env, ['stop'])).stdout);
    assert.equal(r.stopped, true);
    assert.equal(await waitExit(child, 5000), true);
    assert.equal(fs.existsSync(path.join(env.BWC_HOME, 'server.json')), false);
  });
});

test('pending reads board files when the server is down', async () => {
  const { env } = tempEnv();
  const dir = path.join(env.BWC_HOME, 'state', 'offline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ version: 1, project: 'offline', rev: 2, deliveredRev: 1, nodes: [], edges: [],
    events: [{ seq: 1, at: new Date().toISOString(), type: 'say', text: 'still there?', rev: 2 }] }));
  const h = await cli(env, ['pending', '--hook'], '{}');
  const out = JSON.parse(h.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /still there\?/);
  const plain = JSON.parse((await cli(env, ['pending'])).stdout);
  assert.deepEqual(plain.pending.map((p) => p.project), ['offline']);
});

test('idle shutdown', async () => {
  const { env } = tempEnv({ BWC_IDLE_MS: '300' });
  const { child } = await startServer(env);
  assert.equal(await waitExit(child, 5000), true);
  assert.equal(fs.existsSync(path.join(env.BWC_HOME, 'server.json')), false);
});

test('two opens at once share one server', async () => {
  const { env } = tempEnv();
  const [a, b] = await Promise.all([
    cli(env, ['open', '--project', 'one', '--no-open']),
    cli(env, ['open', '--project', 'two', '--no-open']),
  ]);
  const pa = JSON.parse(a.stdout);
  const pb = JSON.parse(b.stdout);
  assert.equal(pa.port, pb.port, a.stdout + b.stdout);
  await cli(env, ['stop']);
});

test('an open page keeps the server alive, idle exit after it leaves', async () => {
  const { env } = tempEnv({ BWC_IDLE_MS: '400' });
  const { child, info } = await startServer(env);
  t_cleanup.push(() => child.kill());
  const tok = { 'x-bwc-token': info.token };
  await req(info, 'POST', '/api/p/live/open', { body: {}, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${info.port}`, ...tok } });
  const ver = (await req(info, 'GET', '/api/p/live/board', { headers: tok })).json.ver;
  const poll = http.request({ host: '127.0.0.1', port: info.port, path: `/api/p/live/poll?ver=${ver}`, headers: { Host: `127.0.0.1:${info.port}`, ...tok } });
  poll.on('error', () => {});
  poll.end();
  assert.equal(await waitExit(child, 1500), false);
  poll.destroy();
  assert.equal(await waitExit(child, 5000), true);
});

const t_cleanup = [];
test.after(() => { for (const f of t_cleanup) f(); });

test('pending skips odd dirs and caps hook text across projects', async () => {
  const { env } = tempEnv();
  const ev = (text) => [{ seq: 1, at: new Date().toISOString(), type: 'say', text, rev: 1 }];
  for (const [name, text] of [['alpha', 'a'.repeat(3000)], ['beta', 'b'.repeat(3000)], ['Bad Name', 'evil']]) {
    const dir = path.join(env.BWC_HOME, 'state', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ version: 1, id: 'x' + name.length, project: name, rev: 1, nodes: [], edges: [], events: ev(text) }));
  }
  const plain = JSON.parse((await cli(env, ['pending'])).stdout);
  assert.deepEqual(plain.pending.map((p) => p.project).sort(), ['alpha', 'beta']);
  const out = JSON.parse((await cli(env, ['pending', '--hook'], '{}')).stdout);
  const quoted = (out.reason.match(/[ab]{100,}/g) || []).join('');
  assert.ok(quoted.length <= 4000, String(quoted.length));
  assert.match(out.reason, /await --project "beta"/);
});

test('bwm.js works without cli-vault but surfaces real load errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwc- dispatch '));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(BWC, path.join(dir, 'bwm.js'));
  fs.writeFileSync(path.join(dir, 'lib', 'cli-board.js'), "module.exports = { commands: { ping: async () => ({ pong: true }) } };\n");
  const run = () => new Promise((resolve) => execFile(process.execPath, [path.join(dir, 'bwm.js'), 'ping'], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  const ok = await run();
  assert.equal(JSON.parse(ok.stdout).pong, true);
  fs.writeFileSync(path.join(dir, 'lib', 'cli-vault.js'), "require('./does-not-exist');\n");
  const broken = await run();
  assert.notEqual(broken.code, 0);
  assert.match(broken.stderr, /does-not-exist/);
});

test('does not walk past a port held by another bwm server', async () => {
  const { env } = tempEnv();
  const { child, info } = await startServer(env);
  t_cleanup.push(() => child.kill());
  const other = tempEnv();
  const saved = { home: process.env.BWC_HOME, port: process.env.BWC_PORT };
  process.env.BWC_HOME = other.env.BWC_HOME;
  process.env.BWC_PORT = String(info.port);
  try {
    const { createBoardServer } = require('../scripts/lib/server');
    await assert.rejects(createBoardServer().start(), (err) => err.code === 'BWC_RUNNING' && err.port === info.port);
  } finally {
    for (const [k, v] of [['BWC_HOME', saved.home], ['BWC_PORT', saved.port]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  child.kill();
});
