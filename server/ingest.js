/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/ingest - from YOUR server, never the browser.
   Authorization: Bearer <INGEST_KEY>

   One item, or { items: [...] } (up to 500) - for backfills.

     { type: "account", account_id, email?, name?, plan?, signed_up_at?, meta? }
         an account exists (call it at sign-up; authoritative, overwrites)
     { type: "identify", account_id, visitor_id }
         this browser is this account (when you'd rather not do it in the page)
     { type: "event", account_id, name, detail?, at? }
         something they did in your product (counts toward site.config.js actions)
     { type: "payment", provider, external_id, amount_minor, currency,
       account_id?, visitor_id?, email?, plan?, paid_at? }
         a charge your own code took (if you don't use the webhooks)

   The browser can do identify() itself (fill-only), but only your server can
   be trusted to say who signed up when, and what they did and paid.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { config, env } from "./lib/config.js";
import { call } from "./lib/db.js";
import { clean, cleanAccountId, cleanEmail, cleanId, header, readJson, sendJson } from "./lib/http.js";
import { validPayment } from "./modules/payments.js";
import { recordPayment } from "./webhook.js";

function authorised(req, key) {
  if (!key) return false;
  const got = Buffer.from(String(header(req, "authorization") || ""));
  const want = Buffer.from(`Bearer ${key}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const when = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? undefined : d.toISOString();
};

/** Pure: item -> [fn, args] or { error }. */
export function plan(item, site = config.site.id) {
  const t = item && item.type;
  if (t === "account") {
    const id = cleanAccountId(item.account_id);
    if (!id) return { error: "account_id missing or malformed" };
    const at = when(item.signed_up_at);
    if (at === undefined) return { error: "bad signed_up_at" };
    return ["upsert_account", {
      p_site: site, p_account: id, p_email: cleanEmail(item.email), p_name: clean(item.name, 120),
      p_plan: clean(item.plan, 60), p_signed_up_at: at,
      p_meta: item.meta && typeof item.meta === "object" ? item.meta : null, p_server: true,
    }];
  }
  if (t === "identify") {
    const id = cleanAccountId(item.account_id), v = cleanId(item.visitor_id);
    if (!id || !v) return { error: "account_id and visitor_id required" };
    return ["identify", { p_site: site, p_visitor: v, p_account: id }];
  }
  if (t === "event") {
    const id = cleanAccountId(item.account_id), name = clean(item.name, 120);
    if (!id || !name) return { error: "account_id and name required" };
    const at = when(item.at);
    if (at === undefined) return { error: "bad at" };
    return ["record_event", { p_site: site, p_account: id, p_name: name, p_detail: clean(item.detail, 500), p_at: at }];
  }
  if (t === "payment") {
    const p = {
      provider: clean(item.provider, 40) || "manual", external_id: clean(item.external_id, 200),
      amount_minor: Number(item.amount_minor), currency: item.currency,
      account_id: cleanAccountId(item.account_id), visitor_id: cleanId(item.visitor_id),
      email: cleanEmail(item.email), plan: clean(item.plan, 60), paid_at: when(item.paid_at),
    };
    if (p.paid_at === undefined || !validPayment(p)) return { error: "payment needs external_id, amount_minor > 0, 3-letter currency" };
    return ["payment", p];
  }
  return { error: `unknown type ${t}` };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  if (!authorised(req, env().ingestKey)) return sendJson(res, 401, { error: "Authorization: Bearer <INGEST_KEY> required" });

  const body = await readJson(req);
  const items = Array.isArray(body.items) ? body.items : [body];
  if (items.length > 500) return sendJson(res, 413, { error: "at most 500 items per request" });

  const results = [];
  for (const item of items) {
    const p = plan(item);
    if (!Array.isArray(p)) { results.push(p); continue; }
    try {
      if (p[0] === "payment") await recordPayment(p[1], item);
      else await call(p[0], p[1]);
      results.push({ ok: true });
    } catch (e) {
      console.error("ingest:", e.message);
      results.push({ error: "could not record" });
    }
  }
  const failed = results.filter((r) => r.error).length;
  return sendJson(res, failed === results.length ? 400 : 200, Array.isArray(body.items) ? { results } : results[0]);
}
