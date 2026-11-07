/* Rummy 51 — reports over finished games. Pure functions, no DOM.
   Players are matched across games by name. */
(function (root) {
  'use strict';

  var R = root.Rummy;

  function finished(games) {
    return games.filter(function (g) { return g.finishedAt; })
      .sort(function (a, b) { return a.finishedAt.localeCompare(b.finishedAt); });
  }

  // tournamentId: 'all' or one tournament's id
  function filterByTournament(games, tournamentId) {
    if (!tournamentId || tournamentId === 'all') return games.slice();
    return games.filter(function (g) { return g.tournamentId === tournamentId; });
  }

  // period: 'all' | 'year' (this calendar year) | '30d' (last 30 days)
  function filterByPeriod(games, period, nowDate) {
    var now = nowDate || new Date();
    if (period === 'year') {
      return games.filter(function (g) { return new Date(g.finishedAt).getFullYear() === now.getFullYear(); });
    }
    if (period === '30d') {
      var from = now.getTime() - 30 * 24 * 3600 * 1000;
      return games.filter(function (g) { return new Date(g.finishedAt).getTime() >= from; });
    }
    return games.slice();
  }

  function lastGame(games) {
    var list = finished(games);
    return list.length ? list[list.length - 1] : null;
  }

  function playerNames(games) {
    var seen = {};
    finished(games).forEach(function (g) {
      g.players.forEach(function (p) { seen[p.name] = (seen[p.name] || 0) + 1; });
    });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b, 'he'); });
  }

  function summary(games) {
    var list = finished(games);
    var byName = {};
    var general = {
      games: list.length, rounds: 0, freshes: 0, gluckRounds: 0, handWins: 0, endedEarly: 0,
      costliestRound: null, longestStreak: null, mostWins: null
    };

    function stat(name) {
      return byName[name] || (byName[name] = {
        name: name, games: 0, wins: 0, placeSum: 0, totalPoints: 0, best: null, worst: null,
        roundsPlayed: 0, roundsWon: 0, handWins: 0, gluckWins: 0, hundreds: 0,
        lossRounds: 0, lossPoints: 0, streak: 0, longestStreak: 0
      });
    }

    list.forEach(function (g) {
      if (g.endedEarly) general.endedEarly++;
      R.ranking(g).forEach(function (row) {
        var s = stat(row.player.name);
        s.games++;
        s.placeSum += row.place;
        s.totalPoints += row.total;
        if (s.best === null || row.total < s.best) s.best = row.total;
        if (s.worst === null || row.total > s.worst) s.worst = row.total;
        if (row.player.id === g.winnerId) {
          s.wins++;
          s.streak++;
          s.longestStreak = Math.max(s.longestStreak, s.streak);
        } else {
          s.streak = 0;
        }
      });

      var table = R.scoreTable(g);
      g.rounds.forEach(function (r, i) {
        if (!r.result) return;
        general.rounds++;
        general.freshes += r.freshCount || 0;
        if (r.gluck) general.gluckRounds++;
        if (r.result.hand) general.handWins++;
        var scores = table.rows[i].scores;
        g.players.forEach(function (p) {
          var s = stat(p.name);
          s.roundsPlayed++;
          if (p.id === r.result.winnerId) {
            s.roundsWon++;
            if (r.result.hand) s.handWins++;
            if (r.gluck) s.gluckWins++;
            return;
          }
          s.lossRounds++;
          s.lossPoints += scores[p.id];
          if (r.result.entries[p.id] && r.result.entries[p.id].noSet) s.hundreds++;
          if (!general.costliestRound || scores[p.id] > general.costliestRound.points) {
            general.costliestRound = { name: p.name, points: scores[p.id], date: g.finishedAt, round: i + 1, gameId: g.id };
          }
        });
      });
    });

    var players = Object.keys(byName).map(function (name) {
      var s = byName[name];
      s.winPct = s.games ? s.wins / s.games : 0;
      s.avgPlace = s.games ? s.placeSum / s.games : 0;
      s.avgPoints = s.games ? s.totalPoints / s.games : 0;
      s.roundWinPct = s.roundsPlayed ? s.roundsWon / s.roundsPlayed : 0;
      s.avgLoss = s.lossRounds ? s.lossPoints / s.lossRounds : 0;
      s.currentStreak = s.streak;
      delete s.streak;
      return s;
    });
    // Leader = most game wins; a tie goes to fewer total points.
    players.sort(function (a, b) {
      return b.wins - a.wins || a.totalPoints - b.totalPoints || a.name.localeCompare(b.name, 'he');
    });

    players.forEach(function (s) {
      if (s.longestStreak && (!general.longestStreak || s.longestStreak > general.longestStreak.length)) {
        general.longestStreak = { name: s.name, length: s.longestStreak };
      }
      if (s.wins && (!general.mostWins || s.wins > general.mostWins.wins)) {
        general.mostWins = { name: s.name, wins: s.wins };
      }
    });

    return { players: players, general: general };
  }

  // Games both played: who finished with the lower total.
  function headToHead(games, nameA, nameB) {
    var out = { together: 0, a: 0, b: 0, even: 0 };
    finished(games).forEach(function (g) {
      var pa = null, pb = null;
      g.players.forEach(function (p) {
        if (p.name === nameA) pa = p;
        if (p.name === nameB) pb = p;
      });
      if (!pa || !pb || pa === pb) return;
      out.together++;
      var rank = R.ranking(g);
      var ia = -1, ib = -1;
      rank.forEach(function (row, i) {
        if (row.player === pa) ia = i;
        if (row.player === pb) ib = i;
      });
      if (rank[ia].total === rank[ib].total && pa.id !== g.winnerId && pb.id !== g.winnerId) out.even++;
      else if (ia < ib) out.a++;
      else out.b++;
    });
    return out;
  }

  var RummyStats = {
    finished: finished,
    filterByTournament: filterByTournament,
    filterByPeriod: filterByPeriod,
    lastGame: lastGame,
    playerNames: playerNames,
    summary: summary,
    headToHead: headToHead
  };

  root.RummyStats = RummyStats;
  if (typeof module !== 'undefined' && module.exports) module.exports = RummyStats;
})(typeof window !== 'undefined' ? window : globalThis);
