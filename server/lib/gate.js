/* ═══════════════════════════════════════════════════════════════════════════
   The dashboard gate. Every report runs requireAdmin() before it even reads
   the report name, so an unknown report and an unauthorised caller look the
   same from outside.

   SIGN-IN: Google Identity Services gives the browser a Google-signed ID
   token; /api/auth verifies it against Google's keys, checks the email is in
   ADMIN_EMAILS, and sets a session cookie signed with SESSION_SECRET (httpOnly,
   30 days). Optional ADMIN_PASSWORD for setups without a Google client.

   THE ALLOWLIST IS RE-CHECKED ON EVERY REQUEST, not just at sign-in, so
   removing an email from ADMIN_EMAILS locks that person out on the next
   deploy even if their cookie has 29 days left.

   NO DEFAULT ALLOWLIST. Unset means nobody gets in - the right direction to
   fail for a page that shows every visitor, email and payment.

   IT RETURNS A REASON, NOT A BOOLEAN. "Not signed in", "session expired",
   "not on the list" and "the server is misconfigured" are four different
   fixes; collapsing them into one 403 sends you to fix the wrong thing.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { env } from "./config.js";
import { sendJson, header } from "./http.js";
import { clientIp } from "./net.js";
import { call } from "./db.js";

export const COOKIE = "sd_session";
const MAX_AGE = 30 * 86400;

const DENIALS = {
  not_configured:  { status: 503, error: "the server has no SESSION_SECRET or no ADMIN_EMAILS / ADMIN_PASSWORD" },
  no_session:      { status: 401, error: "not signed in" },
  unverified:      { status: 401, error: "session invalid or expired - sign in again" },
  not_allowlisted: { status: 403, error: "this account is not in ADMIN_EMAILS" },
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();

export function signSession(email, secret, now = Date.now()) {
  const body = b64u(JSON.stringify({ e: email, x: Math.floor(now / 1000) + MAX_AGE }));
  return `${body}.${b64u(hmac(secret, body))}`;
}

/** The email in a valid, unexpired cookie value - or null. Constant-time compare. */
export function readSession(value, secret, now = Date.now()) {
  if (!value || !secret) return null;
  const [body, sig] = String(value).split(".");
  if (!body || !sig) return null;
  const want = hmac(secret, body);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p.e || !p.x || p.x * 1000 < now) return null;
    return String(p.e).toLowerCase();
  } catch {
    return null;
  }
}

export function cookieOf(req, name = COOKIE) {
  const raw = String(header(req, "cookie") || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** "Secure" except on plain-http localhost, where browsers would drop it. */
export function sessionCookie(req, value, maxAge = MAX_AGE) {
  const host = String(header(req, "host") || "");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${local ? "" : "; Secure"}`;
}

/** The password "account" is named this in the allowlist check. */
export const PASSWORD_USER = "password";

export function requireAdmin(req, e = env()) {
  if (!e.sessionSecret || (!e.adminEmails.length && !e.adminPassword)) return { ok: false, code: "not_configured" };
  const value = cookieOf(req);
  if (!value) return { ok: false, code: "no_session" };
  const email = readSession(value, e.sessionSecret);
  if (!email) return { ok: false, code: "unverified" };
  if (email === PASSWORD_USER ? !e.adminPassword : !e.adminEmails.includes(email)) {
    return { ok: false, code: "not_allowlisted", email };
  }
  return { ok: true, email };
}

export function sendDenied(res, gate) {
  const code = (gate && gate.code) || "not_allowlisted";
  const d = DENIALS[code] || DENIALS.not_allowlisted;
  const body = { error: d.error, code };
  if (gate && gate.email) body.email = gate.email;
  return sendJson(res, d.status, body);
}

/* FAILURES ARE COUNTED, successes are not: a real admin never fails the gate,
   so a failure budget cannot lock them out; a guesser spends it at once.
   Fails OPEN on a database error - the gate above is the boundary, this only
   prices repetition. */
export async function deny(res, gate, req, where) {
  /* NOT the forwarded client-ip header: anyone can set it, and a guesser
     would rotate it to dodge the limit. Platform/socket address only. */
  const ip = clientIp(req, env().trustProxy, null) || "unknown";
  console.warn(`[data-1-1] denied ${where} (${gate.code}) from ${ip}`);
  try {
    const rows = await call("rate_limit_hit", { p_bucket: `gate:${ip}`.slice(0, 200), p_window_seconds: 3600, p_max: 30 });
    const ok = rows && rows[0] ? Object.values(rows[0])[0] : true;
    if (ok === false) {
      res.setHeader("Retry-After", "3600");
      return sendJson(res, 429, { error: "Too many attempts. Try again in an hour.", code: "rate_limited" });
    }
  } catch { /* fail open */ }
  return sendDenied(res, gate);
}
