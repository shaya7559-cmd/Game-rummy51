/* Rummy 51 — game rules. Pure functions, no DOM.
   A tournament has participants and games; everyone plays every game. A game is 12 rounds (or as many as chosen).
   Tournament = { id, name, createdAt, updatedAt, metaAt, archived?, deleted?,
                  players: [{ id, name, at }]   seat order
                  games: [Game]                 in order of play; at most one open game (no finishedAt), always last
                  removed?: [gameId] }          deleted games, so the deletion reaches other phones
   Game = { id, tournamentId, createdAt, updatedAt, players: [{ id, name }], firstDealer, rounds,
            finishedAt?, winnerId?, plannedRounds?, endedEarly? }
   A game stores only what was entered; scores are always recomputed from it.
   metaAt = when the name, archived or deleted state last changed (used when merging copies). */
(function (root) {
  'use strict';

  var WIN_POINTS = -30;
  var NO_SET_POINTS = 100;
  var DEFAULT_ROUNDS = 12;
  var GLUCK_EVERY = 4;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function now() {
    return new Date().toISOString();
  }

  function cleanName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function touch(game) {
    game.updatedAt = now();
  }

  // Round n (1-based) is an automatic gluck when n is a multiple of 4.
  function makeRound(n) {
    var auto = n % GLUCK_EVERY === 0;
    return { gluck: auto, gluckSource: auto ? 'auto' : null, freshCount: 0, result: null };
  }

  // players: names (ids p1, p2…) or { id, name } objects (a tournament's participants).
  function newGame(players, opts) {
    opts = opts || {};
    var count = opts.rounds || DEFAULT_ROUNDS;
    var rounds = [];
    for (var n = 1; n <= count; n++) rounds.push(makeRound(n));
    var t = now();
    return {
      id: uid(),
      createdAt: t,
      updatedAt: t,
      players: players.map(function (x, i) {
        return typeof x === 'string' ? { id: 'p' + (i + 1), name: cleanName(x) } : { id: x.id, name: cleanName(x.name) };
      }),
      firstDealer: opts.firstDealer || 0,
      rounds: rounds
    };
  }

  // Index of the first round without a result, or -1 when every round was played.
  function currentIndex(game) {
    for (var i = 0; i < game.rounds.length; i++) {
      if (!game.rounds[i].result) return i;
    }
    return -1;
  }

  function playedCount(game) {
    return game.rounds.filter(function (r) { return r.result; }).length;
  }

  function isComplete(game) {
    return currentIndex(game) === -1;
  }

  // The dealer moves one seat each round. A fresh redeal does not advance the round,
  // so the same player deals again.
  function dealerIndex(game, i) {
    return (game.firstDealer + i) % game.players.length;
  }

  function dealer(game, i) {
    return game.players[dealerIndex(game, i)];
  }

  function playerById(game, id) {
    for (var i = 0; i < game.players.length; i++) {
      if (game.players[i].id === id) return game.players[i];
    }
    return null;
  }

  // Appends a round. gluckSource marks it as gluck even when it is not every-4th.
  function addRound(game, gluckSource) {
    var r = makeRound(game.rounds.length + 1);
    if (gluckSource && !r.gluck) {
      r.gluck = true;
      r.gluckSource = gluckSource;
    }
    game.rounds.push(r);
    touch(game);
    return game.rounds.length - 1;
  }

  // A fresh turns the current round into gluck; if it already is, the next non-gluck round.
  // needsExtraRound means every remaining round is already gluck.
  function declareFresh(game) {
    var cur = currentIndex(game);
    if (cur < 0) return { ok: false };
    game.rounds[cur].freshCount = (game.rounds[cur].freshCount || 0) + 1;
    touch(game);
    for (var i = cur; i < game.rounds.length; i++) {
      var r = game.rounds[i];
      if (!r.gluck) {
        r.gluck = true;
        r.gluckSource = 'fresh';
        return { ok: true, gluckIndex: i };
      }
    }
    return { ok: true, gluckIndex: -1, needsExtraRound: true };
  }

  function setGluck(game, i, on) {
    var r = game.rounds[i];
    r.gluck = !!on;
    r.gluckSource = on ? 'manual' : null;
    touch(game);
  }

  function multiplier(gluck, hand) {
    return (gluck ? 2 : 1) * (hand ? 2 : 1);
  }

  function roundMultiplier(round) {
    return multiplier(round.gluck, round.result && round.result.hand);
  }

  // Points one player gets in a round. Everything is multiplied: -30, 100 and card points.
  function playerRoundPoints(round, result, playerId) {
    var m = multiplier(round.gluck, result.hand);
    if (playerId === result.winnerId) return WIN_POINTS * m;
    var e = result.entries[playerId] || {};
    return (e.noSet ? NO_SET_POINTS : (Number(e.points) || 0)) * m;
  }

  function roundScores(game, round, result) {
    result = result || round.result;
    if (!result) return null;
    var out = {};
    game.players.forEach(function (p) { out[p.id] = playerRoundPoints(round, result, p.id); });
    return out;
  }

  // rows[i] = { scores: {pid: points} | null, totals: {pid: running total} | null }
  function scoreTable(game) {
    var running = {};
    game.players.forEach(function (p) { running[p.id] = 0; });
    var rows = game.rounds.map(function (r) {
      var s = roundScores(game, r);
      if (!s) return { scores: null, totals: null };
      game.players.forEach(function (p) { running[p.id] += s[p.id]; });
      return { scores: s, totals: Object.assign({}, running) };
    });
    return { rows: rows, totals: running };
  }

  function totals(game) {
    return scoreTable(game).totals;
  }

  // Players with the lowest total.
  function leaders(game) {
    var t = totals(game);
    var min = Math.min.apply(null, game.players.map(function (p) { return t[p.id]; }));
    return game.players.filter(function (p) { return t[p.id] === min; });
  }

  // Sorted standings, lowest total first. A recorded winnerId always takes first place.
  function ranking(game) {
    var t = totals(game);
    var rows = game.players.map(function (p) { return { player: p, total: t[p.id], place: 0 }; });
    rows.sort(function (a, b) {
      if (game.winnerId) {
        if (a.player.id === game.winnerId) return -1;
        if (b.player.id === game.winnerId) return 1;
      }
      return a.total - b.total;
    });
    rows.forEach(function (row, i) {
      var prev = rows[i - 1];
      row.place = prev && prev.total === row.total && prev.player.id !== game.winnerId ? prev.place : i + 1;
    });
    return rows;
  }

  // Returns a Hebrew error message, or null when the result is complete.
  function validateResult(game, result) {
    if (!result || !playerById(game, result.winnerId)) return 'בחר מי ניצח בתור';
    for (var i = 0; i < game.players.length; i++) {
      var p = game.players[i];
      if (p.id === result.winnerId) continue;
      var e = result.entries && result.entries[p.id];
      if (!e || (!e.noSet && !(e.points !== '' && e.points != null && isFinite(e.points) && Number(e.points) >= 0))) {
        return 'חסר ניקוד ל' + p.name;
      }
    }
    return null;
  }

  function normalizeResult(game, result) {
    var entries = {};
    game.players.forEach(function (p) {
      if (p.id === result.winnerId) return;
      var e = result.entries[p.id];
      entries[p.id] = e.noSet ? { points: 0, noSet: true } : { points: Math.round(Number(e.points)), noSet: false };
    });
    return { winnerId: result.winnerId, hand: !!result.hand, entries: entries };
  }

  function setResult(game, i, result) {
    game.rounds[i].result = normalizeResult(game, result);
    touch(game);
  }

  function clearResult(game, i) {
    game.rounds[i].result = null;
    touch(game);
  }

  // Ends the game: unplayed rounds are dropped (the game may end early) and the winner is recorded.
  function finishGame(game, winnerId) {
    var played = game.rounds.filter(function (r) { return r.result; });
    game.plannedRounds = game.rounds.length;
    game.endedEarly = played.length < game.rounds.length;
    game.rounds = played;
    game.winnerId = winnerId || leaders(game)[0].id;
    game.finishedAt = now();
    touch(game);
    return game;
  }

  // After a finished game is corrected: the winner stays when they still have the lowest total.
  // Returns the players tied for the lowest total when someone has to choose, otherwise null.
  function refreshWinner(game) {
    var lead = leaders(game);
    if (lead.some(function (p) { return p.id === game.winnerId; })) return null;
    if (lead.length === 1) {
      game.winnerId = lead[0].id;
      return null;
    }
    return lead;
  }

  // ---------- tournaments ----------
  function newTournament(name, names) {
    var t = now();
    return {
      id: uid(), name: cleanName(name), createdAt: t, updatedAt: t, metaAt: t,
      players: names.map(function (n, i) { return { id: 'p' + (i + 1), name: cleanName(n), at: t }; }),
      games: []
    };
  }

  function touchTour(tour, game) {
    var t = now();
    if (game) game.updatedAt = t;
    tour.updatedAt = t;
  }

  function touchMeta(tour) {
    tour.metaAt = tour.updatedAt = now();
  }

  function byFinish(a, b) {
    return a.finishedAt.localeCompare(b.finishedAt);
  }

  function finishedGames(tour) {
    return tour.games.filter(function (g) { return g.finishedAt; }).sort(byFinish);
  }

  function openGame(tour) {
    for (var i = 0; i < tour.games.length; i++) if (!tour.games[i].finishedAt) return tour.games[i];
    return null;
  }

  function findTourGame(tour, id) {
    for (var i = 0; i < tour.games.length; i++) if (tour.games[i].id === id) return tour.games[i];
    return null;
  }

  // The next game, with every participant. opts = { rounds, firstDealer } (firstDealer = a seat).
  function startGame(tour, opts) {
    var g = newGame(tour.players, opts);
    g.tournamentId = tour.id;
    tour.games.push(g);
    touchTour(tour);
    return g;
  }

  // The seat after the one who dealt first in the previous game.
  function nextFirstDealer(tour) {
    var last = tour.games[tour.games.length - 1];
    if (!last) return 0;
    var first = last.players[last.firstDealer || 0];
    for (var i = 0; first && i < tour.players.length; i++) {
      if (tour.players[i].id === first.id) return (i + 1) % tour.players.length;
    }
    return 0;
  }

  // Deleted games are remembered by id, so a copy from another phone does not bring them back.
  function removeGame(tour, id) {
    tour.removed = tour.removed || [];
    if (tour.removed.indexOf(id) < 0) tour.removed.push(id);
    tour.games = tour.games.filter(function (g) { return g.id !== id; });
    touchTour(tour);
  }

  // Finished games in order, then at most one open game (the one changed last), without deleted games.
  function normalize(tour) {
    var removed = {};
    (tour.removed || []).forEach(function (id) { removed[id] = true; });
    var games = (tour.games || []).filter(function (g) { return g && g.id && Array.isArray(g.rounds) && !removed[g.id]; });
    var done = games.filter(function (g) { return g.finishedAt; }).sort(byFinish);
    var open = games.filter(function (g) { return !g.finishedAt; })
      .sort(function (a, b) { return (a.updatedAt || '').localeCompare(b.updatedAt || ''); });
    tour.games = done.concat(open.slice(-1));
    tour.games.forEach(function (g) { g.tournamentId = tour.id; });
    tour.players = tour.players || [];
    return tour;
  }

  // One row per participant over the given finished games, best first:
  // fewest points, then more game wins. Equal points and wins share a place.
  function tally(players, games) {
    var rows = players.map(function (p, seat) { return { player: p, seat: seat, total: 0, wins: 0, games: 0, place: 0 }; });
    var by = {};
    rows.forEach(function (r) { by[r.player.id] = r; });
    games.forEach(function (g) {
      var t = totals(g);
      g.players.forEach(function (p) {
        var r = by[p.id];
        if (!r) return;
        r.total += t[p.id];
        r.games++;
        if (p.id === g.winnerId) r.wins++;
      });
    });
    rows.sort(function (a, b) { return a.total - b.total || b.wins - a.wins || a.seat - b.seat; });
    rows.forEach(function (r, i) {
      var prev = rows[i - 1];
      r.place = prev && prev.total === r.total && prev.wins === r.wins ? prev.place : i + 1;
    });
    return rows;
  }

  // The tournament table. total = finished games only, so places change only when a game ends.
  // game = points in the open game (null when there is none). exceptId leaves one finished game out.
  function standings(tour, exceptId) {
    var done = finishedGames(tour).filter(function (g) { return g.id !== exceptId; });
    var rows = tally(tour.players, done);
    var open = openGame(tour);
    var t = open ? totals(open) : null;
    rows.forEach(function (r) { r.game = t && r.player.id in t ? t[r.player.id] : null; });
    return rows;
  }

  // How many places each participant moved when the last game ended (+ = up). Empty before the second game.
  function placeMoves(tour) {
    var done = finishedGames(tour);
    if (done.length < 2) return {};
    var before = {};
    standings(tour, done[done.length - 1].id).forEach(function (r) { before[r.player.id] = r.place; });
    var out = {};
    standings(tour).forEach(function (r) { out[r.player.id] = before[r.player.id] - r.place; });
    return out;
  }

  function tourLeaders(tour) {
    if (!finishedGames(tour).length) return [];
    return standings(tour).filter(function (r) { return r.place === 1; }).map(function (r) { return r.player; });
  }

  // A readable digest saved in the git file next to the raw data (the app never reads it back).
  function digest(tour) {
    function named(t, g) {
      var o = {};
      g.players.forEach(function (p) { o[p.name] = t[p.id]; });
      return o;
    }
    var open = openGame(tour);
    return {
      participants: tour.players.map(function (p) { return p.name; }),
      standings: standings(tour).map(function (r) {
        return { place: r.place, name: r.player.name, total: r.total, wins: r.wins, games: r.games };
      }),
      games: finishedGames(tour).map(function (g, i) {
        var w = playerById(g, g.winnerId);
        return { number: i + 1, id: g.id, finishedAt: g.finishedAt, rounds: g.rounds.length, winner: w ? w.name : null, totals: named(totals(g), g) };
      }),
      openGame: open ? { id: open.id, roundsPlayed: playedCount(open), rounds: open.rounds.length, totals: named(totals(open), open) } : null
    };
  }

  var Rummy = {
    WIN_POINTS: WIN_POINTS,
    NO_SET_POINTS: NO_SET_POINTS,
    DEFAULT_ROUNDS: DEFAULT_ROUNDS,
    GLUCK_EVERY: GLUCK_EVERY,
    uid: uid,
    cleanName: cleanName,
    touch: touch,
    newGame: newGame,
    currentIndex: currentIndex,
    playedCount: playedCount,
    isComplete: isComplete,
    dealerIndex: dealerIndex,
    dealer: dealer,
    playerById: playerById,
    addRound: addRound,
    declareFresh: declareFresh,
    setGluck: setGluck,
    multiplier: multiplier,
    roundMultiplier: roundMultiplier,
    playerRoundPoints: playerRoundPoints,
    roundScores: roundScores,
    scoreTable: scoreTable,
    totals: totals,
    leaders: leaders,
    ranking: ranking,
    validateResult: validateResult,
    setResult: setResult,
    clearResult: clearResult,
    finishGame: finishGame,
    refreshWinner: refreshWinner,
    now: now,
    newTournament: newTournament,
    touchTour: touchTour,
    touchMeta: touchMeta,
    finishedGames: finishedGames,
    openGame: openGame,
    findTourGame: findTourGame,
    startGame: startGame,
    nextFirstDealer: nextFirstDealer,
    removeGame: removeGame,
    normalize: normalize,
    tally: tally,
    standings: standings,
    placeMoves: placeMoves,
    tourLeaders: tourLeaders,
    digest: digest
  };

  root.Rummy = Rummy;
  if (typeof module !== 'undefined' && module.exports) module.exports = Rummy;
})(typeof window !== 'undefined' ? window : globalThis);
