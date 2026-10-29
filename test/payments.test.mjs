/* Webhook signatures and parsers - signed exactly the way each provider signs. */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  parseDodo, parseRazorpay, parseStripe, validPayment,
  verifyRazorpay, verifyStandardWebhook, verifyStripe,
} from "../server/modules/payments.js";

const now = Date.parse("2026-10-29T12:00:00Z");
const t = Math.floor(now / 1000);

test("Stripe: valid signature passes; wrong secret, tampered body and stale timestamp fail", () => {
  const raw = '{"id":"evt_1"}';
  const sig = crypto.createHmac("sha256", "whsec_test").update(`${t}.${raw}`).digest("hex");
  const header = `t=${t},v1=${sig}`;
  assert.equal(verifyStripe(raw, header, "whsec_test", { now }), true);
  assert.equal(verifyStripe(raw, header, "whsec_other", { now }), false);
  assert.equal(verifyStripe(raw + " ", header, "whsec_test", { now }), false);
  assert.equal(verifyStripe(raw, header, "whsec_test", { now: now + 600e3 }), false);
  assert.equal(verifyStripe(raw, `t=${t},v1=deadbeef,v1=${sig}`, "whsec_test", { now }), true);
  assert.equal(verifyStripe(raw, null, "whsec_test", { now }), false);
});

test("Stripe: one-time Checkout and paid invoices count; subscription Checkout does not (its invoice does)", () => {
  const one = parseStripe({ type: "checkout.session.completed", data: { object: {
    id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 4900, currency: "usd",
    client_reference_id: "user_7", metadata: { site_visitor_id: "vABCDEFGH12", plan: "pro" },
    customer_details: { email: "a@b.co" }, created: t } } });
  assert.deepEqual(
    [one.external_id, one.amount_minor, one.account_id, one.visitor_id, one.plan, one.email],
    ["pi_1", 4900, "user_7", "vABCDEFGH12", "pro", "a@b.co"]);
  assert.ok(validPayment(one));
  assert.equal(parseStripe({ type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid" } } }), null);
  const inv = parseStripe({ type: "invoice.paid", data: { object: {
    id: "in_1", amount_paid: 1900, currency: "usd", customer_email: "c@d.co",
    parent: { subscription_details: { metadata: { account_id: "u2" } } },
    lines: { data: [{ price: { lookup_key: "monthly" } }] } } } });
  assert.deepEqual([inv.external_id, inv.account_id, inv.plan], ["in_1", "u2", "monthly"]);
  assert.equal(parseStripe({ type: "invoice.paid", data: { object: { id: "in_0", amount_paid: 0, currency: "usd" } } }), null);
  assert.equal(parseStripe({ type: "customer.created", data: { object: {} } }), null);
});

test("Razorpay: hex HMAC of the raw body; payment.captured and subscription.charged share the payment id", () => {
  const raw = '{"event":"payment.captured"}';
  const sig = crypto.createHmac("sha256", "rzp_secret").update(raw).digest("hex");
  assert.equal(verifyRazorpay(raw, sig, "rzp_secret"), true);
  assert.equal(verifyRazorpay(raw, sig, "other"), false);
  const cap = parseRazorpay({ event: "payment.captured", payload: { payment: { entity: {
    id: "pay_1", amount: 49900, currency: "INR", email: "x@y.in", notes: {}, created_at: t } } } });
  const sub = parseRazorpay({ event: "subscription.charged", payload: {
    payment: { entity: { id: "pay_1", amount: 49900, currency: "INR" } },
    subscription: { entity: { notes: { account_id: "u9", plan: "monthly" } } } } });
  assert.equal(cap.external_id, sub.external_id);
  assert.equal(cap.account_id, null);
  assert.equal(sub.account_id, "u9");
  assert.equal(parseRazorpay({ event: "payment.failed", payload: {} }), null);
});

test("Dodo: Standard Webhooks signature over id.timestamp.body with the base64 key", () => {
  const key = Buffer.from("supersecretkey123");
  const secret = `whsec_${key.toString("base64")}`;
  const raw = '{"type":"payment.succeeded"}';
  const sig = crypto.createHmac("sha256", key).update(`msg_1.${t}.${raw}`).digest("base64");
  const h = { "webhook-id": "msg_1", "webhook-timestamp": String(t), "webhook-signature": `v1,${sig}` };
  assert.equal(verifyStandardWebhook(raw, h, secret, { now }), true);
  assert.equal(verifyStandardWebhook(raw, { ...h, "webhook-id": "msg_2" }, secret, { now }), false);
  assert.equal(verifyStandardWebhook(raw, h, secret, { now: now + 3600e3 }), false);
  const p = parseDodo({ type: "payment.succeeded", data: { payment_id: "pay_d1", total_amount: 1499, currency: "INR",
    customer: { email: "e@f.in" }, metadata: { site_visitor_id: "vQQQQQQQQQQ", plan: "yearly" } } });
  assert.deepEqual([p.external_id, p.amount_minor, p.visitor_id, p.plan], ["pay_d1", 1499, "vQQQQQQQQQQ", "yearly"]);
  assert.equal(parseDodo({ type: "subscription.active", data: {} }), null);
});
