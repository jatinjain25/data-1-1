/* GET /api/cron - once a day.
     1. Meta ad spend for the last 7 days (Meta revises a day for ~72 h, so a
        week-wide window repairs any night that failed).
     2. Mixpanel replays of the 2 days before today (export refuses today).
     3. If RETAIN_DAYS is set, delete raw events older than that.
   Each job reports on its own; one failing does not hide the others.

   AUTH: Authorization: Bearer $CRON_SECRET (Vercel Cron sends it for you).
   Without the variable it refuses everything rather than running open. */

import crypto from "node:crypto";
import { config, env } from "./lib/config.js";
import { call } from "./lib/db.js";
import { header, sendJson } from "./lib/http.js";
import { pullMetaAds } from "./modules/meta.js";
import { syncReplays } from "./modules/mixpanel.js";

function authorised(req) {
  const secret = env().cronSecret;
  if (!secret) return false;
  const a = Buffer.from(String(header(req, "authorization") || ""));
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function runDaily(cfg = config) {
  const run = async (name, job) => {
    try {
      const out = await job();
      if (!out.ok) console.error(`cron: ${name} failed`, out.error);
      return out;
    } catch (e) {
      console.error(`cron: ${name} threw`, e.message);
      return { ok: false, error: `${name} threw: ${e.message}` };
    }
  };
  const out = {};
  if (cfg.modules.ads.enabled) out.ads = await run("ads", () => pullMetaAds({ days: 7 }));
  if (cfg.modules.replays.enabled) out.replays = await run("replays", () => syncReplays({ days: 2 }));
  const keep = Number(process.env.RETAIN_DAYS);
  if (keep >= 30) {
    out.prune = await run("prune", async () => {
      const rows = await call("prune", { p_site: cfg.site.id, p_keep_days: keep });
      return { ok: true, deleted: rows[0] ? Object.values(rows[0])[0] : 0 };
    });
  }
  return out;
}

export default async function handler(req, res) {
  if (!authorised(req)) return sendJson(res, 401, { error: "unauthorised" });
  const out = await runDaily();
  const ok = Object.values(out).every((r) => r.ok);
  return sendJson(res, ok ? 200 : 502, { ok, ...out });
}
