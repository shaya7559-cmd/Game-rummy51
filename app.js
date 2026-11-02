/* Rummy 51 — the UI. Every screen is rendered from state; clicks are routed by data-act. */
(function () {
  'use strict';

  const R = window.Rummy;
  const ST = window.RummyStats;
  const SY = window.RummySync;

  const KEY = 'rummy51.v1';
  const GH_KEY = 'rummy51.github';
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 8;
  const MAX_ROUNDS = 40;
  const UNDO_LIMIT = 30;
  const BACKUP_NAG = 10;

  let state = loadState();
  let gh = loadGh();
  let undoStack = [];
  let view = { name: 'home' };
  let stack = [];
  let overlays = [];
  let sheet = null;
  let sheetLayer = null;

  const $view = document.getElementById('view');
  const $overlay = document.getElementById('overlay-root');

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const signed = (n) => (n > 0 ? '+' + n : String(n));
  const pct = (x) => Math.round(x * 100) + '%';
  const round1 = (x) => String(Math.round(x * 10) / 10);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const names = (g) => g.players.map((p) => p.name);
  const findGame = (id) => state.history.find((g) => g.id === id);

  function fmtDate(iso, long) {
    const opts = long
      ? { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' }
      : { day: 'numeric', month: 'numeric', year: '2-digit' };
    return new Date(iso).toLocaleDateString('he-IL', opts);
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ---------- storage ----------
  function loadState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* empty or blocked storage */ }
    if (!s || !Array.isArray(s.history)) s = { current: null, history: [], lastPlayers: [], backupCount: 0 };
    s.sync = Object.assign(SY.emptySync(), s.sync || {});
    return s;
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('השמירה במכשיר נכשלה'); }
  }

  function loadGh() {
    try {
      const g = JSON.parse(localStorage.getItem(GH_KEY));
      return g && g.owner && g.repo && g.token ? g : null;
    } catch (e) {
      return null;
    }
  }

  function saveGh(g) {
    gh = g;
    try {
      if (g) localStorage.setItem(GH_KEY, JSON.stringify(g));
      else localStorage.removeItem(GH_KEY);
    } catch (e) { /* storage blocked */ }
  }

  // ---------- current game changes (undoable) ----------
  function changeCurrent(fn) {
    undoStack.push(JSON.stringify(state.current));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    const out = fn(state.current);
    currentSaved();
    return out;
  }

  function currentSaved() {
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    render();
  }

  function undo() {
    if (!undoStack.length) return;
    state.current = JSON.parse(undoStack.pop());
    R.touch(state.current);
    currentSaved();
    toast('הפעולה האחרונה בוטלה');
  }

  // ---------- navigation ----------
  function go(name, params) {
    if (view.name === name && !params) return;
    stack.push(view);
    view = Object.assign({ name }, params || {});
    history.pushState({ rummy: 1 }, '');
    render();
    window.scrollTo(0, 0);
  }

  function replace(name, params) {
    view = Object.assign({ name }, params || {});
    render();
    window.scrollTo(0, 0);
  }

  function goHome() {
    stack = [];
    replace('home');
  }

  function back() {
    if (stack.length) history.back();
    else goHome();
  }

  // The phone's back button closes an open sheet or dialog before it leaves the screen.
  window.addEventListener('popstate', () => {
    if (overlays.length) {
      removeLayer(overlays[overlays.length - 1]);
      history.pushState({ rummy: 1 }, '');
      return;
    }
    view = stack.length ? stack.pop() : { name: 'home' };
    render();
  });

  // ---------- overlays ----------
  function addLayer(html, onClose) {
    const el = document.createElement('div');
    el.innerHTML = html;
    $overlay.appendChild(el);
    const layer = { el, onClose };
    overlays.push(layer);
    return layer;
  }

  function removeLayer(layer) {
    const i = overlays.indexOf(layer);
    if (i < 0) return;
    overlays.splice(i, 1);
    layer.el.remove();
    if (layer.onClose) layer.onClose();
  }

  // Resolves with the clicked button's value, or opts.cancel when dismissed.
  function ask(opts) {
    return new Promise((resolve) => {
      const cancel = 'cancel' in opts ? opts.cancel : false;
      const buttons = opts.buttons.map((b, i) => `<button class="btn ${b.kind || ''}" data-dlg="${i}">${esc(b.label)}</button>`).join('');
      const layer = addLayer(`
        <div class="backdrop dialog-backdrop" data-dlg="cancel"></div>
        <div class="dialog" role="alertdialog" aria-modal="true">
          <h2>${esc(opts.title)}</h2>
          ${opts.body ? `<p>${opts.body}</p>` : ''}
          <div class="row${opts.buttons.length > 2 ? ' col' : ''}">${buttons}</div>
        </div>`, () => resolve(cancel));
      layer.el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-dlg]');
        if (!t) return;
        const value = t.dataset.dlg === 'cancel' ? cancel : opts.buttons[+t.dataset.dlg].value;
        resolve(value);
        removeLayer(layer);
      });
    });
  }

  // ---------- git sync ----------
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;

  function scheduleSync(delay) {
    renderSyncBadge();
    if (!gh) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, delay == null ? 1200 : delay);
  }

  async function runSync() {
    if (!gh) return;
    if (syncing) { syncAgain = true; return; }
    if (!SY.pending(state)) { renderSyncBadge(); return; }
    syncing = true;
    renderSyncBadge();
    try {
      await SY.flush(state, gh);
    } catch (e) {
      state.sync.lastError = e.message;
    }
    syncing = false;
    persist();
    renderSyncBadge();
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }

  async function pullFromGit(quiet) {
    if (!gh || syncing) return;
    syncing = true;
    renderSyncBadge();
    let remoteCurrent = null;
    try {
      const res = await SY.pull(state, gh);
      remoteCurrent = res.remoteCurrent;
      persist();
      if (res.added) toast('נטענו מגיט ' + res.added + ' משחקים');
      else if (!quiet) toast('הסנכרון הסתיים');
    } catch (e) {
      state.sync.lastError = e.message;
      persist();
      if (!quiet) toast(e.message);
    }
    syncing = false;
    await offerRemoteCurrent(remoteCurrent);
    render();
    scheduleSync(0);
  }

  // A game in progress saved from another phone can be continued here.
  async function offerRemoteCurrent(remote) {
    if (!remote || remote.finishedAt || !Array.isArray(remote.rounds)) return;
    if (findGame(remote.id)) return;
    const local = state.current;
    if (local && local.id === remote.id) {
      if ((remote.updatedAt || '') > (local.updatedAt || '')) {
        state.current = remote;
        undoStack = [];
        state.sync.syncedVersion = state.sync.currentVersion;
        persist();
        toast('המשחק הפתוח עודכן מגיט');
      }
      return;
    }
    if (local && (local.updatedAt || '') >= (remote.updatedAt || '')) return;
    const take = await ask({
      title: 'נמצא בגיט משחק פתוח',
      body: `${esc(names(remote).join(', '))} · שוחקו ${R.playedCount(remote)} תורים.<br>להמשיך אותו בטלפון הזה?${local ? ' המשחק הפתוח כאן יוחלף.' : ''}`,
      buttons: [{ label: 'המשך אותו כאן', value: true, kind: 'primary' }, { label: 'לא', value: false }]
    });
    if (!take) return;
    state.current = remote;
    undoStack = [];
    state.sync.syncedVersion = state.sync.currentVersion;
    persist();
    if (!stack.length) history.pushState({ rummy: 1 }, '');
    stack = [{ name: 'home' }];
    view = { name: 'game' };
  }

  function syncStatusText() {
    const s = state.sync;
    const n = SY.pending(state);
    if (syncing) return 'שומר בגיט…';
    if (s.lastError && n) return `לא נשמר: ${s.lastError}. ממתינים לשמירה: ${n}`;
    if (n) return 'ממתינים לשמירה: ' + n;
    return s.lastSyncAt ? 'הכול שמור בגיט · סנכרון אחרון ' + fmtTime(s.lastSyncAt) : 'הכול שמור בגיט';
  }

  function renderSyncBadge() {
    const b = document.getElementById('sync-badge');
    if (!gh) { b.hidden = true; return; }
    const n = SY.pending(state);
    b.hidden = false;
    b.classList.toggle('err', !!state.sync.lastError && n > 0 && !syncing);
    b.textContent = syncing ? 'גיט ⟳' : state.sync.lastError && n ? 'גיט ⚠' : n ? 'גיט · ' + n : 'גיט ✓';
    const status = document.getElementById('sync-status');
    if (status) status.textContent = syncStatusText();
  }

  window.addEventListener('online', () => scheduleSync(0));

  // ---------- rendering ----------
  const VIEWS = {};

  function render() {
    const fn = VIEWS[view.name] || VIEWS.home;
    $view.innerHTML = fn();
    document.getElementById('btn-back').hidden = view.name === 'home';
    renderSyncBadge();
  }

  function rankList(g, withPlace) {
    return '<ol class="mini-rank">' + R.ranking(g).map((r) =>
      `<li>${withPlace ? r.place + '. ' : ''}${esc(r.player.name)} <b class="num">${r.total}</b></li>`).join('') + '</ol>';
  }

  function lastWinnerCard(g) {
    const winner = R.ranking(g)[0].player.name;
    return `
      <button class="card" data-act="view-game" data-id="${g.id}">
        <div class="label">ניצח בפעם הקודמת</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${fmtDate(g.finishedAt, true)} · ${g.rounds.length} תורים</div>
        ${rankList(g, false)}
      </button>`;
  }

  function backupNag() {
    const unsaved = state.history.length - (state.backupCount || 0);
    if (gh || unsaved < BACKUP_NAG) return '';
    return `
      <button class="card warn" data-act="go" data-to="settings">
        <b>${unsaved} משחקים לא מגובים</b>
        <div class="muted">הם שמורים רק בטלפון הזה. חבר את האפליקציה לגיט או ייצא קובץ גיבוי.</div>
      </button>`;
  }

  VIEWS.home = () => {
    const g = state.current;
    let h = '';
    if (g) {
      const i = R.currentIndex(g);
      h += `
        <button class="card" data-act="go" data-to="game">
          <div class="label">משחק פתוח</div>
          <div class="winner-name" style="font-size:1.25rem">${i >= 0 ? `תור ${i + 1} מתוך ${g.rounds.length}` : 'כל התורים שוחקו'}</div>
          <div class="muted">${esc(names(g).join(' · '))}</div>
        </button>
        <button class="btn primary big" data-act="go" data-to="game">המשך משחק</button>
        <div class="row"><button class="btn" data-act="new-game">משחק חדש</button></div>`;
    } else {
      h += '<button class="btn primary big" data-act="new-game">משחק חדש</button>';
    }
    const last = ST.lastGame(state.history);
    if (last) h += '<div style="height:12px"></div>' + lastWinnerCard(last);
    h += backupNag();
    h += `
      <div class="grid-3">
        <button class="btn" data-act="go" data-to="reports"><span class="ic">📊</span>דוחות</button>
        <button class="btn" data-act="go" data-to="history"><span class="ic">🗂️</span>היסטוריה</button>
        <button class="btn" data-act="go" data-to="settings"><span class="ic">☁️</span>גיט וגיבוי</button>
      </div>`;
    return h;
  };

  // ---------- setup ----------
  VIEWS.setup = () => {
    const known = ST.playerNames(state.history);
    const rows = view.names.map((n, i) => `
      <li>
        <button class="deal-chip${view.firstDealer === i ? ' on' : ''}" data-act="pick-dealer" data-i="${i}" aria-pressed="${view.firstDealer === i}">מחלק</button>
        <input class="pname" data-i="${i}" value="${esc(n)}" placeholder="שחקן ${i + 1}" list="known-names" maxlength="20" autocomplete="off" enterkeyhint="next">
        <button class="btn icon" data-act="move" data-i="${i}" data-d="-1" aria-label="הזז למעלה"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn icon" data-act="move" data-i="${i}" data-d="1" aria-label="הזז למטה"${i === view.names.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="btn icon danger" data-act="remove-player" data-i="${i}" aria-label="הסר"${view.names.length <= MIN_PLAYERS ? ' disabled' : ''}>✕</button>
      </li>`).join('');
    return `
      <h2>שחקנים</h2>
      <p class="muted">לפי סדר הישיבה, כי החלוקה עוברת לפי הסדר. לחץ "מחלק" ליד מי שמחלק ראשון.</p>
      <ul class="player-list">${rows}</ul>
      <datalist id="known-names">${known.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${view.names.length < MAX_PLAYERS ? '<button class="btn block" data-act="add-player">+ הוסף שחקן</button>' : ''}
      <div class="field-row">
        <b>מספר תורים</b>
        <div class="stepper">
          <button class="btn" data-act="rounds" data-d="-1" aria-label="פחות">−</button>
          <span class="val num">${view.rounds}</span>
          <button class="btn" data-act="rounds" data-d="1" aria-label="יותר">+</button>
        </div>
      </div>
      <p class="muted">גלוק אוטומטי בכל תור רביעי (4, 8, 12…). אפשר להוסיף תורים או לסיים מוקדם תוך כדי משחק.</p>
      <button class="btn primary big" data-act="start-game">התחל משחק</button>
      <p class="error" id="setup-error"></p>`;
  };

  function startSetup(list) {
    const ns = (list || []).slice(0, MAX_PLAYERS);
    while (ns.length < MIN_PLAYERS) ns.push('');
    go('setup', { names: ns, firstDealer: 0, rounds: R.DEFAULT_ROUNDS });
  }

  function movePlayer(i, d) {
    const j = i + d;
    if (j < 0 || j >= view.names.length) return;
    const n = view.names;
    [n[i], n[j]] = [n[j], n[i]];
    if (view.firstDealer === i) view.firstDealer = j;
    else if (view.firstDealer === j) view.firstDealer = i;
    render();
  }

  function removePlayer(i) {
    if (view.names.length <= MIN_PLAYERS) return;
    view.names.splice(i, 1);
    if (view.firstDealer === i) view.firstDealer = 0;
    else if (view.firstDealer > i) view.firstDealer--;
    render();
  }

  function startGame() {
    const ns = view.names.map(R.cleanName);
    let err = '';
    if (ns.some((n) => !n)) err = 'יש שורה בלי שם. מלא אותה או הסר אותה.';
    else {
      const dup = ns.find((n, i) => ns.indexOf(n) !== i);
      if (dup) err = `השם "${dup}" מופיע פעמיים`;
    }
    if (err) { document.getElementById('setup-error').textContent = err; return; }
    const first = ns[view.firstDealer];
    state.current = R.newGame(ns, { firstDealer: view.firstDealer, rounds: view.rounds });
    state.lastPlayers = ns;
    undoStack = [];
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    stack = [{ name: 'home' }];
    replace('game');
    toast('בהצלחה! ' + first + ' מחלק ראשון');
  }

  async function newGame() {
    if (state.current) {
      const played = R.playedCount(state.current);
      const buttons = [];
      if (played) buttons.push({ label: 'לסיים ולשמור אותו', value: 'finish', kind: 'primary' });
      buttons.push({ label: 'למחוק אותו', value: 'discard', kind: 'danger' }, { label: 'ביטול', value: null });
      const choice = await ask({ title: 'יש משחק פתוח', body: 'מה לעשות עם המשחק הפתוח לפני שמתחילים חדש?', buttons, cancel: null });
      if (!choice) return;
      if (choice === 'finish') {
        const g = await finishGame({ show: false });
        if (!g) return;
        toast('המשחק נשמר · ניצח ' + R.playerById(g, g.winnerId).name);
      } else if (!(await confirmDiscard())) {
        return;
      }
    }
    startSetup(state.lastPlayers);
  }

  async function confirmDiscard() {
    const ok = await ask({
      title: 'למחוק את המשחק הפתוח?',
      body: 'הניקוד של המשחק הזה יימחק ולא יישמר בהיסטוריה.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return false;
    state.current = null;
    undoStack = [];
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    return true;
  }

  // ---------- game screen ----------
  const GLUCK_REASON = { auto: 'גלוק קבוע (כל תור רביעי)', fresh: 'גלוק בגלל פריש', manual: 'גלוק שנקבע ידנית' };

  function statusNotes(r) {
    const parts = [];
    if (r.gluck) parts.push(GLUCK_REASON[r.gluckSource] || 'גלוק');
    if (r.freshCount) parts.push('פרישים בתור הזה: ' + r.freshCount);
    if (!parts.length) parts.push('תור רגיל');
    return parts.map(esc).join(' · ');
  }

  VIEWS.game = () => {
    const g = state.current;
    if (!g) { view = { name: 'home' }; return VIEWS.home(); }
    const i = R.currentIndex(g);
    const played = R.playedCount(g);
    let h = '';
    if (i >= 0) {
      const r = g.rounds[i];
      h += `
        <section class="status${r.gluck ? ' is-gluck' : ''}">
          <div class="status-top">
            <span class="round-no">תור ${i + 1} <span class="muted">מתוך ${g.rounds.length}</span></span>
            ${r.gluck ? '<span class="gluck-badge">✕ גלוק</span>' : ''}
          </div>
          <div class="dealer">מחלק: ${esc(R.dealer(g, i).name)}</div>
          <div class="notes muted">${statusNotes(r)}</div>
        </section>
        <button class="btn primary big" data-act="open-round" data-i="${i}">סיום תור ${i + 1}</button>
        <div class="row">
          <button class="btn" data-act="fresh">פריש</button>
          <button class="btn${r.gluck ? ' gluck-on' : ''}" data-act="toggle-gluck" data-i="${i}">${r.gluck ? 'בטל גלוק' : 'הפוך לגלוק'}</button>
        </div>`;
    } else {
      const lead = R.leaders(g);
      h += `
        <section class="status">
          <div class="round-no">כל ${g.rounds.length} התורים שוחקו</div>
          <div class="dealer">${lead.length > 1 ? 'תיקו: ' + esc(lead.map((p) => p.name).join(' ו')) : 'מוביל: ' + esc(lead[0].name)}</div>
          ${rankList(g, false)}
        </section>
        <button class="btn primary big" data-act="finish">סיים ושמור</button>`;
    }
    h += scoreTableHtml(g, true);
    h += `
      <div class="legend">
        <span>✕ תור גלוק (×2)</span><span>★ ניצח בהאנט (×2)</span><span>פ = היה פריש</span><span>לחיצה על שורה = עריכה</span>
      </div>
      <div class="row">
        <button class="btn" data-act="undo"${undoStack.length ? '' : ' disabled'}>↶ בטל פעולה</button>
        <button class="btn" data-act="add-round">+ הוסף תור</button>
      </div>`;
    if (i >= 0 && played) h += '<button class="btn block" data-act="finish-early">סיים משחק עכשיו</button>';
    if (!played) h += '<button class="btn block danger" data-act="discard">מחק משחק</button>';
    return h;
  };

  function scoreTableHtml(g, editable) {
    const table = R.scoreTable(g);
    const cur = editable ? R.currentIndex(g) : -1;
    const played = R.playedCount(g);
    let h = '<div class="table-wrap"><table class="score"><thead><tr><th class="c-no">#</th><th class="c-gl" title="גלוק">✕</th>';
    g.players.forEach((p) => { h += `<th>${esc(p.name)}</th>`; });
    h += '</tr></thead><tbody>';
    g.rounds.forEach((r, i) => {
      const row = table.rows[i];
      const res = r.result;
      const cls = [r.gluck ? 'gluck' : '', i === cur ? 'current' : '', res ? 'played' : ''].join(' ').trim();
      h += `<tr class="${cls}"${editable && res ? ` data-act="open-round" data-i="${i}"` : ''}>`;
      h += `<td class="c-no">${i + 1}${r.freshCount ? '<span class="fresh-mark">פ</span>' : ''}</td>`;
      h += editable && !res
        ? `<td class="c-gl toggle" data-act="toggle-gluck" data-i="${i}">${r.gluck ? '✕' : ''}</td>`
        : `<td class="c-gl">${r.gluck ? '✕' : ''}</td>`;
      g.players.forEach((p, pi) => {
        if (res) {
          const win = p.id === res.winnerId;
          h += `<td${win ? ' class="win"' : ''}><span class="tot num">${row.totals[p.id]}</span><span class="delta num">${signed(row.scores[p.id])}${win && res.hand ? ' ★' : ''}</span></td>`;
        } else if (i === cur && R.dealerIndex(g, i) === pi) {
          h += '<td><span class="deal-mark">מחלק</span></td>';
        } else {
          h += '<td></td>';
        }
      });
      h += '</tr>';
    });
    h += '</tbody>';
    if (played) {
      const min = Math.min(...g.players.map((p) => table.totals[p.id]));
      const isLead = (p) => (g.winnerId ? p.id === g.winnerId : table.totals[p.id] === min);
      h += '<tfoot><tr><th colspan="2">סה״כ</th>' +
        g.players.map((p) => `<th class="num${isLead(p) ? ' lead' : ''}">${table.totals[p.id]}</th>`).join('') + '</tr></tfoot>';
    }
    return h + '</table></div>';
  }

  async function fresh() {
    const g = state.current;
    const i = R.currentIndex(g);
    if (i < 0) return;
    const dealerName = R.dealer(g, i).name;
    const res = changeCurrent((game) => R.declareFresh(game));
    if (res.needsExtraRound) {
      const add = await ask({
        title: 'כל התורים שנותרו כבר גלוק',
        body: 'הפריש צריך להפוך תור לגלוק, אבל אין תור פנוי. להוסיף תור גלוק בסוף המשחק?',
        buttons: [{ label: 'הוסף תור גלוק', value: true, kind: 'primary' }, { label: 'לא להוסיף', value: false }]
      });
      if (add) {
        R.addRound(state.current, 'fresh');
        currentSaved();
      }
      toast('פריש! ' + dealerName + ' מחלק שוב');
      return;
    }
    toast('פריש! ' + dealerName + ' מחלק שוב · ' + (res.gluckIndex === i ? 'התור הזה גלוק' : 'תור ' + (res.gluckIndex + 1) + ' הפך לגלוק'));
  }

  function toggleGluck(i) {
    const on = !state.current.rounds[i].gluck;
    changeCurrent((g) => R.setGluck(g, i, on));
    toast('תור ' + (i + 1) + (on ? ' הפך לגלוק' : ' כבר לא גלוק'));
  }

  function addRound() {
    const idx = changeCurrent((g) => R.addRound(g));
    toast('נוסף תור ' + (idx + 1) + (state.current.rounds[idx].gluck ? ' (גלוק)' : ''));
  }

  // ---------- round entry sheet ----------
  function openRound(i) {
    const r = state.current.rounds[i];
    sheet = { i, gluck: r.gluck, isEdit: !!r.result, res: r.result ? clone(r.result) : { winnerId: null, hand: false, entries: {} } };
    sheetLayer = addLayer('<div class="backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" id="sheet"></div>', () => {
      sheet = null;
      sheetLayer = null;
    });
    renderSheet();
  }

  function closeSheet() {
    if (sheetLayer) removeLayer(sheetLayer);
  }

  function renderSheet(focusPid) {
    const g = state.current;
    const s = sheet;
    const res = s.res;
    let h = `<h2>${s.isEdit ? 'עריכת' : 'סיום'} תור ${s.i + 1}</h2>
      <div class="label-line">מי ניצח?</div>
      <div class="chips">${g.players.map((p) => `<button class="chip${res.winnerId === p.id ? ' on' : ''}" data-act="pick-winner" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      <label class="toggle-line"><input type="checkbox" data-field="hand"${res.hand ? ' checked' : ''}> ניצח בהאנט (×2)</label>
      <label class="toggle-line"><input type="checkbox" data-field="gluck"${s.gluck ? ' checked' : ''}> תור גלוק (×2)</label>`;
    if (res.winnerId) {
      h += '<div class="label-line">נקודות הקלפים שנשארו ביד</div>';
      g.players.forEach((p) => {
        if (p.id === res.winnerId) return;
        const e = res.entries[p.id] || (res.entries[p.id] = { points: '', noSet: false });
        h += `
          <div class="entry">
            <span class="ename">${esc(p.name)}</span>
            <input class="pts" data-pid="${p.id}" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" placeholder="נק׳" value="${e.noSet ? '' : esc(e.points)}"${e.noSet ? ' disabled' : ''}>
            <button class="chip sm noset${e.noSet ? ' on' : ''}" data-act="toggle-noset" data-id="${p.id}">לא הוריד</button>
            <span class="pv num" id="pv-${p.id}"></span>
          </div>`;
      });
      h += `<div class="entry"><span class="ename">🏆 ${esc(R.playerById(g, res.winnerId).name)}</span><span></span><span></span><span class="pv num" id="pv-${res.winnerId}"></span></div>`;
    } else {
      h += '<p class="muted" style="margin-top:12px">בחר מנצח, ואז הזן את הנקודות של שאר השחקנים.</p>';
    }
    h += `<p class="mult" id="sheet-mult"></p>
      <p class="error" id="sheet-error"></p>
      <div class="row">
        <button class="btn primary" data-act="save-round">שמור</button>
        <button class="btn" data-act="close-sheet">ביטול</button>
      </div>`;
    if (s.isEdit && s.i === R.playedCount(g) - 1) h += '<button class="btn block danger" data-act="clear-round">מחק את תוצאת התור</button>';
    document.getElementById('sheet').innerHTML = h;
    updateSheetPreview();
    if (focusPid) {
      const el = document.querySelector(`.pts[data-pid="${focusPid}"]`);
      if (el) el.focus();
    }
  }

  function updateSheetPreview() {
    const g = state.current;
    const s = sheet;
    const res = s.res;
    const m = R.multiplier(s.gluck, res.hand);
    const parts = [];
    if (s.gluck) parts.push('גלוק');
    if (res.hand) parts.push('האנט');
    document.getElementById('sheet-mult').textContent = m > 1 ? `מכפיל ×${m} (${parts.join(' + ')})` : 'בלי מכפיל';
    if (!res.winnerId) return;
    g.players.forEach((p) => {
      const el = document.getElementById('pv-' + p.id);
      if (!el) return;
      const e = res.entries[p.id];
      const filled = p.id === res.winnerId || (e && (e.noSet || (e.points !== '' && e.points != null)));
      el.textContent = filled ? signed(R.playerRoundPoints({ gluck: s.gluck }, res, p.id)) : '';
    });
  }

  function pickWinner(id) {
    sheet.res.winnerId = id;
    const g = state.current;
    const firstEmpty = g.players.find((p) => {
      if (p.id === id) return false;
      const e = sheet.res.entries[p.id];
      return !e || (!e.noSet && (e.points === '' || e.points == null));
    });
    renderSheet(firstEmpty && firstEmpty.id);
  }

  function toggleNoSet(btn, pid) {
    const e = sheet.res.entries[pid];
    e.noSet = !e.noSet;
    if (!e.noSet) e.points = '';
    btn.classList.toggle('on', e.noSet);
    const input = document.querySelector(`.pts[data-pid="${pid}"]`);
    input.disabled = e.noSet;
    input.value = '';
    if (!e.noSet) input.focus();
    document.getElementById('sheet-error').textContent = '';
    updateSheetPreview();
  }

  function saveRound() {
    const g = state.current;
    const { i, gluck, res, isEdit } = sheet;
    const err = R.validateResult(g, res);
    if (err) { document.getElementById('sheet-error').textContent = err; return; }
    closeSheet();
    changeCurrent((game) => {
      if (game.rounds[i].gluck !== gluck) R.setGluck(game, i, gluck);
      R.setResult(game, i, res);
    });
    if (isEdit) { toast('תור ' + (i + 1) + ' עודכן'); return; }
    const next = R.currentIndex(state.current);
    if (next < 0) {
      toast('כל התורים שוחקו!');
    } else {
      const nr = state.current.rounds[next];
      toast(`תור ${next + 1}: ${R.dealer(state.current, next).name} מחלק${nr.gluck ? ' · גלוק ✕' : ''}`);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearRound() {
    const i = sheet.i;
    closeSheet();
    changeCurrent((g) => R.clearResult(g, i));
    toast('תוצאת תור ' + (i + 1) + ' נמחקה');
  }

  // ---------- finishing ----------
  async function finishGame(opts) {
    opts = opts || {};
    const g = state.current;
    if (!R.playedCount(g)) {
      if (await confirmDiscard()) goHome();
      return null;
    }
    const lead = R.leaders(g);
    let winnerId = lead[0].id;
    if (lead.length > 1) {
      winnerId = await ask({
        title: 'תיקו בראש הטבלה',
        body: esc(lead.map((p) => p.name).join(' ו')) + ' סיימו עם אותו ניקוד. מי המנצח?',
        buttons: lead.map((p) => ({ label: p.name, value: p.id, kind: 'primary' })).concat([{ label: 'ביטול', value: null }]),
        cancel: null
      });
      if (!winnerId) return null;
    }
    R.finishGame(g, winnerId);
    state.history.push(g);
    state.current = null;
    state.lastPlayers = names(g);
    state.sync.unsyncedGames.push(g.id);
    state.sync.currentVersion++;
    undoStack = [];
    persist();
    scheduleSync(0);
    if (opts.show !== false) {
      stack = [{ name: 'home' }];
      replace('game-detail', { id: g.id, justFinished: true });
    }
    return g;
  }

  async function finishEarly() {
    const g = state.current;
    const ok = await ask({
      title: 'לסיים את המשחק עכשיו?',
      body: `שוחקו ${R.playedCount(g)} מתוך ${g.rounds.length} תורים. התורים שלא שוחקו לא יישמרו, והמנצח ייקבע לפי הניקוד עד עכשיו.`,
      buttons: [{ label: 'סיים ושמור', value: true, kind: 'primary' }, { label: 'ביטול', value: false }]
    });
    if (ok) await finishGame();
  }

  // ---------- history ----------
  VIEWS.history = () => {
    const list = ST.finished(state.history).reverse();
    if (!list.length) return '<p class="empty">עוד אין משחקים שמורים.<br>כל משחק שמסתיים יופיע כאן.</p>';
    return `<h2>היסטוריה <span class="muted">(${list.length})</span></h2><ul class="list">` + list.map((g) => {
      const rank = R.ranking(g);
      return `
        <li><button class="card" data-act="view-game" data-id="${g.id}">
          <div class="hist-top"><span>${fmtDate(g.finishedAt, true)}</span><span>${g.rounds.length} תורים${g.endedEarly ? ' · הסתיים מוקדם' : ''}</span></div>
          <div class="hist-winner">🏆 ${esc(rank[0].player.name)} <span class="num">${rank[0].total}</span></div>
          <div class="muted">${rank.slice(1).map((r) => `${esc(r.player.name)} <span class="num">${r.total}</span>`).join(' · ')}</div>
        </button></li>`;
    }).join('') + '</ul>';
  };

  VIEWS['game-detail'] = () => {
    const g = findGame(view.id);
    if (!g) return '<p class="empty">המשחק לא נמצא.</p>';
    const winner = R.ranking(g)[0].player.name;
    let h = `
      <section class="card">
        <div class="label">${view.justFinished ? 'המשחק הסתיים 🎉' : fmtDate(g.finishedAt, true)}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${g.rounds.length} תורים${g.endedEarly ? ` (הסתיים מוקדם, תוכננו ${g.plannedRounds})` : ''}</div>
        ${rankList(g, true)}
      </section>`;
    h += scoreTableHtml(g, false);
    if (view.justFinished) {
      h += `<button class="btn primary big" data-act="rematch" data-id="${g.id}">משחק חדש עם אותם שחקנים</button>
        <div class="row"><button class="btn" data-act="home">למסך הראשי</button></div>`;
    }
    h += `<button class="btn block danger" data-act="delete-game" data-id="${g.id}">מחק את המשחק מההיסטוריה</button>`;
    return h;
  };

  async function deleteGame(id) {
    const g = findGame(id);
    if (!g) return;
    const ok = await ask({
      title: 'למחוק את המשחק?',
      body: 'המשחק יימחק מההיסטוריה ומהדוחות' + (gh ? ' וגם מגיט' : '') + '.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    state.history = state.history.filter((x) => x.id !== id);
    const u = state.sync.unsyncedGames.indexOf(id);
    if (u >= 0) state.sync.unsyncedGames.splice(u, 1);
    else state.sync.deletedGames.push(SY.gamePath(g));
    persist();
    scheduleSync(0);
    toast('המשחק נמחק');
    back();
  }

  // ---------- reports ----------
  const PERIODS = [['all', 'הכול'], ['year', 'השנה'], ['30d', '30 יום']];
  const TABS = [['winners', 'מנצחים'], ['points', 'נקודות'], ['players', 'שחקנים'], ['general', 'כללי'], ['h2h', 'ראש בראש']];

  // Single-series horizontal bars that grow from the zero line (values may be negative).
  function barChart(items) {
    const vals = items.map((it) => it.value);
    const min = Math.min(0, ...vals);
    const max = Math.max(0, ...vals);
    const span = max - min || 1;
    const zero = (-min / span) * 100;
    return '<div class="bars">' + items.map((it) => {
      const w = (Math.abs(it.value) / span) * 100;
      const start = it.value >= 0 ? zero : zero - w;
      return `
        <div class="bar-row" title="${esc(it.label + ': ' + it.text)}">
          <span class="bl">${esc(it.label)}</span>
          <div class="bar-track">
            ${min < 0 ? `<span class="bar-zero" style="inset-inline-start:${zero}%"></span>` : ''}
            <span class="bar ${it.value >= 0 ? 'pos' : 'neg'}" style="inset-inline-start:${start}%;width:${w}%"></span>
          </div>
          <span class="bv num">${esc(it.text)}</span>
        </div>`;
    }).join('') + '</div>';
  }

  const li = (label, value) => `<li><span>${label}</span><b>${value}</b></li>`;

  const REPORTS = {
    winners(sum, games) {
      const last = ST.lastGame(games);
      let h = last ? lastWinnerCard(last) : '';
      h += `<section class="card"><h3>טבלת מנצחים</h3><div class="table-scroll"><table class="data">
        <thead><tr><th>#</th><th>שחקן</th><th>ניצחונות</th><th>משחקים</th><th>אחוז</th><th>מקום ממוצע</th></tr></thead><tbody>`;
      sum.players.forEach((s, i) => {
        h += `<tr${i === 0 && s.wins ? ' class="top1"' : ''}><td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.wins}</td><td>${s.games}</td><td>${pct(s.winPct)}</td><td>${round1(s.avgPlace)}</td></tr>`;
      });
      h += '</tbody></table></div></section>';
      h += '<section class="card"><h3>ניצחונות במשחקים</h3>' +
        barChart(sum.players.map((s) => ({ label: s.name, value: s.wins, text: String(s.wins) }))) + '</section>';
      return h;
    },

    points(sum) {
      const list = sum.players.slice().sort((a, b) => a.avgPoints - b.avgPoints);
      let h = `<section class="card"><h3>כלל הנקודות</h3><div class="table-scroll"><table class="data">
        <thead><tr><th>#</th><th>שחקן</th><th>סה״כ</th><th>ממוצע</th><th>הכי טוב</th><th>הכי גרוע</th></tr></thead><tbody>`;
      list.forEach((s, i) => {
        h += `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td class="num">${s.totalPoints}</td><td class="num">${Math.round(s.avgPoints)}</td><td class="num">${s.best}</td><td class="num">${s.worst}</td></tr>`;
      });
      h += '</tbody></table></div><p class="muted" style="margin-top:8px">ברמי 51 פחות נקודות זה טוב יותר.</p></section>';
      h += '<section class="card"><h3>ממוצע נקודות למשחק</h3>' +
        barChart(list.map((s) => ({ label: s.name, value: Math.round(s.avgPoints), text: String(Math.round(s.avgPoints)) }))) + '</section>';
      return h;
    },

    players(sum) {
      return sum.players.map((s) => `
        <section class="card">
          <h3>${esc(s.name)} <span class="muted">· ${s.games} משחקים</span></h3>
          <ul class="stat-list">
            ${li('ניצחונות במשחקים', `${s.wins} (${pct(s.winPct)})`)}
            ${li('רצף ניצחונות שיא', s.longestStreak)}
            ${li('רצף ניצחונות נוכחי', s.currentStreak)}
            ${li('תורים שניצח', `${s.roundsWon} מתוך ${s.roundsPlayed} (${pct(s.roundWinPct)})`)}
            ${li('ניצחונות בהאנט', s.handWins)}
            ${li('ניצחונות בתור גלוק', s.gluckWins)}
            ${li('פעמים שלא הוריד (100)', s.hundreds)}
            ${li('ממוצע נקודות בתור שהפסיד', round1(s.avgLoss))}
            ${li('מקום ממוצע', round1(s.avgPlace))}
          </ul>
        </section>`).join('');
    },

    general(sum) {
      const g = sum.general;
      return `
        <section class="card"><ul class="stat-list">
          ${li('משחקים', g.games)}
          ${li('תורים', g.rounds)}
          ${li('תורי גלוק', g.gluckRounds)}
          ${li('פרישים', g.freshes)}
          ${li('ניצחונות בהאנט', g.handWins)}
          ${li('משחקים שהסתיימו מוקדם', g.endedEarly)}
          ${g.mostWins ? li('הכי הרבה ניצחונות', `${esc(g.mostWins.name)} (${g.mostWins.wins})`) : ''}
          ${g.longestStreak ? li('רצף הניצחונות הארוך ביותר', `${esc(g.longestStreak.name)} (${g.longestStreak.length} ברצף)`) : ''}
          ${g.costliestRound ? li('התור היקר ביותר', `${esc(g.costliestRound.name)}: ${g.costliestRound.points} נק׳ (${fmtDate(g.costliestRound.date)}, תור ${g.costliestRound.round})`) : ''}
        </ul></section>`;
    },

    h2h(sum, games) {
      const ns = ST.playerNames(games);
      if (ns.length < 2) return '<p class="empty">צריך לפחות שני שחקנים.</p>';
      const a = ns.includes(view.h2hA) ? view.h2hA : ns[0];
      const b = ns.includes(view.h2hB) && view.h2hB !== a ? view.h2hB : ns.find((n) => n !== a);
      const opts = (sel) => ns.map((n) => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
      const r = ST.headToHead(games, a, b);
      let h = `
        <section class="card form">
          <div class="h2h">
            <select data-field="h2hA" aria-label="שחקן ראשון">${opts(a)}</select>
            <b style="padding-bottom:12px">נגד</b>
            <select data-field="h2hB" aria-label="שחקן שני">${opts(b)}</select>
          </div>`;
      if (!r.together) {
        h += '<p class="empty">השניים לא שיחקו יחד בתקופה הזו.</p>';
      } else {
        h += `
          <div class="h2h-score">
            <div><div class="big">${r.a}</div>${esc(a)}</div>
            <div class="muted">${r.together} משחקים יחד</div>
            <div><div class="big">${r.b}</div>${esc(b)}</div>
          </div>
          <p class="muted" style="text-align:center">כמה פעמים כל אחד סיים עם פחות נקודות מהשני${r.even ? ` · שוויון: ${r.even}` : ''}</p>`;
      }
      return h + '</section>';
    }
  };

  VIEWS.reports = () => {
    view.period = view.period || 'all';
    view.tab = view.tab || 'winners';
    const all = ST.finished(state.history);
    if (!all.length) return '<p class="empty">הדוחות יופיעו אחרי שתסיימו ותשמרו את המשחק הראשון.</p>';
    let h = backupNag();
    h += '<div class="seg">' + PERIODS.map(([v, label]) => `<button class="chip${view.period === v ? ' on' : ''}" data-act="period" data-v="${v}">${label}</button>`).join('') + '</div>';
    h += '<div class="tabs" role="tablist">' + TABS.map(([v, label]) => `<button class="tab${view.tab === v ? ' on' : ''}" role="tab" aria-selected="${view.tab === v}" data-act="tab" data-v="${v}">${label}</button>`).join('') + '</div>';
    const games = ST.filterByPeriod(all, view.period);
    if (!games.length) return h + '<p class="empty">אין משחקים בתקופה הזו.</p>';
    return h + REPORTS[view.tab](ST.summary(games), games);
  };

  // ---------- settings: git + backup ----------
  VIEWS.settings = () => {
    let h = `<section class="card form"><h2>שמירה בגיט</h2>
      <p class="muted">כל משחק שמסתיים, וגם המשחק הפתוח אחרי כל שינוי, נשמרים כקבצים במאגר גיטהאב שלך. כך שום דבר לא הולך לאיבוד, ואפשר להמשיך גם מטלפון אחר.</p>`;
    if (gh) {
      h += `<p>מחובר למאגר <b class="num">${esc(gh.owner + '/' + gh.repo)}</b>${gh.private === false ? ' <span style="color:var(--danger)">(ציבורי: כל אחד יכול לראות את התוצאות)</span>' : ''}</p>
        <p id="sync-status" class="muted">${esc(syncStatusText())}</p>
        <div class="row">
          <button class="btn primary" data-act="gh-sync">סנכרן עכשיו</button>
          <button class="btn danger" data-act="gh-disconnect">נתק</button>
        </div>`;
    } else {
      h += `
        <label for="gh-repo">מאגר (שם-משתמש/שם-מאגר)</label>
        <input type="text" id="gh-repo" class="ltr" placeholder="username/rummy51-data" autocomplete="off" autocapitalize="off" spellcheck="false">
        <label for="gh-token">טוקן גישה</label>
        <input type="password" id="gh-token" class="ltr" placeholder="github_pat_…" autocomplete="off">
        <p class="error" id="gh-error"></p>
        <button class="btn primary block" data-act="gh-connect">חבר ובדוק</button>
        <details>
          <summary>איך יוצרים מאגר וטוקן?</summary>
          <ol>
            <li>בגיטהאב צור מאגר חדש <b>פרטי</b> (Private), למשל <span class="num">rummy51-data</span>, והפעל את האפשרות להוסיף README.</li>
            <li>פתח <span class="num">Settings → Developer settings → Personal access tokens → Fine-grained tokens</span> ולחץ <span class="num">Generate new token</span>.</li>
            <li>תחת <span class="num">Repository access</span> בחר <span class="num">Only select repositories</span> ובחר רק את מאגר הנתונים.</li>
            <li>תחת <span class="num">Permissions → Contents</span> בחר <span class="num">Read and write</span>.</li>
            <li>בחר תוקף, צור את הטוקן, העתק אותו והדבק כאן.</li>
          </ol>
          <p class="muted">הטוקן נשמר רק בטלפון הזה. הוא לא נכנס לקוד של האפליקציה, ויש לו גישה רק למאגר הנתונים.</p>
        </details>`;
    }
    h += `</section>
      <section class="card"><h2>גיבוי לקובץ</h2>
        <p class="muted">קובץ אחד עם כל המשחקים. אפשר לשלוח אותו לעצמך ולטעון אותו בטלפון אחר.</p>
        <div class="row">
          <button class="btn" data-act="export">ייצוא גיבוי</button>
          <label class="btn">ייבוא גיבוי<input type="file" id="import-file" accept=".json,application/json" hidden></label>
        </div>
      </section>
      <section class="card"><h2>במכשיר הזה</h2>
        <ul class="stat-list">
          ${li('משחקים שמורים', state.history.length)}
          ${li('משחק פתוח', state.current ? 'כן' : 'לא')}
        </ul>
      </section>`;
    return h;
  };

  async function ghConnect() {
    const errEl = document.getElementById('gh-error');
    const repo = SY.parseRepo(document.getElementById('gh-repo').value);
    const token = document.getElementById('gh-token').value.trim();
    if (!repo) { errEl.textContent = 'כתוב את המאגר בצורה שם-משתמש/שם-מאגר'; return; }
    if (!token) { errEl.textContent = 'הדבק את הטוקן'; return; }
    errEl.textContent = 'בודק…';
    const cfg = { owner: repo.owner, repo: repo.repo, token };
    let info;
    try {
      info = await SY.check(cfg);
    } catch (e) {
      errEl.textContent = e.message;
      return;
    }
    cfg.private = info.private;
    state.sync.lastError = null;
    saveGh(cfg);
    toast('מחובר לגיט ✓');
    render();
    await pullFromGit(true);
  }

  async function ghDisconnect() {
    const ok = await ask({
      title: 'לנתק את הגיט?',
      body: 'המשחקים יישארו בטלפון ובמאגר, אבל משחקים חדשים לא יישמרו בגיט עד שתתחבר שוב.',
      buttons: [{ label: 'נתק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    saveGh(null);
    render();
  }

  async function exportBackup() {
    const data = { app: 'rummy51', version: 1, exportedAt: new Date().toISOString(), history: state.history, current: state.current };
    const name = 'rummy51-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'גיבוי רמי 51' });
        markBackedUp();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    markBackedUp();
  }

  function markBackedUp() {
    state.backupCount = state.history.length;
    persist();
    toast('קובץ הגיבוי נוצר');
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('הקובץ לא תקין'); return; }
      if (!data || !Array.isArray(data.history)) { toast('זה לא קובץ גיבוי של רמי 51'); return; }
      const before = new Set(state.history.map((g) => g.id));
      const merged = ST.mergeHistory(state.history, data.history);
      state.history = merged.games;
      state.history.forEach((g) => {
        if (!before.has(g.id) && !state.sync.unsyncedGames.includes(g.id)) state.sync.unsyncedGames.push(g.id);
      });
      persist();
      if (data.current && !data.current.finishedAt && !state.current) {
        const load = await ask({
          title: 'בקובץ יש משחק פתוח',
          body: 'לטעון אותו ולהמשיך לשחק?',
          buttons: [{ label: 'טען', value: true, kind: 'primary' }, { label: 'לא', value: false }]
        });
        if (load) {
          state.current = data.current;
          undoStack = [];
          state.sync.currentVersion++;
          persist();
        }
      }
      scheduleSync(0);
      toast(merged.added ? 'נוספו ' + merged.added + ' משחקים' : 'כל המשחקים בקובץ כבר קיימים');
      render();
    };
    reader.readAsText(file);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const d = el.dataset;
    switch (d.act) {
      case 'back': back(); break;
      case 'home': goHome(); break;
      case 'go': go(d.to); break;
      case 'new-game': newGame(); break;
      case 'pick-dealer': view.firstDealer = +d.i; render(); break;
      case 'move': movePlayer(+d.i, +d.d); break;
      case 'remove-player': removePlayer(+d.i); break;
      case 'add-player': view.names.push(''); render(); document.querySelector(`.pname[data-i="${view.names.length - 1}"]`).focus(); break;
      case 'rounds': view.rounds = Math.min(MAX_ROUNDS, Math.max(1, view.rounds + +d.d)); render(); break;
      case 'start-game': startGame(); break;
      case 'open-round': openRound(+d.i); break;
      case 'close-sheet': closeSheet(); break;
      case 'pick-winner': pickWinner(d.id); break;
      case 'toggle-noset': toggleNoSet(el, d.id); break;
      case 'save-round': saveRound(); break;
      case 'clear-round': clearRound(); break;
      case 'fresh': fresh(); break;
      case 'toggle-gluck': toggleGluck(+d.i); break;
      case 'undo': undo(); break;
      case 'add-round': addRound(); break;
      case 'finish': finishGame(); break;
      case 'finish-early': finishEarly(); break;
      case 'discard': confirmDiscard().then((ok) => { if (ok) goHome(); }); break;
      case 'view-game': go('game-detail', { id: d.id }); break;
      case 'rematch': startSetup(names(findGame(d.id))); break;
      case 'delete-game': deleteGame(d.id); break;
      case 'period': view.period = d.v; render(); break;
      case 'tab': view.tab = d.v; render(); break;
      case 'gh-connect': ghConnect(); break;
      case 'gh-sync': pullFromGit(false); break;
      case 'gh-disconnect': ghDisconnect(); break;
      case 'export': exportBackup(); break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('pname')) {
      view.names[+t.dataset.i] = t.value;
    } else if (t.classList.contains('pts') && sheet) {
      t.value = t.value.replace(/\D/g, '');
      sheet.res.entries[t.dataset.pid].points = t.value;
      document.getElementById('sheet-error').textContent = '';
      updateSheetPreview();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    const field = t.dataset.field;
    if (field === 'hand' && sheet) { sheet.res.hand = t.checked; updateSheetPreview(); }
    else if (field === 'gluck' && sheet) { sheet.gluck = t.checked; updateSheetPreview(); }
    else if (field === 'h2hA' || field === 'h2hB') { view[field] = t.value; render(); }
    else if (t.id === 'import-file' && t.files && t.files[0]) { importBackup(t.files[0]); t.value = ''; }
  });

  // Enter moves to the next name / points field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    const cls = t.classList.contains('pts') ? '.pts' : t.classList.contains('pname') ? '.pname' : null;
    if (!cls) return;
    e.preventDefault();
    const all = Array.from(document.querySelectorAll(cls + ':not(:disabled)'));
    const next = all[all.indexOf(t) + 1];
    if (next) next.focus();
    else t.blur();
  });

  // ---------- start ----------
  if (state.current) {
    stack = [{ name: 'home' }];
    view = { name: 'game' };
    history.pushState({ rummy: 1 }, '');
  }
  render();
  if (gh) pullFromGit(true);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
})();
