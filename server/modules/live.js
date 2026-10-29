/* ═══════════════════════════════════════════════════════════════════════════
   Who is on the site RIGHT NOW: browsers with any activity in the last N
   minutes (dashboard.liveMinutes, default 10) - a page event OR the reading
   ping. Without the ping, someone reading one page for 11 minutes would
   vanish: still there, just invisible to a pageview-only tracker.

   ONE PERSON COUNTS ONCE: by account when signed in, else by browser.
   mergeLive() is pure so the tests can hold it.
   ═══════════════════════════════════════════════════════════════════════════ */

import { config } from "../lib/config.js";
import { call } from "../lib/db.js";

/** rows from sitedata.live() -> people, newest first. */
export function mergeLive(rows) {
  const people = new Map();
  for (const r of rows) {
    const key = r.account_id ? `a:${r.account_id}` : `v:${r.visitor_id}`;
    const p = people.get(key) || { key, signals: [], last_seen_at: null };
    for (const k of ["account_id", "visitor_id", "email", "path", "since", "country", "city", "device", "source"]) {
      if (p[k] == null && r[k] != null) p[k] = r[k];
    }
    if (!p.signals.includes(r.signal)) p.signals.push(r.signal);
    const at = r.at instanceof Date ? r.at.toISOString() : r.at;
    if (at && (!p.last_seen_at || at > p.last_seen_at)) p.last_seen_at = at;
    people.set(key, p);
  }
  return [...people.values()].sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
}

export async function livePeople(cfg = config) {
  const minutes = cfg.dashboard.liveMinutes;
  const people = mergeLive(await call("live", { p_site: cfg.site.id, p_minutes: minutes }));
  return { count: people.length, people, minutes };
}
