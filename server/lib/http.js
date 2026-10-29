/* Request/response helpers that work the same on Vercel and on plain node:http. */

const MAX_BODY = 256 * 1024;

/** The raw body as a string. Webhook signatures are computed over these exact
    bytes, so nothing may parse the body before this.

    On Vercel, set NODEJS_HELPERS=0 in the project's environment so the
    platform does not parse it first (AGENTS.md says so). If it already did,
    we get an object back and the signature check will fail loudly. */
export async function readRaw(req) {
  if (typeof req.rawBody === "string") return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** JSON body, whatever the content type (the tracker sends text/plain to
    avoid a CORS preflight). Unparseable is {}. */
export async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    const s = await readRaw(req);
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

export function queryOf(req) {
  if (req.query && typeof req.query === "object") return req.query;
  return Object.fromEntries(new URL(req.url || "/", "http://x").searchParams);
}

export function header(req, name) {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Bounded and printable. The collector is an open write endpoint, so an
    unbounded string is an unbounded row. */
export function clean(v, max = 255) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\x00-\x1f\x7f]/g, "").trim();
  return s ? s.slice(0, max) : null;
}

/** Visitor and session ids come from the browser, so their shape is enforced:
    without it one loop could mint a million rows. */
export function cleanId(v) {
  const s = String(v || "");
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

/** Account ids are YOUR app's user ids: uuids, "user_2abc" (Clerk),
    Firebase uids, "google-oauth2|123" (Auth0), plain integers. */
export function cleanAccountId(v) {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9_.:@|+-]{1,128}$/.test(s) ? s : null;
}

export function cleanEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(s) ? s : null;
}
