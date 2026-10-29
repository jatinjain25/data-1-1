/* Formatting and date maths, driven by site.config.js. Pure - the tests import it. */

import raw from "../../site.config.js";

const SITE = raw.site || {};
export const TZ = SITE.timezone || "UTC";
export const LOCALE = SITE.locale || "en-US";
export const CURRENCY = (SITE.currency || "USD").toUpperCase();

/* ── time zones without a library ─────────────────────────────────────── */

function parts(date, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/** How far `tz` is ahead of UTC at that instant, in ms. */
export function tzOffsetMs(tz, date) {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant midnight fell in `tz`, `daysAgo` days before today (in tz). DST-safe. */
export function zonedMidnight(daysAgo = 0, tz = TZ, now = Date.now()) {
  const p = parts(new Date(now), tz);
  const guess = Date.UTC(p.y, p.m - 1, p.d - daysAgo);
  let t = guess - tzOffsetMs(tz, new Date(guess));
  const again = guess - tzOffsetMs(tz, new Date(t));
  if (again !== t) t = again;
  return new Date(t);
}

/* `to` is now unless a preset says otherwise - a dashboard that stops at
   midnight looks broken at 3pm. "Yesterday" is the one closed day. */
export const RANGES = [
  { key: "today", label: "Today", from: () => zonedMidnight(0) },
  { key: "yesterday", label: "Yesterday", from: () => zonedMidnight(1), to: () => zonedMidnight(0) },
  { key: "7d", label: "7 days", from: () => zonedMidnight(6) },
  { key: "30d", label: "30 days", from: () => zonedMidnight(29) },
  { key: "90d", label: "90 days", from: () => zonedMidnight(89) },
  { key: "all", label: "All time", from: () => {
    const [y, m, d] = String(SITE.startDate || "2026-01-01").split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d);
    return new Date(guess - tzOffsetMs(TZ, new Date(guess)));
  } },
];

/* ── numbers and money ──────────────────────────────────────────────────── */

export const dash = "–";
export const num = (n) => Number(n || 0).toLocaleString(LOCALE);

const fmtCache = new Map();
function moneyFmt(digits) {
  const k = `${CURRENCY}:${digits}`;
  if (!fmtCache.has(k)) {
    fmtCache.set(k, new Intl.NumberFormat(LOCALE, {
      style: "currency", currency: CURRENCY, minimumFractionDigits: digits, maximumFractionDigits: digits,
    }));
  }
  return fmtCache.get(k);
}
/** How many minor units in one major unit (100 for USD/INR, 1 for JPY). */
export const MINOR = 10 ** new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY }).resolvedOptions().maximumFractionDigits;

/** Minor units (cents, paise) -> "$1,234". Totals never show cents. */
export const money = (minor) => moneyFmt(0).format(Math.round(Number(minor || 0) / MINOR));
/** Major units (ad spend) -> "$1,234". */
export const moneyMajor = (amount) => moneyFmt(0).format(Math.round(Number(amount || 0)));
export const money2 = (amount) => (amount == null ? dash : moneyFmt(2).format(Number(amount)));
export const money0 = (amount) => (amount == null ? dash : moneyMajor(amount));

/** Seconds -> "1h 12m" / "4m 05s" / "35s"; zero -> dash. */
export function duration(s) {
  const n = Math.round(Number(s || 0));
  if (!n) return dash;
  if (n < 60) return `${n}s`;
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = n % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** Period-over-period change in %, or null when there is no honest base. */
export function delta(cur, prev) {
  if (cur == null || prev == null) return null;
  const c = Number(cur), p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return dash;
  const s = Math.max(0, (now - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
const dtFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: TZ });

/** "2026-10-26" (a calendar day computed by SQL in the site's zone) -> "26 Oct". */
export const dayLabel = (d) => dayFmt.format(new Date(`${String(d).slice(0, 10)}T12:00:00Z`));
export const dateTime = (ts) => (ts ? dtFmt.format(new Date(ts)) : dash);

const CHANNELS = {
  paid: "Paid ads", direct: "Direct", organic_search: "Search", organic_social: "Social",
  referral: "Referral", email: "Email", campaign: "Campaign", "(not tracked)": "Not tracked", "(none)": "Unknown",
};
export const channelLabel = (c) => CHANNELS[c] || c || "Unknown";

/** Ads Manager's link metrics from SUMMED spend / impressions / clicks - an
    average of daily rates is a different (wrong) number. */
export function adRates(spend, impressions, clicks) {
  const s = Number(spend || 0), i = Number(impressions || 0), c = Number(clicks || 0);
  return { ctr: i ? (c / i) * 100 : null, cpc: c ? s / c : null, cpm: i ? (s / i) * 1000 : null };
}
export const pct2 = (n) => (n == null ? dash : `${Number(n).toFixed(2)}%`);

export const shortId = (id) => {
  const s = String(id || "");
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-5)}` : s;
};
