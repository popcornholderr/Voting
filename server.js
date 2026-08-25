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
      { id: 'c1', name: 'Contestant 1', avg: null },
      { id: 'c2', name: 'Contestant 2', avg: null },
      { id: 'c3', name: 'Contestant 3', avg: null },
      { id: 'c4', name: 'Contestant 4', avg: null }
    ],
    currentId: null,
    sessionId: null,
    votingActive: false
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
        votingActive: appState.votingActive
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
  saveLocalCache();
  db.deleteContestant(id);
}

function persistAppState() {
  saveLocalCache();
  db.saveAppState(state);
}

function persistVote(sessionId, deviceId, score) {
  saveLocalCache();
  db.upsertVote(sessionId, deviceId, score);
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
    const c = { id: newId(), name: name.trim(), avg: null };
    state.contestants.push(c);
    persistContestant(c);
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
      c.avg = roundToHalf(raw);
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
