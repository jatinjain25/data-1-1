/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/query?r=<report> - every dashboard report behind one gated route.

   EVERY REPORT IS GATED before the report name is even read.

   A RANGE THAT CANNOT BE PARSED IS REFUSED (400), never swapped for a
   default: a silently defaulted range is how a dashboard lies to you.
   ═══════════════════════════════════════════════════════════════════════════ */

import { config } from "./lib/config.js";
import { call } from "./lib/db.js";
import { deny, requireAdmin } from "./lib/gate.js";
import { queryOf, sendJson } from "./lib/http.js";
import { livePeople } from "./modules/live.js";
import { adsUpdatedAt, pullMetaAds } from "./modules/meta.js";
import { parseVisitorIds, parseVisitorsQuery, visitorsPage } from "./modules/visitors.js";

export const DIMS = new Set(["channel", "referrer", "utm_source", "utm_campaign", "utm_content",
  "landing", "country", "city", "device"]);

const MAX_RANGE_MS = 800 * 86400e3;
const ADS_STALE_MS = 2 * 3600e3;
const ACCOUNT_RE = /^[A-Za-z0-9_.:@|+-]{1,128}$/;

/** `from`/`to` ISO instants, `to` exclusive; plus the equal-length window
    just before, for the ▲▼ deltas. null when unusable. */
export function parseRange(q) {
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : new Date();
  if (!from || isNaN(from) || isNaN(to) || from >= to) return null;
  if (to - from > MAX_RANGE_MS) return null;
  const prevFrom = new Date(from.getTime() - (to - from));
  return { from: from.toISOString(), to: to.toISOString(), prevFrom: prevFrom.toISOString() };
}

/** Every panel of the overview in one round trip, each named so a failure
    says which report broke instead of blanking the page. */
export function dashboardCalls(site, r, dim, modules = config.modules) {
  const c = {
    current: ["window_stats", { p_site: site, p_from: r.from, p_to: r.to }],
    previous: ["window_stats", { p_site: site, p_from: r.prevFrom, p_to: r.from }],
    daily: ["daily", { p_site: site, p_from: r.from, p_to: r.to }],
    sources: ["sources", { p_site: site, p_from: r.from, p_to: r.to, p_dim: dim }],
  };
  if (modules.ads.enabled) c.ads = ["ads", { p_site: site, p_from: r.from, p_to: r.to }];
  return c;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  const gate = requireAdmin(req);
  if (!gate.ok) return deny(res, gate, req, "query");

  const q = queryOf(req);
  const site = config.site.id;
  const m = config.modules;

  try {
    switch (q.r) {
      case "dashboard": {
        const r = parseRange(q);
        if (!r) return sendJson(res, 400, { error: "bad range" });
        const dim = DIMS.has(q.dim) ? q.dim : "channel";
        const calls = dashboardCalls(site, r, dim);
        const names = Object.keys(calls);
        const [results, live] = await Promise.all([
          Promise.all(names.map((n) => call(...calls[n]))),
          livePeople(),
        ]);
        const out = Object.fromEntries(names.map((n, i) => [n, results[i]]));
        out.current = (out.current || [])[0] || null;
        out.previous = (out.previous || [])[0] || null;
        out.live = live;
        out.ads_updated_at = m.ads.enabled ? await adsUpdatedAt(site) : null;
        out.range = r;
        return sendJson(res, 200, out);
      }
      case "sources": {
        const r = parseRange(q);
        if (!r || !DIMS.has(q.dim)) return sendJson(res, 400, { error: "bad range or dim" });
        return sendJson(res, 200, await call("sources", { p_site: site, p_from: r.from, p_to: r.to, p_dim: q.dim }));
      }
      case "people":
        return sendJson(res, 200, await call("people", {
          p_site: site, p_actions: config.actions.map((a) => a.event), p_limit: 5000 }));
      case "person": {
        if (!ACCOUNT_RE.test(String(q.id || ""))) return sendJson(res, 400, { error: "bad id" });
        return sendJson(res, 200, await call("person_timeline", { p_site: site, p_account: q.id, p_limit: 400 }));
      }
      case "visitor": {
        const ids = parseVisitorIds(q.ids);
        if (!ids) return sendJson(res, 400, { error: "bad ids" });
        return sendJson(res, 200, await call("visitor_timeline", { p_site: site, p_visitors: ids, p_limit: 400 }));
      }
      case "live":
        return sendJson(res, 200, await livePeople());
      case "visitors": {
        const args = parseVisitorsQuery(q);
        if (!args) return sendJson(res, 400, { error: "bad cursor" });
        return sendJson(res, 200, await visitorsPage(args));
      }
      case "ads_refresh": {
        if (!m.ads.enabled) return sendJson(res, 200, { ok: false, error: "ads module off" });
        const last = await adsUpdatedAt(site);
        if (q.force !== "1" && last && Date.now() - new Date(last).getTime() < ADS_STALE_MS) {
          return sendJson(res, 200, { ok: true, fresh: true, updated_at: last });
        }
        return sendJson(res, 200, await pullMetaAds({ days: 3 }));
      }
      case "survey": {
        if (!m.survey.enabled) return sendJson(res, 200, null);
        const r = parseRange(q);
        if (!r) return sendJson(res, 400, { error: "bad range" });
        const rows = await call("answers_summary", {
          p_site: site, p_survey: "survey", p_shown_event: m.survey.shownEvent, p_from: r.from, p_to: r.to });
        return sendJson(res, 200, rows[0] ? Object.values(rows[0])[0] : null);
      }
      case "survey_people": {
        if (!m.survey.enabled) return sendJson(res, 200, []);
        const n = Number(q.limit || 50);
        return sendJson(res, 200, await call("answers_people", {
          p_site: site, p_survey: "survey",
          p_limit: Number.isFinite(n) ? Math.max(1, Math.min(5000, Math.floor(n))) : 50,
          p_q: q.q ? String(q.q).slice(0, 80) : null,
        }));
      }
      default:
        return sendJson(res, 400, { error: "unknown report" });
    }
  } catch (e) {
    console.error("query:", e && e.message);
    return sendJson(res, 500, { error: "report failed", report: (e && e.fn) || q.r });
  }
}
