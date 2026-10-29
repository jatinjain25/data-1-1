/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/collect - the ingest endpoint, and the ONLY unauthenticated route.

   Your site should reach it as a SAME-ORIGIN path (e.g. /ke on your domain,
   rewritten here - AGENTS.md step 6). A beacon to a third-party analytics
   host is on every blocklist; a same-origin path is the difference between
   measuring your traffic and measuring the half that does not block.

   IT ALWAYS ANSWERS 204, EVEN WHEN IT FAILS. sendBeacon cannot read the
   answer and never retries, and a collector that answers 400/500 is a free
   map of the stack behind it. Failures go to the log. Only a wrong METHOD
   gets 405 - that is a wiring mistake worth seeing.

   IT NEVER RETURNS DATA. Anything it could be made to say would be public.
   ═══════════════════════════════════════════════════════════════════════════ */

import { config, env, origins } from "./lib/config.js";
import { call } from "./lib/db.js";
import { clean, cleanAccountId, cleanEmail, cleanId, header, readJson } from "./lib/http.js";
import { clientIp, geo, ipHash, isDatacentre, parseUa, referrerHost } from "./lib/net.js";
import { cleanAnswers } from "./modules/survey.js";

const KINDS = new Set(["pageview", "custom", "exit", "identify", "engage", "ping", "answer"]);

/* Only the NAME of an ad click id is kept (which platform), never its value. */
const CLICK_SOURCES = new Set(["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "twclid", "li_fat_id", "msclkid"]);

/* The most one ping may claim. The SQL caps again against wall-clock time. */
export const MAX_PING_SECONDS = 60;

function siteFor(domain, cfg) {
  const d = String(domain || "").toLowerCase().trim().replace(/^www\./, "");
  return cfg.site.domains.includes(d) ? { id: cfg.site.id, domains: cfg.site.domains } : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   build() - every decision this endpoint makes, as a PURE function so the
   tests can hold it with no network or database. Returns [fn, args] for the
   SQL function to call, or null to drop the beacon.
   ═══════════════════════════════════════════════════════════════════════════ */
export function build(req, body, { cfg = config, e = env() } = {}) {
  const site = siteFor(body.d, cfg);
  if (!site) return null;

  const ua = parseUa(header(req, "user-agent"));
  if (ua.bot) return null;

  const visitor = cleanId(body.v);
  const session = cleanId(body.s);
  if (!visitor || !session) return null;

  const kind = KINDS.has(body.k) ? body.k : "pageview";
  const ip = clientIp(req, e.trustProxy, e.clientIpHeader);
  /* Automation announces itself (navigator.webdriver); a data-centre address
     is a crawler that renders. Neither is deleted - flagged as a bot - but
     neither earns reading time, a survey answer or an account link. */
  const automated = body.w === true || isDatacentre(ip);

  if (kind === "engage") return ["verify", { p_site: site.id, p_visitor: visitor }];

  if (kind === "ping") {
    if (automated) return null;
    const secs = Math.floor(Number(body.n));
    if (!Number.isFinite(secs) || secs < 1) return null;
    return ["add_time", { p_site: site.id, p_visitor: visitor, p_seconds: Math.min(secs, MAX_PING_SECONDS) }];
  }

  if (kind === "identify") {
    if (automated) return null;
    const account = cleanAccountId(body.n);
    if (!account) return null;
    const m = body.m && typeof body.m === "object" ? body.m : {};
    const signed = m.signed_up_at ? new Date(m.signed_up_at) : null;
    return ["identify", {
      p_site: site.id, p_visitor: visitor, p_account: account,
      p_email: cleanEmail(m.email), p_name: clean(m.name, 120),
      p_signed_up_at: signed && !isNaN(signed) && signed <= new Date() ? signed.toISOString() : null,
    }];
  }

  if (kind === "answer") {
    const sv = cfg.modules.survey;
    if (!sv.enabled || automated) return null;
    const m = body.m && typeof body.m === "object" ? body.m : {};
    const data = cleanAnswers(m.answers, sv.questions);
    if (!data) return null;
    const skipped = Number(m.skipped);
    return ["save_answers", {
      p_site: site.id, p_visitor: visitor, p_survey: "survey", p_data: data,
      p_skipped_at: Number.isInteger(skipped) && skipped >= 1 && skipped <= 20 ? skipped : null,
      p_account: m.account === true, p_path: cleanPath(body.p),
    }];
  }

  /* custom carries an event name, exit the target host. Nameless is dropped. */
  const named = kind === "custom" || kind === "exit";
  const name = named ? clean(body.n, 160) : null;
  if (named && !name) return null;

  const referrer = clean(body.r, 1024);
  const g = geo(req);
  return ["ingest", {
    p_site: site.id,
    p_visitor: visitor,
    p_session: session,
    p_kind: kind,
    p_name: name,
    p_path: cleanPath(body.p),
    p_referrer: referrer,
    /* Your own pages (and the host actually serving them - staging, previews)
       are never a referral. */
    p_referrer_host: referrerHost(referrer, [...site.domains, String(body.h || "").toLowerCase().replace(/^www\./, "")].filter(Boolean)),
    p_utm_source: clean(body.us, 120),
    p_utm_medium: clean(body.um, 120),
    p_utm_campaign: clean(body.uc, 120),
    p_utm_content: clean(body.uo, 120),
    p_utm_term: clean(body.ut, 120),
    p_country: g.country,
    p_region: g.region,
    p_city: g.city,
    p_device: ua.device,
    p_browser: ua.browser,
    p_os: ua.os,
    p_ip_hash: ipHash(ip, e.salt),
    p_meta: body.m && typeof body.m === "object" && !Array.isArray(body.m) ? trimMeta(body.m) : null,
    p_hostname: clean(body.h, 120),
    p_click_source: CLICK_SOURCES.has(body.cs) ? body.cs : null,
    p_bot: automated,
  }];
}

/* The path is stored, the query string is NOT - it can carry a reset token or
   an email address from a shared link. */
function cleanPath(p) {
  let path = clean(p, 512) || "/";
  path = path.split("?")[0].split("#")[0];
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  return path;
}

/* Event properties: at most 20 keys, short scalar values. */
function trimMeta(m) {
  const out = {};
  for (const [k, v] of Object.entries(m).slice(0, 20)) {
    const key = String(k).slice(0, 40);
    if (v === null || typeof v === "boolean" || typeof v === "number") out[key] = v;
    else out[key] = String(v).slice(0, 200);
  }
  return out;
}

export default async function handler(req, res) {
  const origin = header(req, "origin");
  if (origin && origins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, OPTIONS");
    return res.end();
  }

  try {
    const plan = build(req, await readJson(req));
    if (plan) await call(plan[0], plan[1]);
  } catch (err) {
    console.error("collect:", err && err.message);
  }
  res.statusCode = 204;
  return res.end();
}
