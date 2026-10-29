/* npm run doctor [-- --url https://data.example.com] [--site https://example.com]

   Checks everything that can be checked, and says exactly what to fix.
     1. site.config.js makes sense
     2. the environment has what the enabled modules need
     3. the database is reachable, migrated, and knows your site
     4. (--url) the deployed dashboard answers the way it should
     5. (--site) your site serves the tracker and its /ke proxy reaches us -
        it sends ONE test beacon flagged as a bot (never counted) and then
        looks for it in the database.
   Exit code 0 = no failures (warnings allowed). */

import "./env.mjs";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const URL_ = (arg("--url") || "").replace(/\/$/, "");
const SITE_URL = (arg("--site") || "").replace(/\/$/, "");

let fails = 0, warns = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => { warns++; console.log(`  ! ${m}`); };
const fail = (m) => { fails++; console.log(`  ✗ ${m}`); };
const head = (m) => console.log(`\n${m}`);

head("1. site.config.js");
let config;
try {
  ({ config } = await import("../server/lib/config.js"));
  ok(`site "${config.site.id}" on ${config.site.domains.join(", ")} · ${config.site.timezone} · ${config.site.currency}`);
  if (config.site.domains.includes("example.com")) warn("site.domains is still example.com - beacons from your real domain will be dropped");
  try { new Intl.DateTimeFormat("en", { timeZone: config.site.timezone }); } catch { fail(`timezone "${config.site.timezone}" is not an IANA zone`); }
  try { new Intl.NumberFormat("en", { style: "currency", currency: config.site.currency }); } catch { fail(`currency "${config.site.currency}" is not ISO 4217`); }
  const on = Object.entries(config.modules).filter(([, v]) => v.enabled).map(([k]) => k);
  ok(`modules on: ${on.join(", ") || "none"} · actions: ${config.actions.map((a) => a.event).join(", ") || "none"}`);
  if (config.modules.survey.enabled && !config.modules.survey.questions.length) warn("survey is enabled but has no questions");
} catch (e) {
  fail(e.message);
  process.exit(1);
}

head("2. environment");
const e = process.env;
const need = (k, why) => (e[k] ? ok(`${k} set`) : fail(`${k} missing - ${why}`));
const want = (k, why) => (e[k] ? ok(`${k} set`) : warn(`${k} not set - ${why}`));
need("DATABASE_URL", "Postgres connection string (AGENTS.md step 2)");
if (!e.SESSION_SECRET) fail("SESSION_SECRET missing - `npm run secret` prints one");
else if (e.SESSION_SECRET.length < 32) fail("SESSION_SECRET is shorter than 32 characters");
else ok("SESSION_SECRET set");
if (!e.ADMIN_EMAILS && !e.ADMIN_PASSWORD) fail("neither ADMIN_EMAILS nor ADMIN_PASSWORD - nobody can sign in");
else ok(e.ADMIN_EMAILS ? `ADMIN_EMAILS: ${e.ADMIN_EMAILS}` : "ADMIN_PASSWORD set (password sign-in)");
if (e.ADMIN_EMAILS && !e.GOOGLE_CLIENT_ID) fail("ADMIN_EMAILS set but GOOGLE_CLIENT_ID missing - Google sign-in cannot work (AGENTS.md step 4)");
want("ANALYTICS_SALT", "no IP hash is stored, so the bot-burst rule is off");
want("INGEST_KEY", "your server cannot post accounts, events or payments to /api/ingest");
want("CRON_SECRET", "the daily job (ads, replays) refuses to run");
if (config.modules.revenue.enabled && !e.STRIPE_WEBHOOK_SECRET && !e.RAZORPAY_WEBHOOK_SECRET && !e.DODO_WEBHOOK_SECRET && !e.INGEST_KEY) {
  warn("revenue is on but no webhook secret (STRIPE_/RAZORPAY_/DODO_WEBHOOK_SECRET) and no INGEST_KEY - no payment can arrive");
}
if (config.modules.ads.enabled) { need("META_ADS_TOKEN", "ads module is on"); need("META_AD_ACCOUNT", "ads module is on"); }
if (config.modules.replays.enabled) {
  need("MIXPANEL_SA_USER", "replays module is on"); need("MIXPANEL_SA_SECRET", "replays module is on");
  need("MIXPANEL_PROJECT_ID", "replays module is on");
}

head("3. database");
let h = null;
if (e.DATABASE_URL) {
  try {
    const { db } = await import("../server/lib/db.js");
    h = await db();
    await h.query("select 1");
    ok(`connected (${h.kind})`);
    const site = await h.query("select * from sitedata.sites where id = $1", [config.site.id]).catch(() => null);
    if (!site) fail("schema not applied - run `npm run migrate`");
    else if (!site.length) fail(`site "${config.site.id}" not registered - run \`npm run migrate\``);
    else {
      const s = site[0];
      if (s.timezone !== config.site.timezone || s.currency !== config.site.currency) {
        fail("the database's site row differs from site.config.js - run `npm run migrate`");
      } else ok("schema applied, site registered");
      const [c] = await h.query(
        `select (select count(*) from sitedata.visitors where site_id = $1) v,
                (select count(*) from sitedata.visitors where site_id = $1 and verified) vv,
                (select max(created_at) from sitedata.events where site_id = $1) last_event,
                (select count(*) from sitedata.accounts where site_id = $1) a,
                (select count(*) from sitedata.payments where site_id = $1) p`, [config.site.id]);
      ok(`${c.v} visitors (${c.vv} verified), ${c.a} accounts, ${c.p} payments · last event ${c.last_event ? new Date(c.last_event).toISOString() : "never"}`);
      if (Number(c.v) === 0) warn("no visitors yet - install the tracker (AGENTS.md step 6) and open your site");
      /* A proxy that does not forward the visitor's IP makes everyone look
         like one cloud address: all flagged as bots, dashboard at zero. */
      const [top] = await h.query(
        `select count(*) n, count(*) filter (where is_bot) bots,
                (select count(*) from sitedata.visitors where site_id = $1 and first_seen > now() - interval '7 days') total
           from sitedata.visitors where site_id = $1 and first_seen > now() - interval '7 days'
            and ip_hash = (select ip_hash from sitedata.visitors where site_id = $1 and ip_hash is not null
                            and first_seen > now() - interval '7 days' group by 1 order by count(*) desc limit 1)`, [config.site.id]);
      if (Number(top.total) >= 10 && Number(top.n) / Number(top.total) > 0.5) {
        fail(`${top.n} of ${top.total} recent visitors share ONE IP - your proxy is not forwarding the visitor's address. Add the x-client-ip header (AGENTS.md step 6).`);
      } else if (Number(top.total) >= 10) ok("visitor IPs look real (no proxy collapsing them into one)");
    }
  } catch (err) {
    if (err.code === "pglite_locked") {
      /* The running server holds the PGlite folder; opening it here would
         read a stale copy (and could corrupt it). Ask the server instead. */
      h = null;
      if (URL_) ok(`PGlite is open in the running server (pid ${err.pid}) - checking through ${URL_} instead`);
      else warn(`PGlite is open in another process (pid ${err.pid}) - pass --url <dashboard> to check through it`);
    } else fail(`cannot connect: ${err.message}`);
  }
}

/* Signed-in API access, for checking the database through the server. */
let cookie = null;
async function signIn() {
  if (cookie !== null || !URL_) return cookie;
  cookie = "";
  if (!e.ADMIN_PASSWORD) return cookie;
  try {
    const r = await fetch(`${URL_}/api/auth`, { method: "POST", body: JSON.stringify({ password: e.ADMIN_PASSWORD }) });
    if (r.ok) cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  } catch { /* stays "" */ }
  return cookie;
}
async function api(report, params = "") {
  const c = await signIn();
  if (!c) return null;
  const r = await fetch(`${URL_}/api/query?r=${report}${params}`, { headers: { cookie: c } });
  return r.ok ? r.json() : null;
}

if (URL_) {
  head(`4. ${URL_}`);
  const get = async (path, init) => {
    try { return await fetch(URL_ + path, { redirect: "manual", ...init }); } catch (err) { return { status: `unreachable (${err.message})` }; }
  };
  const a = await get("/api/auth");
  if (a.status === 200) {
    const j = await a.json();
    j.configured ? ok("/api/auth answers, sign-in configured") : fail("/api/auth: server says sign-in is not configured (SESSION_SECRET / ADMIN_*)");
    if (j.google_client_id) ok("Google sign-in offered"); else if (!j.password) fail("no sign-in method offered");
  } else fail(`/api/auth -> ${a.status}`);
  const q = await get("/api/query?r=people");
  q.status === 401 ? ok("/api/query refuses without a session (401)") : fail(`/api/query without a session -> ${q.status} (expected 401)`);
  const c = await get("/api/cron");
  c.status === 401 ? ok("/api/cron refuses without the secret (401)") : fail(`/api/cron without a secret -> ${c.status} (expected 401)`);
  const t = await get("/t.js");
  t.status === 200 ? ok("/t.js served") : fail(`/t.js -> ${t.status}`);
  const b = await get("/api/collect", { method: "POST", body: "{}" });
  b.status === 204 ? ok("/api/collect answers 204") : fail(`/api/collect -> ${b.status} (expected 204)`);
  const d = await get("/");
  d.status === 200 ? ok("dashboard page served") : fail(`/ -> ${d.status}`);
  if (!h) {
    const people = await api("people");
    const live = await api("live");
    if (people && live) ok(`signed in with ADMIN_PASSWORD: ${people.length} accounts · ${live.count} on the site now`);
    else if (e.ADMIN_PASSWORD) fail("could not sign in with ADMIN_PASSWORD to read reports");
  }
}

if (SITE_URL) {
  head(`5. ${SITE_URL}`);
  try {
    const html = await (await fetch(SITE_URL)).text();
    const tag = html.match(/<script[^>]+(?:t\.js|ke\.js)[^>]*>/);
    tag ? ok(`tracker tag found: ${tag[0].slice(0, 120)}`) : warn("no tracker tag in the HTML (fine if your site injects it client-side)");
    const endpoint = (tag && tag[0].match(/data-endpoint="([^"]+)"/)?.[1]) || "/ke";
    /* The tag reports data-domain when set (staging, localhost), else the page's host. */
    const host = ((tag && tag[0].match(/data-domain="([^"]+)"/)?.[1]) || new URL(SITE_URL).hostname).toLowerCase().replace(/^www\./, "");
    if (!config.site.domains.includes(host)) {
      fail(`the tag reports "${host}", which is not in site.domains - its beacons are dropped. Add it to site.domains, or set data-domain="${config.site.domains[0]}" on the tag for a staging/local copy.`);
    }
    const vid = "doctor" + crypto.randomBytes(8).toString("hex");
    const r = await fetch(new URL(endpoint, SITE_URL), {
      method: "POST", headers: { "content-type": "text/plain", "user-agent": "Mozilla/5.0 (Macintosh) data-1-1-doctor Chrome/130" },
      body: JSON.stringify({ d: host, v: vid, s: vid, k: "pageview", p: "/__data-1-1-doctor", w: true }),
    });
    r.status === 204 ? ok(`${endpoint} on your site reaches the collector (204)`) : fail(`${endpoint} on your site -> ${r.status} (the proxy rewrite is missing or wrong - AGENTS.md step 6)`);
    if (h) {
      await new Promise((res) => setTimeout(res, 1500));
      const row = await h.query("select is_bot from sitedata.visitors where visitor_id = $1", [vid]);
      row.length ? ok("test beacon landed in the database (flagged as a bot, never counted)")
        : fail("test beacon did not land - check the proxy target URL and site.domains");
      await h.query("delete from sitedata.events where visitor_id = $1", [vid]);
      await h.query("delete from sitedata.visitors where visitor_id = $1", [vid]);
    } else if (URL_) {
      await new Promise((res) => setTimeout(res, 1500));
      const rows = await api("visitor", `&ids=${vid}`);
      if (rows === null) warn("cannot confirm the test beacon landed - set ADMIN_PASSWORD (or check the dashboard) ");
      else rows.length ? ok("test beacon landed (checked through the dashboard; flagged as a bot, never counted)")
        : fail("test beacon did not land - check the proxy target URL and site.domains");
    }
  } catch (err) {
    fail(`cannot reach ${SITE_URL}: ${err.message}`);
  }
}

if (h) await h.end();
console.log(`\n${fails ? `✗ ${fails} to fix` : "✓ all good"}${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""}\n`);
process.exit(fails ? 1 : 0);
