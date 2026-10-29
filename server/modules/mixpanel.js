/* ═══════════════════════════════════════════════════════════════════════════
   Mixpanel Session Replay -> sitedata.replays, so the Visitors list can say
   "Watch replay" beside the person who did it.

   The link: your site registers the tracker's visitor id on Mixpanel
   (mixpanel.register({ site_visitor_id: siteData.visitorId() })), so every
   replay carries it. Signed-in replays also match by $user_id = account id.

   ONLY THE RAW EXPORT API WORKS ON MIXPANEL'S FREE PLAN, and it refuses the
   current day - so the nightly sync reads the two days BEFORE today. The
   query API's refusal ("Your plan does not allow API calls") is itself valid
   JSON; parseExport() refuses it instead of reading it as two events.

   A WRONG REGION FAILS QUIETLY: an EU project read through data.mixpanel.com
   answers 200 with zero rows. Set modules.replays.region.

   Env: MIXPANEL_SA_USER, MIXPANEL_SA_SECRET (a service account on the
   project), MIXPANEL_PROJECT_ID, optional MIXPANEL_WORKSPACE_ID.
   ═══════════════════════════════════════════════════════════════════════════ */

import { config } from "../lib/config.js";
import { db } from "../lib/db.js";

export const VISITOR_PROP = "site_visitor_id";

/* A service account's username is "<name>.<hex>.mp-service-account"; the
   secret has no dot. They get pasted into each other's boxes; put them back
   by shape - a swapped pair only ever answers 401. */
export function credentials(a, b) {
  const looksUser = (v) => /\.mp-service-account$/.test(v) || v.includes(".");
  return looksUser(b) && !looksUser(a) ? { user: b, secret: a } : { user: a, secret: b };
}

export function mixpanelCfg(e = process.env, region = config.modules.replays.region) {
  const r = String(region || "us").trim();
  const { user, secret } = credentials((e.MIXPANEL_SA_USER || "").trim(), (e.MIXPANEL_SA_SECRET || "").trim());
  const ws = (e.MIXPANEL_WORKSPACE_ID || "").trim();
  return {
    user, secret,
    projectId: (e.MIXPANEL_PROJECT_ID || "").trim(),
    workspaceId: /^\d+$/.test(ws) ? ws : "",
    exportHost: r === "us" ? "https://data.mixpanel.com" : `https://data-${r}.mixpanel.com`,
    appHost: r === "us" ? "https://mixpanel.com" : `https://${r}.mixpanel.com`,
  };
}

export function replayUrl(replayId, cfg = mixpanelCfg()) {
  if (!replayId || !cfg.projectId) return null;
  const view = cfg.workspaceId ? `/view/${cfg.workspaceId}` : "";
  return `${cfg.appHost}/project/${cfg.projectId}${view}/app/replay/${encodeURIComponent(replayId)}`;
}

/* The replay link wants the workspace id, which Mixpanel's UI barely shows.
   When unset, ask once per instance (/api/app/me), preferring the project's
   all-data workspace. A failed lookup links without it. */
let wsLookup = null;
export function pickWorkspace(me, projectId) {
  const all = Object.values(me?.results?.workspaces || {}).filter((w) => String(w.project_id) === String(projectId));
  const w = all.find((x) => x.is_global) || all.find((x) => x.is_default) || all[0];
  return w ? String(w.id) : "";
}

export async function withWorkspace(cfg = mixpanelCfg()) {
  if (cfg.workspaceId || !cfg.user || !cfg.secret || !cfg.projectId) return cfg;
  if (!wsLookup) {
    wsLookup = (async () => {
      try {
        const auth = Buffer.from(`${cfg.user}:${cfg.secret}`).toString("base64");
        const res = await fetch(`${cfg.appHost}/api/app/me`, { headers: { Authorization: `Basic ${auth}` } });
        if (!res.ok) throw new Error(`me ${res.status}`);
        return pickWorkspace(await res.json(), cfg.projectId);
      } catch (e) {
        console.error("mixpanel: workspace lookup failed", e.message);
        wsLookup = null;
        return "";
      }
    })();
  }
  return { ...cfg, workspaceId: await wsLookup };
}

/** JSONL -> events. Refuses an error object rather than reading it as data. */
export function parseExport(body) {
  const out = [];
  for (const line of String(body || "").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row && row.error && !row.event) throw new Error(`mixpanel: ${row.error}`);
    if (row && row.event && row.properties) out.push(row);
  }
  return out;
}

export async function exportEvents({ from, to, where } = {}, cfg = mixpanelCfg()) {
  if (!cfg.user || !cfg.secret || !cfg.projectId) throw new Error("MIXPANEL_* unset");
  const qs = new URLSearchParams({ project_id: cfg.projectId, from_date: from, to_date: to });
  if (where) qs.set("where", where);
  const auth = Buffer.from(`${cfg.user}:${cfg.secret}`).toString("base64");
  const res = await fetch(`${cfg.exportHost}/api/2.0/export?${qs}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "text/plain" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`mixpanel export ${res.status}: ${body.slice(0, 200)}`);
  return parseExport(body);
}

const eventMs = (p) => {
  const t = Number(p.time);
  return t > 1e12 ? t : t * 1000;
};

export function deviceOf(p) {
  const did = String(p.distinct_id || "");
  const d = p.$device_id || (did.startsWith("$device:") ? did.slice(8) : "");
  return d ? String(d).slice(0, 100) : null;
}

/** The account: $user_id, or a distinct_id that is not a device id. */
export function userOf(p) {
  const v = p.$user_id || (p.distinct_id && !String(p.distinct_id).startsWith("$device:") ? p.distinct_id : null);
  return v && String(v) !== deviceOf(p) ? String(v).slice(0, 128) : null;
}

/** Every Session Replay in a list of events, one row per $mp_replay_id. */
export function replayRows(events, prop = VISITOR_PROP) {
  const by = new Map();
  for (const e of events) {
    const p = e.properties || {};
    const id = p.$mp_replay_id;
    if (!id) continue;
    const at = eventMs(p);
    const r = by.get(id) || { replay_id: String(id), first: at, last: at, length_ms: 0,
                              account_id: null, visitor_id: null, device_id: null, distinct_id: null };
    r.first = Math.min(r.first, at);
    r.last = Math.max(r.last, at);
    r.length_ms = Math.max(r.length_ms, Number(p.replay_length_ms) || 0);
    r.account_id = r.account_id || userOf(p);
    r.visitor_id = r.visitor_id || (p[prop] ? String(p[prop]) : null);
    r.device_id = r.device_id || deviceOf(p);
    r.distinct_id = r.distinct_id || (p.distinct_id ? String(p.distinct_id) : null);
    by.set(id, r);
  }
  return [...by.values()].map(({ first, last, ...r }) => ({
    ...r, started_at: new Date(first).toISOString(), length_ms: Math.max(r.length_ms, last - first),
  }));
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Replays from the `days` whole days before today -> sitedata.replays. */
export async function syncReplays({ days = 2, cfg = mixpanelCfg(), now = Date.now(), site = config.site.id } = {}) {
  if (!cfg.user || !cfg.secret || !cfg.projectId) return { ok: false, error: "MIXPANEL_* unset" };
  const from = ymd(now - days * 86400e3);
  const to = ymd(now - 86400e3);
  const events = await exportEvents({ from, to, where: 'defined(properties["$mp_replay_id"])' }, cfg);
  const rows = replayRows(events);
  const h = await db();
  for (const r of rows) {
    await h.query(
      `insert into sitedata.replays (site_id, replay_id, distinct_id, account_id, visitor_id, device_id, started_at, length_ms, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (site_id, replay_id) do update set
         account_id = coalesce(excluded.account_id, sitedata.replays.account_id),
         visitor_id = coalesce(excluded.visitor_id, sitedata.replays.visitor_id),
         length_ms = greatest(excluded.length_ms, sitedata.replays.length_ms), updated_at = now()`,
      [site, r.replay_id, r.distinct_id, r.account_id, r.visitor_id, r.device_id, r.started_at, r.length_ms],
    );
  }
  return { ok: true, replays: rows.length, from, to };
}
