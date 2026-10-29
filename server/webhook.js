/* POST /api/webhook?provider=stripe|razorpay|dodo

   Point your payment provider's webhook here (AGENTS.md step 7c). Signed with
   STRIPE_WEBHOOK_SECRET / RAZORPAY_WEBHOOK_SECRET / DODO_WEBHOOK_SECRET.

   Answers:
     200  recorded, or an event type this does not count (so the provider stops retrying)
     400  bad signature - check the secret, or (Vercel) NODEJS_HELPERS=0
     500  database trouble - the provider retries, and record_payment() is idempotent */

import { config } from "./lib/config.js";
import { call } from "./lib/db.js";
import { header, queryOf, readRaw, sendJson } from "./lib/http.js";
import {
  parseDodo, parseRazorpay, parseStripe, validPayment,
  verifyRazorpay, verifyStandardWebhook, verifyStripe,
} from "./modules/payments.js";

export async function recordPayment(p, raw = null, cfg = config) {
  const rows = await call("record_payment", {
    p_site: cfg.site.id, p_provider: p.provider, p_external_id: p.external_id,
    p_amount_minor: Math.round(p.amount_minor), p_currency: String(p.currency).toUpperCase(),
    p_account: p.account_id || null, p_visitor: p.visitor_id || null, p_email: p.email || null,
    p_plan: p.plan || null, p_paid_at: p.paid_at || null, p_raw: raw,
  });
  return rows && rows[0] ? Object.values(rows[0])[0] : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  if (!config.modules.revenue.enabled) return sendJson(res, 200, { ok: true, ignored: "revenue module off" });

  const provider = String(queryOf(req).provider || "");
  const raw = await readRaw(req);
  let ok = false;
  let parse = null;

  if (provider === "stripe") {
    ok = verifyStripe(raw, header(req, "stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
    parse = parseStripe;
  } else if (provider === "razorpay") {
    ok = verifyRazorpay(raw, header(req, "x-razorpay-signature"), process.env.RAZORPAY_WEBHOOK_SECRET);
    parse = parseRazorpay;
  } else if (provider === "dodo") {
    ok = verifyStandardWebhook(raw, {
      "webhook-id": header(req, "webhook-id"),
      "webhook-timestamp": header(req, "webhook-timestamp"),
      "webhook-signature": header(req, "webhook-signature"),
    }, process.env.DODO_WEBHOOK_SECRET);
    parse = parseDodo;
  } else {
    return sendJson(res, 400, { error: "unknown provider - use ?provider=stripe|razorpay|dodo" });
  }

  if (!ok) {
    console.warn(`[data-1-1] ${provider} webhook: bad signature`);
    return sendJson(res, 400, { error: "bad signature" });
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "not json" }); }
  const p = parse(evt);
  if (!p || !validPayment(p)) return sendJson(res, 200, { ok: true, ignored: evt.type || evt.event || "event" });

  try {
    const isNew = await recordPayment(p, evt);
    return sendJson(res, 200, { ok: true, recorded: p.external_id, new: isNew });
  } catch (e) {
    console.error("webhook:", e.message);
    return sendJson(res, 500, { error: "could not record" });
  }
}
