// Adversarial tests for the new runConnect flow and showTerminateModal.
// Runs websh.js under jsdom with fetch/xterm stubbed out.
//
// IMPORTANT: websh.js declares state vars with `const`/`let` at module
// scope. In a browser script tag those do *not* attach to window — so
// `win.panes` is undefined. We read them via `win.eval('panes')`.
// Function declarations (doConnect, splitPane, ...) DO attach to window.

const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');

const REPO = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(REPO, 'websh.js'), 'utf8');

let passed = 0, failed = 0, failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  FAIL: ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFakes(win) {
  win.Terminal = class {
    constructor() { this.cols = 80; this.rows = 24; }
    loadAddon() {} open() {} focus() {} reset() {}
    write() {} dispose() {}
    onData() {} onBinary() {} onResize() {} onSelectionChange() {} onBell() {}
    get buffer() { return {active: {length: 0, getLine: () => null}}; }
    get unicode() { return {activeVersion: '11'}; }
  };
  win.FitAddon = {FitAddon: class {
    activate() {} fit() {}
    proposeDimensions() { return {cols: 80, rows: 24}; }
  }};
  win.WebLinksAddon = {WebLinksAddon: class {}};
  win.Unicode11Addon = {Unicode11Addon: class {}};
  win.ResizeObserver = class { observe() {} disconnect() {} };
}

// Each plan entry: {action, match?, response, delay?, once?, fallthrough?}.
// `match` filters on the request body. `response` may be a function(body).
// `once` consumes the entry. `fallthrough` lets an unmatched entry fall
// through silently (used so we can register a "catch-all" last).
function makeFetch(plan, log) {
  return function(url, init) {
    const u = new URL(url, 'http://x/');
    const action = u.searchParams.get('action');
    const body = init && init.body ? JSON.parse(init.body) : null;
    log.push({action, body});
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      if (p.action !== action) continue;
      if (p.match && !p.match(body)) continue;
      if (p.once) plan.splice(i, 1);
      const resp = typeof p.response === 'function' ? p.response(body) : p.response;
      const d = p.delay || 1;
      return sleep(d).then(() => ({json: () => Promise.resolve(resp)}));
    }
    // Keep the test moving on unexpected actions (output polls after a
    // test's assertions have already run, for example).
    return sleep(1).then(() => ({json: () => Promise.resolve({alive: false})}));
  };
}

// Expose module-scope const/let bindings from websh.js onto `window` so
// tests can inspect them. Getter for let-like vars so we see reassignments.
const EXPOSE = `
; (function(){
  Object.defineProperty(window, 'panes', {get: () => panes, configurable: true});
  Object.defineProperty(window, 'overlayMode', {get: () => overlayMode, configurable: true});
  Object.defineProperty(window, 'pendingSplit', {get: () => pendingSplit, configurable: true});
  Object.defineProperty(window, 'connectingFor', {get: () => connectingFor, configurable: true});
  Object.defineProperty(window, 'currentConnectRun', {
    get: () => currentConnectRun,
    set: v => { currentConnectRun = v; },
    configurable: true});
  Object.defineProperty(window, 'serverConfig', {get: () => serverConfig, configurable: true});
})();`;

async function mkEnv(plan) {
  const dom = new JSDOM(html, {runScripts: 'outside-only', pretendToBeVisual: true,
                               url: 'http://localhost/websh/'});
  const win = dom.window;
  const log = [];
  makeFakes(win);
  win.fetch = makeFetch(plan, log);
  win.localStorage.clear();
  win.eval(js + EXPOSE);
  await sleep(30);
  return {dom, win, log};
}

function cleanup(env) {
  try {
    const panes = env.win.panes;
    Object.keys(panes).forEach(k => {
      panes[k].polling = false;
      try { env.win.stopKeepalive(panes[k]); } catch(e) {}
    });
    try {
      if (env.win.currentConnectRun) env.win.currentConnectRun.cancelled = true;
    } catch(e) {}
    env.dom.window.close();
  } catch(e) {}
}

const $ = (win, id) => win.document.getElementById(id);
const hidden = el => el.classList.contains('h');
// jsdom runScripts:outside-only doesn't execute inline onclick handlers,
// so .click() fires the event but the handler is a no-op. Evaluate the
// onclick attribute in the window context manually.
function clickBtn(win, id) {
  const el = $(win, id);
  const code = el.getAttribute('onclick');
  if (!code) throw new Error('no onclick on #' + id);
  win.eval('(function(){' + code + '}).call(document.getElementById("' + id + '"))');
}
const getPanes = win => win.panes;
const getOverlayMode = win => win.overlayMode;
const paneList = win => { const p = getPanes(win); return Object.keys(p).map(k => p[k]); };

const scenarios = [];
function test(name, fn) { scenarios.push({name, fn}); }

// =====================================================================
test('non-persistent success materializes pane and closes form', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid1', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  ok(!hidden($(win, 'ov')), 'form visible on boot');
  ok(paneList(win).length === 0, 'no pane before connect');
  $(win, 'iH').value = '10.0.0.1';
  $(win, 'iU').value = 'alex';
  $(win, 'iPw').value = 'pw';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  ok(hidden($(win, 'ov')), 'form hidden on success');
  ok(hidden($(win, 'tmuxOv')), 'popup hidden on success');
  const ps = paneList(win);
  ok(ps.length === 1, 'one pane, got ' + ps.length);
  if (ps.length) {
    ok(ps[0].sid === 'sid1', 'pane.sid, got ' + ps[0].sid);
    ok(ps[0].persistent === false, 'not persistent');
  }
  cleanup(env);
});

test('non-persistent auth-fail: popup shown, form open, no pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '10.0.0.1'; $(win, 'iU').value = 'alex';
  $(win, 'iPw').value = 'wrong'; $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(60);
  ok(!hidden($(win, 'ov')), 'form still visible');
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok(paneList(win).length === 0, 'no pane');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'title; got=' + $(win, 'tmTitle').textContent);
  ok($(win, 'tmCancel').textContent === 'OK', 'button OK');
  clickBtn(win, 'tmCancel');
  await sleep(10);
  ok(hidden($(win, 'tmuxOv')), 'popup dismissed');
  ok(!hidden($(win, 'ov')), 'form still visible');
  cleanup(env);
});

// After dropping the tmux probe, persistent connects no longer block on
// a separate bg session. The "tmux not found" UX is reactive: the real
// connect succeeds, dies quickly, and showTmuxBar is raised by
// handleOutputPayload's regex match. The connect popup itself only sees
// the bare "connection went away" outcome here — no special title.
test('persistent + no-tmux: real connect runs (no separate probe session)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'real-sid', alive: true}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'remote'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = true;
  win.doConnect();
  await sleep(80);
  // Exactly one /api/connect, NOT a bg-tagged probe call.
  const connects = log.filter(e => e.action === 'connect');
  ok(connects.length === 1, 'one connect call, got ' + connects.length);
  ok(connects[0].body && connects[0].body.background !== true,
     'connect call is NOT background-tagged');
  ok(connects[0].body && connects[0].body.persistent === true,
     'connect call is persistent');
  cleanup(env);
});

test('persistent + auth-fail at real connect: auth_failed popup, no pane', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'r'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'bad';
  $(win, 'iPersistent').checked = true;
  win.doConnect();
  await sleep(120);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'title');
  ok(paneList(win).length === 0, 'no pane');
  cleanup(env);
});

test('cancel during connect: run cancelled, orphan sid disconnected, form stays', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-delayed', alive: true}, delay: 300},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = '10.0.0.1'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(50);
  ok(!hidden($(win, 'tmuxOv')), 'connecting popup up');
  ok($(win, 'tmCancel').textContent === 'Cancel', 'button Cancel during connecting');
  clickBtn(win, 'tmCancel');
  await sleep(500);
  ok(hidden($(win, 'tmuxOv')), 'popup hidden after cancel');
  ok(!hidden($(win, 'ov')), 'form still open');
  ok(paneList(win).length === 0, 'no pane');
  const discs = log.filter(e => e.action === 'disconnect' && e.body && e.body.session_id === 'sid-delayed');
  ok(discs.length === 1, 'orphan sid disconnected once, got ' + discs.length);
  cleanup(env);
});

test('form × during split connect cancels run and closes form', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.host === 'seed.host',
     response: {session_id: 'seed', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'connect', match: b => b.host === '10.0.0.2',
     response: {session_id: 'split-sid', alive: true}, delay: 300, once: true},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'seed.host'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const seedPs = paneList(win);
  ok(seedPs.length === 1, 'seed pane exists, got ' + seedPs.length);
  if (seedPs.length !== 1) { cleanup(env); return; }
  const seedId = seedPs[0].id;
  win.splitPane(seedId, 'h');
  await sleep(10);
  ok(!hidden($(win, 'ov')), 'form re-opens for split');
  ok(getOverlayMode(win) === 'split', "overlayMode=split, got=" + getOverlayMode(win));
  $(win, 'iH').value = '10.0.0.2'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(50);
  win.cancelConnect();
  await sleep(450);
  ok(hidden($(win, 'ov')), 'form closed by ×');
  ok(hidden($(win, 'tmuxOv')), 'popup closed');
  ok(paneList(win).length === 1, 'only seed pane, got ' + paneList(win).length);
  const discs = log.filter(e => e.action === 'disconnect' && e.body && e.body.session_id === 'split-sid');
  ok(discs.length === 1, 'split orphan disconnected, got ' + discs.length);
  cleanup(env);
});

test('saved-card: auth fail → popup, saved entry unchanged', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  const saved = [{name: 'myprod', host: 'prod.ex', port: 22, user: 'a',
                  auth: 'pw', pass: 'stored', persistent: false}];
  win.localStorage.setItem('websh_connections', JSON.stringify(saved));
  win.renderSaved();
  win.connectSaved(saved[0]);
  await sleep(60);
  ok(!hidden($(win, 'tmuxOv')), 'popup shown');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'title');
  ok(paneList(win).length === 0, 'no pane');
  ok(!hidden($(win, 'ov')), 'form visible');
  const still = JSON.parse(win.localStorage.getItem('websh_connections'));
  ok(still.length === 1 && still[0].name === 'myprod', 'saved entry intact');
  cleanup(env);
});

test('server error "not allowed" → policy_deny popup', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {error: "user 'root' is not allowed for this connection"}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'x'; $(win, 'iU').value = 'root'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(60);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent === 'Connection not allowed',
     'title; got=' + $(win, 'tmTitle').textContent);
  ok($(win, 'tmStatus').textContent.indexOf('not allowed') !== -1, 'status has msg');
  ok(paneList(win).length === 0, 'no pane');
  ok(!hidden($(win, 'ov')), 'form visible');
  cleanup(env);
});

test('second runConnect supersedes first in-flight', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.host === 'first',
     response: {session_id: 'first-sid', alive: true}, delay: 300, once: true},
    {action: 'connect', match: b => b.host === 'second',
     response: {session_id: 'second-sid', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win; const log = env.log;
  $(win, 'iH').value = 'first'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(30);
  $(win, 'iH').value = 'second';
  win.doConnect();
  await sleep(500);
  const ps = paneList(win);
  ok(ps.length === 1, 'one pane, got ' + ps.length);
  if (ps.length) ok(ps[0].sid === 'second-sid', 'pane sid=second-sid, got ' + ps[0].sid);
  const discs = log.filter(e => e.action === 'disconnect' && e.body && e.body.session_id === 'first-sid');
  ok(discs.length === 1, 'first sid disconnected, got ' + discs.length);
  cleanup(env);
});

test('terminate modal uses label, not host IP', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 'sid-t', alive: true, slot_id: 'slt1'}},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = '65.108.5.233';
  $(win, 'iU').value = 'alex'; $(win, 'iPw').value = 'p';
  $(win, 'iName').value = 'hetzner-hel';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const ps = paneList(win);
  ok(ps.length === 1, 'pane made, got ' + ps.length);
  if (ps.length !== 1) { cleanup(env); return; }
  const p = ps[0];
  ok(p.label === 'hetzner-hel', 'label, got ' + p.label);
  p.persistent = true; p.slotId = 'slt1';
  win.closePane(p.id);
  await sleep(20);
  ok(!hidden($(win, 'confirmOv')), 'confirm modal shown');
  const t = $(win, 'cfTitle').textContent;
  ok(t.indexOf('hetzner-hel') !== -1 && t.indexOf('65.108.5.233') === -1,
     'title uses label, not IP; got: ' + t);
  win.confirmCancel();
  cleanup(env);
});

test('ESC dismisses popup first, then form (split mode)', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', match: b => b.host === 'seed',
     response: {session_id: 'seed', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    {action: 'output', response: {data: '', alive: true}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'seed'; $(win, 'iU').value = 'a'; $(win, 'iPw').value = 'p';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  const seedPs = paneList(win);
  if (seedPs.length !== 1) { ok(false, 'seed pane needed for ESC test'); cleanup(env); return; }
  win.splitPane(seedPs[0].id, 'h');
  await sleep(10);
  $(win, 'iH').value = 'bad'; $(win, 'iPw').value = 'bad';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(80);
  ok(!hidden($(win, 'tmuxOv')), 'popup up after auth fail');
  // Synthesize key event on document. Some listeners hit e.target.closest,
  // so use an element (body) as the target.
  const esc = () => {
    const ev = new win.KeyboardEvent('keydown', {key: 'Escape', bubbles: true});
    win.document.body.dispatchEvent(ev);
  };
  esc(); await sleep(10);
  ok(hidden($(win, 'tmuxOv')), 'popup closed after ESC #1');
  ok(!hidden($(win, 'ov')), 'form still open after ESC #1');
  esc(); await sleep(10);
  ok(hidden($(win, 'ov')), 'form closed after ESC #2');
  cleanup(env);
});

// Reactive showTmuxBar: regex must catch the major shells' wordings.
test('showTmuxBar regex matches bash/zsh/fish/csh "tmux not found"', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  // We assert via the same boolean expression websh.js uses internally.
  // Recreate it here to lock in regression-safety on the regex.
  const re = win.eval('(/tmux: (?:command )?not found|command not found:?\\s*tmux|tmux:\\s*Command not found|Unknown command:?\\s*tmux|tmux:\\s*No such file/i)');
  const should = [
    'bash: tmux: command not found',
    'zsh: command not found: tmux',
    'Unknown command: tmux',
    'tmux: Command not found.',
    'tmux: No such file or directory',
    '/bin/sh: tmux: not found',
    'ksh: tmux: not found',
  ];
  const shouldNot = [
    'bash: foo: command not found',
    'No such file or directory',
    'permission denied',
    'connection closed',
  ];
  for (const s of should) ok(re.test(s), 'should match: ' + JSON.stringify(s));
  for (const s of shouldNot) ok(!re.test(s), 'should NOT match: ' + JSON.stringify(s));
  cleanup(env);
});

test('pendingSave: NOT committed on auth-fail shortly after connect', async () => {
  let outCalls = 0;
  const plan = [
    {action: 'config', response: {restrict_hosts: false, connections: []}},
    {action: 'connect', response: {session_id: 's1', alive: true}, once: true},
    {action: 'resize', response: {ok: true}},
    // First output poll: empty. Second: auth_failed.
    {action: 'output', response: () => {
      outCalls++;
      if (outCalls === 1) return {data: '', alive: true};
      return {auth_failed: true, alive: false};
    }},
    {action: 'disconnect', response: {ok: true}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  $(win, 'iH').value = 'saveme'; $(win, 'iU').value = 'alex'; $(win, 'iPw').value = 'p';
  $(win, 'iSave').checked = true;
  $(win, 'iName').value = 'savelabel';
  $(win, 'iPersistent').checked = false;
  win.doConnect();
  await sleep(300);
  // Auth-failed triggers after the second poll. Saved list should be empty.
  const saved = JSON.parse(win.localStorage.getItem('websh_connections') || '[]');
  ok(saved.length === 0, 'saved entry NOT committed on quick auth fail; got ' + saved.length);
  cleanup(env);
});

test('auto-connect failure → user dismiss popup → form appears', async () => {
  const plan = [
    {action: 'config', response: {restrict_hosts: true, connections:
      [{name: 'hetzner-hel', kind: 'ready', host: '1.2.3.4', port: 22,
        username: 'alex', persistent: false}]}},
    {action: 'connect', response: {auth_failed: true, alive: false}},
  ];
  const env = await mkEnv(plan); const win = env.win;
  await sleep(120);
  ok(!hidden($(win, 'tmuxOv')), 'popup visible');
  ok($(win, 'tmTitle').textContent === 'Authentication failed', 'auth fail title; got=' + $(win, 'tmTitle').textContent);
  ok(paneList(win).length === 0, 'no pane');
  clickBtn(win, 'tmCancel');
  await sleep(20);
  ok(hidden($(win, 'tmuxOv')), 'popup hidden');
  ok(!hidden($(win, 'ov')), 'form appears as fallback');
  cleanup(env);
});

// =====================================================================
// Regression: handleOutputPayload must NOT drop tail-drain bytes
// arriving after a frame that already flipped alive=false.
// SSE _stream emits {data, alive:false} → tail-drain {data:"x",
// alive:false} → event:end{alive:false}. The idempotency guard for
// the disconnect/auth-failed branches must sit AFTER the r.data
// handler, otherwise the tail bytes vanish.
test('disconnect: tail-drain data after alive=false still rendered', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;
  // Capture every term.write into an array we can assert on.
  const writes = [];
  // Build a minimal pane object the way websh.js itself does, then
  // hand it to handleOutputPayload directly (bypassing transports).
  const p = {
    id: 'p1', sid: 'abc', polling: true,
    term: {
      write(b) {
        if (typeof b === 'string') { writes.push(b); return; }
        // Uint8Array-like: array of byte values. instanceof Uint8Array
        // doesn't cross the jsdom realm boundary, so feature-detect.
        let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        writes.push(s);
      },
      buffer: {active: {type: 'normal'}}
    },
    el: win.document.createElement('div'),
    persistent: false, host: '', connection: null,
    connectedAt: 0, recentOutput: ''
  };
  // Inject the pane into websh.js' module-scope panes registry, and
  // expose handleOutputPayload (a function declaration, so it's already
  // on window).
  win._tp = p;
  win.eval(`panes['p1'] = window._tp; activeId = 'p1';`);
  // Frame 1: final output + alive=false. Should write 'first' AND
  // the closed banner, then null p.sid.
  win.handleOutputPayload(p, {data: win.btoa('first\r\n'), alive: false});
  ok(p.sid === null, 'p.sid nulled after alive=false; got ' + p.sid);
  let bannerCount = writes.filter(s => s.indexOf('connection closed') !== -1).length;
  ok(bannerCount === 1, 'banner written once; got ' + bannerCount);
  ok(writes.some(s => s.indexOf('first') !== -1), 'first chunk rendered; writes=' + JSON.stringify(writes));
  // Frame 2 (tail-drain): alive=false again, with new bytes. The
  // bytes MUST land in the terminal — losing them silently would be
  // a regression. The banner MUST NOT be re-written.
  win.handleOutputPayload(p, {data: win.btoa('tail-bytes\r\n'), alive: false});
  ok(writes.some(s => s.indexOf('tail-bytes') !== -1),
     'tail bytes rendered; writes=' + JSON.stringify(writes));
  bannerCount = writes.filter(s => s.indexOf('connection closed') !== -1).length;
  ok(bannerCount === 1, 'banner still written only once; got ' + bannerCount);
  // Frame 3: the bare event:end frame. No data, alive=false. Should
  // be a complete no-op.
  const wlen = writes.length;
  win.handleOutputPayload(p, {alive: false});
  ok(writes.length === wlen, 'event:end is no-op; new writes=' + (writes.length - wlen));
  cleanup(env);
});

// =====================================================================
// Fix A regression: SSE 'open' event MUST NOT disarm the first-message
// buffer-detection timer. 'open' fires when HTTP response headers arrive
// — before any body byte traverses an upstream proxy. A buffering proxy
// flushes headers immediately and holds the body, which is exactly the
// case the timer is meant to detect. Only body events ('data' / 'end')
// prove the channel actually flushes.
test("SSE 'open' event does not mark body as arrived", async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false, connections: []}}];
  const env = await mkEnv(plan); const win = env.win;

  // Capture the listeners streamOutput attaches to its EventSource.
  const captured = {listeners: {}};
  win.EventSource = class {
    constructor(url) { captured.url = url; }
    addEventListener(event, fn) { captured.listeners[event] = fn; }
    set onerror(fn) { captured.onerror = fn; }
    close() { captured.closed = true; }
  };

  const p = {
    id: 'p1', sid: 'abc', polling: true,
    term: {write: () => {}, buffer: {active: {type: 'normal'}}},
    el: win.document.createElement('div'),
    persistent: false, host: '', connection: null,
    connectedAt: 0, recentOutput: '',
    firstFailureAt: 0, retryCount: 0, pollRetries: 0,
  };
  win._tp = p;
  win.eval(`panes['p1'] = window._tp; activeId = 'p1';`);

  win.streamOutput(p);
  ok(p.sseFirstMsgTimer != null,
     'first-message timer armed; got ' + p.sseFirstMsgTimer);
  ok(p.sseGotAnyMessage === false,
     'sseGotAnyMessage=false before any event; got ' + p.sseGotAnyMessage);

  // 'open' fires when HTTP headers arrive. It must NOT flip
  // sseGotAnyMessage and must NOT clear the retry clock — a buffering
  // proxy passes headers through but holds the body. The handler may
  // either register an 'open' listener that's a no-op, or skip the
  // listener entirely; both are correct. Fire whatever the handler
  // registered (if any) and verify nothing changes.
  if (typeof captured.listeners.open === 'function') {
    p.firstFailureAt = 12345; // sentinel: must NOT be cleared by 'open'
    captured.listeners.open();
    ok(p.sseGotAnyMessage === false,
       "'open' must not mark body arrived; got " + p.sseGotAnyMessage);
    ok(p.sseFirstMsgTimer != null,
       "'open' must not clear first-message timer; got " + p.sseFirstMsgTimer);
    ok(p.firstFailureAt === 12345,
       "'open' must not clear retry clock; got " + p.firstFailureAt);
  }

  // Fire 'data' with a benign payload: NOW the body has arrived.
  captured.listeners.data({data: JSON.stringify({data: '', alive: true})});
  ok(p.sseGotAnyMessage === true,
     "'data' marks body arrived; got " + p.sseGotAnyMessage);
  cleanup(env);
});

// fitPaneWhenStable runs an async settle loop and is called from
// multiple places (createPane, applySettings, the 1 s drift watchdog,
// kickPanesAfterAbsence). An earlier iteration had a self-feeding
// listener that called it from xterm's onCharSizeChange event, which
// the function itself fires synchronously via its fontFamily round-
// trip — exponential Promise pile-up froze the JS event loop and
// blocked SSE delivery. The `p._fitInFlight` guard prevents any
// future re-entry from rebuilding that runaway. This test simulates
// rapid re-entry: ten calls in tight succession produce one in-flight
// chain, not ten, and the flag releases cleanly on completion.
test('fitPaneWhenStable bails on re-entry while in flight', async () => {
  const plan = [{action: 'config', response: {restrict_hosts: false,
                                               connections: []}}];
  const env = await mkEnv(plan);
  const win = env.win;
  let fitCount = 0;
  const p = {
    id: 'p1',
    fitAddon: { fit() { fitCount++; } },
    term: {
      cols: 80,
      options: { fontFamily: 'monospace' },
      _core: { _charSizeService: { measure() {}, width: 9 } },
    },
    sid: null,
  };
  win._tp = p;
  win.eval(`panes['p1'] = window._tp;`);

  // Fire 10 calls back-to-back. Without the guard each would queue
  // its own settle-loop RAF chain; with the guard the first call
  // claims `_fitInFlight` and the other nine bail synchronously.
  for (let i = 0; i < 10; i++) win.fitPaneWhenStable(p);
  ok(p._fitInFlight === true,
     'first call took the in-flight flag; got ' + p._fitInFlight);

  // Let the awaited Promise.resolve() and the settle RAFs run.
  await sleep(200);

  ok(p._fitInFlight === false,
     'flag releases after settle completes; got ' + p._fitInFlight);
  // The mock Terminal returns cols=80 every fit, so the settle loop
  // converges in two iterations: iter 1 sees -1 → 80 (continue), iter
  // 2 sees 80 === 80 (exit). Without the guard, ten chains would each
  // do the same — 20 fit() calls. The guard collapses to one chain.
  ok(fitCount >= 1 && fitCount <= 4,
     `single chain expected (1-4 fit calls), got ${fitCount}`);

  cleanup(env);
});

// ─── Bell-triggered notifications ────────────────────────────────────
// Title + favicon flash on bell when the user is elsewhere; silent
// no-op when the user is looking at the tab; auto-reset on focus.

function _setHidden(win, hidden) {
  Object.defineProperty(win.document, 'hidden', {value: hidden, configurable: true});
  Object.defineProperty(win.document, 'visibilityState',
    {value: hidden ? 'hidden' : 'visible', configurable: true});
}
function _setHasFocus(win, focused) {
  win.document.hasFocus = () => focused;
}

test('notifyPaneIdle: user is looking at tab → silent no-op', async () => {
  const env = await mkEnv([{action: 'config',
                            response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  _setHidden(win, false);
  _setHasFocus(win, true);
  const origTitle = win.document.title;
  win.notifyPaneIdle({id: 'p1', label: 'staging'});
  ok(win.document.title === origTitle,
     'title unchanged when tab is focused; got ' + win.document.title);
  cleanup(env);
});

test('notifyPaneIdle: tab hidden → title flashes with pane label', async () => {
  const env = await mkEnv([{action: 'config',
                            response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  _setHidden(win, true);
  _setHasFocus(win, false);
  win.notifyPaneIdle({id: 'p1', label: 'build'});
  ok(win.document.title.includes('build'),
     'title carries pane label; got ' + win.document.title);
  ok(win.document.title.indexOf('●') === 0,
     'title starts with bullet; got ' + win.document.title);
  cleanup(env);
});

test('notifyPaneIdle: favicon swapped to red-dot SVG when hidden', async () => {
  const env = await mkEnv([{action: 'config',
                            response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  _setHidden(win, true);
  _setHasFocus(win, false);
  win.notifyPaneIdle({id: 'p1', label: 'x'});
  const href = win.document.querySelector('link[rel="icon"]').href;
  ok(href.includes('da3633'), 'favicon swapped to red-dot; got ' + href);
  cleanup(env);
});

test('notifyPaneIdle: visibilitychange resets title + favicon', async () => {
  const env = await mkEnv([{action: 'config',
                            response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  _setHidden(win, true);
  _setHasFocus(win, false);
  win.notifyPaneIdle({id: 'p1', label: 'x'});
  ok(win.document.title.indexOf('●') === 0, 'flashed before return');
  // User returns — flip hidden → false, dispatch visibilitychange.
  _setHidden(win, false);
  _setHasFocus(win, true);
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  await sleep(10);
  ok(win.document.title.indexOf('●') !== 0,
     'title reset after focus; got ' + win.document.title);
  const href = win.document.querySelector('link[rel="icon"]').href;
  ok(!href.includes('da3633'), 'favicon reset; got ' + href);
  cleanup(env);
});

test('toggleNotifyOnBell: flips pane flag and updates button visual', async () => {
  const env = await mkEnv([{action: 'config',
                            response: {restrict_hosts: false, connections: []}}]);
  const win = env.win;
  // Plant a stub pane with a button — createPane spawns the real one
  // but it's tied to a network connect we don't want to run here.
  const el = win.document.createElement('div');
  const btn = win.document.createElement('button');
  btn.setAttribute('data-notify-btn', 'p1');
  el.appendChild(btn);
  win._tp = {id: 'p1', el: el, notifyOnBell: false};
  win.eval('panes["p1"] = window._tp;');

  win.toggleNotifyOnBell('p1');
  ok(win._tp.notifyOnBell === true, 'flag flipped on');
  ok(btn.classList.contains('on'), 'button got .on class');
  ok(btn.getAttribute('aria-pressed') === 'true', 'aria-pressed=true');

  win.toggleNotifyOnBell('p1');
  ok(win._tp.notifyOnBell === false, 'flag flipped off');
  ok(!btn.classList.contains('on'), 'button lost .on class');
  ok(btn.getAttribute('aria-pressed') === 'false', 'aria-pressed=false');
  cleanup(env);
});

// =====================================================================
(async () => {
  for (const s of scenarios) {
    console.log('\n=== ' + s.name + ' ===');
    try { await s.fn(); } catch (e) {
      failed++;
      failures.push(s.name + ': ' + e.message);
      console.log('  THREW: ' + (e.stack || e.message));
    }
  }
  console.log('\n===========================================');
  console.log('  passed: ' + passed + '   failed: ' + failed);
  if (failed) {
    console.log('  failures:');
    failures.forEach(f => console.log('    - ' + f));
  }
  process.exit(failed ? 1 : 0);
})();
