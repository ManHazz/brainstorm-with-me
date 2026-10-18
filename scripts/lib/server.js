'use strict';
// Local board server. One process serves every project under /p/<project>/.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const model = require('./board-model');
const { mergeDraw, validateDraw } = require('./merge');
const { semanticDiff } = require('./diff');

const APP = 'brainstorm-with-me';
const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const STATIC = {
  '/static/board.js': [path.join(WEB, 'board.js'), 'text/javascript; charset=utf-8'],
  '/static/board.css': [path.join(WEB, 'board.css'), 'text/css; charset=utf-8'],
  '/vendor/mermaid/mermaid.min.js': [path.join(ROOT, 'vendor', 'mermaid', 'mermaid.min.js'), 'text/javascript; charset=utf-8'],
};
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 2 * 1024 * 1024;
const POLL_MS = 25000;
const MAX_PAGE_WAITERS = 8;
const MAX_PROJECTS = 50;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function home() {
  return config.homeDir();
}

function serverFile() {
  return path.join(home(), 'server.json');
}

function readServerInfo() {
  try {
    return JSON.parse(fs.readFileSync(serverFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function boardFile(project) {
  return path.join(config.stateDir(project), 'board.json');
}

function validProject(p) {
  if (typeof p !== 'string' || !PROJECT_RE.test(p)) return false;
  try { return config.slug(p) === p; } catch (_) { return false; }
}

function envInt(name, dflt) {
  const raw = process.env[name];
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) ? v : dflt;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Ask whatever listens on a port if it is one of us. Resolves the health JSON or null.
function probe(port, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const headers = { Host: `127.0.0.1:${port}` };
    if (token) headers['x-bwc-token'] = token;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(j && j.app === APP ? j : null);
        } catch (_) { resolve(null); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return null; }
}

function createBoardServer() {
  const token = crypto.randomBytes(24).toString('hex');
  const idleMs = envInt('BWC_IDLE_MS', 30 * 60 * 1000);
  const settleMs = envInt('BWC_SETTLE_MS', 700);
  const projects = new Map();
  let port = 0;
  let lastActivity = Date.now();
  let idleTimer = null;
  let server = null;
  let indexTemplate = null;

  // Loaded project, or null. Only create:true makes a new one.
  function project(name, create) {
    let p = projects.get(name);
    if (p) {
      projects.delete(name); // re-insert keeps the map in LRU order
      projects.set(name, p);
      reloadIfChanged(name, p);
      return p;
    }
    const file = boardFile(name);
    if (!create && mtimeOf(file) === null) return null;
    p = { board: model.loadBoard(file, name), ver: 1, pageWaiters: new Set(), agentWaiters: new Set(), ended: false, settle: null, mtime: mtimeOf(file) };
    p.board.project = name;
    projects.set(name, p);
    if (p.mtime === null) persist(name, p);
    evict();
    return p;
  }

  function evict() {
    if (projects.size <= MAX_PROJECTS) return;
    for (const [name, p] of projects) {
      if (projects.size <= MAX_PROJECTS) break;
      if (!p.pageWaiters.size && !p.agentWaiters.size) {
        clearTimeout(p.settle);
        projects.delete(name);
      }
    }
  }

  // backstop: someone else wrote board.json behind our back
  function reloadIfChanged(name, p) {
    const m = mtimeOf(boardFile(name));
    if (m === null || m === p.mtime) return;
    try {
      p.board = model.loadBoard(boardFile(name), name);
      p.board.project = name;
      p.mtime = m;
      touch(p);
      if (p.board.events.length) wakeAgents(name, p, settleMs);
    } catch (_) { /* half-written file: keep memory, try again next time */ }
  }

  function persist(name, p) {
    model.saveBoard(boardFile(name), p.board);
    p.mtime = mtimeOf(boardFile(name));
  }

  function status(p) {
    if (p.agentWaiters.size) return 'your_turn';
    if (p.board.events.length) return 'claude_reading';
    return 'claude_working';
  }

  function pageView(p) {
    return Object.assign(model.publicView(p.board), { status: status(p), ver: p.ver });
  }

  // something visible changed: wake page long-polls
  function touch(p) {
    p.ver += 1;
    for (const w of [...p.pageWaiters]) w();
  }

  // Build the await payload. Events only count as delivered once the
  // response was actually written (commit), so a dead client loses nothing.
  function prepareDelivery(name, p) {
    const b = p.board;
    const snap = model.deliverySnapshot(b);
    const out = {
      status: 'input',
      project: name,
      user_said: b.events.filter((e) => e.type === 'say').map((e) => e.text),
      diff: semanticDiff(b.baseline, b),
      rev: b.rev,
    };
    const commit = () => {
      model.markDelivered(p.board, snap);
      persist(name, p);
      touch(p);
    };
    return { out, commit };
  }

  function newestWaiter(p) {
    let last = null;
    for (const w of p.agentWaiters) last = w;
    return last;
  }

  // agent long-poll gets answered once input settles
  function wakeAgents(name, p, ms) {
    if (!p.agentWaiters.size) return;
    clearTimeout(p.settle);
    p.settle = setTimeout(() => {
      p.settle = null;
      if (!p.agentWaiters.size) return;
      if (p.ended) {
        p.ended = false;
        for (const w of [...p.agentWaiters]) w({ status: 'ended', project: name });
        touch(p);
        return;
      }
      if (!p.board.events.length) return;
      const newest = newestWaiter(p);
      for (const w of [...p.agentWaiters]) if (w !== newest) w({ status: 'superseded', project: name });
      const { out, commit } = prepareDelivery(name, p);
      newest(out, commit);
    }, ms);
  }

  function send(res, code, body, type, onDelivered) {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    };
    let data = body;
    if (type) headers['Content-Type'] = type;
    else {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      data = JSON.stringify(body);
    }
    if (onDelivered) res.once('finish', onDelivered);
    res.writeHead(code, headers);
    res.end(data);
  }

  function fail(res, code, message) {
    send(res, code, { error: message });
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (_) {
          reject(Object.assign(new Error('bad json'), { code: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function hostOk(req) {
    const h = req.headers.host;
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  function originOk(req) {
    const o = req.headers.origin;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function tokenOk(req) {
    const t = req.headers['x-bwc-token'];
    if (typeof t !== 'string' || t.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  }

  function serveIndex(res, name) {
    if (!indexTemplate) indexTemplate = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    // project names are slug-checked, token is hex: nothing to escape
    const html = indexTemplate.split('__BWC_TOKEN__').join(token).split('__BWC_PROJECT__').join(name);
    send(res, 200, html, 'text/html; charset=utf-8');
  }

  // long-poll: resolver(body, onDelivered) answers now, resolver() answers with fallback()
  function waitFor(res, set, ms, fallback) {
    let done = false;
    const fn = (body, onDelivered) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      set.delete(fn);
      send(res, 200, body === undefined ? fallback() : body, undefined, onDelivered);
    };
    const timer = setTimeout(() => fn(), ms);
    res.on('close', () => {
      if (!done) { done = true; clearTimeout(timer); set.delete(fn); }
    });
    set.add(fn);
  }

  async function handleApi(req, res, url, parts) {
    if (parts[1] === 'stop' && req.method === 'POST') {
      await readJson(req);
      send(res, 200, { ok: true, stopping: true });
      setImmediate(() => shutdown('stop'));
      return;
    }
    if (parts[1] === 'pending' && req.method === 'GET') {
      // only loaded projects; the CLI reads the rest from disk
      const out = [];
      for (const [name, p] of projects) {
        reloadIfChanged(name, p);
        if (p.board.events.length) out.push({ project: name, boardId: p.board.id, events: p.board.events, agentWaiting: p.agentWaiters.size > 0 });
      }
      return send(res, 200, { pending: out });
    }
    if (parts[1] !== 'p' || !validProject(parts[2]) || parts.length !== 4) return fail(res, 404, 'not found');
    const name = parts[2];
    const action = parts[3];

    if (req.method === 'GET') {
      const p = project(name, false);
      if (!p) return fail(res, 404, 'no such project');
      if (action === 'board') return send(res, 200, pageView(p));
      if (action === 'poll') {
        const since = Number(url.searchParams.get('ver') || 0);
        if (p.ver !== since) return send(res, 200, pageView(p));
        if (p.pageWaiters.size >= MAX_PAGE_WAITERS) return fail(res, 429, 'too many open pages');
        waitFor(res, p.pageWaiters, POLL_MS, () => pageView(p));
        return;
      }
      if (action === 'await') {
        const ms = Math.min(Math.max(Number(url.searchParams.get('timeout_ms') || POLL_MS), 0), POLL_MS);
        // one listener per project: a new await replaces older ones
        for (const w of [...p.agentWaiters]) w({ status: 'superseded', project: name });
        if (p.ended) {
          p.ended = false;
          touch(p);
          return send(res, 200, { status: 'ended', project: name });
        }
        if (p.board.events.length) {
          const { out, commit } = prepareDelivery(name, p);
          return send(res, 200, out, undefined, commit);
        }
        waitFor(res, p.agentWaiters, ms, () => ({ status: 'timeout', project: name, rev: p.board.rev }));
        touch(p); // page shows "your turn"
        res.on('close', () => setImmediate(() => touch(p)));
        return;
      }
      return fail(res, 404, 'not found');
    }

    if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
    const body = await readJson(req);
    const creates = action === 'open' || action === 'draw' || action === 'export';
    const p = project(name, creates);
    if (!p) return fail(res, 404, 'no such project');

    switch (action) {
      case 'open':
        return send(res, 200, { ok: true, project: name, rev: p.board.rev });
      case 'say': {
        model.userSay(p.board, body.text);
        persist(name, p);
        touch(p);
        wakeAgents(name, p, Math.min(settleMs, 300));
        return send(res, 200, { ok: true, rev: p.board.rev });
      }
      case 'edit': {
        const edit = body.edit || body;
        const seq = p.board.eventSeq;
        // validate on a copy so a bad edit never half-applies
        const next = model.applyUserEdit(model.clone(p.board), edit);
        p.board = next;
        persist(name, p);
        touch(p);
        if (p.board.eventSeq > seq) wakeAgents(name, p, settleMs);
        return send(res, 200, { ok: true, rev: p.board.rev });
      }
      case 'render-error': {
        model.applyUserEdit(p.board, { op: 'render_error', id: body.id, message: body.message });
        persist(name, p);
        touch(p);
        wakeAgents(name, p, settleMs);
        return send(res, 200, { ok: true });
      }
      case 'draw': {
        const spec = body.spec || body;
        const check = validateDraw(p.board, spec);
        if (!check.ok) return send(res, 422, { error: 'spec rejected', errors: check.errors, warnings: check.warnings });
        const { board, report } = mergeDraw(p.board, spec);
        p.board = board;
        persist(name, p);
        touch(p);
        return send(res, 200, Object.assign({ ok: true, project: name, rev: board.rev, warnings: check.warnings }, report));
      }
      case 'export': {
        // export against the live board so canvas edits land in memory, not behind us
        const vault = require('./vault');
        const before = new Set(p.board.nodes.concat(p.board.edges).map((i) => i.id));
        const r = vault.exportBoard(name, p.board, { mermaid: body.mermaid === true });
        if (r.boardChanged) {
          const next = model.normalize(r.board, name);
          const after = new Set(next.nodes.concat(next.edges).map((i) => i.id));
          model.tombstone(next, [...before].filter((id) => !after.has(id)));
          p.board = next;
          persist(name, p);
          touch(p);
          if (p.board.events.length) wakeAgents(name, p, settleMs);
        }
        return send(res, 200, { ok: true, project: name, boardChanged: !!r.boardChanged, rev: p.board.rev, canvas: r.canvas, note: r.note });
      }
      case 'reply': {
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 20000) : '';
        if (!text) return fail(res, 400, 'empty reply');
        model.addChat(p.board, 'claude', text);
        persist(name, p);
        touch(p);
        return send(res, 200, { ok: true });
      }
      case 'end': {
        p.ended = true;
        touch(p);
        wakeAgents(name, p, 0);
        return send(res, 200, { ok: true });
      }
      default:
        return fail(res, 404, 'not found');
    }
  }

  async function handle(req, res) {
    const raw = req.url || '/';
    if (!hostOk(req)) return fail(res, 403, 'bad host');
    if (raw.includes('..') || raw.includes('\\') || /%2e|%5c|%2f/i.test(raw)) return fail(res, 400, 'bad path');
    const url = new URL(raw, `http://127.0.0.1:${port}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST') {
      if (!originOk(req)) return fail(res, 403, 'bad origin');
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return fail(res, 415, 'json only');
    } else if (req.method !== 'GET') {
      return fail(res, 405, 'method not allowed');
    }

    if (parts[0] === 'api') {
      // health answers without a token so another bwm can tell we are here
      if (parts[1] === 'health' && parts.length === 2 && req.method === 'GET') {
        const out = { ok: true, app: APP };
        if (tokenOk(req)) Object.assign(out, { pid: process.pid, port });
        return send(res, 200, out);
      }
      if (!tokenOk(req)) return fail(res, 401, 'bad token');
      lastActivity = Date.now();
      try {
        await handleApi(req, res, url, parts);
      } catch (err) {
        if (!res.headersSent) fail(res, err.code === 413 || err.code === 400 ? err.code : 400, err.message);
      }
      return;
    }

    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    lastActivity = Date.now();
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      fs.readFile(file, (err, data) => {
        if (err) return fail(res, 404, 'not found');
        send(res, 200, data, type);
      });
      return;
    }
    if (parts[0] === 'p' && parts.length === 2 && validProject(parts[1])) {
      if (!project(parts[1], false)) return fail(res, 404, 'no such project, run bwm open first');
      if (!url.pathname.endsWith('/')) {
        res.writeHead(302, { Location: `/p/${parts[1]}/`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return serveIndex(res, parts[1]);
    }
    if (url.pathname === '/') return send(res, 200, 'brainstorm-with-me board server. Open /p/<project>/', 'text/plain; charset=utf-8');
    return fail(res, 404, 'not found');
  }

  function idleCheck() {
    let waiting = 0;
    for (const p of projects.values()) waiting += p.agentWaiters.size + p.pageWaiters.size;
    if (waiting) { lastActivity = Date.now(); return; }
    if (Date.now() - lastActivity >= idleMs) shutdown('idle');
  }

  let closing = false;
  function shutdown(reason) {
    if (closing) return;
    closing = true;
    clearInterval(idleTimer);
    for (const p of projects.values()) {
      clearTimeout(p.settle);
      for (const w of [...p.agentWaiters]) w({ status: 'ended', reason });
      for (const w of [...p.pageWaiters]) w();
    }
    const info = readServerInfo();
    if (info && info.pid === process.pid) {
      try { fs.unlinkSync(serverFile()); } catch (_) { /* gone already */ }
    }
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 1000).unref();
  }

  function listenOn(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((err) => { if (!res.headersSent) fail(res, 500, err.message); });
      });
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => resolve(s));
    });
  }

  async function listen(startPort) {
    const ports = startPort === 0 ? [0] : [...Array(10).keys()].map((i) => startPort + i).concat(0);
    for (const p of ports) {
      try {
        server = await listenOn(p);
        port = server.address().port;
        return port;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
        // the port belongs to another bwm server: use that one, do not start a second
        if (p !== 0 && await probe(p)) throw Object.assign(new Error(`a board server already runs on port ${p}`), { code: 'BWC_RUNNING', port: p });
      }
    }
    throw new Error('no free port');
  }

  async function start() {
    const existing = readServerInfo();
    if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
      const h = await probe(existing.port, existing.token);
      if (h && h.pid === existing.pid) throw Object.assign(new Error(`a board server already runs on port ${existing.port}`), { code: 'BWC_RUNNING', port: existing.port });
    }
    const envPort = process.env.BWC_PORT;
    let startPort = 4527;
    if (envPort !== undefined && envPort !== '') startPort = Number(envPort);
    else {
      try { startPort = Number(config.loadConfig().port) || 4527; } catch (_) { /* default */ }
    }
    await listen(startPort);
    server.requestTimeout = 60000; // long-polls stay under 25s
    server.headersTimeout = 30000;
    server.maxConnections = 64;
    fs.mkdirSync(home(), { recursive: true });
    const info = { pid: process.pid, port, token, startedAt: new Date().toISOString() };
    const tmp = serverFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, serverFile());
    idleTimer = setInterval(idleCheck, Math.max(50, Math.min(60000, Math.floor(idleMs / 4))));
    process.on('SIGINT', () => shutdown('signal'));
    process.on('SIGTERM', () => shutdown('signal'));
    return info;
  }

  return { start, shutdown };
}

module.exports = { createBoardServer, readServerInfo, serverFile, boardFile, home, validProject, probe, pidAlive, APP };
