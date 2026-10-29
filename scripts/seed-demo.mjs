/* npm run seed-demo [-- --clear]

   60 days of believable fake traffic so you can see every panel before your
   own data arrives: ~2,000 visitors across channels and ads, reading time,
   accounts, product actions, payments, Meta ad spend and survey answers.

   Every demo id starts with "demo" and --clear removes exactly those rows.
   Refuses to run against anything but a local PGlite database unless you
   pass --force, so it can never pollute production by accident. */

import "./env.mjs";
import { config } from "../server/lib/config.js";

process.env.DATABASE_URL ||= "pglite://./.data";
const url = process.env.DATABASE_URL;
const args = new Set(process.argv.slice(2));
if (!url.startsWith("pglite://") && !args.has("--force")) {
  console.error("✗ seed-demo only writes to a local pglite:// database. Pass --force to write to DATABASE_URL anyway.");
  process.exit(1);
}

const { db } = await import("../server/lib/db.js");
const { migrate } = await import("./migrate.mjs");
const h = await db();
await migrate(h);
const SITE = config.site.id;

async function clear() {
  await h.exec(`
    delete from sitedata.events where visitor_id like 'demo%';
    delete from sitedata.active_time where visitor_id like 'demo%';
    delete from sitedata.answers where visitor_id like 'demo%';
    delete from sitedata.replays where replay_id like 'demo%';
    delete from sitedata.visitors where visitor_id like 'demo%';
    delete from sitedata.account_events where account_id like 'demo%';
    delete from sitedata.payments where external_id like 'demo%';
    delete from sitedata.accounts where account_id like 'demo%';
    delete from sitedata.ad_spend where ad_id like 'demo%';`);
}
await clear();
if (args.has("--clear")) {
  console.log("✓ demo rows removed");
  process.exit(0);
}

/* A seeded RNG, so every run draws the same believable shape. */
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const weighted = (pairs) => {
  const t = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * t;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};

const ADS = [
  { id: "demo_ad_1", name: "Launch video - 18-24", campaign: "Launch", utm_campaign: "launch", utm_content: "video_1", cpc: 0.35 },
  { id: "demo_ad_2", name: "Carousel - features", campaign: "Launch", utm_campaign: "launch", utm_content: "carousel", cpc: 0.28 },
  { id: "demo_ad_3", name: "Testimonial reel", campaign: "Retarget", utm_campaign: "retarget", utm_content: "testimonial", cpc: 0.52 },
];
const SOURCES = [
  [{ ch: "direct" }, 26],
  [{ ref: "https://www.google.com/" }, 24],
  [{ ref: "https://l.instagram.com/", us: "instagram" }, 8],
  [{ ref: "https://news.ycombinator.com/" }, 5],
  [{ ref: "https://www.reddit.com/r/startups/" }, 4],
  [{ ref: "https://someblog.dev/best-tools" }, 4],
  [{ ad: ADS[0] }, 14],
  [{ ad: ADS[1] }, 10],
  [{ ad: ADS[2] }, 5],
];
const PAGES = ["/", "/pricing", "/features", "/blog/getting-started", "/docs", "/about", "/signup"];
const CITIES = [["Bengaluru", "IN"], ["Mumbai", "IN"], ["Delhi", "IN"], ["London", "GB"], ["New York", "US"],
                ["Berlin", "DE"], ["Toronto", "CA"], ["Singapore", "SG"], ["San Francisco", "US"], ["Sydney", "AU"]];
const DEVICES = [["mobile", "iOS", "Safari"], ["mobile", "Android", "Chrome"], ["desktop", "macOS", "Chrome"],
                 ["desktop", "Windows", "Edge"], ["desktop", "macOS", "Safari"], ["tablet", "iOS", "Safari"]];
const actions = config.actions.map((a) => a.event);
const questions = config.modules.survey.questions;

const now = Date.now();
const DAY = 86400e3;
const tz = config.site.timezone;
const dayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

const visitors = [], sessions = [], events = [], times = [], accounts = [], accEvents = [], payments = [], answers = [];
let vn = 0;

for (let d = 59; d >= 0; d--) {
  const daily = Math.round(12 + (59 - d) * 0.55 + rnd() * 10);
  for (let i = 0; i < daily; i++) {
    const vid = `demo${String(++vn).padStart(6, "0")}xxxx`;
    const src = weighted(SOURCES);
    const [city, country] = pick(CITIES);
    const [device, os, browser] = pick(DEVICES);
    const t0 = now - d * DAY - Math.floor(rnd() * (d === 0 ? Math.min(DAY, (now % DAY) || DAY) : DAY));
    const ad = src.ad;
    const channel = ad ? "paid"
      : !src.ref ? "direct"
      : /google/.test(src.ref) ? "organic_search"
      : /instagram|ycombinator|reddit/.test(src.ref) ? "organic_social"
      : "referral";
    const refHost = src.ref ? new URL(src.ref).hostname.replace(/^www\./, "") : ad ? "facebook.com" : null;
    const landing = ad ? "/" : pick(PAGES.slice(0, 5));
    const bounce = rnd() < 0.35;
    const verified = !bounce || rnd() < 0.5;
    const pages = bounce ? 1 : 1 + Math.floor(rnd() * 5);
    visitors.push([vid, SITE, t0, channel, refHost, src.us || (ad ? "facebook" : null), ad ? "paid_social" : null,
                   ad ? ad.utm_campaign : null, ad ? ad.utm_content : null, landing, ad ? "fbclid" : null,
                   country, city, device, browser, os, verified, pages]);
    const sid = `demo_s_${vn}`;
    let t = t0, path = landing;
    for (let p = 0; p < pages; p++) {
      events.push([SITE, vid, sid, "pageview", null, path, t, channel, p === 0 ? refHost : null]);
      t += 20e3 + rnd() * 120e3;
      path = pick(PAGES);
    }
    sessions.push([sid, vid, SITE, t0, t, landing, path, pages, channel, refHost, country, city, device]);
    if (verified && !bounce) times.push([SITE, vid, dayOf(t0), Math.round(30 + rnd() * 600), t]);
    if (rnd() < 0.08) events.push([SITE, vid, sid, "exit", null, path, t, channel, null, "github.com"]);

    /* ~9% sign up; paid ads convert a bit better. */
    if (verified && !bounce && rnd() < (ad ? 0.13 : 0.08)) {
      const acct = `demo_user_${vn}`;
      const nm = pick(["Asha", "Ben", "Chen", "Diya", "Emil", "Fatima", "Gabe", "Hana", "Ivan", "Jia", "Kofi", "Lena"]);
      accounts.push([SITE, acct, `${nm.toLowerCase()}${vn}@example.com`, `${nm} ${String.fromCharCode(65 + (vn % 26))}.`, t + 60e3]);
      visitors[visitors.length - 1].push(acct);
      for (const a of actions) {
        const n = Math.floor(rnd() * 6);
        for (let k = 0; k < n; k++) accEvents.push([SITE, acct, a, t + (k + 1) * 3600e3 * rnd()]);
      }
      if (rnd() < 0.3) {
        payments.push([SITE, "stripe", `demo_pay_${vn}`, acct, vid, pick([1900, 4900, 4900, 9900]), config.site.currency, pick(["pro", "pro", "team"]), t + 3 * 3600e3]);
      }
    }
    const shown = questions.length && verified && rnd() < 0.6;
    if (shown) events.push([SITE, vid, sid, "custom", config.modules.survey.shownEvent, landing, t0 + 4000, channel, null]);
    if (shown && rnd() < 0.65) {
      const data = {};
      for (const q of questions) {
        const keys = Object.keys(q.options || {});
        if (!keys.length) continue;
        if (q.type === "multi") data[q.id] = [...new Set([pick(keys), ...(rnd() < 0.4 ? [pick(keys)] : [])])];
        else data[q.id] = pick(keys);
        if (q.other && (data[q.id] === "other" || (Array.isArray(data[q.id]) && data[q.id].includes("other")))) data[`${q.id}_other`] = pick(["A friend", "Newsletter", "Podcast"]);
      }
      answers.push([SITE, vid, JSON.stringify(data), rnd() < 0.15 ? 2 : null, landing, t0 + 8000]);
    }
  }
}

const iso = (ms) => new Date(ms).toISOString();
async function insertMany(sql, rows, map) {
  for (const r of rows) await h.query(sql, map(r));
}

await insertMany(
  `insert into sitedata.visitors (visitor_id, site_id, first_seen, last_seen, first_channel, first_referrer_host,
     first_utm_source, first_utm_medium, first_utm_campaign, first_utm_content, first_landing_path, first_click_source,
     country, city, device, browser, os, verified, pageview_count, session_count, account_id)
   values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,$19)`,
  visitors, (v) => [v[0], v[1], iso(v[2]), v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14], v[15], v[16], v[17], v[18] || null]);
await insertMany(
  `insert into sitedata.sessions (session_id, visitor_id, site_id, started_at, last_event_at, entry_path, exit_path,
     pageview_count, event_count, channel, referrer_host, country, city, device)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13)`,
  sessions, (s) => [s[0], s[1], s[2], iso(s[3]), iso(s[4]), s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12]]);
await insertMany(
  `insert into sitedata.events (site_id, visitor_id, session_id, kind, name, path, created_at, channel, referrer_host)
   values ($1,$2,$3,$4,coalesce($10,$5),$6,$7,$8,$9)`,
  events, (e) => [e[0], e[1], e[2], e[3], e[4], e[5], iso(e[6]), e[7], e[8], e[9] || null]);
await insertMany(
  `insert into sitedata.active_time (site_id, visitor_id, day, source, seconds, pings, last_ping_at)
   values ($1,$2,$3,'tag',$4,1,$5) on conflict do nothing`,
  times, (t) => [t[0], t[1], t[2], t[3], iso(t[4])]);
await h.query(`update sitedata.active_time t set account_id = v.account_id from sitedata.visitors v
               where v.visitor_id = t.visitor_id and t.visitor_id like 'demo%'`);
await insertMany(
  `insert into sitedata.accounts (site_id, account_id, email, name, signed_up_at, source) values ($1,$2,$3,$4,$5,'server')`,
  accounts, (a) => [a[0], a[1], a[2], a[3], iso(a[4])]);
await insertMany(
  `insert into sitedata.account_events (site_id, account_id, name, at) values ($1,$2,$3,$4)`,
  accEvents.filter((e) => e[3] < now), (e) => [e[0], e[1], e[2], iso(e[3])]);
await insertMany(
  `insert into sitedata.payments (site_id, provider, external_id, account_id, visitor_id, amount_minor, currency, plan, paid_at)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  payments.filter((p) => p[8] < now), (p) => [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], iso(p[8])]);
await insertMany(
  `insert into sitedata.answers (site_id, visitor_id, survey, data, skipped_at, path, created_at, updated_at)
   values ($1,$2,'survey',$3::jsonb,$4,$5,$6,$6)`,
  answers, (a) => [a[0], a[1], a[2], a[3], a[4], iso(a[5])]);
for (let d = 59; d >= 0; d--) {
  for (const ad of ADS) {
    const clicks = Math.round(20 + rnd() * 40 + (59 - d) * 0.6);
    await h.query(
      `insert into sitedata.ad_spend (site_id, day, ad_id, ad_name, campaign_name, utm_campaign, utm_content, spend, currency,
         impressions, link_clicks, landing_views, platform_signups, platform_purchases)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [SITE, dayOf(now - d * DAY), ad.id, ad.name, ad.campaign, ad.utm_campaign, ad.utm_content,
       (clicks * ad.cpc).toFixed(2), config.site.currency, Math.round(clicks * (40 + rnd() * 20)), clicks,
       Math.round(clicks * 0.8), Math.round(rnd() * 3), Math.round(rnd() * 1.4)],
    );
  }
}
/* A couple of people "on the site now". */
await h.query(`update sitedata.sessions set last_event_at = now() - interval '2 minutes'
                where session_id in (select session_id from sitedata.sessions where visitor_id like 'demo%'
                                      order by started_at desc limit 3)`);

console.log(`✓ demo data: ${visitors.length} visitors, ${accounts.length} accounts, ${payments.length} payments, ${answers.length} survey answers`);
console.log("  remove it with: npm run seed-demo -- --clear");
await h.end();
