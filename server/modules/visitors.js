/* The "Earlier" list: everyone who came, newest first, 25 at a time. Load
   more passes the last row's (last_seen, person) back - keyset, not offset,
   so someone arriving between two clicks cannot repeat a row. Pure parsers,
   so the tests can hold them. */

import { config } from "../lib/config.js";
import { call } from "../lib/db.js";
import { replayUrl, withWorkspace } from "./mixpanel.js";

const PERSON_RE = /^[A-Za-z0-9:_.@|+-]{1,128}$/;

/** null when the cursor is unusable - refused, never defaulted. */
export function parseVisitorsQuery(q) {
  let before = null;
  if (q.before) {
    before = new Date(q.before);
    if (isNaN(before)) return null;
  }
  const person = q.person ? String(q.person) : null;
  if (person && !PERSON_RE.test(person)) return null;
  if (person && !before) return null;
  const n = Number(q.limit || 25);
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 25;
  return { p_before: before ? before.toISOString() : null, p_person: person, p_limit: limit, p_signed_in: q.signed === "1" };
}

/** Browser ids for an anonymous timeline: comma-separated, at most 20. */
export function parseVisitorIds(raw) {
  const ids = String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > 20 || !ids.every((id) => PERSON_RE.test(id))) return null;
  return ids;
}

export async function visitorsPage(args, { cfg = config, rpc = call, now = Date.now() } = {}) {
  const params = { p_site: cfg.site.id, ...args };
  /* The first page starts where the live card stops: nobody listed twice. */
  if (!params.p_before) params.p_before = new Date(now - cfg.dashboard.liveMinutes * 60e3).toISOString();
  const rows = await rpc("visitors_page", params);
  const mp = cfg.modules.replays.enabled && rows.some((r) => r.replay_id) ? await withWorkspace() : null;
  const people = rows.map((r) => ({ ...r, replay_url: mp && r.replay_id ? replayUrl(r.replay_id, mp) : null }));
  return { people, done: rows.length < params.p_limit };
}
