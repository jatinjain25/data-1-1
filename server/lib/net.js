/* ═══════════════════════════════════════════════════════════════════════════
   Who sent this request - read from the network, never stored raw.

   THE RAW IP NEVER REACHES A TABLE. It is read here, hashed with a salt (for
   the bot-burst rule) and tested against cloud ranges (for the data-centre
   rule); only the hash and a boolean leave this file.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { createRequire } from "node:module";
import { header } from "./http.js";

/* ── the client address ────────────────────────────────────────────────────
   WHEN YOUR SITE PROXIES THE BEACON (/ke -> here), the connecting address is
   the PROXY, not the visitor - one cloud IP for everyone. Left alone, that
   flags every visitor as a data-centre bot and trips the burst rule, and the
   dashboard shows zero people. So a proxy forwards the visitor's address in
   CLIENT_IP_HEADER (default "x-client-ip") and it is read FIRST.

   It can be forged by anyone posting to /api/collect directly - which buys
   them nothing they could not already do by sending fake beacons. It only
   steers bot-flagging and hashing, never access.

   (A Vercel-hosted site rewriting to a Vercel-hosted dashboard needs none of
   this: Vercel carries x-vercel-forwarded-for through the rewrite.)

   Then platform headers, set by the edge from the real socket. Then
   x-forwarded-for, only when TRUST_PROXY says how many proxies of yours sit
   in front, read from the RIGHT (the client writes the left end). */
export function clientIp(req, trustProxy = 0, ipHeader = "x-client-ip") {
  for (const h of [ipHeader, "x-vercel-forwarded-for", "cf-connecting-ip", "fly-client-ip", "true-client-ip"]) {
    if (!h) continue;
    const v = header(req, h);
    if (v) return String(v).split(",")[0].trim() || null;
  }
  if (trustProxy > 0) {
    const xff = String(header(req, "x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[Math.max(0, xff.length - trustProxy)] || null;
  }
  const sock = req.socket && req.socket.remoteAddress;
  return sock ? String(sock).replace(/^::ffff:/, "") : null;
}

/* IPv6 is cut to its /64: privacy extensions rotate the low half per
   connection, so a full v6 hash would count one device as many people. */
function normaliseIp(ip) {
  if (!ip) return null;
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + "::/64";
  return ip;
}

/** sha256(salt + ip). No salt, no hash: an unsalted IPv4 hash is reversible
    in minutes, so it is better to store nothing. */
export function ipHash(ip, salt) {
  if (!salt) return null;
  const n = normaliseIp(ip);
  return n ? crypto.createHash("sha256").update(salt + n).digest("hex") : null;
}

/* ── is this a cloud data centre? ─────────────────────────────────────────
   See scripts/build-datacentre-ranges.mjs for why. Loaded once; if the file is
   missing, ingest carries on and simply flags nothing. */
let DC = { v4: [], v6: [] };
try {
  DC = createRequire(import.meta.url)("./datacentre-ranges.json");
} catch (e) {
  console.error("data-1-1: datacentre-ranges.json unreadable - cloud traffic will not be flagged", e.message);
}
const DC_V6 = (DC.v6 || []).map(([len, prefixes]) => [len, new Set(prefixes)]);

function v4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/* Full nibble expansion; must match the builder's or every v6 test misses. */
function v6Nibbles(addr) {
  const a = addr.split("%")[0];
  if (a.indexOf("::") !== a.lastIndexOf("::")) return null;
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (h.length + t.length > 8) return null;
  const groups = [...h, ...(a.includes("::") ? Array(8 - h.length - t.length).fill("0") : []), ...t];
  if (groups.length !== 8) return null;
  let out = "";
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out += g.toLowerCase().padStart(4, "0");
  }
  return out;
}

/** True only when provably inside a published cloud range. "Could not tell"
    is never "bot". */
export function isDatacentre(ip) {
  try {
    if (!ip) return false;
    if (!ip.includes(":")) {
      const n = v4ToInt(ip);
      if (n === null) return false;
      const r = DC.v4;
      let lo = 0, hi = r.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (n < r[mid][0]) hi = mid - 1;
        else if (n > r[mid][1]) lo = mid + 1;
        else return true;
      }
      return false;
    }
    const nib = v6Nibbles(ip);
    if (nib === null) return false;
    for (const [len, set] of DC_V6) if (set.has(nib.slice(0, len))) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── where ─────────────────────────────────────────────────────────────────
   From the edge's own geo headers (Vercel, Cloudflare), never a GeoIP database
   we would have to keep current. On other hosts these are simply null. */
export function geo(req) {
  /* x-client-* first: a proxy that knows the visitor's location (a Cloudflare
     Worker, Netlify Edge) passes it on; the platform's own headers would
     describe the proxy. */
  const country = header(req, "x-client-country") || header(req, "x-vercel-ip-country") || header(req, "cf-ipcountry");
  const region = header(req, "x-client-region") || header(req, "x-vercel-ip-country-region") || header(req, "cf-region-code");
  const cityRaw = header(req, "x-client-city") || header(req, "x-vercel-ip-city") || header(req, "cf-ipcity");
  let city = null;
  if (cityRaw) {
    try { city = decodeURIComponent(String(cityRaw)); } catch { city = String(cityRaw); }
  }
  return {
    country: /^[A-Za-z]{2}$/.test(country || "") && country !== "XX" ? String(country).toUpperCase() : null,
    region: region ? String(region).slice(0, 10) : null,
    city: city ? city.slice(0, 120) : null,
  };
}

/* ── user agent ────────────────────────────────────────────────────────────
   Small on purpose: three breakdowns, the long tail is "(other)". ORDER IS
   THE ALGORITHM - Edge says Chrome, Chrome says Safari, iPad says Mac OS X. */
export function parseUa(ua) {
  const s = String(ua || "");
  if (!s) return { device: null, browser: null, os: null, bot: false };
  const bot = /bot|crawler|spider|crawling|headless|preview|monitor|curl|wget|python-requests|axios|Go-http/i.test(s);

  let browser = "(other)";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/SamsungBrowser/.test(s)) browser = "Samsung Internet";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Chrome\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s)) browser = "Safari";

  let os = "(other)";
  if (/Windows/.test(s)) os = "Windows";
  else if (/Android/.test(s)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Linux/.test(s)) os = "Linux";

  let device = "desktop";
  if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = "tablet";
  else if (/Mobi|iPhone|iPod|Android/.test(s)) device = "mobile";

  return { device, browser, os, bot };
}

/* Only the referrer's HOST is kept - a full URL can carry a search query or a
   token. A visitor moving between your own pages is not a referral. */
export function referrerHost(referrer, selfDomains = []) {
  if (!referrer) return null;
  let host;
  try { host = new URL(String(referrer)).hostname.replace(/^www\./, ""); } catch { return null; }
  if (!host) return null;
  for (const d of selfDomains) if (host === d || host.endsWith("." + d)) return null;
  return host.slice(0, 255);
}
