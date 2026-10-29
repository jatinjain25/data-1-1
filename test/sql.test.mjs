/* The database, for real: schema.sql on an in-process Postgres (PGlite), then
   the same function calls the handlers make, with numbers checked. */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { openDb, call as rawCall } from "../server/lib/db.js";
import { migrate } from "../scripts/migrate.mjs";
import { normalise } from "../server/lib/config.js";

const cfg = normalise({
  site: { id: "shop", name: "Shop", domains: ["shop.example"], timezone: "Asia/Kolkata", currency: "INR" },
  modules: { revenue: { excludePlans: ["course"] } },
});
let h;
const call = (fn, args) => rawCall(fn, args, h);
const S = "shop";
const one = async (fn, args) => (await call(fn, args))[0];

const ingest = (v, extra = {}) => call("ingest", {
  p_site: S, p_visitor: v, p_session: `s_${v}`, p_kind: "pageview", p_name: null, p_path: "/",
  p_referrer: null, p_referrer_host: null, p_utm_source: null, p_utm_medium: null, p_utm_campaign: null,
  p_utm_content: null, p_utm_term: null, p_country: "IN", p_region: null, p_city: "Pune",
  p_device: "mobile", p_browser: "Chrome", p_os: "Android", p_ip_hash: `ip_${v}`, ...extra,
});
const range = () => ({ p_site: S, p_from: new Date(Date.now() - 86400e3).toISOString(), p_to: new Date(Date.now() + 60e3).toISOString() });

before(async () => {
  h = await openDb("pglite://memory");
  await migrate(h, cfg);
  await migrate(h, cfg);   // idempotent
});

test("a visitor counts only once verified; bots never", async () => {
  await ingest("vHuman0001", { p_utm_source: "meta", p_utm_campaign: "launch", p_utm_content: "ad1", p_click_source: "fbclid" });
  await ingest("vBounce001");
  await ingest("vRobot0001", { p_bot: true });
  await call("verify", { p_site: S, p_visitor: "vHuman0001" });
  await call("verify", { p_site: S, p_visitor: "vRobot0001" });
  const w = await one("window_stats", range());
  assert.equal(Number(w.visitors), 1);
  const v = (await h.query("select first_channel, verified, is_bot from sitedata.visitors where visitor_id = 'vRobot0001'"))[0];
  assert.deepEqual([v.verified, v.is_bot], [false, true]);
  const hv = (await h.query("select first_channel from sitedata.visitors where visitor_id = 'vHuman0001'"))[0];
  assert.equal(hv.first_channel, "paid");
});

test("many fresh ids from one hashed IP in minutes are flagged as a burst", async () => {
  for (const v of ["vBurst0001", "vBurst0002", "vBurst0003"]) await ingest(v, { p_ip_hash: "same" });
  const rows = await h.query("select count(*) n from sitedata.visitors where ip_hash = 'same' and is_bot");
  assert.equal(Number(rows[0].n), 3);
});

test("a known bot sharing an IP does not drag the next real visitor down", async () => {
  await ingest("vDoctor001", { p_ip_hash: "office", p_bot: true });   // e.g. doctor's test beacon
  await ingest("vPerson001", { p_ip_hash: "office" });
  const v = (await h.query("select is_bot from sitedata.visitors where visitor_id = 'vPerson001'"))[0];
  assert.equal(v.is_bot, false);
});

test("first touch is written once and never moved by later visits", async () => {
  await ingest("vHuman0001", { p_utm_source: "google", p_path: "/pricing" });
  const v = (await h.query("select first_utm_source, first_landing_path, pageview_count from sitedata.visitors where visitor_id = 'vHuman0001'"))[0];
  assert.deepEqual([v.first_utm_source, v.first_landing_path, v.pageview_count], ["meta", "/", 2]);
});

test("reading time is capped per ping and by wall-clock time since the last one", async () => {
  await call("add_time", { p_site: S, p_visitor: "vHuman0001", p_seconds: 9999 });
  await call("add_time", { p_site: S, p_visitor: "vHuman0001", p_seconds: 60 });
  const t = (await h.query("select seconds, pings from sitedata.active_time where visitor_id = 'vHuman0001'"))[0];
  assert.equal(t.pings, 2);
  assert.ok(t.seconds >= 60 && t.seconds <= 67, `got ${t.seconds}`);   // 60 + at most ~5 s for an instant replay
  await call("add_time", { p_site: S, p_visitor: "vRobot0001", p_seconds: 30 });
  assert.equal((await h.query("select count(*) n from sitedata.active_time where visitor_id = 'vRobot0001'"))[0].n, 0);
});

test("identify links once (fill-only); the browser cannot rename what the server said", async () => {
  await call("upsert_account", { p_site: S, p_account: "u1", p_email: "Real@Shop.example", p_name: "Real", p_server: true });
  await call("identify", { p_site: S, p_visitor: "vHuman0001", p_account: "u1", p_email: "fake@evil.example", p_name: "Fake" });
  await call("identify", { p_site: S, p_visitor: "vHuman0001", p_account: "u2" });
  const v = (await h.query("select account_id from sitedata.visitors where visitor_id = 'vHuman0001'"))[0];
  const a = (await h.query("select email, name from sitedata.accounts where account_id = 'u1'"))[0];
  assert.equal(v.account_id, "u1");
  assert.deepEqual([a.email, a.name], ["real@shop.example", "Real"]);
  const t = (await h.query("select account_id from sitedata.active_time where visitor_id = 'vHuman0001'"))[0];
  assert.equal(t.account_id, "u1");
});

test("a payment is counted once, fills blanks on the second copy, and is credited to first touch", async () => {
  assert.equal(Object.values((await call("record_payment", { p_site: S, p_provider: "razorpay", p_external_id: "pay_1",
    p_amount_minor: 49900, p_currency: "inr" }))[0])[0], true);
  assert.equal(Object.values((await call("record_payment", { p_site: S, p_provider: "razorpay", p_external_id: "pay_1",
    p_amount_minor: 99999, p_currency: "INR", p_account: "u1", p_plan: "monthly" }))[0])[0], false);
  await call("record_payment", { p_site: S, p_provider: "stripe", p_external_id: "pi_x", p_amount_minor: 100, p_currency: "USD", p_account: "u1" });
  await call("record_payment", { p_site: S, p_provider: "manual", p_external_id: "c1", p_amount_minor: 500, p_currency: "INR", p_account: "u1", p_plan: "course" });
  const w = await one("window_stats", range());
  assert.deepEqual([Number(w.revenue_minor), Number(w.payments), Number(w.paying), Number(w.other_currency_payments)], [49900, 1, 1, 1]);
  const src = await call("sources", { ...range(), p_dim: "utm_content" });
  const ad1 = src.find((r) => r.value === "ad1");
  assert.equal(Number(ad1.revenue_minor), 49900);
  assert.equal(Number(ad1.signups), 1);
});

test("a payment with only an email finds its account", async () => {
  await call("upsert_account", { p_site: S, p_account: "u3", p_email: "buyer@x.in", p_server: true });
  await call("record_payment", { p_site: S, p_provider: "dodo", p_external_id: "d1", p_amount_minor: 1000, p_currency: "INR", p_email: "BUYER@x.in" });
  const p = (await call("paid", { p_site: S })).find((r) => r.external_id === "d1");
  assert.equal(p.account_id, "u3");
});

test("an unknown dimension is refused", async () => {
  await assert.rejects(call("sources", { ...range(), p_dim: "password" }), /unknown dimension/);
});

test("today exists in the site's timezone and the daily rows add up", async () => {
  const d = await call("daily", range());
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  assert.equal(d.at(-1).day, today);
  assert.equal(d.reduce((a, r) => a + Number(r.revenue_minor), 0), 49900 + 1000);
});

test("people: actions from browser and server, time, money; the timeline shows all of it", async () => {
  await ingest("vHuman0001", { p_kind: "custom", p_name: "question_asked" });
  await call("record_event", { p_site: S, p_account: "u1", p_name: "question_asked" });
  await call("record_event", { p_site: S, p_account: "u1", p_name: "other_thing" });
  const u1 = (await call("people", { p_site: S, p_actions: ["question_asked"] })).find((r) => r.account_id === "u1");
  assert.deepEqual(u1.actions, { question_asked: 2 });
  assert.equal(u1.channel, "paid");
  assert.equal(Number(u1.revenue_minor), 49900);
  assert.ok(Number(u1.seconds_total) >= 60);
  const kinds = new Set((await call("person_timeline", { p_site: S, p_account: "u1" })).map((r) => r.kind));
  for (const k of ["pageview", "custom", "action", "payment"]) assert.ok(kinds.has(k), k);
});

test("live and visitors list see the same people, one row per account", async () => {
  const live = await call("live", { p_site: S, p_minutes: 10 });
  assert.ok(live.some((r) => r.account_id === "u1" && r.email === "real@shop.example"));
  assert.ok(!live.some((r) => r.visitor_id === "vRobot0001"));
  const page = await call("visitors_page", { p_site: S, p_before: new Date(Date.now() + 60e3).toISOString(), p_limit: 10 });
  assert.equal(page.filter((r) => r.person === "u1").length, 1);
  assert.ok(!page.some((r) => r.person === "vBounce001"));   // never verified
});

test("survey answers merge per browser and summarise per question", async () => {
  await call("save_answers", { p_site: S, p_visitor: "vHuman0001", p_survey: "survey", p_data: { goal: ["a", "other"], goal_other: "Friend" } });
  await call("save_answers", { p_site: S, p_visitor: "vHuman0001", p_survey: "survey", p_data: { role: "dev" }, p_skipped_at: 2 });
  await call("save_answers", { p_site: S, p_visitor: "vBounce001", p_survey: "survey", p_data: { goal: ["a"] } });
  await ingest("vHuman0001", { p_kind: "custom", p_name: "survey_shown" });
  const s = Object.values((await call("answers_summary", { ...range(), p_survey: "survey", p_shown_event: "survey_shown" }))[0])[0];
  assert.equal(s.answered, 2);
  assert.equal(s.shown, 1);
  assert.deepEqual(s.skipped, { 2: 1 });
  assert.deepEqual(s.questions.goal, [{ key: "a", n: 2 }, { key: "other", n: 1 }]);
  assert.deepEqual(s.typed.goal, [{ key: "Friend", n: 1 }]);
  const people = await call("answers_people", { p_site: S, p_survey: "survey", p_q: "friend" });
  assert.equal(people.length, 1);
  assert.equal(people[0].email, "real@shop.example");
});

test("ad spend sits beside the people its link brought", async () => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  await h.query(`insert into sitedata.ad_spend (site_id, day, ad_id, ad_name, utm_campaign, utm_content, spend, impressions, link_clicks)
                 values ($1, $2, 'a1', 'Launch', 'launch', 'ad1', 250.50, 1000, 40), ($1, $2, 'a2', 'No UTM', null, null, 10, 100, 2)`, [S, day]);
  const ads = await call("ads", range());
  const a1 = ads.find((r) => r.ad_id === "a1");
  assert.deepEqual([Number(a1.visitors), Number(a1.signups), Number(a1.paying), Number(a1.revenue_minor)], [1, 1, 1, 49900]);
  assert.equal(ads.find((r) => r.ad_id === "a2").visitors, null);   // cannot match: null, not zero
  assert.equal(Number((await one("window_stats", range())).ad_spend), 260.5);
});

test("the gate's rate limit counts within a window", async () => {
  const hit = async () => Object.values((await call("rate_limit_hit", { p_bucket: "t", p_window_seconds: 3600, p_max: 2 }))[0])[0];
  assert.deepEqual([await hit(), await hit(), await hit()], [true, true, false]);
});
