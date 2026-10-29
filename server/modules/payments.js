/* ═══════════════════════════════════════════════════════════════════════════
   Payment webhooks -> one normalised shape -> sitedata.record_payment().

   Every parser is PURE (event in, payment or null out) and every signature
   check is pure (raw body + headers + secret in, boolean out), so the tests
   hold both without a network.

   WHAT COUNTS: one row per successful CHARGE, keyed by the provider's own
   payment id, so retries and duplicate event types never double count.

   ATTRIBUTION: pass these in your checkout's metadata / notes and the
   dashboard can credit the payment to the ad or link that brought the buyer,
   even if they never signed in:
       account_id       your user id (optional if the email matches an account)
       site_visitor_id  window.siteData.visitorId() in the browser at checkout
       plan             a name for what they bought
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const meta = (m) => (m && typeof m === "object" ? m : {});
const pick = (m, ...keys) => {
  for (const k of keys) if (m[k] != null && m[k] !== "") return String(m[k]);
  return null;
};
const isoFromUnix = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

/* ── Stripe ──────────────────────────────────────────────────────────────── */

/** Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>]" over `${t}.${raw}`. */
export function verifyStripe(raw, sigHeader, secret, { now = Date.now(), tolerance = 300 } = {}) {
  if (!secret || !sigHeader) return false;
  let t = null;
  const v1 = [];
  for (const kv of String(sigHeader).split(",")) {
    const [k, v] = kv.split("=");
    if (k === "t") t = v;
    if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > tolerance) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return v1.some((s) => safeEq(s, want));
}

/** One-time Checkout payments and every paid subscription invoice. (A
    Checkout subscription's first charge arrives as invoice.paid, so counting
    checkout.session.completed only for mode=payment never double counts.) */
export function parseStripe(evt) {
  const o = evt && evt.data && evt.data.object;
  if (!o) return null;
  if (evt.type === "checkout.session.completed") {
    if (o.mode !== "payment" || o.payment_status !== "paid") return null;
    const m = meta(o.metadata);
    return {
      provider: "stripe", external_id: String(o.payment_intent || o.id),
      amount_minor: Number(o.amount_total), currency: o.currency,
      account_id: pick(m, "account_id", "user_id") || (o.client_reference_id ? String(o.client_reference_id) : null),
      visitor_id: pick(m, "site_visitor_id", "visitor_id"),
      email: o.customer_details?.email || o.customer_email || null,
      plan: pick(m, "plan"), paid_at: isoFromUnix(o.created),
    };
  }
  if (evt.type === "invoice.paid") {
    if (!(Number(o.amount_paid) > 0)) return null;
    const m = { ...meta(o.metadata), ...meta(o.subscription_details?.metadata), ...meta(o.parent?.subscription_details?.metadata) };
    const line = o.lines?.data?.[0] || {};
    return {
      provider: "stripe", external_id: String(o.id),
      amount_minor: Number(o.amount_paid), currency: o.currency,
      account_id: pick(m, "account_id", "user_id"),
      visitor_id: pick(m, "site_visitor_id", "visitor_id"),
      email: o.customer_email || null,
      plan: pick(m, "plan") || line.price?.lookup_key || line.price?.nickname || line.plan?.nickname || null,
      paid_at: isoFromUnix(o.status_transitions?.paid_at || o.created),
    };
  }
  return null;
}

/* ── Razorpay ────────────────────────────────────────────────────────────── */

/** X-Razorpay-Signature: hex HMAC-SHA256 of the raw body. */
export function verifyRazorpay(raw, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  return safeEq(crypto.createHmac("sha256", secret).update(raw).digest("hex"), sigHeader);
}

/** payment.captured covers every charge, one-time or subscription;
    subscription.charged carries the subscription's notes for the same
    payment id, so whichever arrives second fills the blanks. */
export function parseRazorpay(evt) {
  if (!evt || (evt.event !== "payment.captured" && evt.event !== "subscription.charged")) return null;
  const p = evt.payload?.payment?.entity;
  if (!p || !p.id || !(Number(p.amount) > 0)) return null;
  const m = { ...meta(evt.payload?.subscription?.entity?.notes), ...meta(p.notes) };
  return {
    provider: "razorpay", external_id: String(p.id),
    amount_minor: Number(p.amount), currency: p.currency || "INR",
    account_id: pick(m, "account_id", "user_id"),
    visitor_id: pick(m, "site_visitor_id", "visitor_id"),
    email: p.email || null, plan: pick(m, "plan"), paid_at: isoFromUnix(p.created_at),
  };
}

/* ── Dodo Payments (Standard Webhooks) ───────────────────────────────────── */

/** webhook-signature: "v1,<base64> [v1,<base64>]" over `${id}.${timestamp}.${raw}`,
    keyed by the base64 part of "whsec_<base64>". */
export function verifyStandardWebhook(raw, headers, secret, { now = Date.now(), tolerance = 300 } = {}) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!secret || !id || !ts || !sig) return false;
  if (Math.abs(now / 1000 - Number(ts)) > tolerance) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const want = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return String(sig).split(" ").some((s) => {
    const [v, b] = s.split(",");
    return v === "v1" && b && safeEq(b, want);
  });
}

export function parseDodo(evt) {
  if (!evt || evt.type !== "payment.succeeded") return null;
  const d = evt.data || {};
  if (!d.payment_id || !(Number(d.total_amount) > 0)) return null;
  const m = meta(d.metadata);
  return {
    provider: "dodo", external_id: String(d.payment_id),
    amount_minor: Number(d.total_amount), currency: d.currency || "USD",
    account_id: pick(m, "account_id", "user_id"),
    visitor_id: pick(m, "site_visitor_id", "visitor_id"),
    email: d.customer?.email || null, plan: pick(m, "plan"),
    paid_at: d.created_at || evt.timestamp || null,
  };
}

/** Shape check shared by webhooks and POST /api/ingest {type:"payment"}. */
export function validPayment(p) {
  return !!(p && p.provider && p.external_id && Number.isFinite(p.amount_minor) && p.amount_minor > 0
    && /^[A-Za-z]{3}$/.test(String(p.currency || "")));
}
