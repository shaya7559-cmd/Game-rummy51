/* Rummy 51 — the list of tournaments: finding them, keeping copies in step (two phones, git, a backup file),
   and converting what the previous version saved (a list of games, each pointing to a tournament). Pure functions, no DOM.
   A deleted tournament stays as a tombstone ({ id, name, deleted: true }) so the deletion reaches other phones. */
(function (root) {
  'use strict';

  var R = root.Rummy;

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // Same people, any seating order.
  function lineupKey(names) {
    return names.map(R.cleanName).filter(Boolean).sort().join('|');
  }

  function defaultName(names) {
    return names.map(R.cleanName).filter(Boolean).join(' · ');
  }

  function live(list) {
    return list.filter(function (t) { return !t.deleted; });
  }

  // Tournaments that are played in now (not in the archive).
  function active(list) {
    return live(list).filter(function (t) { return !t.archived; });
  }

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findByName(list, name) {
    var key = R.cleanName(name).toLowerCase();
    var hits = live(list).filter(function (t) { return t.name.toLowerCase() === key; });
    return hits.length ? hits[0] : null;
  }

  function findByLineup(list, names) {
    var key = lineupKey(names);
    var hits = active(list).filter(function (t) { return lineupKey(t.players.map(function (p) { return p.name; })) === key; });
    return hits.length ? hits[0] : null;
  }

  // Every finished game of every tournament that is not deleted, oldest first.
  function allGames(list) {
    var out = [];
    live(list).forEach(function (t) { out = out.concat(R.finishedGames(t)); });
    return out.sort(function (a, b) { return a.finishedAt.localeCompare(b.finishedAt); });
  }

  // { tour, game } for a game id, or null.
  function findGame(list, id) {
    var ts = live(list);
    for (var i = 0; i < ts.length; i++) {
      var g = R.findTourGame(ts[i], id);
      if (g) return { tour: ts[i], game: g };
    }
    return null;
  }

  function tombstone(t) {
    var at = R.now();
    return { id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: at, metaAt: at, deleted: true, players: [], games: [] };
  }

  // One row per tournament that is not deleted: finished games (only those pick() accepts, when given),
  // the last one, and the table over them. Most recently used first.
  function overview(list, pick) {
    return live(list).map(function (t) {
      var games = R.finishedGames(t).filter(function (g) { return !pick || pick(g); });
      var table = games.length ? R.tally(t.players, games) : [];
      return {
        tournament: t,
        games: games.length,
        lastAt: games.length ? games[games.length - 1].finishedAt : null,
        leaders: table.filter(function (r) { return r.place === 1; }),
        top: table.slice(0, 3),
        open: R.openGame(t)
      };
    }).sort(function (a, b) {
      return (b.tournament.updatedAt || '').localeCompare(a.tournament.updatedAt || '');
    });
  }

  // ---------- merging copies ----------
  // JSON with sorted keys, so two copies compare by content and not by key order.
  function canon(o) {
    if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
    if (o && typeof o === 'object') {
      return '{' + Object.keys(o).sort().filter(function (k) { return o[k] !== undefined; })
        .map(function (k) { return JSON.stringify(k) + ':' + canon(o[k]); }).join(',') + '}';
    }
    return JSON.stringify(o);
  }

  function metaSig(t) {
    return JSON.stringify([t.name, !!t.deleted, !!t.archived]);
  }

  // What two copies are compared by.
  function sig(t) {
    return canon([t.metaAt || '', metaSig(t), t.players || [], (t.removed || []).slice().sort(), t.games || []]);
  }

  // How far along a copy of a game is: finished, then more rounds played.
  function progress(g) {
    return (g.finishedAt ? 1e6 : 0) + (Array.isArray(g.rounds) ? R.playedCount(g) : 0);
  }

  // Whether copy x should replace copy have: the later stamp wins. With equal stamps the copy further along wins,
  // and otherwise a fixed order, so every phone picks the same one.
  function wins(x, have, stamp) {
    var a = x[stamp] || '', b = have[stamp] || '';
    if (a !== b) return a > b;
    var sx = canon(x), sh = canon(have);
    if (sx === sh) return false;
    if (progress(x) !== progress(have)) return progress(x) > progress(have);
    return sx > sh;
  }

  function unionById(a, b, stamp) {
    var map = {};
    var order = [];
    a.concat(b).forEach(function (x) {
      if (!x || !x.id) return;
      var have = map[x.id];
      if (!have) { map[x.id] = x; order.push(x.id); }
      else if (wins(x, have, stamp)) map[x.id] = x;
    });
    return order.map(function (id) { return clone(map[id]); });
  }

  // The git file also carries a readable digest; it is never read back.
  function strip(t) {
    var c = clone(t);
    delete c.summary;
    return c;
  }

  // Two copies of one tournament. The name and the archived/deleted state come from the copy whose metaAt is later;
  // each game comes from the copy that changed it last, and a game deleted in either copy stays deleted.
  // changed = the result differs from local; ahead = it differs from remote (it should be uploaded).
  function mergeTournament(local, remote) {
    if (!local) return { tournament: R.normalize(strip(remote)), changed: true, ahead: false };
    if (!remote) return { tournament: local, changed: false, ahead: true };
    remote = strip(remote);
    var lm = local.metaAt || '', rm = remote.metaAt || '';
    var meta = rm > lm || (rm === lm && metaSig(remote) > metaSig(local)) ? remote : local;
    var out = {
      id: local.id,
      name: meta.name,
      createdAt: [local.createdAt, remote.createdAt].filter(Boolean).sort()[0],
      updatedAt: [local.updatedAt || '', remote.updatedAt || ''].sort()[1],
      metaAt: meta.metaAt
    };
    if (meta.deleted) {
      out.deleted = true;
      out.players = [];
      out.games = [];
    } else {
      if (meta.archived) out.archived = true;
      out.players = unionById(local.players || [], remote.players || [], 'at');
      var removed = (local.removed || []).concat(remote.removed || []).filter(function (id, i, arr) { return arr.indexOf(id) === i; });
      if (removed.length) out.removed = removed.sort();
      out.games = unionById(local.games || [], remote.games || [], 'updatedAt');
      R.normalize(out);
    }
    var s = sig(out);
    return { tournament: out, changed: s !== sig(local), ahead: s !== sig(remote) };
  }

  // Merges a list (e.g. from a backup file) into the local one. Returns the new list and the ids that changed.
  function mergeLists(local, incoming) {
    var list = local.slice();
    var changed = [];
    var added = 0;
    (incoming || []).forEach(function (t) {
      if (!t || !t.id) return;
      var i = -1;
      list.forEach(function (x, k) { if (x.id === t.id) i = k; });
      var m = mergeTournament(i >= 0 ? list[i] : null, t);
      if (!m.changed) return;
      if (i >= 0) list[i] = m.tournament;
      else { list.push(m.tournament); if (!t.deleted) added++; }
      changed.push(t.id);
    });
    return { list: list, changed: changed, added: added };
  }

  // ---------- data saved by the previous version ----------
  // A stable short id, so converting the same data on two phones gives the same ids.
  function hashId(prefix, s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return prefix + h.toString(36);
  }

  function isGame(g) {
    return g && g.id && Array.isArray(g.players) && Array.isArray(g.rounds);
  }

  // A copy of a game whose player ids are replaced through map (old id → new id), everywhere they appear.
  function remapGame(g, map) {
    var ng = clone(g);
    ng.players = g.players.map(function (p) { return { id: map[p.id], name: R.cleanName(p.name) }; });
    if (g.winnerId) ng.winnerId = map[g.winnerId];
    ng.rounds = g.rounds.map(function (r) {
      var nr = clone(r);
      if (r.result) {
        nr.result = { winnerId: map[r.result.winnerId], hand: !!r.result.hand, entries: {} };
        Object.keys(r.result.entries || {}).forEach(function (k) {
          if (map[k]) nr.result.entries[map[k]] = clone(r.result.entries[k]);
        });
      }
      return nr;
    });
    return ng;
  }

  // Previous version: { history: [finished game], current: game|null, tournaments: [{ id, name, lineup, archived, deleted }] },
  // where each game has its own player ids (p1, p2…) and a tournamentId. Every game moves into its tournament,
  // and the participants are matched by name.
  function fromV1(old) {
    var games = (old.history || []).filter(function (g) { return isGame(g) && g.finishedAt; });
    if (isGame(old.current) && !old.current.finishedAt) games.push(old.current);
    var stamp = function (g) { return g.finishedAt || g.updatedAt || g.createdAt || ''; };
    games.sort(function (a, b) { return stamp(a).localeCompare(stamp(b)); });
    var oldTours = {};
    (old.tournaments || []).forEach(function (t) { if (t && t.id) oldTours[t.id] = t; });

    var groups = {};
    var order = [];
    games.forEach(function (g) {
      var names = g.players.map(function (p) { return R.cleanName(p.name); });
      var key = g.tournamentId || hashId('l', lineupKey(names));
      if (!groups[key]) { groups[key] = { games: [], name: g.tournamentName || defaultName(names), lineup: [] }; order.push(key); }
      groups[key].games.push(g);
    });
    // Tournaments opened for a lineup and not played in yet.
    Object.keys(oldTours).forEach(function (id) {
      var t = oldTours[id];
      if (!groups[id] && !t.deleted && t.lineup) {
        groups[id] = { games: [], name: t.name, lineup: t.lineup.split('|') };
        order.push(id);
      }
    });

    return order.map(function (key) {
      var grp = groups[key];
      var ot = oldTours[key];
      var at = (ot && ot.createdAt) || (grp.games[0] && grp.games[0].createdAt) || R.now();
      var tour = { id: key, name: R.cleanName((ot && ot.name) || grp.name), createdAt: at, updatedAt: at, metaAt: (ot && ot.updatedAt) || at, players: [], games: [] };
      if (ot && ot.archived) tour.archived = true;
      var pid = {};
      var addPlayer = function (name) {
        if (!pid[name]) {
          pid[name] = hashId('n', name);
          tour.players.push({ id: pid[name], name: name, at: at });
        }
        return pid[name];
      };
      grp.lineup.forEach(addPlayer);
      grp.games.forEach(function (g) {
        var map = {};
        g.players.forEach(function (p) { map[p.id] = addPlayer(R.cleanName(p.name)); });
        var ng = remapGame(g, map);
        delete ng.tournamentName;
        ng.tournamentId = key;
        tour.games.push(ng);
        if ((ng.updatedAt || '') > tour.updatedAt) tour.updatedAt = ng.updatedAt;
      });
      return R.normalize(tour);
    });
  }

  var RummyTournaments = {
    lineupKey: lineupKey,
    defaultName: defaultName,
    live: live,
    active: active,
    find: find,
    findByName: findByName,
    findByLineup: findByLineup,
    allGames: allGames,
    findGame: findGame,
    tombstone: tombstone,
    overview: overview,
    canon: canon,
    sig: sig,
    mergeTournament: mergeTournament,
    mergeLists: mergeLists,
    remapGame: remapGame,
    fromV1: fromV1
  };

  root.RummyTournaments = RummyTournaments;
  if (typeof module !== 'undefined' && module.exports) module.exports = RummyTournaments;
})(typeof window !== 'undefined' ? window : globalThis);
