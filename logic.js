/* Rummy 51 — game rules. Pure functions, no DOM.
   A game stores only what was entered; scores are always recomputed from it. */
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

  function newGame(names, opts) {
    opts = opts || {};
    var count = opts.rounds || DEFAULT_ROUNDS;
    var rounds = [];
    for (var n = 1; n <= count; n++) rounds.push(makeRound(n));
    var t = now();
    return {
      id: uid(),
      createdAt: t,
      updatedAt: t,
      players: names.map(function (name, i) { return { id: 'p' + (i + 1), name: cleanName(name) }; }),
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
    finishGame: finishGame
  };

  root.Rummy = Rummy;
  if (typeof module !== 'undefined' && module.exports) module.exports = Rummy;
})(typeof window !== 'undefined' ? window : globalThis);
