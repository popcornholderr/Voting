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

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- in-memory state ----------------
// `state` mirrors what's in Supabase. `votesBySession` mirrors the `votes` table
// for whichever session is currently active. Both are kept in memory for speed,
// and mirrored to disk (instant) + Supabase (best-effort, async) on every change.

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
    round: 1
  };
}

let state = defaultState();
let votesBySession = {}; // sessionId -> { deviceId: score }

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

// Final score = average of the audience average and the judges' average,
// rounded to the nearest 0.5 (ties round down) — same rule as everywhere
// else, but applied ONCE, at the end. audienceAvg itself is stored as the
// exact raw average (not pre-rounded), so nothing gets rounded twice before
// landing on the Final number.
function combineScores(c) {
  const hasAud = c.audienceAvg !== null && c.audienceAvg !== undefined;
  const hasJudge = c.judgeAvg !== null && c.judgeAvg !== undefined;
  if (hasAud && hasJudge) return roundToHalf((c.audienceAvg + c.judgeAvg) / 2);
  if (hasAud) return roundToHalf(c.audienceAvg);
  if (hasJudge) return roundToHalf(c.judgeAvg);
  return null;
}

// ---------------- local cache (instant, disk-only fallback) ----------------

function saveLocalCache() {
  try {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ ...state, votesBySession }, null, 2)
    );
  } catch (e) {
    console.error('[local-cache] failed to write:', e.message);
  }
}

function loadLocalCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const { votesBySession: v, ...rest } = raw;
    return { state: rest, votesBySession: v || {} };
  } catch (e) {
    return null;
  }
}

// ---------------- boot: load from Supabase, fall back to local cache ----------------

async function initState() {
  let loadedFromSupabase = false;

  await db.checkSchema();

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
        round: appState.round || 1
      };

      if (state.votingActive && state.sessionId) {
        const votes = await db.fetchVotesForSession(state.sessionId);
        votesBySession[state.sessionId] = votes || {};
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
// fails (server's internet is down, Supabase is briefly unreachable, etc.) we
// log it and move on; nothing already accepted from the audience/admin is lost,
// because it's sitting in the local cache and in memory, and will be pushed to
// Supabase the next time a write succeeds or the server is restarted with a
// working connection.

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

function persistReorder(ids) {
  saveLocalCache();
  db.setSortOrders(ids);
}

function currentVoteCount() {
  if (!state.sessionId) return 0;
  const votes = votesBySession[state.sessionId];
  return votes ? Object.keys(votes).length : 0;
}

function broadcastState() {
  io.emit('state', state);
}

function broadcastVoteCount() {
  io.emit('voteCount', { sessionId: state.sessionId, count: currentVoteCount() });
}

// ---------------- sockets ----------------
io.on('connection', (socket) => {
  socket.emit('state', state);
  if (state.votingActive) {
    socket.emit('voteCount', { sessionId: state.sessionId, count: currentVoteCount() });
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

  // Takes the top 50% by score (ties included, so a tie at the cutoff advances
  // everyone tied with it) into a fresh, randomly-shuffled lineup for the next
  // round — no need to type the list in again. Eliminated contestants are kept
  // in Supabase (soft-deleted) rather than destroyed.
  socket.on('admin:startNextRound', () => {
    if (state.votingActive) return;
    const scored = state.contestants.filter((c) => c.avg !== null && c.avg !== undefined);
    if (scored.length === 0) return;

    const sorted = [...scored].sort((a, b) => b.avg - a.avg);
    const cutoffCount = Math.max(1, Math.ceil(sorted.length / 2));
    const cutoffScore = sorted[cutoffCount - 1].avg;
    const qualifiers = sorted.filter((c) => c.avg >= cutoffScore);
    const eliminated = state.contestants.filter((c) => !qualifiers.some((q) => q.id === c.id));

    // Fisher-Yates shuffle
    for (let i = qualifiers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [qualifiers[i], qualifiers[j]] = [qualifiers[j], qualifiers[i]];
    }
    qualifiers.forEach((c) => {
      c.avg = null; // fresh scoring for the new round
      c.audienceAvg = null;
      c.judgeAvg = null;
    });

    state.contestants = qualifiers;
    state.currentId = null;
    state.sessionId = null;
    state.votingActive = false;
    state.round = (state.round || 1) + 1;

    saveLocalCache();
    db.saveAppState(state);
    db.setSortOrders(qualifiers.map((c) => c.id));
    qualifiers.forEach((c) => db.upsertContestant({ id: c.id, name: c.name, avg: null, audienceAvg: null, judgeAvg: null }));
    eliminated.forEach((c) => db.setContestantActive(c.id, false));

    broadcastState();
  });

  // Full reset: brings back every contestant ever added (including ones
  // eliminated in later rounds), clears every score, and drops the round
  // counter back to 1. Only allowed between votes, same as starting a round.
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
      round: 1
    };
    votesBySession = {};

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
    persistAppState();
    broadcastState();
    broadcastVoteCount();
  });

  socket.on('admin:endVoting', () => {
    if (!state.votingActive || !state.sessionId) return;
    const endedSessionId = state.sessionId;
    const votes = votesBySession[endedSessionId] || {};
    const scores = Object.values(votes);
    const c = state.contestants.find((x) => x.id === state.currentId);
    if (c && scores.length > 0) {
      const raw = scores.reduce((a, b) => a + b, 0) / scores.length;
      c.audienceAvg = raw; // exact, unrounded — rounding happens once, on the Final
      c.avg = combineScores(c);
      persistContestant(c);
    }
    delete votesBySession[endedSessionId];
    state.votingActive = false;
    state.currentId = null;
    state.sessionId = null;
    persistAppState();
    db.deleteVotesForSession(endedSessionId); // round is over, its raw votes aren't needed anymore
    broadcastState();
  });

  // Admin enters (or clears) a judges' average for a contestant. Independent
  // of the audience vote — can be set before, during, or after it. The final
  // score is recomputed immediately so ranking always reflects both.
  socket.on('admin:setJudgeAvg', ({ id, score }) => {
    const c = state.contestants.find((x) => x.id === id);
    if (!c) return;

    if (score === null || score === undefined || score === '') {
      c.judgeAvg = null;
    } else {
      const n = parseFloat(score);
      if (isNaN(n) || n < 0 || n > 10) return;
      c.judgeAvg = Math.round(n * 2) / 2; // snap to nearest 0.5, same granularity as everything else
    }
    c.avg = combineScores(c);
    persistContestant(c);
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
});

initState().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log(`  Live Vote is running`);
    console.log(`  Audience:  http://localhost:${PORT}`);
    console.log(`  Admin:     http://localhost:${PORT}/?admin=1`);
    console.log(`  Storage:   ${db.isUp() ? 'Supabase (+ local cache backup)' : 'local cache only (Supabase not configured)'}`);
    console.log('');
  });
});
