require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'local-cache.json');

const JUDGE_COUNT = 4;
const ROUND_NAMES = { 1: 'Talent', 2: 'Catent' };

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- in-memory state ----------------
// `state` mirrors what's in Supabase. `votesBySession` / `judgeVotesBySession`
// mirror the `votes` / `judge_votes` tables for whichever session is active.
// Everything is kept in memory for speed, and mirrored to disk (instant) +
// Supabase (best-effort, async) on every change.

function defaultState() {
  return {
    contestants: [
      { id: 'c1', name: 'Contestant 1', avg: null, audienceAvg: null, judgeAvg: null },
      { id: 'c2', name: 'Contestant 2', avg: null, audienceAvg: null, judgeAvg: null },
      { id: 'c3', name: 'Contestant 3', avg: null, audienceAvg: null, judgeAvg: null },
      { id: 'c4', name: 'Contestant 4', avg: null, audienceAvg: null, judgeAvg: null }
    ],
    currentId: null,
    sessionId: null,
    votingActive: false,
    round: 1, // 1 = Talent, 2 = Catent (final)
    talentResults: null // frozen snapshot of Talent's final standings, set once Catent begins
  };
}

let state = defaultState();
let votesBySession = {};      // sessionId -> { deviceId: score }        (audience, 1-10)
let judgeVotesBySession = {}; // sessionId -> { '1'|'2'|'3'|'4': score } (judges, 1-10)

function newId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// round to nearest 0.5, exact ties round DOWN (8.25 -> 8, 8.4 -> 8.5, 8.1 -> 8)
function roundToHalf(avg) {
  const scaled = avg * 2;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  const rounded = Math.abs(frac - 0.5) < 1e-9 ? floor : Math.round(scaled);
  return rounded / 2;
}

// Final score = average of the audience average and the judges' average, same
// rounding rule as everything else. If only one of the two exists yet, that
// one stands in as the final score on its own so ranking still works with
// partial data (e.g. judges haven't voted yet).
function combineScores(c) {
  const hasAud = c.audienceAvg !== null && c.audienceAvg !== undefined;
  const hasJudge = c.judgeAvg !== null && c.judgeAvg !== undefined;
  if (hasAud && hasJudge) return roundToHalf((c.audienceAvg + c.judgeAvg) / 2);
  if (hasAud) return c.audienceAvg;
  if (hasJudge) return c.judgeAvg;
  return null;
}

// ---------------- local cache (instant, disk-only fallback) ----------------

function saveLocalCache() {
  try {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ ...state, votesBySession, judgeVotesBySession }, null, 2)
    );
  } catch (e) {
    console.error('[local-cache] failed to write:', e.message);
  }
}

function loadLocalCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const { votesBySession: v, judgeVotesBySession: j, ...rest } = raw;
    return { state: rest, votesBySession: v || {}, judgeVotesBySession: j || {} };
  } catch (e) {
    return null;
  }
}

// ---------------- boot: load from Supabase, fall back to local cache ----------------

async function initState() {
  let loadedFromSupabase = false;

  if (db.isUp()) {
    const [contestants, appState] = await Promise.all([
      db.fetchContestants(),
      db.fetchAppState()
    ]);

    if (contestants && appState) {
      state = {
        contestants: contestants.length ? contestants : defaultState().contestants,
        currentId: appState.currentId,
        sessionId: appState.sessionId,
        votingActive: appState.votingActive,
        round: appState.round || 1,
        talentResults: appState.talentResults || null
      };

      if (state.votingActive && state.sessionId) {
        const [votes, judgeVotes] = await Promise.all([
          db.fetchVotesForSession(state.sessionId),
          db.fetchJudgeVotesForSession(state.sessionId)
        ]);
        votesBySession[state.sessionId] = votes || {};
        judgeVotesBySession[state.sessionId] = judgeVotes || {};
      }

      loadedFromSupabase = true;
      console.log('[boot] state loaded from Supabase');
    }
  }

  if (!loadedFromSupabase) {
    const cached = loadLocalCache();
    if (cached) {
      state = cached.state;
      votesBySession = cached.votesBySession;
      judgeVotesBySession = cached.judgeVotesBySession;
      console.log('[boot] Supabase unreachable — state restored from local cache');
    } else {
      state = defaultState();
      console.log('[boot] no Supabase and no local cache — starting fresh');
    }
  }

  // Whatever we ended up with, make sure the local cache reflects it.
  saveLocalCache();
}

// ---------------- persistence on every change ----------------
// Always write the local cache synchronously first (this can never fail due to
// the network being down). Then push to Supabase in the background — if that
// fails we log it and move on; nothing already accepted is lost, because it's
// sitting in the local cache and in memory, and will be pushed to Supabase the
// next time a write succeeds or the server is restarted with a working
// connection.

function persistContestant(c) {
  saveLocalCache();
  db.upsertContestant(c);
}

function persistContestantDeleted(id) {
  // Soft delete: keep the row in Supabase (for history), just hide it from the
  // active lineup so a restart doesn't bring it back.
  saveLocalCache();
  db.setContestantActive(id, false);
}

function persistAppState() {
  saveLocalCache();
  db.saveAppState(state);
}

function persistVote(sessionId, deviceId, score) {
  saveLocalCache();
  db.upsertVote(sessionId, deviceId, score);
}

function persistJudgeVote(sessionId, judgeNum, score) {
  saveLocalCache();
  db.upsertJudgeVote(sessionId, judgeNum, score);
}

function persistReorder(ids) {
  saveLocalCache();
  db.setSortOrders(ids);
}

function currentAudienceVoteCount() {
  if (!state.sessionId) return 0;
  const votes = votesBySession[state.sessionId];
  return votes ? Object.keys(votes).length : 0;
}

function currentJudgeVoteCount() {
  if (!state.sessionId) return 0;
  const votes = judgeVotesBySession[state.sessionId];
  return votes ? Object.keys(votes).length : 0;
}

function broadcastState() {
  io.emit('state', state);
}

function broadcastVoteCount() {
  io.emit('voteCount', {
    sessionId: state.sessionId,
    audienceCount: currentAudienceVoteCount(),
    judgeCount: currentJudgeVoteCount(),
    judgeTotal: JUDGE_COUNT
  });
}

// Ranked standings for the CURRENT round's contestants, highest final score
// first. Contestants with no final score yet are listed separately.
function rankContestants(contestants) {
  const scored = contestants.filter((c) => c.avg !== null && c.avg !== undefined);
  const unscored = contestants.filter((c) => c.avg === null || c.avg === undefined);
  const sorted = [...scored].sort((a, b) => b.avg - a.avg);
  return { sorted, unscored };
}

// ---------------- sockets ----------------
io.on('connection', (socket) => {
  socket.emit('state', state);
  if (state.votingActive) {
    socket.emit('voteCount', {
      sessionId: state.sessionId,
      audienceCount: currentAudienceVoteCount(),
      judgeCount: currentJudgeVoteCount(),
      judgeTotal: JUDGE_COUNT
    });
  }

  socket.on('admin:addContestant', ({ name }) => {
    if (!name || !name.trim()) return;
    const c = { id: newId(), name: name.trim(), avg: null, audienceAvg: null, judgeAvg: null };
    state.contestants.push(c);
    persistContestant({ ...c, sortOrder: state.contestants.length - 1, active: true });
    broadcastState();
  });

  socket.on('admin:renameContestant', ({ id, name }) => {
    if (!name || !name.trim()) return;
    const c = state.contestants.find((x) => x.id === id);
    if (c) {
      c.name = name.trim();
      persistContestant(c);
      broadcastState();
    }
  });

  socket.on('admin:deleteContestant', ({ id }) => {
    if (state.currentId === id) return; // never delete the live entry
    state.contestants = state.contestants.filter((c) => c.id !== id);
    persistContestantDeleted(id);
    broadcastState();
  });

  socket.on('admin:reorderContestants', ({ ids }) => {
    if (!Array.isArray(ids)) return;
    const byId = new Map(state.contestants.map((c) => [c.id, c]));
    const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
    // Safety net: if any current contestant wasn't in the incoming id list
    // (e.g. added/removed by someone else mid-drag), keep it, appended at the end.
    const missing = state.contestants.filter((c) => !ids.includes(c.id));
    state.contestants = [...reordered, ...missing];
    persistReorder(state.contestants.map((c) => c.id));
    broadcastState();
  });

  // TALENT -> CATENT: takes the top 50% by final score (ties included, so a
  // tie at the cutoff advances everyone tied with it), freezes Talent's
  // standings into state.talentResults so they stay visible, and starts
  // Catent with a fresh, randomly-shuffled lineup of just the qualifiers.
  // Eliminated contestants are kept in Supabase (soft-deleted) rather than
  // destroyed, so a full reset can always bring everyone back.
  socket.on('admin:startNextRound', () => {
    if (state.votingActive) return;
    if (state.round !== 1) return; // only Talent -> Catent is a transfer; Catent is final
    const { sorted, unscored } = rankContestants(state.contestants);
    if (sorted.length === 0) return;

    const cutoffCount = Math.max(1, Math.ceil(sorted.length / 2));
    const cutoffScore = sorted[cutoffCount - 1].avg;
    const qualifiers = sorted.filter((c) => c.avg >= cutoffScore);
    const eliminated = state.contestants.filter((c) => !qualifiers.some((q) => q.id === c.id));

    // Freeze Talent's full standings (qualifiers + everyone else) for the record.
    const qualifyingIds = new Set(qualifiers.map((c) => c.id));
    state.talentResults = [
      ...sorted.map((c) => ({
        id: c.id,
        name: c.name,
        audienceAvg: c.audienceAvg,
        judgeAvg: c.judgeAvg,
        avg: c.avg,
        qualified: qualifyingIds.has(c.id)
      })),
      ...unscored.map((c) => ({
        id: c.id,
        name: c.name,
        audienceAvg: c.audienceAvg,
        judgeAvg: c.judgeAvg,
        avg: c.avg,
        qualified: false
      }))
    ];

    // Fisher-Yates shuffle
    const shuffled = [...qualifiers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((c) => {
      c.avg = null; // fresh scoring for Catent
      c.audienceAvg = null;
      c.judgeAvg = null;
    });

    state.contestants = shuffled;
    state.currentId = null;
    state.sessionId = null;
    state.votingActive = false;
    state.round = 2;

    saveLocalCache();
    db.saveAppState(state);
    db.setSortOrders(shuffled.map((c) => c.id));
    shuffled.forEach((c) => db.upsertContestant({ id: c.id, name: c.name, avg: null, audienceAvg: null, judgeAvg: null }));
    eliminated.forEach((c) => db.setContestantActive(c.id, false));

    broadcastState();
  });

  // Full reset: brings back every contestant ever added (including ones
  // eliminated going into Catent), clears every score, drops back to Talent,
  // and clears the frozen Talent results. Only allowed between votes.
  socket.on('admin:resetToRound1', async () => {
    if (state.votingActive) return;

    let contestants = null;
    if (db.isUp()) {
      const all = await db.fetchAllContestants();
      if (all && all.length) {
        contestants = all.map((c) => ({ id: c.id, name: c.name, avg: null, audienceAvg: null, judgeAvg: null }));
        await db.resetAllContestants();
      }
    }
    if (!contestants) {
      // No Supabase (or it's empty) — can't recover previously eliminated
      // contestants, so just clear scores on whoever's in the current lineup.
      contestants = state.contestants.map((c) => ({ ...c, avg: null, audienceAvg: null, judgeAvg: null }));
    }

    state = {
      contestants,
      currentId: null,
      sessionId: null,
      votingActive: false,
      round: 1,
      talentResults: null
    };
    votesBySession = {};
    judgeVotesBySession = {};

    saveLocalCache();
    db.saveAppState(state);
    broadcastState();
  });

  socket.on('admin:startVoting', ({ id }) => {
    const c = state.contestants.find((x) => x.id === id);
    if (!c) return;
    state.currentId = id;
    state.sessionId = id + '_' + Date.now();
    state.votingActive = true;
    votesBySession[state.sessionId] = {};
    judgeVotesBySession[state.sessionId] = {};
    persistAppState();
    broadcastState();
    broadcastVoteCount();
  });

  socket.on('admin:endVoting', () => {
    if (!state.votingActive || !state.sessionId) return;
    const endedSessionId = state.sessionId;
    const audScores = Object.values(votesBySession[endedSessionId] || {});
    const judgeScores = Object.values(judgeVotesBySession[endedSessionId] || {});
    const c = state.contestants.find((x) => x.id === state.currentId);
    if (c) {
      if (audScores.length > 0) {
        const raw = audScores.reduce((a, b) => a + b, 0) / audScores.length;
        c.audienceAvg = roundToHalf(raw);
      }
      if (judgeScores.length > 0) {
        const raw = judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length;
        c.judgeAvg = roundToHalf(raw);
      }
      c.avg = combineScores(c);
      persistContestant(c);
    }
    delete votesBySession[endedSessionId];
    delete judgeVotesBySession[endedSessionId];
    state.votingActive = false;
    state.currentId = null;
    state.sessionId = null;
    persistAppState();
    db.deleteVotesForSession(endedSessionId); // round is over, its raw votes aren't needed anymore
    db.deleteJudgeVotesForSession(endedSessionId);
    broadcastState();
  });

  socket.on('audience:submitVote', ({ sessionId, deviceId, score }) => {
    if (!state.votingActive || state.sessionId !== sessionId) return;
    const n = parseInt(score, 10);
    if (isNaN(n) || n < 1 || n > 10) return;
    if (!votesBySession[sessionId]) votesBySession[sessionId] = {};
    votesBySession[sessionId][deviceId] = n;
    persistVote(sessionId, deviceId, n); // written immediately, not just at round end
    broadcastVoteCount();
  });

  // A judge's ballot is keyed by judge slot (1-4), not device — so if a judge
  // reloads or switches devices mid-vote, they just overwrite their own slot
  // instead of creating a duplicate voter.
  socket.on('judge:submitVote', ({ sessionId, judgeNum, score }) => {
    if (!state.votingActive || state.sessionId !== sessionId) return;
    const jn = parseInt(judgeNum, 10);
    if (isNaN(jn) || jn < 1 || jn > JUDGE_COUNT) return;
    const n = parseInt(score, 10);
    if (isNaN(n) || n < 1 || n > 10) return;
    if (!judgeVotesBySession[sessionId]) judgeVotesBySession[sessionId] = {};
    judgeVotesBySession[sessionId][jn] = n;
    persistJudgeVote(sessionId, jn, n);
    broadcastVoteCount();
  });
});

initState().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log(`  Live Vote is running`);
    console.log(`  Audience:  http://localhost:${PORT}`);
    console.log(`  Judges:    http://localhost:${PORT}/?judge=1  (…2, 3, 4)`);
    console.log(`  Admin:     http://localhost:${PORT}/?admin=1`);
    console.log(`  Storage:   ${db.isUp() ? 'Supabase (+ local cache backup)' : 'local cache only (Supabase not configured)'}`);
    console.log('');
  });
});
