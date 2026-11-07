/* Rummy 51 — the UI. Every screen is rendered from state; clicks are routed by data-act.
   state = { tournaments: [Tournament], activeId, backupCount, sync } (see logic.js for Tournament and Game). */
(function () {
  'use strict';

  const R = window.Rummy;
  const ST = window.RummyStats;
  const T = window.RummyTournaments;
  const SY = window.RummySync;

  const KEY = 'rummy51.v2';
  const OLD_KEY = 'rummy51.v1';
  const GH_KEY = 'rummy51.github';
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 8;
  const MAX_ROUNDS = 40;
  const UNDO_LIMIT = 30;
  const BACKUP_NAG = 10;

  let converted = 0;
  let state = loadState();
  let gh = loadGh();
  let undoStack = []; // snapshots of the open game: { tid, gid, json }
  let view = { name: 'home' };
  let stack = [];
  let overlays = [];
  let sheet = null;
  let sheetLayer = null;
  let psheet = null;

  const $view = document.getElementById('view');
  const $overlay = document.getElementById('overlay-root');

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const signed = (n) => (n > 0 ? '+' + n : String(n));
  const pct = (x) => Math.round(x * 100) + '%';
  const round1 = (x) => String(Math.round(x * 10) / 10);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const names = (x) => x.players.map((p) => p.name);
  const winsText = (n) => (n === 1 ? 'ניצחון 1' : n + ' ניצחונות');
  const gamesText = (n) => (n === 1 ? 'משחק 1' : n + ' משחקים');
  const roundsText = (n) => (n === 1 ? 'תור 1' : n + ' תורים');

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

  // ---------- state ----------
  function tourById(id) {
    const t = id ? T.find(state.tournaments, id) : null;
    return t && !t.deleted ? t : null;
  }

  // The tournament shown on the home screen: the one opened last, unless it went to the archive.
  function activeTour() {
    const t = tourById(state.activeId);
    return t && !t.archived ? t : null;
  }

  const findGame = (id) => T.findGame(state.tournaments, id);
  const allGames = () => T.allGames(state.tournaments);
  const tourName = (g) => { const t = tourById(g.tournamentId); return t ? t.name : 'ללא טורניר'; };
  const gameNumber = (t, g) => R.finishedGames(t).findIndex((x) => x.id === g.id) + 1;

  // The tournament screen's tournament and its open game.
  function curTG() {
    const t = view.name === 'tournament' ? tourById(view.id) : null;
    return { t, g: t ? R.openGame(t) : null };
  }

  // ---------- storage ----------
  function loadState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* empty or blocked storage */ }
    if (!s || !Array.isArray(s.tournaments)) s = fromOldVersion() || { tournaments: [], activeId: null, backupCount: 0 };
    s.sync = Object.assign(SY.emptySync(), s.sync || {});
    s.tournaments.forEach((t) => { if (!t.deleted) R.normalize(t); });
    return s;
  }

  // The previous version kept a list of games. They move into their tournaments once; the old copy stays as it is.
  function fromOldVersion() {
    let old = null;
    try { old = JSON.parse(localStorage.getItem(OLD_KEY)); } catch (e) { return null; }
    if (!old || !Array.isArray(old.history)) return null;
    const list = T.fromV1(old);
    const s = { tournaments: list, activeId: null, backupCount: old.backupCount || 0, sync: SY.emptySync() };
    list.forEach((t) => SY.markDirty(s, t.id));
    const want = old.current ? old.current.tournamentId : old.lastTournamentId;
    s.activeId = list.some((t) => t.id === want) ? want : (list[list.length - 1] || {}).id || null;
    converted = list.length;
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

  // ---------- changes ----------
  // Saves a changed tournament here and queues it for git.
  function saveTour(t) {
    SY.markDirty(state, t.id);
    persist();
    scheduleSync();
  }

  function tourSaved(t) {
    saveTour(t);
    render();
  }

  // A change to a game. Changes to the open game can be undone.
  function changeGame(t, g, fn) {
    if (!g.finishedAt) {
      undoStack.push({ tid: t.id, gid: g.id, json: JSON.stringify(g) });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    const out = fn(g);
    R.touchTour(t, g);
    tourSaved(t);
    return out;
  }

  function canUndo(t, g) {
    const last = undoStack[undoStack.length - 1];
    return !!(g && last && last.tid === t.id && last.gid === g.id);
  }

  function undo() {
    const { t, g } = curTG();
    if (!canUndo(t, g)) return;
    const back = JSON.parse(undoStack.pop().json);
    t.games[t.games.indexOf(g)] = back;
    R.touchTour(t, back);
    tourSaved(t);
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

  function openTour(id) {
    if (!tourById(id)) return;
    if (psheet) closePlayer();
    state.activeId = id;
    persist();
    if (view.name === 'tournament' && view.id === id) return;
    go('tournament', { id });
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

  // A dialog with one text field. Resolves with the cleaned text, or null when dismissed.
  // opts.validate(text) returns an error message, or '' when the text is fine.
  function askText(opts) {
    return new Promise((resolve) => {
      const layer = addLayer(`
        <div class="backdrop dialog-backdrop" data-dlg="cancel"></div>
        <div class="dialog form" role="dialog" aria-modal="true">
          <h2>${esc(opts.title)}</h2>
          ${opts.body ? `<p class="muted">${opts.body}</p>` : ''}
          <input type="text" id="dlg-text" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}" maxlength="40" autocomplete="off" enterkeyhint="done">
          <p class="error" id="dlg-error"></p>
          <div class="row">
            <button class="btn primary" data-dlg="ok">${esc(opts.okLabel || 'שמור')}</button>
            <button class="btn" data-dlg="cancel">ביטול</button>
          </div>
        </div>`, () => resolve(null));
      const input = layer.el.querySelector('#dlg-text');
      const submit = () => {
        const text = R.cleanName(input.value);
        const err = text ? (opts.validate ? opts.validate(text) : '') : 'כתוב שם';
        if (err) { layer.el.querySelector('#dlg-error').textContent = err; return; }
        resolve(text);
        removeLayer(layer);
      };
      layer.el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-dlg]');
        if (!t) return;
        if (t.dataset.dlg === 'ok') submit();
        else removeLayer(layer);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 30);
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

  // Screens with typed text that a re-render would lose are left alone.
  function renderIfIdle() {
    if (view.name !== 'setup' && view.name !== 'settings') render();
  }

  async function runSync() {
    if (!gh) return;
    if (syncing) { syncAgain = true; return; }
    if (!SY.pending(state)) { renderSyncBadge(); return; }
    syncing = true;
    renderSyncBadge();
    let changed = false;
    try {
      const before = state.tournaments.map(T.sig).join();
      await SY.flush(state, gh);
      changed = state.tournaments.map(T.sig).join() !== before; // another phone's changes were merged in
    } catch (e) {
      state.sync.lastError = e.message;
    }
    syncing = false;
    persist();
    if (changed) renderIfIdle();
    renderSyncBadge();
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }

  async function pullFromGit(quiet) {
    if (!gh || syncing) return;
    syncing = true;
    renderSyncBadge();
    try {
      const res = await SY.pull(state, gh);
      if (!activeTour()) {
        const recent = T.overview(state.tournaments).find((r) => !r.tournament.archived);
        if (recent) state.activeId = recent.tournament.id;
      }
      persist();
      if (res.added) toast('נטענו מגיט ' + res.added + ' טורנירים');
      else if (res.updated) toast('עודכן מגיט: ' + (res.updated === 1 ? 'טורניר 1' : res.updated + ' טורנירים'));
      else if (!quiet) toast('הסנכרון הסתיים');
    } catch (e) {
      state.sync.lastError = e.message;
      persist();
      if (!quiet) toast(e.message);
    }
    syncing = false;
    renderIfIdle();
    scheduleSync(0);
  }

  function syncStatusText() {
    const s = state.sync;
    const n = SY.pending(state);
    if (syncing) return 'שומר בגיט…';
    if (s.lastError && n) return `לא נשמר: ${s.lastError}. טורנירים שממתינים לשמירה: ${n}`;
    if (n) return 'טורנירים שממתינים לשמירה: ' + n;
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
        <div class="label">ניצח בפעם הקודמת · טורניר ${esc(tourName(g))}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${fmtDate(g.finishedAt, true)} · ${roundsText(g.rounds.length)}</div>
        ${rankList(g, false)}
      </button>`;
  }

  // The tournament table: one row per participant with place, name, points in the game and the total.
  // The game column is the open game, or the last game when none is open.
  // opts.rows = clickable rows (open the participant's points), opts.moves = arrows for places gained or lost.
  function standingsHtml(t, opts) {
    opts = opts || {};
    const rows = R.standings(t);
    const done = R.finishedGames(t);
    const open = R.openGame(t);
    const ref = open || done[done.length - 1];
    const gt = ref ? R.totals(ref) : null;
    const moves = opts.moves ? R.placeMoves(t) : {};
    const tag = opts.rows ? 'button' : 'div';
    let h = `<div class="standings">
      <div class="srow head"><span class="s-place">#</span><span>משתתף</span><span class="s-game">${open ? 'במשחק' : ref ? 'משחק אחרון' : ''}</span><span class="s-total">כללי</span></div>`;
    rows.forEach((r) => {
      const lead = done.length && r.place === 1;
      const mv = moves[r.player.id];
      const move = mv ? `<span class="s-move ${mv > 0 ? 'up' : 'down'}" title="${mv > 0 ? 'עלה' : 'ירד'} ${Math.abs(mv)}">${mv > 0 ? '▲' : '▼'}${Math.abs(mv)}</span>` : '';
      const g = gt && r.player.id in gt ? gt[r.player.id] : null;
      h += `
        <${tag} class="srow${lead ? ' lead' : ''}"${opts.rows ? ` data-act="player" data-tid="${t.id}" data-pid="${r.player.id}"` : ''}>
          <span class="s-place">${done.length ? r.place : ''}</span>
          <span class="s-name"><b>${esc(r.player.name)}</b>${r.wins ? ` <span class="s-wins">🏆 ${r.wins}</span>` : ''}${move}</span>
          <span class="s-game num">${g == null ? '' : g}</span>
          <span class="s-total num">${r.total}</span>
        </${tag}>`;
    });
    return h + '</div>';
  }

  function backupNag() {
    const unsaved = allGames().length - (state.backupCount || 0);
    if (gh || unsaved < BACKUP_NAG) return '';
    return `
      <button class="card warn" data-act="go" data-to="settings">
        <b>${unsaved} משחקים לא מגובים</b>
        <div class="muted">הם שמורים רק בטלפון הזה. חבר את האפליקציה לגיט או ייצא קובץ גיבוי.</div>
      </button>`;
  }

  function openGameText(g) {
    const i = R.currentIndex(g);
    return i >= 0 ? `תור ${i + 1} מתוך ${g.rounds.length}` : 'כל התורים שוחקו';
  }

  VIEWS.home = () => {
    const t = activeTour();
    const others = T.overview(state.tournaments).filter((r) => !r.tournament.archived && (!t || r.tournament.id !== t.id));
    let h = '';
    if (t) {
      const open = R.openGame(t);
      const done = R.finishedGames(t);
      const last = done[done.length - 1];
      h += `
        <button class="card" data-act="open-tour" data-id="${t.id}">
          <div class="label">הטורניר הפעיל · ${done.length ? gamesText(done.length) : 'עוד אין משחקים שהסתיימו'}</div>
          <div class="tour-head">${esc(t.name)}</div>
          ${last ? `<div class="muted">במשחק האחרון ניצח ${esc(R.playerById(last, last.winnerId).name)} · ${fmtDate(last.finishedAt)}</div>` : ''}
          ${standingsHtml(t)}
        </button>
        ${open
          ? `<button class="btn primary big" data-act="open-tour" data-id="${t.id}">המשך משחק · ${openGameText(open)}</button>`
          : `<button class="btn primary big" data-act="next-game" data-id="${t.id}">משחק חדש בטורניר</button>`}
        <div class="row"><button class="btn" data-act="new-tour">+ טורניר חדש</button></div>`;
    } else {
      if (!others.length) {
        h += `<section class="card"><h2>איך זה עובד</h2>
          <p class="muted">פותחים טורניר עם המשתתפים, ומשחקים בו כמה משחקים שרוצים. כולם משחקים בכל משחק.
          הטבלה מסודרת לפי הניקוד הכללי: הכי מעט נקודות במקום הראשון.</p></section>`;
      }
      h += '<button class="btn primary big" data-act="new-tour">טורניר חדש</button>';
    }
    if (others.length) {
      h += `<h2 class="sec">${t ? 'עוד טורנירים פעילים' : 'טורנירים פעילים'}</h2><ul class="list">` + others.map((r) => {
        const x = r.tournament;
        return `
          <li><button class="card" data-act="open-tour" data-id="${x.id}">
            <div class="hist-top"><b class="tour-title">${esc(x.name)}</b><span>${r.games ? gamesText(r.games) : 'עוד אין משחקים'}</span></div>
            ${r.open ? `<div class="muted">משחק פתוח · ${openGameText(r.open)}</div>` : ''}
            ${r.leaders.length ? `<div class="muted">מוביל: ${esc(r.leaders.map((l) => l.player.name).join(', '))} (${r.leaders[0].total})</div>` : ''}
          </button></li>`;
      }).join('') + '</ul>';
    }
    h += backupNag();
    h += `
      <div class="tiles">
        <button class="btn" data-act="go" data-to="reports"><span class="ic">📊</span>דוחות</button>
        <button class="btn" data-act="go" data-to="tournaments"><span class="ic">🏅</span>טורנירים</button>
        <button class="btn" data-act="go" data-to="history"><span class="ic">🗂️</span>היסטוריה</button>
        <button class="btn" data-act="go" data-to="settings"><span class="ic">☁️</span>גיט וגיבוי</button>
      </div>`;
    return h;
  };

  // ---------- new tournament ----------
  function knownNames() {
    const count = {};
    T.live(state.tournaments).forEach((t) => {
      const n = R.finishedGames(t).length + 1;
      t.players.forEach((p) => { count[p.name] = (count[p.name] || 0) + n; });
    });
    return Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b, 'he'));
  }

  function dealerRows(list, editable) {
    return list.map((n, i) => `
      <li>
        <button class="deal-chip${view.firstDealer === i ? ' on' : ''}" data-act="pick-dealer" data-i="${i}" aria-pressed="${view.firstDealer === i}">מחלק</button>
        ${editable
          ? `<input class="pname" data-i="${i}" value="${esc(n)}" placeholder="משתתף ${i + 1}" list="known-names" maxlength="20" autocomplete="off" enterkeyhint="next">
             <button class="btn icon" data-act="move" data-i="${i}" data-d="-1" aria-label="הזז למעלה"${i === 0 ? ' disabled' : ''}>↑</button>
             <button class="btn icon" data-act="move" data-i="${i}" data-d="1" aria-label="הזז למטה"${i === list.length - 1 ? ' disabled' : ''}>↓</button>
             <button class="btn icon danger" data-act="remove-player" data-i="${i}" aria-label="הסר"${list.length <= MIN_PLAYERS ? ' disabled' : ''}>✕</button>`
          : `<span class="pname-static">${esc(n)}</span>`}
      </li>`).join('');
  }

  function roundsStepper() {
    return `
      <div class="field-row">
        <b>מספר תורים במשחק</b>
        <div class="stepper">
          <button class="btn" data-act="rounds" data-d="-1" aria-label="פחות">−</button>
          <span class="val num">${view.rounds}</span>
          <button class="btn" data-act="rounds" data-d="1" aria-label="יותר">+</button>
        </div>
      </div>
      <p class="muted">גלוק אוטומטי בכל תור רביעי (4, 8, 12…). אפשר להוסיף תורים או לסיים מוקדם תוך כדי משחק.</p>`;
  }

  VIEWS.setup = () => {
    const known = knownNames();
    return `
      <h2>טורניר חדש</h2>
      <section class="card form">
        <label for="tour-name">שם הטורניר</label>
        <input type="text" id="tour-name" value="${esc(view.tourName)}" placeholder="${esc(T.defaultName(view.names) || 'למשל: אצל סבתא')}" maxlength="40" autocomplete="off" enterkeyhint="next">
        <p class="muted tour-line">לא חובה. בלי שם, הטורניר נקרא לפי המשתתפים.</p>
      </section>
      <h2>משתתפים</h2>
      <p class="muted">לפי סדר הישיבה, כי החלוקה עוברת לפי הסדר. לחץ "מחלק" ליד מי שמחלק ראשון. כולם משחקים בכל משחק בטורניר.</p>
      <ul class="player-list">${dealerRows(view.names, true)}</ul>
      <datalist id="known-names">${known.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${view.names.length < MAX_PLAYERS ? '<button class="btn block" data-act="add-player">+ הוסף משתתף</button>' : ''}
      <div id="same-lineup">${sameLineupHtml()}</div>
      ${roundsStepper()}
      <button class="btn primary big" data-act="start-tour">פתח טורניר והתחל משחק</button>
      <p class="error" id="setup-error"></p>`;
  };

  // A tournament with exactly these participants is already open: offer it.
  function sameLineupHtml() {
    const ns = view.names.map(R.cleanName);
    if (ns.length < MIN_PLAYERS || ns.some((n) => !n)) return '';
    const t = T.findByLineup(state.tournaments, ns);
    if (!t) return '';
    return `
      <div class="card warn">
        <b>כבר יש טורניר פעיל עם המשתתפים האלה: ${esc(t.name)}</b>
        <div class="muted">אפשר להמשיך אותו, או לפתוח טורניר חדש.</div>
        <div class="tour-actions"><button class="btn sm" data-act="open-tour" data-id="${t.id}">להמשיך את ${esc(t.name)}</button></div>
      </div>`;
  }

  function refreshSetup() {
    const el = document.getElementById('same-lineup');
    if (el) el.innerHTML = sameLineupHtml();
    const input = document.getElementById('tour-name');
    if (input) input.placeholder = T.defaultName(view.names) || 'למשל: אצל סבתא';
  }

  function startSetup() {
    go('setup', { names: ['', ''], firstDealer: 0, rounds: R.DEFAULT_ROUNDS, tourName: '' });
    const first = document.querySelector('.pname');
    if (first) first.focus();
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

  // A name that is not taken: the participants' names, and the date when they already have a tournament.
  function freeName(base) {
    if (!T.findByName(state.tournaments, base)) return base;
    const dated = base + ' · ' + fmtDate(new Date().toISOString());
    let name = dated;
    for (let k = 2; T.findByName(state.tournaments, name); k++) name = dated + ' (' + k + ')';
    return name;
  }

  function startTour() {
    const ns = view.names.map(R.cleanName);
    const typed = R.cleanName(view.tourName);
    let err = '';
    if (ns.some((n) => !n)) err = 'יש שורה בלי שם. מלא אותה או הסר אותה.';
    else {
      const dup = ns.find((n, i) => ns.indexOf(n) !== i);
      if (dup) err = `השם "${dup}" מופיע פעמיים`;
      else if (typed && T.findByName(state.tournaments, typed)) err = 'כבר יש טורניר בשם הזה. כתוב שם אחר.';
    }
    if (err) { document.getElementById('setup-error').textContent = err; return; }
    const t = R.newTournament(typed || freeName(T.defaultName(ns)), ns);
    state.tournaments.push(t);
    const g = R.startGame(t, { firstDealer: view.firstDealer, rounds: view.rounds });
    state.activeId = t.id;
    undoStack = [];
    saveTour(t);
    stack = [{ name: 'home' }];
    replace('tournament', { id: t.id });
    toast('בהצלחה! ' + R.dealer(g, 0).name + ' מחלק ראשון');
  }

  // ---------- next game in a tournament ----------
  VIEWS.next = () => {
    const t = tourById(view.id);
    if (!t) { view = { name: 'home' }; return VIEWS.home(); }
    if (R.openGame(t)) { view = { name: 'tournament', id: t.id }; return VIEWS.tournament(); }
    const n = R.finishedGames(t).length + 1;
    return `
      <h2>משחק ${n} · ${esc(t.name)}</h2>
      <p class="muted">אותם משתתפים, לפי סדר הישיבה. לחץ "מחלק" ליד מי שמחלק ראשון.</p>
      <ul class="player-list">${dealerRows(names(t), false)}</ul>
      ${roundsStepper()}
      <button class="btn primary big" data-act="start-next">התחל משחק ${n}</button>`;
  };

  function nextGame(id) {
    const t = tourById(id);
    if (!t) return;
    if (R.openGame(t)) { openTour(id); return; }
    state.activeId = id;
    persist();
    go('next', { id, firstDealer: R.nextFirstDealer(t), rounds: R.DEFAULT_ROUNDS });
  }

  function startNext() {
    const t = tourById(view.id);
    if (!t) return;
    if (t.archived) {
      t.archived = false;
      R.touchMeta(t);
    }
    const g = R.startGame(t, { firstDealer: view.firstDealer, rounds: view.rounds });
    undoStack = [];
    saveTour(t);
    stack = [{ name: 'home' }];
    replace('tournament', { id: t.id });
    toast('בהצלחה! ' + R.dealer(g, 0).name + ' מחלק ראשון');
  }

  // ---------- tournament screen ----------
  const GLUCK_REASON = { auto: 'גלוק קבוע (כל תור רביעי)', fresh: 'גלוק בגלל פריש', manual: 'גלוק שנקבע ידנית' };

  function statusNotes(r) {
    const parts = [];
    if (r.gluck) parts.push(GLUCK_REASON[r.gluckSource] || 'גלוק');
    if (r.freshCount) parts.push('פרישים בתור הזה: ' + r.freshCount);
    if (!parts.length) parts.push('תור רגיל');
    return parts.map(esc).join(' · ');
  }

  function gameControls(t, g) {
    const number = R.finishedGames(t).length + 1;
    const i = R.currentIndex(g);
    if (i >= 0) {
      const r = g.rounds[i];
      return `
        <section class="status${r.gluck ? ' is-gluck' : ''}">
          <div class="status-top">
            <span class="round-no">תור ${i + 1} <span class="muted">מתוך ${g.rounds.length}</span></span>
            ${r.gluck ? '<span class="gluck-badge">✕ גלוק</span>' : ''}
          </div>
          <div class="dealer">מחלק: ${esc(R.dealer(g, i).name)}</div>
          <div class="notes muted">${statusNotes(r)}</div>
          <div class="muted tour-line">${esc(t.name)} · משחק ${number}</div>
        </section>
        <button class="btn primary big" data-act="open-round" data-gid="${g.id}" data-i="${i}">סיום תור ${i + 1}</button>
        <div class="row">
          <button class="btn" data-act="fresh">פריש</button>
          <button class="btn${r.gluck ? ' gluck-on' : ''}" data-act="toggle-gluck" data-i="${i}">${r.gluck ? 'בטל גלוק' : 'הפוך לגלוק'}</button>
        </div>`;
    }
    const lead = R.leaders(g);
    return `
      <section class="status">
        <div class="round-no">כל ${g.rounds.length} התורים שוחקו</div>
        <div class="dealer">${lead.length > 1 ? 'תיקו: ' + esc(lead.map((p) => p.name).join(' ו')) : 'ניצח במשחק: ' + esc(lead[0].name)}</div>
        <div class="muted tour-line">${esc(t.name)} · משחק ${number}</div>
      </section>
      <button class="btn primary big" data-act="finish">סיים ושמור</button>`;
  }

  const LEGEND = `
    <div class="legend">
      <span>✕ תור גלוק (×2)</span><span>★ ניצח בהאנט (×2)</span><span>פ = היה פריש</span><span>לחיצה על שורה = תיקון</span>
    </div>`;

  // The finished games, newest first; a row opens the game.
  function gamesListHtml(t) {
    const done = R.finishedGames(t);
    if (!done.length) return '';
    return `<section class="card"><h3>משחקים בטורניר</h3><div class="table-scroll"><table class="data games">
      <thead><tr><th>#</th><th>ניצח</th><th>תאריך</th><th>תורים</th></tr></thead><tbody>` +
      done.map((g, k) => ({ g, k })).reverse().map(({ g, k }) => `
        <tr data-act="view-game" data-id="${g.id}">
          <td>${k + 1}</td><td>🏆 ${esc(R.playerById(g, g.winnerId).name)}</td><td>${fmtDate(g.finishedAt)}</td><td>${g.rounds.length}</td>
        </tr>`).join('') +
      '</tbody></table></div><p class="muted" style="margin:8px 0 0">לחיצה על משחק פותחת אותו, ושם אפשר לתקן כל תור.</p></section>';
  }

  VIEWS.tournament = () => {
    const t = tourById(view.id);
    if (!t) { view = { name: 'home' }; return VIEWS.home(); }
    const g = R.openGame(t);
    const done = R.finishedGames(t);
    let h = '';
    if (g) {
      h += gameControls(t, g);
    } else {
      const last = done[done.length - 1];
      h += `
        <section class="status">
          <div class="round-no">${esc(t.name)}</div>
          <div class="muted">${done.length ? gamesText(done.length) + ' · אחרון ' + fmtDate(last.finishedAt) : 'עוד אין משחקים'}${t.archived ? ' · בארכיון' : ''}</div>
        </section>
        <button class="btn primary big" data-act="next-game" data-id="${t.id}">משחק חדש בטורניר</button>`;
    }
    h += standingsHtml(t, { rows: true, moves: true });
    h += `<p class="muted s-note">${done.length ? 'הכי מעט נקודות במקום הראשון. המקומות מתעדכנים בסוף כל משחק. ' : ''}לחיצה על משתתף מציגה את הנקודות שלו בכל תור, ומשם אפשר לתקן.</p>`;
    if (g) {
      const played = R.playedCount(g);
      h += `<button class="fold" data-act="toggle-rounds" aria-expanded="${!!view.roundsOpen}">${view.roundsOpen ? '▾' : '▸'} פירוט התורים במשחק</button>`;
      if (view.roundsOpen) h += scoreTableHtml(g, true) + LEGEND;
      h += `
        <div class="row">
          <button class="btn" data-act="undo"${canUndo(t, g) ? '' : ' disabled'}>↶ בטל פעולה</button>
          <button class="btn" data-act="add-round">+ הוסף תור</button>
        </div>`;
      if (R.currentIndex(g) >= 0 && played) h += '<button class="btn block" data-act="finish-early">סיים משחק עכשיו</button>';
      if (!played) h += '<button class="btn block danger" data-act="discard">מחק את המשחק הזה</button>';
    }
    h += gamesListHtml(t);
    h += `
      <div class="row">
        ${done.length ? `<button class="btn sm" data-act="tour-reports" data-id="${t.id}">דוחות הטורניר</button>` : ''}
        <button class="btn sm" data-act="tour-rename" data-id="${t.id}">שינוי שם הטורניר</button>
      </div>`;
    return h;
  };

  function scoreTableHtml(g, editable) {
    const table = R.scoreTable(g);
    const cur = editable && !g.finishedAt ? R.currentIndex(g) : -1;
    const played = R.playedCount(g);
    let h = '<div class="table-wrap"><table class="score"><thead><tr><th class="c-no">#</th><th class="c-gl" title="גלוק">✕</th>';
    g.players.forEach((p) => { h += `<th>${esc(p.name)}</th>`; });
    h += '</tr></thead><tbody>';
    g.rounds.forEach((r, i) => {
      const row = table.rows[i];
      const res = r.result;
      const cls = [r.gluck ? 'gluck' : '', i === cur ? 'current' : '', res && editable ? 'played' : ''].join(' ').trim();
      h += `<tr class="${cls}"${editable && res ? ` data-act="open-round" data-gid="${g.id}" data-i="${i}"` : ''}>`;
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
    const { t, g } = curTG();
    const i = g ? R.currentIndex(g) : -1;
    if (i < 0) return;
    const dealerName = R.dealer(g, i).name;
    const res = changeGame(t, g, (game) => R.declareFresh(game));
    if (res.needsExtraRound) {
      const add = await ask({
        title: 'כל התורים שנותרו כבר גלוק',
        body: 'הפריש צריך להפוך תור לגלוק, אבל אין תור פנוי. להוסיף תור גלוק בסוף המשחק?',
        buttons: [{ label: 'הוסף תור גלוק', value: true, kind: 'primary' }, { label: 'לא להוסיף', value: false }]
      });
      const cur = curTG();
      if (add && cur.g) changeGame(cur.t, cur.g, (game) => R.addRound(game, 'fresh'));
      toast('פריש! ' + dealerName + ' מחלק שוב');
      return;
    }
    toast('פריש! ' + dealerName + ' מחלק שוב · ' + (res.gluckIndex === i ? 'התור הזה גלוק' : 'תור ' + (res.gluckIndex + 1) + ' הפך לגלוק'));
  }

  function toggleGluck(i) {
    const { t, g } = curTG();
    if (!g) return;
    const on = !g.rounds[i].gluck;
    changeGame(t, g, (game) => R.setGluck(game, i, on));
    toast('תור ' + (i + 1) + (on ? ' הפך לגלוק' : ' כבר לא גלוק'));
  }

  function addRound() {
    const { t, g } = curTG();
    if (!g) return;
    const idx = changeGame(t, g, (game) => R.addRound(game));
    toast('נוסף תור ' + (idx + 1) + (g.rounds[idx].gluck ? ' (גלוק)' : ''));
  }

  // ---------- round entry sheet (open game, or a finished game being corrected) ----------
  function sheetGame() {
    const f = sheet && findGame(sheet.gid);
    return f ? f.game : null;
  }

  function openRound(gid, i) {
    const f = findGame(gid);
    if (!f || !f.game.rounds[i]) return;
    const r = f.game.rounds[i];
    sheet = { gid, i, gluck: r.gluck, isEdit: !!r.result, res: r.result ? clone(r.result) : { winnerId: null, hand: false, entries: {} } };
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
    const g = sheetGame();
    if (!g) { closeSheet(); return; }
    const s = sheet;
    const res = s.res;
    let h = `<h2>${s.isEdit ? 'תיקון' : 'סיום'} תור ${s.i + 1}</h2>
      ${g.finishedAt ? `<p class="muted">במשחק שהסתיים ב-${fmtDate(g.finishedAt)}. הניקוד בטורניר יתעדכן לפי התיקון.</p>` : ''}
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
    if (s.isEdit && !g.finishedAt && s.i === R.playedCount(g) - 1) h += '<button class="btn block danger" data-act="clear-round">מחק את תוצאת התור</button>';
    document.getElementById('sheet').innerHTML = h;
    updateSheetPreview();
    if (focusPid) {
      const el = document.querySelector(`.pts[data-pid="${focusPid}"]`);
      if (el) el.focus();
    }
  }

  function updateSheetPreview() {
    const g = sheetGame();
    if (!g) return;
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
    const g = sheetGame();
    if (!g) return;
    sheet.res.winnerId = id;
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

  async function saveRound() {
    const f = findGame(sheet.gid);
    if (!f) { closeSheet(); return; }
    const { i, gluck, res, isEdit } = sheet;
    const err = R.validateResult(f.game, res);
    if (err) { document.getElementById('sheet-error').textContent = err; return; }
    closeSheet();
    const wasFinished = !!f.game.finishedAt;
    changeGame(f.tour, f.game, (game) => {
      if (game.rounds[i].gluck !== gluck) R.setGluck(game, i, gluck);
      R.setResult(game, i, res);
    });
    if (wasFinished) {
      toast('תור ' + (i + 1) + ' תוקן');
      await fixWinner(f.tour, f.game.id);
      return;
    }
    if (isEdit) { toast('תור ' + (i + 1) + ' תוקן'); return; }
    const next = R.currentIndex(f.game);
    if (next < 0) {
      toast('כל התורים שוחקו!');
    } else {
      const nr = f.game.rounds[next];
      toast(`תור ${next + 1}: ${R.dealer(f.game, next).name} מחלק${nr.gluck ? ' · גלוק ✕' : ''}`);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // A corrected finished game: when the winner no longer has the lowest total, the new one is set
  // (on a tie, someone chooses).
  async function fixWinner(t, gid) {
    const g = R.findTourGame(t, gid);
    if (!g) return;
    const before = g.winnerId;
    const tie = R.refreshWinner(g);
    if (tie) {
      const id = await ask({
        title: 'תיקו בראש המשחק',
        body: 'אחרי התיקון ' + esc(tie.map((p) => p.name).join(' ו')) + ' סיימו את המשחק עם אותו ניקוד. מי המנצח?',
        buttons: tie.map((p) => ({ label: p.name, value: p.id, kind: 'primary' })),
        cancel: null
      });
      g.winnerId = id || tie[0].id;
    }
    if (g.winnerId === before) return;
    R.touchTour(t, g);
    tourSaved(t);
    toast('המנצח במשחק השתנה: ' + R.playerById(g, g.winnerId).name);
  }

  function clearRound() {
    const f = findGame(sheet.gid);
    const i = sheet.i;
    closeSheet();
    if (!f) return;
    changeGame(f.tour, f.game, (g) => R.clearResult(g, i));
    toast('תוצאת תור ' + (i + 1) + ' נמחקה');
  }

  // ---------- a participant's points ----------
  function openPlayer(tid, pid) {
    const layer = addLayer('<div class="backdrop" data-act="close-player"></div><div class="sheet" role="dialog" aria-modal="true" id="psheet"></div>', () => { psheet = null; });
    psheet = { layer, tid, pid };
    renderPlayerSheet();
  }

  function closePlayer() {
    if (psheet) removeLayer(psheet.layer);
  }

  function renderPlayerSheet() {
    const t = tourById(psheet.tid);
    const p = t && t.players.find((x) => x.id === psheet.pid);
    if (!p) { closePlayer(); return; }
    const row = R.standings(t).find((r) => r.player.id === p.id);
    const done = R.finishedGames(t);
    const g = R.openGame(t) || done[done.length - 1];
    let h = `<h2>${esc(p.name)}</h2>
      <p class="muted">${done.length ? `מקום ${row.place} · ${row.total} נקודות בטורניר · ${winsText(row.wins)}` : 'עוד אין משחקים שהסתיימו'}</p>`;
    if (g && g.players.some((x) => x.id === p.id)) {
      const table = R.scoreTable(g);
      const played = g.rounds.map((r, i) => ({ r, i })).filter((x) => x.r.result);
      h += `<div class="label-line">${g.finishedAt ? 'במשחק האחרון (' + fmtDate(g.finishedAt) + ')' : 'במשחק הנוכחי'} · לחיצה על תור = תיקון</div>`;
      if (!played.length) {
        h += '<p class="muted">עוד לא שוחקו תורים.</p>';
      } else {
        h += '<ul class="list plist">' + played.map(({ r, i }) => {
          const e = r.result.entries[p.id];
          const tags = [
            r.result.winnerId === p.id ? 'ניצח' : e && e.noSet ? 'לא הוריד' : '',
            r.gluck ? '✕ גלוק' : '',
            r.result.hand ? '★ האנט' : ''
          ].filter(Boolean).join(' · ');
          return `<li><button class="prow" data-act="edit-round-of" data-gid="${g.id}" data-i="${i}">
            <span>תור ${i + 1}</span><span class="muted">${tags}</span><b class="num">${signed(table.rows[i].scores[p.id])}</b></button></li>`;
        }).join('') + `</ul><p class="ptotal">סה״כ במשחק: <b class="num">${table.totals[p.id]}</b></p>`;
      }
    }
    if (done.length) {
      h += '<div class="label-line">כל המשחקים בטורניר</div><ul class="list plist">' + done.map((x, k) => ({ x, k })).reverse().map(({ x, k }) => {
        const tot = R.totals(x)[p.id];
        return `<li><button class="prow" data-act="view-game" data-id="${x.id}">
          <span>משחק ${k + 1}</span><span class="muted">${fmtDate(x.finishedAt)}${x.winnerId === p.id ? ' · 🏆 ניצח' : ''}</span><b class="num">${tot == null ? '—' : tot}</b></button></li>`;
      }).join('') + '</ul>';
    }
    h += '<div class="row"><button class="btn" data-act="close-player">סגור</button></div>';
    document.getElementById('psheet').innerHTML = h;
  }

  // ---------- finishing ----------
  async function finishGame() {
    const { t, g } = curTG();
    if (!g) return;
    if (!R.playedCount(g)) {
      await discardGame();
      return;
    }
    const lead = R.leaders(g);
    let winnerId = lead[0].id;
    if (lead.length > 1) {
      winnerId = await ask({
        title: 'תיקו בראש המשחק',
        body: esc(lead.map((p) => p.name).join(' ו')) + ' סיימו עם אותו ניקוד. מי המנצח?',
        buttons: lead.map((p) => ({ label: p.name, value: p.id, kind: 'primary' })).concat([{ label: 'ביטול', value: null }]),
        cancel: null
      });
      if (!winnerId) return;
    }
    R.finishGame(g, winnerId);
    R.touchTour(t, g);
    undoStack = [];
    saveTour(t);
    scheduleSync(0);
    stack = [{ name: 'home' }];
    replace('game-detail', { id: g.id, justFinished: true });
  }

  async function finishEarly() {
    const { g } = curTG();
    if (!g) return;
    const ok = await ask({
      title: 'לסיים את המשחק עכשיו?',
      body: `שוחקו ${R.playedCount(g)} מתוך ${g.rounds.length} תורים. התורים שלא שוחקו לא יישמרו, והמנצח ייקבע לפי הניקוד עד עכשיו.`,
      buttons: [{ label: 'סיים ושמור', value: true, kind: 'primary' }, { label: 'ביטול', value: false }]
    });
    if (ok) await finishGame();
  }

  async function discardGame() {
    const { t, g } = curTG();
    if (!g) return;
    const ok = await ask({
      title: 'למחוק את המשחק הזה?',
      body: 'המשחק יימחק מהטורניר. אפשר להתחיל משחק חדש במקומו.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    R.removeGame(t, g.id);
    undoStack = [];
    tourSaved(t);
  }

  // ---------- history ----------
  // Tournament picker for history and reports; hidden while there is only one tournament.
  function tourFilter(games) {
    const ids = new Set(games.map((g) => g.tournamentId));
    const list = T.live(state.tournaments).filter((t) => ids.has(t.id));
    if (list.length < 2 && view.tour === 'all') return '';
    return `<select class="tour-filter" data-field="tour" aria-label="טורניר">
      <option value="all">כל הטורנירים</option>
      ${list.map((t) => `<option value="${t.id}"${view.tour === t.id ? ' selected' : ''}>${esc(t.name)}${t.archived ? ' (בארכיון)' : ''}</option>`).join('')}
    </select>`;
  }

  function validTour(id) {
    return tourById(id) ? id : 'all';
  }

  VIEWS.history = () => {
    const all = allGames();
    if (!all.length) return '<p class="empty">עוד אין משחקים שהסתיימו.<br>כל משחק שמסתיים יופיע כאן.</p>';
    view.tour = validTour(view.tour);
    const list = ST.filterByTournament(all, view.tour).reverse();
    const showTour = view.tour === 'all' && new Set(all.map((g) => g.tournamentId)).size > 1;
    return `<h2>היסטוריה <span class="muted">(${list.length})</span></h2>` + tourFilter(all) + '<ul class="list">' + list.map((g) => {
      const rank = R.ranking(g);
      return `
        <li><button class="card" data-act="view-game" data-id="${g.id}">
          <div class="hist-top"><span>${fmtDate(g.finishedAt, true)}</span><span>${roundsText(g.rounds.length)}${g.endedEarly ? ' · הסתיים מוקדם' : ''}</span></div>
          <div class="hist-winner">🏆 ${esc(rank[0].player.name)} <span class="num">${rank[0].total}</span></div>
          <div class="muted">${rank.slice(1).map((r) => `${esc(r.player.name)} <span class="num">${r.total}</span>`).join(' · ')}</div>
          ${showTour ? `<div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>` : ''}
        </button></li>`;
    }).join('') + '</ul>';
  };

  VIEWS['game-detail'] = () => {
    const f = findGame(view.id);
    if (!f || !f.game.finishedAt) return '<p class="empty">המשחק לא נמצא.</p>';
    const { tour: t, game: g } = f;
    const winner = R.ranking(g)[0].player.name;
    let h = `
      <section class="card">
        <div class="label">${view.justFinished ? 'המשחק הסתיים 🎉' : fmtDate(g.finishedAt, true)}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">משחק ${gameNumber(t, g)} בטורניר ${esc(t.name)} · ${roundsText(g.rounds.length)}${g.endedEarly ? ` (הסתיים מוקדם, תוכננו ${g.plannedRounds})` : ''}</div>
        ${rankList(g, true)}
      </section>`;
    if (view.justFinished) {
      h += `<h2 class="sec">הטבלה בטורניר אחרי המשחק</h2>${standingsHtml(t, { moves: true })}
        <button class="btn primary big" data-act="next-game" data-id="${t.id}">משחק הבא בטורניר</button>
        <div class="row"><button class="btn" data-act="open-tour" data-id="${t.id}">למסך הטורניר</button></div>`;
    }
    h += '<h2 class="sec">התורים</h2>' + scoreTableHtml(g, true) +
      '<p class="muted">לחיצה על תור פותחת אותו לתיקון. הניקוד בטורניר מתעדכן לפי התיקון.</p>';
    h += `<button class="btn block" data-act="move-game" data-id="${g.id}">העבר לטורניר אחר</button>
      <button class="btn block danger" data-act="delete-game" data-id="${g.id}">מחק את המשחק</button>`;
    return h;
  };

  // A game can move only to a tournament with the same participants.
  async function moveGame(id) {
    const f = findGame(id);
    if (!f) return;
    const key = T.lineupKey(names(f.game));
    const others = T.active(state.tournaments).filter((t) => t.id !== f.tour.id && T.lineupKey(names(t)) === key);
    if (!others.length) { toast('אין טורניר אחר עם אותם משתתפים'); return; }
    const to = await ask({
      title: 'להעביר לאיזה טורניר?',
      body: 'המשחק עובר עם כל התוצאות, והטבלה של שני הטורנירים מתעדכנת.',
      buttons: others.map((t) => ({ label: t.name, value: t.id })).concat([{ label: 'ביטול', value: null }]),
      cancel: null
    });
    const target = tourById(to);
    if (!target) return;
    const map = {};
    f.game.players.forEach((p) => { map[p.id] = target.players.find((x) => x.name === p.name).id; });
    const g = T.remapGame(f.game, map);
    g.tournamentId = target.id;
    target.removed = (target.removed || []).filter((x) => x !== g.id);
    target.games.push(g);
    R.touchTour(target, g);
    R.normalize(target);
    R.removeGame(f.tour, id);
    saveTour(f.tour);
    saveTour(target);
    render();
    toast('המשחק הועבר לטורניר ' + target.name);
  }

  async function deleteGame(id) {
    const f = findGame(id);
    if (!f) return;
    const ok = await ask({
      title: 'למחוק את המשחק?',
      body: 'המשחק יימחק מהטורניר, מההיסטוריה ומהדוחות' + (gh ? ', וגם מגיט' : '') + '.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    R.removeGame(f.tour, id);
    saveTour(f.tour);
    toast('המשחק נמחק');
    back();
  }

  // ---------- reports ----------
  const PERIODS = [['all', 'הכול'], ['year', 'השנה'], ['30d', '30 יום']];
  const TABS = [['winners', 'מנצחים'], ['points', 'נקודות'], ['players', 'שחקנים'], ['general', 'כללי'], ['h2h', 'ראש בראש'], ['tours', 'טורנירים']];

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
        <thead><tr><th>#</th><th>שחקן</th><th>ניצחונות</th><th>משחקים</th><th>אחוז</th><th>נקודות</th></tr></thead><tbody>`;
      sum.players.forEach((s, i) => {
        h += `<tr${i === 0 && s.wins ? ' class="top1"' : ''}><td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.wins}</td><td>${s.games}</td><td>${pct(s.winPct)}</td><td class="num">${s.totalPoints}</td></tr>`;
      });
      h += '</tbody></table></div><p class="muted" style="margin-top:8px">הדירוג כאן לפי ניצחונות במשחקים. בשוויון, מי שצבר פחות נקודות. הטבלה של כל טורניר (לפי נקודות) נמצאת במסך הטורניר ובלשונית "טורנירים".</p></section>';
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

  // Every tournament with games in the period; a row opens that tournament's reports.
  function toursReport(pick) {
    const rows = T.overview(state.tournaments, pick).filter((r) => r.games);
    if (!rows.length) return '<p class="empty">אין משחקים בתקופה הזו.</p>';
    return `<section class="card"><h3>כל הטורנירים</h3><div class="table-scroll"><table class="data tours">
      <thead><tr><th>טורניר</th><th>משחקים</th><th>אחרון</th><th>מוביל</th></tr></thead><tbody>` +
      rows.map((r) => `
        <tr data-act="pick-tour" data-id="${r.tournament.id}"${view.tour === r.tournament.id ? ' class="top1"' : ''}>
          <td>${esc(r.tournament.name)}${r.tournament.archived ? ' <span class="muted">(בארכיון)</span>' : ''}</td>
          <td>${r.games}</td><td>${fmtDate(r.lastAt)}</td>
          <td>${esc(r.leaders.map((l) => l.player.name).join(', '))} <span class="muted num">(${r.leaders[0].total})</span></td>
        </tr>`).join('') +
      '</tbody></table></div><p class="muted" style="margin-top:8px">המוביל הוא מי שצבר הכי מעט נקודות בטורניר. בשוויון, מי שניצח ביותר משחקים. לחיצה על טורניר מציגה את הדוחות שלו.</p></section>';
  }

  VIEWS.reports = () => {
    view.period = view.period || 'all';
    view.tab = view.tab || 'winners';
    const all = allGames();
    if (!all.length) return '<p class="empty">הדוחות יופיעו אחרי שיסתיים המשחק הראשון.</p>';
    view.tour = validTour(view.tour);
    let h = backupNag();
    h += tourFilter(all);
    h += '<div class="seg">' + PERIODS.map(([v, label]) => `<button class="chip${view.period === v ? ' on' : ''}" data-act="period" data-v="${v}">${label}</button>`).join('') + '</div>';
    h += '<div class="tabs" role="tablist">' + TABS.map(([v, label]) => `<button class="tab${view.tab === v ? ' on' : ''}" role="tab" aria-selected="${view.tab === v}" data-act="tab" data-v="${v}">${label}</button>`).join('') + '</div>';
    if (view.tab === 'tours') {
      const inPeriod = new Set(ST.filterByPeriod(all, view.period).map((g) => g.id));
      return h + toursReport((g) => inPeriod.has(g.id));
    }
    const games = ST.filterByPeriod(ST.filterByTournament(all, view.tour), view.period);
    if (!games.length) return h + '<p class="empty">אין משחקים בתקופה הזו.</p>';
    return h + REPORTS[view.tab](ST.summary(games), games);
  };

  // ---------- tournaments ----------
  VIEWS.tournaments = () => {
    const rows = T.overview(state.tournaments);
    const card = (r) => {
      const t = r.tournament;
      return `
        <li class="card">
          <div class="hist-top"><b class="tour-title">${esc(t.name)}</b><span>${r.games ? gamesText(r.games) : 'עוד אין משחקים'}</span></div>
          <div class="muted">${esc(names(t).join(' · '))}</div>
          ${r.open ? `<div class="muted">משחק פתוח · ${openGameText(r.open)}</div>` : ''}
          ${r.leaders.length ? `<div class="muted">מוביל: ${esc(r.leaders.map((l) => l.player.name).join(', '))} (${r.leaders[0].total} נק׳) · אחרון: ${fmtDate(r.lastAt)}</div>` : ''}
          <div class="tour-actions">
            <button class="btn sm" data-act="open-tour" data-id="${t.id}">פתח</button>
            ${r.games ? `<button class="btn sm" data-act="tour-reports" data-id="${t.id}">דוחות</button>` : ''}
            <button class="btn sm" data-act="tour-rename" data-id="${t.id}">שנה שם</button>
            <button class="btn sm" data-act="tour-archive" data-id="${t.id}">${t.archived ? 'החזר מהארכיון' : 'לארכיון'}</button>
            ${r.games ? '' : `<button class="btn sm danger" data-act="tour-delete" data-id="${t.id}">מחק</button>`}
          </div>
        </li>`;
    };
    const open = rows.filter((r) => !r.tournament.archived);
    const archived = rows.filter((r) => r.tournament.archived);
    let h = `<h2>טורנירים</h2>
      <p class="muted">טורניר = משתתפים קבועים וכמה משחקים. כולם משחקים בכל משחק. הטבלה לפי הניקוד הכללי: הכי מעט נקודות במקום הראשון.</p>
      <button class="btn block" data-act="new-tour">+ טורניר חדש</button>
      <div style="height:12px"></div>`;
    h += open.length ? `<ul class="list">${open.map(card).join('')}</ul>` : '<p class="empty">אין טורנירים פעילים.</p>';
    if (archived.length) {
      h += `<h2>בארכיון</h2><p class="muted">הם לא מופיעים במסך הראשי, אבל נשארים בדוחות ובהיסטוריה. משחק חדש בטורניר מחזיר אותו מהארכיון.</p><ul class="list">${archived.map(card).join('')}</ul>`;
    }
    return h;
  };

  const nameTaken = (name, except) => {
    const t = T.findByName(state.tournaments, name);
    return t && t !== except ? 'כבר יש טורניר בשם הזה' : '';
  };

  async function renameTournament(id) {
    const t = tourById(id);
    if (!t) return;
    const name = await askText({ title: 'שם הטורניר', value: t.name, validate: (v) => nameTaken(v, t) });
    if (!name || name === t.name) return;
    t.name = name;
    R.touchMeta(t);
    tourSaved(t);
  }

  function toggleArchive(id) {
    const t = tourById(id);
    if (!t) return;
    t.archived = !t.archived;
    R.touchMeta(t);
    tourSaved(t);
    toast(t.archived ? 'הטורניר הועבר לארכיון' : 'הטורניר חזר מהארכיון');
  }

  async function deleteTournament(id) {
    const t = tourById(id);
    if (!t) return;
    if (R.finishedGames(t).length) {
      toast('אפשר למחוק רק טורניר בלי משחקים שהסתיימו');
      return;
    }
    const ok = await ask({
      title: `למחוק את הטורניר "${t.name}"?`,
      body: R.openGame(t) ? 'גם המשחק הפתוח בו יימחק.' : '',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    state.tournaments[state.tournaments.indexOf(t)] = T.tombstone(t);
    if (state.activeId === id) state.activeId = null;
    undoStack = undoStack.filter((u) => u.tid !== id);
    tourSaved(t);
  }

  function tourReports(id) {
    if (view.name === 'reports') {
      view.tour = id;
      view.tab = 'winners';
      render();
      window.scrollTo(0, 0);
    } else {
      go('reports', { tour: id, tab: 'winners' });
    }
  }

  // ---------- settings: git + backup ----------
  VIEWS.settings = () => {
    const games = allGames().length;
    const open = T.live(state.tournaments).filter((t) => R.openGame(t)).length;
    let h = `<section class="card form"><h2>שמירה בגיט</h2>
      <p class="muted">כל טורניר נשמר כקובץ אחד במאגר גיטהאב שלך, אחרי כל שינוי: המשתתפים, כל המשחקים עם כל התורים, והמשחק שבאמצע. כך שום דבר לא הולך לאיבוד, ואפשר להמשיך גם מטלפון אחר.</p>`;
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
        <p class="muted">קובץ אחד עם כל הטורנירים. אפשר לשלוח אותו לעצמך ולטעון אותו בטלפון אחר.</p>
        <div class="row">
          <button class="btn" data-act="export">ייצוא גיבוי</button>
          <label class="btn">ייבוא גיבוי<input type="file" id="import-file" accept=".json,application/json" hidden></label>
        </div>
      </section>
      <section class="card"><h2>במכשיר הזה</h2>
        <ul class="stat-list">
          ${li('טורנירים', T.live(state.tournaments).length)}
          ${li('משחקים שהסתיימו', games)}
          ${li('משחקים פתוחים', open)}
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
      body: 'הטורנירים יישארו בטלפון ובמאגר, אבל שינויים חדשים לא יישמרו בגיט עד שתתחבר שוב.',
      buttons: [{ label: 'נתק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    saveGh(null);
    render();
  }

  async function exportBackup() {
    const data = { app: 'rummy51', version: 2, exportedAt: new Date().toISOString(), tournaments: state.tournaments };
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
    state.backupCount = allGames().length;
    persist();
    toast('קובץ הגיבוי נוצר');
  }

  // Accepts this version's backup (tournaments) and the previous one's (a list of games).
  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('הקובץ לא תקין'); return; }
      let incoming = null;
      if (data && data.version === 2 && Array.isArray(data.tournaments)) incoming = data.tournaments;
      else if (data && Array.isArray(data.history)) incoming = T.fromV1(data);
      if (!incoming) { toast('זה לא קובץ גיבוי של רמי 51'); return; }
      const m = T.mergeLists(state.tournaments, incoming);
      state.tournaments = m.list;
      m.changed.forEach((id) => SY.markDirty(state, id));
      if (!activeTour() && m.changed.length) state.activeId = m.changed[m.changed.length - 1];
      persist();
      scheduleSync(0);
      toast(m.added ? 'נוספו ' + (m.added === 1 ? 'טורניר 1' : m.added + ' טורנירים') : m.changed.length ? 'עודכנו ' + m.changed.length + ' טורנירים' : 'כל מה שבקובץ כבר קיים');
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
      case 'new-tour': startSetup(); break;
      case 'open-tour': openTour(d.id); break;
      case 'next-game': nextGame(d.id); break;
      case 'pick-dealer': view.firstDealer = +d.i; render(); break;
      case 'move': movePlayer(+d.i, +d.d); break;
      case 'remove-player': removePlayer(+d.i); break;
      case 'add-player': view.names.push(''); render(); document.querySelector(`.pname[data-i="${view.names.length - 1}"]`).focus(); break;
      case 'rounds': view.rounds = Math.min(MAX_ROUNDS, Math.max(1, view.rounds + +d.d)); render(); break;
      case 'start-tour': startTour(); break;
      case 'start-next': startNext(); break;
      case 'open-round': openRound(d.gid, +d.i); break;
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
      case 'discard': discardGame(); break;
      case 'toggle-rounds': view.roundsOpen = !view.roundsOpen; render(); break;
      case 'player': openPlayer(d.tid, d.pid); break;
      case 'close-player': closePlayer(); break;
      case 'edit-round-of': closePlayer(); openRound(d.gid, +d.i); break;
      case 'view-game': if (psheet) closePlayer(); go('game-detail', { id: d.id }); break;
      case 'delete-game': deleteGame(d.id); break;
      case 'move-game': moveGame(d.id); break;
      case 'pick-tour': tourReports(d.id); break;
      case 'tour-reports': tourReports(d.id); break;
      case 'tour-rename': renameTournament(d.id); break;
      case 'tour-archive': toggleArchive(d.id); break;
      case 'tour-delete': deleteTournament(d.id); break;
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
      refreshSetup();
    } else if (t.id === 'tour-name') {
      view.tourName = t.value;
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
    else if (field === 'tour') { view.tour = t.value; render(); }
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
  if (converted) persist();
  const start = activeTour();
  if (start && R.openGame(start)) {
    stack = [{ name: 'home' }];
    view = { name: 'tournament', id: start.id };
    history.pushState({ rummy: 1 }, '');
  }
  render();
  if (converted) toast('הנתונים עברו למבנה החדש: ' + (converted === 1 ? 'טורניר 1' : converted + ' טורנירים'));
  if (gh) pullFromGit(true);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
})();
