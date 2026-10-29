/* /api/auth
     GET     -> { configured, google_client_id, password, signed_in, email }  (public: what the sign-in page needs)
     POST    { credential }  (a Google ID token from Google Identity Services)
             { password }    (only if ADMIN_PASSWORD is set)
     DELETE  -> signs out */

import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./lib/config.js";
import { readJson, sendJson } from "./lib/http.js";
import {
  PASSWORD_USER, cookieOf, deny, readSession, requireAdmin, sessionCookie, signSession,
} from "./lib/gate.js";

const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Verify a Google ID token: Google's signature, our client id, a verified email. */
export async function verifyGoogle(credential, clientId, keys = GOOGLE_KEYS) {
  const { payload } = await jwtVerify(String(credential || ""), keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
  if (!payload.email || payload.email_verified !== true) throw new Error("email not verified");
  return String(payload.email).toLowerCase();
}

function samePassword(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  const e = env();

  if (req.method === "GET") {
    const email = readSession(cookieOf(req), e.sessionSecret);
    const gate = requireAdmin(req, e);
    return sendJson(res, 200, {
      configured: !!e.sessionSecret && (e.adminEmails.length > 0 || !!e.adminPassword),
      google_client_id: e.googleClientId || null,
      password: !!e.adminPassword,
      signed_in: gate.ok,
      email: email || null,
      code: gate.ok ? null : gate.code,
    });
  }

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "GET, POST or DELETE" });
  if (!e.sessionSecret) return deny(res, { code: "not_configured" }, req, "auth");

  const body = await readJson(req);
  let email = null;

  if (body.credential) {
    if (!e.googleClientId) return deny(res, { code: "not_configured" }, req, "auth");
    try {
      email = await verifyGoogle(body.credential, e.googleClientId);
    } catch (err) {
      console.warn("[data-1-1] google token rejected:", err.message);
      return deny(res, { code: "unverified" }, req, "auth");
    }
    if (!e.adminEmails.includes(email)) return deny(res, { code: "not_allowlisted", email }, req, "auth");
  } else if (body.password !== undefined) {
    if (!e.adminPassword || !samePassword(body.password, e.adminPassword)) {
      return deny(res, { code: "unverified" }, req, "auth");
    }
    email = PASSWORD_USER;
  } else {
    return sendJson(res, 400, { error: "send { credential } or { password }" });
  }

  res.setHeader("Set-Cookie", sessionCookie(req, signSession(email, e.sessionSecret)));
  return sendJson(res, 200, { ok: true, email });
}
