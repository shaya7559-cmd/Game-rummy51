/* Rummy 51 — tournaments. Pure functions, no DOM.
   Every game belongs to one tournament. By default each lineup gets its own tournament;
   a named tournament (e.g. per place) can be opened at any time.
   Tournament = { id, name, lineup: key|null, createdAt, updatedAt, archived?, deleted? }
   A deleted tournament stays as a tombstone so the deletion syncs to other phones. */
(function (root) {
  'use strict';

  var R = root.Rummy;
  var ST = root.RummyStats;

  function playerNames(game) {
    return game.players.map(function (p) { return p.name; });
  }

  // Same people, any seating order.
  function lineupKey(names) {
    return names.map(R.cleanName).filter(Boolean).sort().join('|');
  }

  function defaultName(names) {
    return names.map(R.cleanName).filter(Boolean).join(' · ');
  }

  function make(name, lineup) {
    var t = new Date().toISOString();
    return { id: R.uid(), name: R.cleanName(name), lineup: lineup || null, createdAt: t, updatedAt: t, archived: false };
  }

  function touch(t) {
    t.updatedAt = new Date().toISOString();
  }

  function live(list) {
    return list.filter(function (t) { return !t.deleted; });
  }

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function sameName(a, b) {
    return R.cleanName(a).toLowerCase() === R.cleanName(b).toLowerCase();
  }

  function findByName(list, name) {
    var hits = live(list).filter(function (t) { return sameName(t.name, name); });
    return hits.length ? hits[0] : null;
  }

  function gamesOf(games, id) {
    return games.filter(function (g) { return g.tournamentId === id; });
  }

  function nameOf(list, game) {
    var t = game && find(list, game.tournamentId);
    return t ? t.name : (game && game.tournamentName) || 'ללא טורניר';
  }

  // The tournament this lineup played in last, or one opened for this lineup and not used yet.
  // Returns null when the lineup is new (the caller offers a new tournament).
  function suggest(list, games, names) {
    var key = lineupKey(names);
    var open = function (t) { return t && !t.deleted && !t.archived; };
    var played = ST.finished(games).reverse();
    for (var i = 0; i < played.length; i++) {
      if (lineupKey(playerNames(played[i])) !== key) continue;
      var t = find(list, played[i].tournamentId);
      if (open(t)) return t;
    }
    var byLineup = list.filter(function (x) { return open(x) && x.lineup === key; });
    return byLineup.length ? byLineup[byLineup.length - 1] : null;
  }

  // Gives every game a tournament: games from before tournaments existed are grouped by lineup,
  // and a tournament known only from a game (e.g. pulled from git) is rebuilt from it.
  // Returns { games: ids of games that changed, tournaments: whether the list changed }.
  function ensure(list, games) {
    var out = { games: [], tournaments: false };
    games.forEach(function (g) {
      if (!g) return;
      if (!g.tournamentId) {
        var key = lineupKey(playerNames(g));
        var t = live(list).filter(function (x) { return x.lineup === key; })[0];
        if (!t) {
          t = make(defaultName(playerNames(g)), key);
          t.createdAt = t.updatedAt = g.createdAt || t.createdAt;
          list.push(t);
          out.tournaments = true;
        }
        g.tournamentId = t.id;
        g.tournamentName = t.name;
        out.games.push(g.id);
        return;
      }
      var known = find(list, g.tournamentId);
      if (!known) {
        var at = g.createdAt || new Date().toISOString();
        list.push({ id: g.tournamentId, name: g.tournamentName || defaultName(playerNames(g)), lineup: null, createdAt: at, updatedAt: at, archived: false });
        out.tournaments = true;
      } else if (known.deleted) {
        known.deleted = false;
        touch(known);
        out.tournaments = true;
      }
    });
    return out;
  }

  // Union by id; the copy updated last wins. changed = the local list was modified,
  // ahead = the local list has something the incoming one lacks (it should be uploaded).
  function merge(local, incoming) {
    var changed = false, ahead = false;
    var map = {};
    local.forEach(function (t) { map[t.id] = t; });
    var seen = {};
    (incoming || []).forEach(function (t) {
      if (!t || !t.id) return;
      seen[t.id] = true;
      var have = map[t.id];
      if (!have || (t.updatedAt || '') > (have.updatedAt || '')) {
        map[t.id] = t;
        changed = true;
      } else if ((have.updatedAt || '') > (t.updatedAt || '')) {
        ahead = true;
      }
    });
    local.forEach(function (t) { if (!seen[t.id]) ahead = true; });
    var list = Object.keys(map).map(function (id) { return map[id]; })
      .sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
    return { list: list, changed: changed, ahead: ahead };
  }

  // One row per tournament that is not deleted: game count, last game and leader
  // (most game wins, then fewest total points). Most recently played first.
  function overview(list, games) {
    var done = ST.finished(games);
    return live(list).map(function (t) {
      var own = gamesOf(done, t.id);
      var sum = own.length ? ST.summary(own) : null;
      return {
        tournament: t,
        games: own.length,
        lastAt: own.length ? own[own.length - 1].finishedAt : null,
        leader: sum ? sum.players[0] : null,
        top: sum ? sum.players.slice(0, 3) : []
      };
    }).sort(function (a, b) {
      return (b.lastAt || b.tournament.createdAt || '').localeCompare(a.lastAt || a.tournament.createdAt || '');
    });
  }

  var RummyTournaments = {
    lineupKey: lineupKey,
    defaultName: defaultName,
    make: make,
    touch: touch,
    live: live,
    find: find,
    findByName: findByName,
    gamesOf: gamesOf,
    nameOf: nameOf,
    suggest: suggest,
    ensure: ensure,
    merge: merge,
    overview: overview
  };

  root.RummyTournaments = RummyTournaments;
  if (typeof module !== 'undefined' && module.exports) module.exports = RummyTournaments;
})(typeof window !== 'undefined' ? window : globalThis);
