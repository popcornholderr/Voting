const supabase = require('./supabaseClient');

function isUp() {
  return !!supabase;
}

// ---------------- contestants ----------------

async function fetchContestants() {
  if (!isUp()) return null; // null = "couldn't reach Supabase", caller should fall back
  try {
    const { data, error } = await supabase
      .from('contestants')
      .select('id, name, avg')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('[supabase] fetchContestants failed:', e.message);
    return null;
  }
}

// c: { id, name, avg, sortOrder?, active? }. sortOrder/active are only written
// when explicitly provided, so a plain rename/score update doesn't disturb them.
async function upsertContestant(c) {
  if (!isUp()) return false;
  try {
    const payload = { id: c.id, name: c.name, avg: c.avg };
    if (c.sortOrder !== undefined) payload.sort_order = c.sortOrder;
    if (c.active !== undefined) payload.active = c.active;
    const { error } = await supabase.from('contestants').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] upsertContestant failed:', e.message);
    return false;
  }
}

// Soft-delete: used both for the admin's "Remove" button and for contestants
// eliminated at the end of a round — kept in the table, just hidden from
// the active lineup, so nothing is destructively lost.
async function setContestantActive(id, active) {
  if (!isUp()) return false;
  try {
    const { error } = await supabase.from('contestants').update({ active }).eq('id', id);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] setContestantActive failed:', e.message);
    return false;
  }
}

// Persists a full reordering (drag-and-drop, or the shuffle at round start).
async function setSortOrders(idsInOrder) {
  if (!isUp()) return false;
  try {
    await Promise.all(
      idsInOrder.map((id, i) =>
        supabase.from('contestants').update({ sort_order: i }).eq('id', id)
      )
    );
    return true;
  } catch (e) {
    console.error('[supabase] setSortOrders failed:', e.message);
    return false;
  }
}

async function deleteContestant(id) {
  // Kept for completeness, but the app uses setContestantActive(id, false) instead
  // so eliminated/removed contestants remain in Supabase for history.
  if (!isUp()) return false;
  try {
    const { error } = await supabase.from('contestants').delete().eq('id', id);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] deleteContestant failed:', e.message);
    return false;
  }
}

// ---------------- app state (current round) ----------------

async function fetchAppState() {
  if (!isUp()) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('current_id, session_id, voting_active, round')
      .eq('id', 1)
      .single();
    if (error) throw error;
    return {
      currentId: data.current_id,
      sessionId: data.session_id,
      votingActive: data.voting_active,
      round: data.round || 1
    };
  } catch (e) {
    console.error('[supabase] fetchAppState failed:', e.message);
    return null;
  }
}

async function saveAppState({ currentId, sessionId, votingActive, round }) {
  if (!isUp()) return false;
  try {
    const { error } = await supabase
      .from('app_state')
      .upsert(
        {
          id: 1,
          current_id: currentId,
          session_id: sessionId,
          voting_active: votingActive,
          round: round || 1,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'id' }
      );
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] saveAppState failed:', e.message);
    return false;
  }
}

// ---------------- votes ----------------

// Written immediately as each vote comes in, so a crash/restart mid-round
// loses zero already-cast votes.
async function upsertVote(sessionId, deviceId, score) {
  if (!isUp()) return false;
  try {
    const { error } = await supabase
      .from('votes')
      .upsert(
        { session_id: sessionId, device_id: deviceId, score, updated_at: new Date().toISOString() },
        { onConflict: 'session_id,device_id' }
      );
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] upsertVote failed:', e.message);
    return false;
  }
}

async function fetchVotesForSession(sessionId) {
  if (!isUp() || !sessionId) return null;
  try {
    const { data, error } = await supabase
      .from('votes')
      .select('device_id, score')
      .eq('session_id', sessionId);
    if (error) throw error;
    const votes = {};
    for (const row of data) votes[row.device_id] = row.score;
    return votes;
  } catch (e) {
    console.error('[supabase] fetchVotesForSession failed:', e.message);
    return null;
  }
}

async function deleteVotesForSession(sessionId) {
  if (!isUp() || !sessionId) return false;
  try {
    const { error } = await supabase.from('votes').delete().eq('session_id', sessionId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] deleteVotesForSession failed:', e.message);
    return false;
  }
}

module.exports = {
  isUp,
  fetchContestants,
  upsertContestant,
  setContestantActive,
  setSortOrders,
  deleteContestant,
  fetchAppState,
  saveAppState,
  upsertVote,
  fetchVotesForSession,
  deleteVotesForSession
};
