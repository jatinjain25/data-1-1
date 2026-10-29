/* The collector's decisions, offline - no network, no database. */

import test from "node:test";
import assert from "node:assert/strict";
import { build, MAX_PING_SECONDS } from "../server/collect.js";
import { normalise } from "../server/lib/config.js";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const req = (h = {}) => ({ headers: { "user-agent": UA, "x-vercel-forwarded-for": "49.36.1.2", ...h } });
const cfg = normalise({
  site: { id: "shop", domains: ["shop.example"], timezone: "UTC" },
  modules: { survey: { enabled: true, questions: [
    { id: "goal", type: "multi", options: { a: "A", b: "B", other: "Other" }, other: true },
    { id: "role", type: "single", options: { dev: "Dev", pm: "PM" } },
  ] } },
});
const e = { salt: "s", trustProxy: 0, clientIpHeader: "x-client-ip" };
const opts = { cfg, e };
const base = { d: "shop.example", v: "vAAAAAAAAAAAAAAAAAAAA", s: "sAAAAAAAAAAAAAAAAAAAA", p: "/" };

test("the configured domain (and www) is collected; any other is dropped", () => {
  assert.equal(build(req(), base, opts)[1].p_site, "shop");
  assert.equal(build(req(), { ...base, d: "www.shop.example" }, opts)[1].p_site, "shop");
  assert.equal(build(req(), { ...base, d: "evil.example" }, opts), null);
  assert.equal(build(req(), { ...base, d: "localhost" }, opts), null);
});

test("a bot user-agent is dropped before anything is built", () => {
  assert.equal(build(req({ "user-agent": "Googlebot/2.1" }), base, opts), null);
});

test("the query string never survives into the stored path", () => {
  assert.equal(build(req(), { ...base, p: "/pricing/?email=a@b.c#x" }, opts)[1].p_path, "/pricing");
});

test("first touch fields, channel inputs and click-id NAME are passed; the IP is hashed", () => {
  const [fn, a] = build(req(), { ...base, r: "https://www.google.com/", us: "meta", uo: "ad1", cs: "fbclid" }, opts);
  assert.equal(fn, "ingest");
  assert.equal(a.p_referrer_host, "google.com");
  assert.equal(a.p_click_source, "fbclid");
  assert.equal(a.p_utm_content, "ad1");
  assert.match(a.p_ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(build(req(), { ...base, cs: "evil" }, opts)[1].p_click_source, null);
});

test("no salt, no hash - never a reversible identifier", () => {
  assert.equal(build(req(), base, { cfg, e: { ...e, salt: "" } })[1].p_ip_hash, null);
});

test("a self-referral is not a referral", () => {
  assert.equal(build(req(), { ...base, r: "https://shop.example/a" }, opts)[1].p_referrer_host, null);
  assert.equal(build(req(), { ...base, h: "preview.vercel.app", r: "https://preview.vercel.app/a" }, opts)[1].p_referrer_host, null);
});

test("a ping credits seconds, capped per ping", () => {
  assert.deepEqual(build(req(), { ...base, k: "ping", n: "30" }, opts),
    ["add_time", { p_site: "shop", p_visitor: base.v, p_seconds: 30 }]);
  assert.equal(build(req(), { ...base, k: "ping", n: "9999" }, opts)[1].p_seconds, MAX_PING_SECONDS);
});

test("a ping with no usable seconds, from automation, or from a data centre earns nothing", () => {
  for (const n of ["0", "abc", "-5"]) assert.equal(build(req(), { ...base, k: "ping", n }, opts), null);
  assert.equal(build(req(), { ...base, k: "ping", n: "30", w: true }, opts), null);
  // 31.13.64.1 is Meta's crawler space, in the committed ranges
  assert.equal(build(req({ "x-vercel-forwarded-for": "31.13.64.1" }), { ...base, k: "ping", n: "30" }, opts), null);
});

test("automation and data-centre pageviews are kept but flagged as bots", () => {
  assert.equal(build(req(), { ...base, w: true }, opts)[1].p_bot, true);
  assert.equal(build(req({ "x-vercel-forwarded-for": "31.13.64.1" }), base, opts)[1].p_bot, true);
  assert.equal(build(req(), base, opts)[1].p_bot, false);
});

test("engage verifies, identify links - neither mints a phantom pageview", () => {
  assert.equal(build(req(), { ...base, k: "engage" }, opts)[0], "verify");
  const id = build(req(), { ...base, k: "identify", n: "user_2abc", m: { email: " Ann@X.com ", name: "Ann" } }, opts);
  assert.equal(id[0], "identify");
  assert.equal(id[1].p_account, "user_2abc");
  assert.equal(id[1].p_email, "ann@x.com");
  assert.equal(build(req(), { ...base, k: "identify", n: "has spaces" }, opts), null);
  assert.equal(build(req(), { ...base, k: "identify", n: "u1", w: true }, opts), null);
});

test("account ids from common auth providers are accepted", () => {
  for (const n of ["0b9e3c1a-7f2d-4c55-9a10-5d2e8f6b4c33", "user_2abcDEF", "google-oauth2|1234", "42", "a@b.c"]) {
    assert.ok(build(req(), { ...base, k: "identify", n }, opts), n);
  }
});

test("survey answers are whitelisted against the config", () => {
  const [fn, a] = build(req(), { ...base, k: "answer", m: { answers: {
    goal: ["a", "nope", "other"], goal_other: "A friend", role: "ceo", extra: "x" }, skipped: 2 } }, opts);
  assert.equal(fn, "save_answers");
  assert.deepEqual(a.p_data, { goal: ["a", "other"], goal_other: "A friend" });
  assert.equal(a.p_skipped_at, 2);
  const off = normalise({ site: { id: "shop", domains: ["shop.example"] } });
  assert.equal(build(req(), { ...base, k: "answer", m: { answers: { goal: ["a"] } } }, { cfg: off, e }), null);
});

test("malformed visitor/session ids are dropped (cardinality guard)", () => {
  assert.equal(build(req(), { ...base, v: "x" }, opts), null);
  assert.equal(build(req(), { ...base, s: "a b c d e f g h" }, opts), null);
});

test("event properties are bounded", () => {
  const m = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v".repeat(500)]));
  const meta = build(req(), { ...base, k: "custom", n: "x", m }, opts)[1].p_meta;
  assert.equal(Object.keys(meta).length, 20);
  assert.equal(meta.k0.length, 200);
});

test("a proxied beacon is judged by the visitor's address, not the proxy's", () => {
  // the proxy itself sits in a cloud range; the visitor does not
  const viaProxy = req({ "x-vercel-forwarded-for": "31.13.64.1", "x-client-ip": "49.36.1.2" });
  assert.equal(build(viaProxy, base, opts)[1].p_bot, false);
  assert.equal(build(req({ "x-vercel-forwarded-for": "31.13.64.1" }), base, opts)[1].p_bot, true);
});

test("an IP from TRUST_PROXY hops is read from the right, never the forgeable left", async () => {
  const { clientIp } = await import("../server/lib/net.js");
  const r = { headers: { "x-forwarded-for": "6.6.6.6, 49.36.1.2" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientIp(r, 0), "10.0.0.1");
  assert.equal(clientIp(r, 1), "49.36.1.2");
  assert.equal(clientIp({ ...r, headers: { ...r.headers, "x-client-ip": "8.8.4.4" } }, 1), "8.8.4.4");
});
