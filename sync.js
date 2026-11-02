/* Rummy 51 — saves games to a GitHub repository through the contents API.
   data/games/<date>_<id>.json  one file per finished game
   data/current.json            the game in progress (removed when there is none)
   data/tournaments.json        the list of tournaments
   The token lives only in this device's localStorage; it is never part of the app's code. */
(function (root) {
  'use strict';

  var API = 'https://api.github.com';
  var GAMES_DIR = 'data/games';
  var CURRENT = 'data/current.json';
  var TOURNAMENTS = 'data/tournaments.json';

  // Tests replace fetchImpl with a fake GitHub.
  var Sync = { fetchImpl: null };

  function doFetch(url, init) {
    return (Sync.fetchImpl || root.fetch.bind(root))(url, init);
  }

  function emptySync() {
    return {
      currentVersion: 0, syncedVersion: 0, tournamentsVersion: 0, tournamentsSynced: 0,
      unsyncedGames: [], deletedGames: [], lastSyncAt: null, lastError: null
    };
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

  async function putJSON(cfg, path, data, message) {
    var existing = await request(cfg, 'GET', contentsPath(cfg, path));
    var body = { message: message, content: b64encode(JSON.stringify(data, null, 1) + '\n') };
    if (existing && existing.sha) body.sha = existing.sha;
    await request(cfg, 'PUT', contentsPath(cfg, path), body);
  }

  async function deleteFile(cfg, path, message) {
    var existing = await request(cfg, 'GET', contentsPath(cfg, path));
    if (!existing || !existing.sha) return;
    await request(cfg, 'DELETE', contentsPath(cfg, path), { message: message, sha: existing.sha });
  }

  function gamePath(game) {
    return GAMES_DIR + '/' + (game.finishedAt || game.createdAt).slice(0, 10) + '_' + game.id + '.json';
  }

  function idFromFileName(name) {
    var m = /_([a-z0-9]+)\.json$/.exec(name);
    return m ? m[1] : null;
  }

  function gameTitle(game) {
    var winner = null;
    game.players.forEach(function (p) { if (p.id === game.winnerId) winner = p.name; });
    return (game.finishedAt || '').slice(0, 10) + (winner ? ' — ניצח ' + winner : '');
  }

  function pending(state) {
    var s = state.sync;
    return s.unsyncedGames.length + s.deletedGames.length +
      (s.currentVersion !== s.syncedVersion ? 1 : 0) + (s.tournamentsVersion !== s.tournamentsSynced ? 1 : 0);
  }

  function removeFrom(list, item) {
    var i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  }

  // Pushes everything waiting: finished games, deletions, tournaments and the game in progress.
  // Mutates state.sync; the caller persists it.
  async function flush(state, cfg) {
    var s = state.sync;
    var done = 0;
    var ids = s.unsyncedGames.slice();
    for (var i = 0; i < ids.length; i++) {
      var game = null;
      state.history.forEach(function (g) { if (g.id === ids[i]) game = g; });
      if (game) await putJSON(cfg, gamePath(game), game, 'משחק ' + gameTitle(game));
      removeFrom(s.unsyncedGames, ids[i]);
      done++;
    }
    var paths = s.deletedGames.slice();
    for (var j = 0; j < paths.length; j++) {
      await deleteFile(cfg, paths[j], 'מחיקת משחק');
      removeFrom(s.deletedGames, paths[j]);
      done++;
    }
    if (s.tournamentsVersion !== s.tournamentsSynced) {
      var tVersion = s.tournamentsVersion;
      await putJSON(cfg, TOURNAMENTS, { tournaments: state.tournaments || [] }, 'עדכון טורנירים');
      s.tournamentsSynced = tVersion;
      done++;
    }
    if (s.currentVersion !== s.syncedVersion) {
      // Snapshot first: the game may change while the request is in flight.
      var version = s.currentVersion;
      var snapshot = state.current ? JSON.parse(JSON.stringify(state.current)) : null;
      if (snapshot) {
        var played = snapshot.rounds.filter(function (r) { return r.result; }).length;
        await putJSON(cfg, CURRENT, snapshot, 'משחק פתוח — שוחקו ' + played + ' תורים');
      } else {
        await deleteFile(cfg, CURRENT, 'אין משחק פתוח');
      }
      s.syncedVersion = version;
      done++;
    }
    s.lastSyncAt = new Date().toISOString();
    s.lastError = null;
    return done;
  }

  // Brings in finished games and tournaments that exist only in the repository, and queues
  // what exists only here. Returns the repository's game in progress so the caller can offer it.
  async function pull(state, cfg) {
    var s = state.sync;
    var files = (await listDir(cfg, GAMES_DIR)).filter(function (f) {
      return f.type === 'file' && /\.json$/.test(f.name);
    });
    var have = {};
    state.history.forEach(function (g) { have[g.id] = true; });
    var remoteIds = {};
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var id = idFromFileName(files[i].name);
      if (!id) continue;
      remoteIds[id] = true;
      if (have[id] || s.deletedGames.indexOf(files[i].path) >= 0) continue;
      var got = await getJSON(cfg, files[i].path);
      if (got && got.data && got.data.id && got.data.finishedAt) {
        state.history.push(got.data);
        have[got.data.id] = true;
        added++;
      }
    }
    state.history.sort(function (a, b) { return a.finishedAt.localeCompare(b.finishedAt); });
    state.history.forEach(function (g) {
      if (!remoteIds[g.id] && s.unsyncedGames.indexOf(g.id) < 0) s.unsyncedGames.push(g.id);
    });
    var remoteT = await getJSON(cfg, TOURNAMENTS);
    var merged = root.RummyTournaments.merge(state.tournaments || [], remoteT && remoteT.data ? remoteT.data.tournaments : []);
    state.tournaments = merged.list;
    if (merged.ahead) s.tournamentsVersion++;
    var cur = await getJSON(cfg, CURRENT);
    return { added: added, remoteCurrent: cur ? cur.data : null };
  }

  Sync.GAMES_DIR = GAMES_DIR;
  Sync.CURRENT = CURRENT;
  Sync.TOURNAMENTS = TOURNAMENTS;
  Sync.emptySync = emptySync;
  Sync.parseRepo = parseRepo;
  Sync.b64encode = b64encode;
  Sync.b64decode = b64decode;
  Sync.check = check;
  Sync.getJSON = getJSON;
  Sync.listDir = listDir;
  Sync.putJSON = putJSON;
  Sync.deleteFile = deleteFile;
  Sync.gamePath = gamePath;
  Sync.pending = pending;
  Sync.flush = flush;
  Sync.pull = pull;

  root.RummySync = Sync;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
})(typeof window !== 'undefined' ? window : globalThis);
