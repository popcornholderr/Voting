const supabase = require('./supabaseClient');

function isUp() {
  return !!supabase;
}

// ---------------- contestants ----------------

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    avg: row.avg,
    audienceAvg: row.audience_avg,
    judgeAvg: row.judge_avg
  };
}

async function fetchContestants() {
  if (!isUp()) return null; // null = "couldn't reach Supabase", caller should fall back
  try {
    const { data, error } = await supabase
      .from('contestants')
      .select('id, name, avg, audience_avg, judge_avg')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data.map(mapRow);
  } catch (e) {
    console.error('[supabase] fetchContestants failed:', e.message);
    return null;
  }
}

// c: { id, name, avg, audienceAvg?, judgeAvg?, sortOrder?, active? }. Optional
// fields are only written when explicitly provided (not undefined), so e.g. a
// plain rename doesn't disturb sortOrder/active, and a fresh-round score reset
// doesn't disturb anything else.
async function upsertContestant(c) {
  if (!isUp()) return false;
  try {
    const payload = { id: c.id, name: c.name, avg: c.avg };
    if (c.audienceAvg !== undefined) payload.audience_avg = c.audienceAvg;
    if (c.judgeAvg !== undefined) payload.judge_avg = c.judgeAvg;
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
// eliminated going into Catent — kept in the table, just hidden from the
// active lineup, so nothing is destructively lost.
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

// Everyone who's ever been added, active or soft-deleted (eliminated),
// ordered the way they'll come back into the lineup on a full reset. This is
// the "very first list" the Start Over button rebuilds from.
async function fetchAllContestants() {
  if (!isUp()) return null;
  try {
    const { data, error } = await supabase
      .from('contestants')
      .select('id, name, avg, audience_avg, judge_avg')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data.map(mapRow);
  } catch (e) {
    console.error('[supabase] fetchAllContestants failed:', e.message);
    return null;
  }
}

// Reactivates every contestant (including ones eliminated going into Catent)
// and clears every score, for "Start Over".
async function resetAllContestants() {
  if (!isUp()) return false;
  try {
    const { error } = await supabase
      .from('contestants')
      .update({ active: true, avg: null, audience_avg: null, judge_avg: null })
      .not('id', 'is', null); // matches every row; Supabase requires a filter
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] resetAllContestants failed:', e.message);
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
      .select('current_id, session_id, voting_active, round, talent_results')
      .eq('id', 1)
      .single();
    if (error) throw error;
    return {
      currentId: data.current_id,
      sessionId: data.session_id,
      votingActive: data.voting_active,
      round: data.round || 1,
      talentResults: data.talent_results || null
    };
  } catch (e) {
    console.error('[supabase] fetchAppState failed:', e.message);
    return null;
  }
}

async function saveAppState({ currentId, sessionId, votingActive, round, talentResults }) {
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
          talent_results: talentResults || null,
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

// ---------------- audience votes ----------------

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

// ---------------- judge votes ----------------
// Same shape as audience votes, but keyed by judge slot (1-4) instead of a
// device id, so a judge overwrites their own mark instead of stacking extras.

async function upsertJudgeVote(sessionId, judgeNum, score) {
  if (!isUp()) return false;
  try {
    const { error } = await supabase
      .from('judge_votes')
      .upsert(
        { session_id: sessionId, judge_num: judgeNum, score, updated_at: new Date().toISOString() },
        { onConflict: 'session_id,judge_num' }
      );
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] upsertJudgeVote failed:', e.message);
    return false;
  }
}

async function fetchJudgeVotesForSession(sessionId) {
  if (!isUp() || !sessionId) return null;
  try {
    const { data, error } = await supabase
      .from('judge_votes')
      .select('judge_num, score')
      .eq('session_id', sessionId);
    if (error) throw error;
    const votes = {};
    for (const row of data) votes[row.judge_num] = row.score;
    return votes;
  } catch (e) {
    console.error('[supabase] fetchJudgeVotesForSession failed:', e.message);
    return null;
  }
}

async function deleteJudgeVotesForSession(sessionId) {
  if (!isUp() || !sessionId) return false;
  try {
    const { error } = await supabase.from('judge_votes').delete().eq('session_id', sessionId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[supabase] deleteJudgeVotesForSession failed:', e.message);
    return false;
  }
}

module.exports = {
  isUp,
  fetchContestants,
  fetchAllContestants,
  resetAllContestants,
  upsertContestant,
  setContestantActive,
  setSortOrders,
  deleteContestant,
  fetchAppState,
  saveAppState,
  upsertVote,
  fetchVotesForSession,
  deleteVotesForSession,
  upsertJudgeVote,
  fetchJudgeVotesForSession,
  deleteJudgeVotesForSession
};
