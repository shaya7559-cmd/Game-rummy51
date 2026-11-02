/* Rummy 51 — the UI. Every screen is rendered from state; clicks are routed by data-act. */
(function () {
  'use strict';

  const R = window.Rummy;
  const ST = window.RummyStats;
  const T = window.RummyTournaments;
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
  const tourName = (g) => T.nameOf(state.tournaments, g);
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

  // ---------- storage ----------
  function loadState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* empty or blocked storage */ }
    if (!s || !Array.isArray(s.history)) s = { current: null, history: [], lastPlayers: [], backupCount: 0 };
    if (!Array.isArray(s.tournaments)) s.tournaments = [];
    s.sync = Object.assign(SY.emptySync(), s.sync || {});
    return s;
  }

  function toursChanged() {
    state.sync.tournamentsVersion++;
  }

  // Gives every game a tournament (games from before tournaments, pulled from git or imported)
  // and queues whatever changed for git. Returns true when something changed.
  function fixTournaments() {
    const res = T.ensure(state.tournaments, state.history.concat(state.current ? [state.current] : []));
    res.games.forEach((id) => {
      if (state.current && state.current.id === id) state.sync.currentVersion++;
      else if (!state.sync.unsyncedGames.includes(id)) state.sync.unsyncedGames.push(id);
    });
    if (res.tournaments) toursChanged();
    return res.games.length > 0 || res.tournaments;
  }

  // The tournament of the open game, or of the last game that was started.
  function homeTournament() {
    const t = T.find(state.tournaments, state.current ? state.current.tournamentId : state.lastTournamentId);
    return t && !t.deleted ? t : null;
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
      fixTournaments();
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
        fixTournaments();
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
    fixTournaments();
    if (remote.tournamentId) state.lastTournamentId = remote.tournamentId;
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
        <div class="label">ניצח בפעם הקודמת · טורניר ${esc(tourName(g))}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${fmtDate(g.finishedAt, true)} · ${roundsText(g.rounds.length)}</div>
        ${rankList(g, false)}
      </button>`;
  }

  // The top three of a tournament; opens its reports.
  function tournamentCard(id) {
    const row = T.overview(state.tournaments, state.history).find((o) => o.tournament.id === id);
    if (!row || !row.games) return '';
    return `
      <button class="card" data-act="tour-reports" data-id="${id}">
        <div class="label">המובילים בטורניר ${esc(row.tournament.name)} · ${gamesText(row.games)}</div>
        <ol class="mini-rank stack">${row.top.map((s, i) => `<li>${i + 1}. ${esc(s.name)} <b>${winsText(s.wins)}</b></li>`).join('')}</ol>
        <div class="muted tour-line">לדוחות של הטורניר ←</div>
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
          <div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>
        </button>
        <button class="btn primary big" data-act="go" data-to="game">המשך משחק</button>
        <div class="row"><button class="btn" data-act="new-game">משחק חדש</button></div>`;
    } else {
      h += '<button class="btn primary big" data-act="new-game">משחק חדש</button>';
    }
    // Last winner and leaders of the current tournament; any last game when it has none yet.
    const done = ST.finished(state.history);
    const ht = homeTournament();
    const inTour = ht ? T.gamesOf(done, ht.id) : [];
    const last = inTour.length ? inTour[inTour.length - 1] : ST.lastGame(done);
    if (last) h += '<div style="height:12px"></div>' + lastWinnerCard(last) + tournamentCard(last.tournamentId);
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
      <section class="card form" id="tour-pick">${tourPickHtml()}</section>
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

  // tourSel = a tournament id or 'new'. Until the user picks one (tourManual), it follows the
  // lineup: the tournament these players played in last, or a new one named after them.
  function tourPickHtml() {
    const open = T.live(state.tournaments).filter((t) => !t.archived);
    let h = `
      <label for="tour-sel">טורניר</label>
      <select id="tour-sel" data-field="tourSel">
        ${open.map((t) => `<option value="${t.id}"${view.tourSel === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
        <option value="new"${view.tourSel === 'new' ? ' selected' : ''}>+ טורניר חדש…</option>
      </select>`;
    if (view.tourSel === 'new') {
      h += `
        <input type="text" id="tour-name" class="tour-name" value="${esc(view.tourName)}" placeholder="שם הטורניר, למשל: אצל סבתא" maxlength="40" autocomplete="off" enterkeyhint="done">
        <p class="muted tour-line">${view.tourManual ? 'ייפתח טורניר חדש בשם הזה.' : 'הרכב חדש, ולכן ייפתח לו טורניר חדש. אפשר לשנות את השם או לבחור טורניר קיים.'}</p>`;
    } else if (!view.tourManual) {
      h += '<p class="muted tour-line">נבחר לבד לפי ההרכב. אפשר לבחור טורניר אחר.</p>';
    }
    return h;
  }

  function refreshTourPick() {
    const el = document.getElementById('tour-pick');
    if (el) el.innerHTML = tourPickHtml();
  }

  function autoTournament(v) {
    const ns = v.names.map(R.cleanName);
    if (!v.tourNameEdited) v.tourName = T.defaultName(ns);
    if (v.tourManual) return;
    const t = T.suggest(state.tournaments, state.history, ns);
    v.tourSel = t ? t.id : 'new';
  }

  function startSetup(list, tourId) {
    const ns = (list || []).slice(0, MAX_PLAYERS);
    while (ns.length < MIN_PLAYERS) ns.push('');
    const t = T.find(state.tournaments, tourId);
    const keep = t && !t.deleted && !t.archived;
    const params = { names: ns, firstDealer: 0, rounds: R.DEFAULT_ROUNDS, tourSel: keep ? t.id : 'new', tourManual: keep, tourName: '', tourNameEdited: false };
    autoTournament(params);
    go('setup', params);
  }

  function movePlayer(i, d) {
    const j = i + d;
    if (j < 0 || j >= view.names.length) return;
    const n = view.names;
    [n[i], n[j]] = [n[j], n[i]];
    if (view.firstDealer === i) view.firstDealer = j;
    else if (view.firstDealer === j) view.firstDealer = i;
    autoTournament(view);
    render();
  }

  function removePlayer(i) {
    if (view.names.length <= MIN_PLAYERS) return;
    view.names.splice(i, 1);
    if (view.firstDealer === i) view.firstDealer = 0;
    else if (view.firstDealer > i) view.firstDealer--;
    autoTournament(view);
    render();
  }

  // The tournament chosen on the setup screen; a new one is created here.
  function setupTournament(ns) {
    let t = view.tourSel !== 'new' ? T.find(state.tournaments, view.tourSel) : null;
    if (!t || t.deleted) {
      const name = R.cleanName(view.tourName) || T.defaultName(ns);
      t = T.findByName(state.tournaments, name);
      if (!t) {
        t = T.make(name, view.tourNameEdited ? null : T.lineupKey(ns));
        state.tournaments.push(t);
        toursChanged();
      }
    }
    if (t.archived) {
      t.archived = false;
      T.touch(t);
      toursChanged();
    }
    return t;
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
    const t = setupTournament(ns);
    state.current = R.newGame(ns, { firstDealer: view.firstDealer, rounds: view.rounds });
    state.current.tournamentId = t.id;
    state.current.tournamentName = t.name;
    state.lastTournamentId = t.id;
    state.lastPlayers = ns;
    undoStack = [];
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    stack = [{ name: 'home' }];
    replace('game');
    toast('בהצלחה! ' + first + ' מחלק ראשון · ' + t.name);
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
          <div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>
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
    if (g.tournamentId) state.lastTournamentId = g.tournamentId;
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
    const t = T.find(state.tournaments, id);
    return t && !t.deleted ? id : 'all';
  }

  VIEWS.history = () => {
    const all = ST.finished(state.history);
    if (!all.length) return '<p class="empty">עוד אין משחקים שמורים.<br>כל משחק שמסתיים יופיע כאן.</p>';
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
    const g = findGame(view.id);
    if (!g) return '<p class="empty">המשחק לא נמצא.</p>';
    const winner = R.ranking(g)[0].player.name;
    let h = `
      <section class="card">
        <div class="label">${view.justFinished ? 'המשחק הסתיים 🎉' : fmtDate(g.finishedAt, true)}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${roundsText(g.rounds.length)}${g.endedEarly ? ` (הסתיים מוקדם, תוכננו ${g.plannedRounds})` : ''}</div>
        <div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>
        ${rankList(g, true)}
      </section>`;
    h += scoreTableHtml(g, false);
    if (view.justFinished) {
      h += `<button class="btn primary big" data-act="rematch" data-id="${g.id}">משחק חדש עם אותם שחקנים</button>
        <div class="row"><button class="btn" data-act="home">למסך הראשי</button></div>`;
    }
    h += `<button class="btn block" data-act="move-game" data-id="${g.id}">העבר לטורניר אחר</button>
      <button class="btn block danger" data-act="delete-game" data-id="${g.id}">מחק את המשחק מההיסטוריה</button>`;
    return h;
  };

  async function moveGame(id) {
    const g = findGame(id);
    if (!g) return;
    const others = T.live(state.tournaments).filter((t) => !t.archived && t.id !== g.tournamentId);
    if (!others.length) { toast('אין טורניר אחר. אפשר לפתוח אחד במסך "טורנירים".'); return; }
    const to = await ask({
      title: 'להעביר לאיזה טורניר?',
      body: 'המשחק עובר עם כל התוצאות, והדוחות של שני הטורנירים מתעדכנים.',
      buttons: others.map((t) => ({ label: t.name, value: t.id })).concat([{ label: 'ביטול', value: null }]),
      cancel: null
    });
    if (!to) return;
    const t = T.find(state.tournaments, to);
    g.tournamentId = t.id;
    g.tournamentName = t.name;
    R.touch(g);
    if (!state.sync.unsyncedGames.includes(g.id)) state.sync.unsyncedGames.push(g.id);
    persist();
    scheduleSync(0);
    render();
    toast('המשחק הועבר לטורניר ' + t.name);
  }

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
      h += '</tbody></table></div><p class="muted" style="margin-top:8px">הדירוג לפי ניצחונות במשחקים. בשוויון, מי שצבר פחות נקודות.</p></section>';
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
  function toursReport(games) {
    const rows = T.overview(state.tournaments, games).filter((r) => r.games);
    if (!rows.length) return '<p class="empty">אין משחקים בתקופה הזו.</p>';
    return `<section class="card"><h3>כל הטורנירים</h3><div class="table-scroll"><table class="data tours">
      <thead><tr><th>טורניר</th><th>משחקים</th><th>אחרון</th><th>מוביל</th></tr></thead><tbody>` +
      rows.map((r) => `
        <tr data-act="pick-tour" data-id="${r.tournament.id}"${view.tour === r.tournament.id ? ' class="top1"' : ''}>
          <td>${esc(r.tournament.name)}${r.tournament.archived ? ' <span class="muted">(בארכיון)</span>' : ''}</td>
          <td>${r.games}</td><td>${fmtDate(r.lastAt)}</td>
          <td>${esc(r.leader.name)} <span class="muted">(${winsText(r.leader.wins)})</span></td>
        </tr>`).join('') +
      '</tbody></table></div><p class="muted" style="margin-top:8px">המוביל הוא מי שניצח בהכי הרבה משחקים. בשוויון, מי שצבר פחות נקודות. לחיצה על טורניר מציגה את הדוחות שלו.</p></section>';
  }

  VIEWS.reports = () => {
    view.period = view.period || 'all';
    view.tab = view.tab || 'winners';
    const all = ST.finished(state.history);
    if (!all.length) return '<p class="empty">הדוחות יופיעו אחרי שתסיימו ותשמרו את המשחק הראשון.</p>';
    view.tour = validTour(view.tour);
    let h = backupNag();
    h += tourFilter(all);
    h += '<div class="seg">' + PERIODS.map(([v, label]) => `<button class="chip${view.period === v ? ' on' : ''}" data-act="period" data-v="${v}">${label}</button>`).join('') + '</div>';
    h += '<div class="tabs" role="tablist">' + TABS.map(([v, label]) => `<button class="tab${view.tab === v ? ' on' : ''}" role="tab" aria-selected="${view.tab === v}" data-act="tab" data-v="${v}">${label}</button>`).join('') + '</div>';
    if (view.tab === 'tours') return h + toursReport(ST.filterByPeriod(all, view.period));
    const games = ST.filterByPeriod(ST.filterByTournament(all, view.tour), view.period);
    if (!games.length) return h + '<p class="empty">אין משחקים בתקופה הזו.</p>';
    return h + REPORTS[view.tab](ST.summary(games), games);
  };

  // ---------- tournaments ----------
  VIEWS.tournaments = () => {
    const rows = T.overview(state.tournaments, state.history);
    const inUse = (r) => r.games || (state.current && state.current.tournamentId === r.tournament.id);
    const card = (r) => {
      const t = r.tournament;
      return `
        <li class="card">
          <div class="hist-top"><b class="tour-title">${esc(t.name)}</b><span>${r.games ? gamesText(r.games) : 'עוד אין משחקים'}</span></div>
          ${r.leader ? `<div class="muted">מוביל: ${esc(r.leader.name)} (${winsText(r.leader.wins)}) · אחרון: ${fmtDate(r.lastAt)}</div>` : ''}
          <div class="tour-actions">
            ${r.games ? `<button class="btn sm" data-act="tour-reports" data-id="${t.id}">דוחות</button>` : ''}
            <button class="btn sm" data-act="tour-rename" data-id="${t.id}">שנה שם</button>
            <button class="btn sm" data-act="tour-archive" data-id="${t.id}">${t.archived ? 'החזר מהארכיון' : 'לארכיון'}</button>
            ${inUse(r) ? '' : `<button class="btn sm danger" data-act="tour-delete" data-id="${t.id}">מחק</button>`}
          </div>
        </li>`;
    };
    const open = rows.filter((r) => !r.tournament.archived);
    const archived = rows.filter((r) => r.tournament.archived);
    let h = `<h2>טורנירים</h2>
      <p class="muted">כל הרכב שחקנים מקבל טורניר משלו אוטומטית. כדי להפריד, למשל לפי מקום, פותחים טורניר חדש ובוחרים אותו כשמתחילים משחק.</p>
      <button class="btn block" data-act="tour-new">+ טורניר חדש</button>
      <div style="height:12px"></div>`;
    h += open.length ? `<ul class="list">${open.map(card).join('')}</ul>` : '<p class="empty">עוד אין טורנירים. טורניר נפתח כשמתחילים משחק.</p>';
    if (archived.length) {
      h += `<h2>בארכיון</h2><p class="muted">הם לא מוצעים כשמתחילים משחק, אבל נשארים בדוחות ובהיסטוריה.</p><ul class="list">${archived.map(card).join('')}</ul>`;
    }
    return h;
  };

  const nameTaken = (name, except) => {
    const t = T.findByName(state.tournaments, name);
    return t && t !== except ? 'כבר יש טורניר בשם הזה' : '';
  };

  function tournamentsSaved() {
    toursChanged();
    persist();
    scheduleSync();
    render();
  }

  async function newTournament() {
    const name = await askText({ title: 'טורניר חדש', placeholder: 'למשל: אצל סבתא', okLabel: 'פתח טורניר', validate: (v) => nameTaken(v) });
    if (!name) return;
    state.tournaments.push(T.make(name, null));
    tournamentsSaved();
    toast('הטורניר נפתח. בוחרים אותו כשמתחילים משחק.');
  }

  async function renameTournament(id) {
    const t = T.find(state.tournaments, id);
    if (!t) return;
    const name = await askText({ title: 'שם הטורניר', value: t.name, validate: (v) => nameTaken(v, t) });
    if (!name || name === t.name) return;
    t.name = name;
    T.touch(t);
    tournamentsSaved();
  }

  function toggleArchive(id) {
    const t = T.find(state.tournaments, id);
    if (!t) return;
    t.archived = !t.archived;
    T.touch(t);
    tournamentsSaved();
    toast(t.archived ? 'הטורניר הועבר לארכיון' : 'הטורניר חזר מהארכיון');
  }

  async function deleteTournament(id) {
    const t = T.find(state.tournaments, id);
    if (!t) return;
    if (T.gamesOf(state.history, id).length || (state.current && state.current.tournamentId === id)) {
      toast('אפשר למחוק רק טורניר בלי משחקים');
      return;
    }
    const ok = await ask({
      title: `למחוק את הטורניר "${t.name}"?`,
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    t.deleted = true;
    T.touch(t);
    if (state.lastTournamentId === id) state.lastTournamentId = null;
    tournamentsSaved();
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
          ${li('טורנירים', T.live(state.tournaments).length)}
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
    const data = { app: 'rummy51', version: 1, exportedAt: new Date().toISOString(), history: state.history, current: state.current, tournaments: state.tournaments };
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
      const mt = T.merge(state.tournaments, data.tournaments || []);
      state.tournaments = mt.list;
      if (mt.changed) toursChanged();
      fixTournaments();
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
          fixTournaments();
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
      case 'rematch': startSetup(names(findGame(d.id)), findGame(d.id).tournamentId); break;
      case 'delete-game': deleteGame(d.id); break;
      case 'move-game': moveGame(d.id); break;
      case 'pick-tour': tourReports(d.id); break;
      case 'tour-reports': tourReports(d.id); break;
      case 'tour-new': newTournament(); break;
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
      autoTournament(view);
      refreshTourPick();
    } else if (t.id === 'tour-name') {
      view.tourName = t.value;
      view.tourNameEdited = true;
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
    else if (field === 'tourSel') {
      view.tourSel = t.value;
      view.tourManual = true;
      refreshTourPick();
      const input = document.getElementById('tour-name');
      if (input) { input.focus(); input.select(); }
    }
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
  if (fixTournaments()) persist();
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
