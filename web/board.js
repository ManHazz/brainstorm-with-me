// Board page: renders the board, sends user edits, long-polls for Claude's changes.
(function () {
  'use strict';

  const TOKEN = document.querySelector('meta[name="bwc-token"]').content;
  const PROJECT = document.querySelector('meta[name="bwc-project"]').content;
  const API = '/api/p/' + encodeURIComponent(PROJECT);
  const FENCE = /^\s*```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/;
  const STATUS_TEXT = {
    your_turn: 'Your turn',
    claude_reading: 'Claude is reading',
    claude_working: 'Claude is drawing',
    offline: 'Server stopped',
  };

  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport');
  const world = $('world');
  const nodeLayer = $('node-layer');
  const edgeLayer = $('edge-layer');
  const hint = $('hint');

  const state = {
    board: { nodes: [], edges: [], chat: [], rev: 0 },
    ver: 0,
    view: { x: 40, y: 40, scale: 1 },
    selected: null, // { kind: 'node'|'edge', id }
    editingId: null,
    dragging: null,
    connectFrom: null,
    connectMode: false,
    fitted: false,
  };
  const els = new Map(); // node id -> element
  const svgCache = new Map(); // mermaid source -> svg string
  const reportedErrors = new Set();
  let mermaidReady = false;
  let renderSeq = 0;

  $('project-name').textContent = PROJECT;

  // ---- api ----
  async function api(method, path, body) {
    const opts = { method, headers: { 'x-bwc-token': TOKEN }, cache: 'no-store' };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API + path, opts);
    if (res.status === 401) reloadForNewToken();
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
    return json;
  }

  // server restarted with a new token: reload to pick it up, at most every 10s
  function reloadForNewToken() {
    let last = 0;
    try { last = Number(sessionStorage.getItem('bwc-reload') || 0); } catch (_) { /* storage blocked */ }
    if (Date.now() - last < 10000) return;
    try { sessionStorage.setItem('bwc-reload', String(Date.now())); } catch (_) { /* storage blocked */ }
    location.reload();
  }

  function sendEdit(edit) {
    return api('POST', '/edit', { edit }).catch((err) => flash('Edit failed: ' + err.message));
  }

  function flash(text) {
    hint.textContent = text;
    hint.classList.add('show');
    clearTimeout(flash.t);
    flash.t = setTimeout(() => hint.classList.remove('show'), 3000);
  }

  function newId(prefix) {
    const a = new Uint8Array(4);
    crypto.getRandomValues(a);
    return prefix + '-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- view transform ----
  function applyView() {
    const v = state.view;
    world.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.scale + ')';
    viewport.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
    viewport.style.backgroundSize = 24 * v.scale + 'px ' + 24 * v.scale + 'px';
  }

  function toWorld(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return { x: (clientX - r.left - state.view.x) / state.view.scale, y: (clientY - r.top - state.view.y) / state.view.scale };
  }

  function fit() {
    const nodes = state.board.nodes;
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height);
    }
    const r = viewport.getBoundingClientRect();
    const pad = 60;
    const scale = Math.max(0.2, Math.min(1.5, Math.min((r.width - pad * 2) / (x1 - x0 || 1), (r.height - pad * 2) / (y1 - y0 || 1))));
    state.view.scale = scale;
    state.view.x = (r.width - (x1 - x0) * scale) / 2 - x0 * scale;
    state.view.y = (r.height - (y1 - y0) * scale) / 2 - y0 * scale;
    applyView();
  }

  // ---- rendering ----
  function nodeById(id) {
    return state.board.nodes.find((n) => n.id === id);
  }

  function isUserOwned(item) {
    return !!(item.meta && (item.meta.locked || item.meta.owner === 'user'));
  }

  function setGeometry(el, n) {
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = n.width + 'px';
    el.style.height = n.height + 'px';
  }

  function renderNode(n) {
    let el = els.get(n.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'node';
      el.dataset.id = n.id;
      el.addEventListener('pointerdown', onNodePointerDown);
      el.addEventListener('dblclick', onNodeDblClick);
      nodeLayer.appendChild(el);
      els.set(n.id, el);
    }
    if (state.editingId === n.id || (state.dragging && state.dragging.id === n.id)) return;
    const kind = (n.meta && n.meta.kind) || 'note';
    const color = n.color ? String(n.color) : '';
    const sig = JSON.stringify([n.type, n.text, n.label, n.file, n.url, kind, color, isUserOwned(n), n.meta && n.meta.answerFor]);
    setGeometry(el, n);
    el.style.zIndex = n.type === 'group' ? '0' : '1';
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;

    el.className = 'node ' + kind + (n.type === 'group' ? ' group' : '');
    el.style.borderColor = '';
    if (/^[1-6]$/.test(color)) el.classList.add('c' + color);
    else if (/^#[0-9a-fA-F]{6}$/.test(color)) el.style.borderColor = color;
    if (state.selected && state.selected.kind === 'node' && state.selected.id === n.id) el.classList.add('selected');
    el.replaceChildren();

    if (n.type === 'group') {
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = n.label || '';
      el.appendChild(label);
    } else {
      const body = document.createElement('div');
      body.className = 'body';
      el.appendChild(body);
      fillBody(body, n);
    }

    if (kind === 'question') {
      const box = document.createElement('form');
      box.className = 'answer-box';
      const input = document.createElement('input');
      input.placeholder = 'Your answer';
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.textContent = 'Answer';
      box.append(input, btn);
      box.addEventListener('pointerdown', (e) => e.stopPropagation());
      box.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        sendEdit({ op: 'answer', question_id: n.id, text });
      });
      el.appendChild(box);
    }

    if (isUserOwned(n)) {
      const lock = document.createElement('div');
      lock.className = 'lock';
      lock.title = 'You changed this, so Claude will not touch it';
      const label = document.createElement('span');
      label.textContent = 'yours';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'let Claude rearrange';
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', () => sendEdit({ op: 'unlock', id: n.id }));
      lock.append(label, btn);
      el.appendChild(lock);
    }

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.title = 'Resize';
    el.appendChild(handle);
  }

  function fillBody(body, n) {
    if (n.type === 'file') { body.textContent = 'file: ' + (n.file || ''); return; }
    if (n.type === 'link') { body.textContent = 'link: ' + (n.url || ''); return; }
    const text = n.text || '';
    const m = FENCE.exec(text);
    if (!m) { body.textContent = text; return; }
    body.classList.add('diagram');
    renderMermaid(body, n.id, m[1]);
  }

  function insertSvg(body, svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('mermaid returned no svg');
    body.replaceChildren(document.importNode(svg, true));
  }

  function showSource(body, src, message) {
    body.classList.remove('diagram');
    const err = document.createElement('div');
    err.className = 'render-error';
    err.textContent = 'Diagram did not render: ' + message;
    const pre = document.createElement('pre');
    pre.className = 'source';
    pre.textContent = src;
    body.replaceChildren(err, pre);
  }

  async function renderMermaid(body, id, src) {
    if (!mermaidReady) {
      body.textContent = 'Loading diagram...';
      return;
    }
    if (svgCache.has(src)) {
      try { insertSvg(body, svgCache.get(src)); return; } catch (_) { /* rerender below */ }
    }
    body.textContent = 'Rendering...';
    try {
      const out = await window.mermaid.render('bwc-mmd-' + (++renderSeq), src);
      svgCache.set(src, out.svg);
      insertSvg(body, out.svg);
    } catch (err) {
      const message = String((err && err.message) || err).slice(0, 1500);
      showSource(body, src, message);
      const key = id + '\u0000' + src;
      if (!reportedErrors.has(key)) {
        reportedErrors.add(key);
        api('POST', '/render-error', { id, message }).catch(() => {});
      }
    }
  }

  function anchor(n, toward) {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const dx = toward.x - cx;
    const dy = toward.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const sx = (n.width / 2) / Math.abs(dx || 1e-9);
    const sy = (n.height / 2) / Math.abs(dy || 1e-9);
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function sidePoint(n, side) {
    if (side === 'top') return { x: n.x + n.width / 2, y: n.y };
    if (side === 'bottom') return { x: n.x + n.width / 2, y: n.y + n.height };
    if (side === 'left') return { x: n.x, y: n.y + n.height / 2 };
    if (side === 'right') return { x: n.x + n.width, y: n.y + n.height / 2 };
    return null;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function renderEdges() {
    edgeLayer.replaceChildren();
    for (const e of state.board.edges) {
      const a = nodeById(e.fromNode);
      const b = nodeById(e.toNode);
      if (!a || !b) continue;
      const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
      const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const p1 = sidePoint(a, e.fromSide) || anchor(a, cb);
      const p2 = sidePoint(b, e.toSide) || anchor(b, ca);
      const g = svgEl('g', {});
      g.dataset.id = e.id;
      if (isUserOwned(e)) g.classList.add('user');
      if (state.selected && state.selected.kind === 'edge' && state.selected.id === e.id) g.classList.add('selected');
      const line = svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'edge' });
      if ((e.toEnd || 'arrow') === 'arrow') line.setAttribute('marker-end', 'url(#arrow)');
      if (e.fromEnd === 'arrow') line.setAttribute('marker-start', 'url(#arrow)');
      if (/^#[0-9a-fA-F]{6}$/.test(e.color || '')) line.style.stroke = e.color;
      const hit = svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'hit' });
      hit.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        select({ kind: 'edge', id: e.id });
      });
      hit.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        const label = window.prompt('Edge label', e.label || '');
        if (label !== null) sendEdit({ op: 'edit_text', id: e.id, text: label });
      });
      g.append(line, hit);
      if (e.label) {
        const t = svgEl('text', { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 4, 'text-anchor': 'middle' });
        t.textContent = e.label;
        g.appendChild(t);
      }
      edgeLayer.appendChild(g);
    }
  }

  function renderBoard() {
    const ids = new Set(state.board.nodes.map((n) => n.id));
    for (const [id, el] of els) {
      if (!ids.has(id) && state.editingId !== id) { el.remove(); els.delete(id); }
    }
    // groups first so they sit underneath
    const sorted = state.board.nodes.slice().sort((a, b) => (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1));
    for (const n of sorted) renderNode(n);
    renderEdges();
  }

  function renderChat() {
    const log = $('chat-log');
    const chat = state.board.chat || [];
    const last = chat[chat.length - 1];
    const sig = chat.length + '|' + (last ? last.at + last.text.length : '');
    if (log.dataset.sig === sig) return;
    log.dataset.sig = sig;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
    log.replaceChildren();
    for (const m of chat) {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.who === 'user' ? 'user' : 'claude');
      div.textContent = m.text;
      log.appendChild(div);
    }
    if (atBottom || chat.length) log.scrollTop = log.scrollHeight;
  }

  function setStatus(s) {
    const el = $('status');
    el.className = 'status ' + s;
    el.textContent = STATUS_TEXT[s] || s;
  }

  function select(sel) {
    state.selected = sel;
    for (const [id, el] of els) el.classList.toggle('selected', !!sel && sel.kind === 'node' && sel.id === id);
    renderEdges();
  }

  function applyServer(data) {
    if (!data || !Array.isArray(data.nodes)) return;
    // keep local geometry for a node mid-drag
    if (state.dragging) {
      const local = nodeById(state.dragging.id);
      const incoming = data.nodes.find((n) => n.id === state.dragging.id);
      if (local && incoming) Object.assign(incoming, { x: local.x, y: local.y, width: local.width, height: local.height });
    }
    state.board = data;
    state.ver = data.ver;
    renderBoard();
    renderChat();
    setStatus(data.status);
    if (!state.fitted && data.nodes.length) { state.fitted = true; fit(); }
  }

  // ---- long-poll loop ----
  async function pollLoop() {
    let failures = 0;
    for (;;) {
      try {
        const data = await api('GET', '/poll?ver=' + state.ver);
        failures = 0;
        applyServer(data);
      } catch (_) {
        failures++;
        if (failures >= 3) setStatus('offline');
        await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * failures)));
      }
    }
  }

  // ---- interactions ----
  function onNodePointerDown(ev) {
    if (ev.button !== 0) return;
    const el = ev.currentTarget;
    const id = el.dataset.id;
    if (state.editingId === id) return;
    ev.stopPropagation();
    const n = nodeById(id);
    if (!n) return;

    if (state.connectMode) {
      if (!state.connectFrom) {
        state.connectFrom = id;
        el.classList.add('pick');
        hint.textContent = 'Now click the item to connect to';
      } else if (state.connectFrom !== id) {
        sendEdit({ op: 'connect', id: newId('ue'), from: state.connectFrom, to: id });
        stopConnect();
      }
      return;
    }

    select({ kind: 'node', id });
    const resizing = ev.target.classList.contains('handle');
    const start = toWorld(ev.clientX, ev.clientY);
    state.dragging = { id, resizing, start, orig: { x: n.x, y: n.y, width: n.width, height: n.height }, moved: false };
    el.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const d = state.dragging;
      if (!d) return;
      const p = toWorld(e.clientX, e.clientY);
      const dx = Math.round(p.x - d.start.x);
      const dy = Math.round(p.y - d.start.y);
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      if (d.resizing) {
        n.width = Math.max(40, d.orig.width + dx);
        n.height = Math.max(30, d.orig.height + dy);
      } else {
        n.x = d.orig.x + dx;
        n.y = d.orig.y + dy;
      }
      setGeometry(el, n);
      renderEdges();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const d = state.dragging;
      state.dragging = null;
      if (!d || !d.moved) return;
      if (d.resizing) sendEdit({ op: 'resize', id, width: n.width, height: n.height });
      else sendEdit({ op: 'move', id, x: n.x, y: n.y });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function onNodeDblClick(ev) {
    const id = ev.currentTarget.dataset.id;
    const n = nodeById(id);
    if (!n || n.type !== 'text' || ev.target.closest('.answer-box, .lock')) return;
    startEdit(n);
  }

  function startEdit(n) {
    const el = els.get(n.id);
    if (!el) return;
    state.editingId = n.id;
    const original = n.text || '';
    const ta = document.createElement('textarea');
    ta.className = 'editor';
    ta.value = original;
    el.replaceChildren(ta);
    delete el.dataset.sig;
    ta.focus();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      state.editingId = null;
      const text = ta.value;
      if (save && text !== original) {
        n.text = text;
        sendEdit({ op: 'edit_text', id: n.id, text });
      }
      renderNode(nodeById(n.id) || n);
    };
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    });
  }

  function stopConnect() {
    state.connectMode = false;
    state.connectFrom = null;
    $('btn-connect').classList.remove('active');
    viewport.classList.remove('connecting');
    for (const el of els.values()) el.classList.remove('pick');
    hint.classList.remove('show');
  }

  $('btn-connect').addEventListener('click', () => {
    if (state.connectMode) return stopConnect();
    state.connectMode = true;
    $('btn-connect').classList.add('active');
    viewport.classList.add('connecting');
    hint.textContent = 'Click the item to connect from (Esc cancels)';
    hint.classList.add('show');
  });

  $('btn-note').addEventListener('click', async () => {
    const r = viewport.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const n = { id: newId('u'), type: 'text', x: Math.round(c.x - 110), y: Math.round(c.y - 50), width: 220, height: 100, text: '',
      meta: { owner: 'user', locked: true, kind: 'note' } };
    state.board.nodes.push(n);
    renderNode(n);
    await sendEdit({ op: 'add_note', id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, text: '' });
    startEdit(n);
  });

  $('btn-fit').addEventListener('click', fit);

  $('btn-end').addEventListener('click', () => {
    if (!window.confirm('End this brainstorm session? Claude will wrap up.')) return;
    api('POST', '/end', {}).then(() => flash('Session ended')).catch((err) => flash(err.message));
  });

  // pan on background
  viewport.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.node')) return;
    if (state.connectMode) return stopConnect();
    select(null);
    viewport.focus();
    const sx = ev.clientX, sy = ev.clientY, ox = state.view.x, oy = state.view.y;
    viewport.classList.add('panning');
    viewport.setPointerCapture(ev.pointerId);
    const move = (e) => {
      state.view.x = ox + e.clientX - sx;
      state.view.y = oy + e.clientY - sy;
      applyView();
    };
    const up = () => {
      viewport.classList.remove('panning');
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
    };
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
  });

  viewport.addEventListener('wheel', (ev) => {
    if (ev.target.closest('.node .body') && !ev.ctrlKey) {
      const body = ev.target.closest('.body');
      if (body.scrollHeight > body.clientHeight) return; // let long notes scroll
    }
    ev.preventDefault();
    const r = viewport.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const old = state.view.scale;
    const scale = Math.max(0.2, Math.min(3, old * Math.exp(-ev.deltaY * 0.0015)));
    state.view.x = mx - (mx - state.view.x) * (scale / old);
    state.view.y = my - (my - state.view.y) * (scale / old);
    state.view.scale = scale;
    applyView();
  }, { passive: false });

  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (ev.key === 'Escape') { stopConnect(); select(null); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selected) {
      ev.preventDefault();
      const sel = state.selected;
      select(null);
      sendEdit({ op: 'delete', id: sel.id });
    }
  });

  // chat
  const input = $('chat-input');
  $('chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '';
    api('POST', '/say', { text }).catch((err) => {
      input.value = text;
      flash('Not sent: ' + err.message);
    });
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $('chat-form').requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  });

  // ---- start ----
  function initMermaid() {
    if (!window.mermaid) return;
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    mermaidReady = true;
    // diagrams drawn before mermaid was ready
    for (const el of els.values()) delete el.dataset.sig;
    renderBoard();
  }

  applyView();
  initMermaid();
  pollLoop();
})();
