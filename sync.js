/* Rummy 51 — saves tournaments to a GitHub repository through the contents API.
   data/tournaments/<id>.json  one file per tournament: its participants and all its games with every round,
                               also the game being played (so another phone can continue it),
                               and a readable digest ("summary": table, every game's totals) for reports.
   The previous version's files (data/games/, data/current.json, data/tournaments.json) are read once,
   converted, and then left as they are.
   state.sync = { dirty: { id: version }, shas: { id: sha }, legacyDone, lastSyncAt, lastError }
   The token lives only in this device's localStorage; it is never part of the app's code. */
(function (root) {
  'use strict';

  var API = 'https://api.github.com';
  var DIR = 'data/tournaments';
  var LEGACY_GAMES = 'data/games';
  var LEGACY_CURRENT = 'data/current.json';
  var LEGACY_TOURNAMENTS = 'data/tournaments.json';

  // Tests replace fetchImpl with a fake GitHub.
  var Sync = { fetchImpl: null };

  function doFetch(url, init) {
    return (Sync.fetchImpl || root.fetch.bind(root))(url, init);
  }

  function emptySync() {
    return { dirty: {}, shas: {}, legacyDone: false, lastSyncAt: null, lastError: null };
  }

  // Accepts "owner/repo", "https://github.com/owner/repo" or "...repo.git".
  function parseRepo(s) {
    var m = String(s || '').trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function errorMessage(status) {
    if (status === 401) return 'הטוקן לא תקין או שפג תוקפו';
    if (status === 403) return 'לטוקן אין הרשאה. ודא שיש לו הרשאת כתיבה לתוכן (Contents) במאגר';
    if (status === 404) return 'המאגר לא נמצא, או שלטוקן אין גישה אליו';
    if (status === 409 || status === 422) return 'התנגשות בשמירה. נסה לסנכרן שוב';
    return 'שגיאה מגיטהאב (' + status + ')';
  }

  async function request(cfg, method, path, body) {
    var res;
    try {
      res = await doFetch(API + path, {
        method: method,
        cache: 'no-store',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + cfg.token,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error('אין חיבור לגיטהאב');
    }
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      var err = new Error(errorMessage(res.status));
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? {} : res.json();
  }

  function contentsPath(cfg, path) {
    return '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  }

  // Confirms the repository is reachable with this token.
  async function check(cfg) {
    var info = await request(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo);
    if (!info) throw new Error(errorMessage(404));
    return { private: !!info.private, fullName: info.full_name };
  }

  async function getJSON(cfg, path) {
    var f = await request(cfg, 'GET', contentsPath(cfg, path));
    if (!f || Array.isArray(f)) return null;
    return { data: JSON.parse(b64decode(f.content)), sha: f.sha };
  }

  async function listDir(cfg, path) {
    var list = await request(cfg, 'GET', contentsPath(cfg, path));
    return Array.isArray(list) ? list : [];
  }

  function tournamentPath(id) {
    return DIR + '/' + id + '.json';
  }

  function markDirty(state, id) {
    state.sync.dirty[id] = (state.sync.dirty[id] || 0) + 1;
  }

  function pending(state) {
    return Object.keys(state.sync.dirty).length;
  }

  function commitMessage(t) {
    if (t.deleted) return 'מחיקת טורניר ' + t.name;
    var R = root.Rummy;
    var open = R.openGame(t);
    var done = R.finishedGames(t).length;
    return 'טורניר ' + t.name + ' — ' + done + ' משחקים' + (open ? ', משחק פתוח: שוחקו ' + R.playedCount(open) + ' תורים' : '');
  }

  // The file: the raw data, with the digest right after the name so it is easy to read.
  function fileContent(t) {
    var out = { id: t.id, name: t.name };
    if (!t.deleted) out.summary = root.Rummy.digest(t);
    Object.keys(t).forEach(function (k) { if (!(k in out)) out[k] = t[k]; });
    return b64encode(JSON.stringify(out, null, 1) + '\n');
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  // Brings a copy from the repository into the local list. Returns the merge result.
  function takeRemote(state, data) {
    var i = indexOfId(state.tournaments, data.id);
    var m = root.RummyTournaments.mergeTournament(i >= 0 ? state.tournaments[i] : null, data);
    if (m.changed) {
      if (i >= 0) state.tournaments[i] = m.tournament;
      else state.tournaments.push(m.tournament);
    }
    return m;
  }

  // Writes one tournament. When the file changed in the repository since this phone last saw it
  // (another phone saved it), that copy is merged in first, so nothing is lost.
  async function putTournament(state, cfg, id) {
    var path = contentsPath(cfg, tournamentPath(id));
    var t = state.tournaments[indexOfId(state.tournaments, id)];
    var sha = state.sync.shas[id];
    var res;
    try {
      res = await request(cfg, 'PUT', path, { message: commitMessage(t), content: fileContent(t), sha: sha });
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      var got = await getJSON(cfg, tournamentPath(id));
      if (got && got.data) takeRemote(state, got.data);
      t = state.tournaments[indexOfId(state.tournaments, id)];
      res = await request(cfg, 'PUT', path, { message: commitMessage(t), content: fileContent(t), sha: got ? got.sha : undefined });
    }
    if (res && res.content && res.content.sha) state.sync.shas[id] = res.content.sha;
  }

  // Pushes every tournament that changed. A tournament that changes while it is being sent stays pending.
  // Mutates state; the caller persists it.
  async function flush(state, cfg) {
    var s = state.sync;
    var ids = Object.keys(s.dirty);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var version = s.dirty[id];
      if (indexOfId(state.tournaments, id) >= 0) await putTournament(state, cfg, id);
      if (s.dirty[id] === version) delete s.dirty[id];
    }
    s.lastSyncAt = new Date().toISOString();
    s.lastError = null;
    return ids.length;
  }

  // The previous version's files, in the shape it kept them on the phone: { history, current, tournaments }.
  async function readLegacy(cfg) {
    var files = (await listDir(cfg, LEGACY_GAMES)).filter(function (f) { return f.type === 'file' && /\.json$/.test(f.name); });
    var history = [];
    for (var i = 0; i < files.length; i++) {
      var got = await getJSON(cfg, files[i].path);
      if (got && got.data && got.data.id && got.data.finishedAt) history.push(got.data);
    }
    var cur = await getJSON(cfg, LEGACY_CURRENT);
    var tours = await getJSON(cfg, LEGACY_TOURNAMENTS);
    return {
      history: history,
      current: cur && cur.data && !cur.data.finishedAt ? cur.data : null,
      tournaments: tours && tours.data && Array.isArray(tours.data.tournaments) ? tours.data.tournaments : []
    };
  }

  // Brings in tournaments that changed in the repository and queues what exists only here.
  // Only files whose sha changed since the last pull are downloaded. The first time, the previous
  // version's files are converted and merged in too.
  async function pull(state, cfg) {
    var s = state.sync;
    var files = (await listDir(cfg, DIR)).filter(function (f) { return f.type === 'file' && /\.json$/.test(f.name); });
    var remote = {};
    var added = 0, updated = 0;
    for (var i = 0; i < files.length; i++) {
      var id = files[i].name.replace(/\.json$/, '');
      remote[id] = true;
      if (s.shas[id] === files[i].sha) continue;
      var got = await getJSON(cfg, files[i].path);
      if (!got || !got.data || got.data.id !== id) continue;
      var isNew = indexOfId(state.tournaments, id) < 0;
      var m = takeRemote(state, got.data);
      if (m.changed) { if (isNew && !got.data.deleted) added++; else if (!isNew) updated++; }
      if (m.ahead) markDirty(state, id);
      s.shas[id] = got.sha;
    }
    if (!s.legacyDone) {
      var old = await readLegacy(cfg);
      var conv = root.RummyTournaments.fromV1(old);
      conv.forEach(function (t) {
        var isNew = indexOfId(state.tournaments, t.id) < 0;
        var m = takeRemote(state, t);
        if (m.changed) { if (isNew) added++; else updated++; }
      });
      s.legacyDone = true;
    }
    state.tournaments.forEach(function (t) {
      if (remote[t.id]) return;
      delete s.shas[t.id];
      if (!s.dirty[t.id]) markDirty(state, t.id);
    });
    return { added: added, updated: updated };
  }

  Sync.DIR = DIR;
  Sync.emptySync = emptySync;
  Sync.parseRepo = parseRepo;
  Sync.b64encode = b64encode;
  Sync.b64decode = b64decode;
  Sync.check = check;
  Sync.getJSON = getJSON;
  Sync.listDir = listDir;
  Sync.tournamentPath = tournamentPath;
  Sync.markDirty = markDirty;
  Sync.pending = pending;
  Sync.flush = flush;
  Sync.readLegacy = readLegacy;
  Sync.pull = pull;

  root.RummySync = Sync;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
