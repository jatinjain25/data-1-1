/* The dashboard gate. Asserts BOTH directions, and the first matters more:
   every branch still DENIES. A refactor that makes the reasons nicer and the
   gate weaker is the failure to fear. */

import test from "node:test";
import assert from "node:assert/strict";
import { readSession, requireAdmin, signSession, PASSWORD_USER } from "../server/lib/gate.js";

const SECRET = "s".repeat(64);
const env = (over = {}) => ({ sessionSecret: SECRET, adminEmails: ["owner@example.com"], adminPassword: "", ...over });
const withCookie = (v) => ({ headers: { cookie: `other=1; sd_session=${encodeURIComponent(v)}` } });

test("no secret, or no way to sign in at all, admits nobody", () => {
  const good = withCookie(signSession("owner@example.com", SECRET));
  assert.equal(requireAdmin(good, env({ sessionSecret: "" })).code, "not_configured");
  assert.equal(requireAdmin(good, env({ adminEmails: [], adminPassword: "" })).code, "not_configured");
});

test("no cookie is 'not signed in', never 'not allowlisted'", () => {
  assert.equal(requireAdmin({ headers: {} }, env()).code, "no_session");
});

test("a forged, tampered or expired cookie is refused", () => {
  const good = signSession("owner@example.com", SECRET);
  assert.equal(requireAdmin(withCookie(signSession("owner@example.com", "other-secret")), env()).code, "unverified");
  const [body, sig] = good.split(".");
  const evil = Buffer.from(JSON.stringify({ e: "owner@example.com", x: 9999999999 })).toString("base64url");
  assert.equal(requireAdmin(withCookie(`${evil}.${sig}`), env()).code, "unverified");
  assert.equal(requireAdmin(withCookie(`${body}.`), env()).code, "unverified");
  const old = signSession("owner@example.com", SECRET, Date.now() - 31 * 86400e3);
  assert.equal(requireAdmin(withCookie(old), env()).code, "unverified");
});

test("a valid cookie for an email no longer on the list is refused - removal revokes", () => {
  const g = requireAdmin(withCookie(signSession("ex@example.com", SECRET)), env());
  assert.equal(g.ok, false);
  assert.equal(g.code, "not_allowlisted");
  assert.equal(g.email, "ex@example.com");
});

test("the password session only works while ADMIN_PASSWORD is set", () => {
  const c = withCookie(signSession(PASSWORD_USER, SECRET));
  assert.equal(requireAdmin(c, env({ adminPassword: "pw" })).ok, true);
  assert.equal(requireAdmin(c, env({ adminPassword: "" })).code, "not_allowlisted");
});

test("the right person with a valid cookie gets in", () => {
  const g = requireAdmin(withCookie(signSession("Owner@Example.com", SECRET)), env());
  assert.deepEqual(g, { ok: true, email: "owner@example.com" });
  assert.equal(readSession(signSession("a@b.c", SECRET), SECRET), "a@b.c");
});
