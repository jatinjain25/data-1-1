/* ═══════════════════════════════════════════════════════════════════════════
   node server.js - the whole app on any Node host (Railway, Render, Fly, a
   VPS, Docker). Serves the built dashboard from dist/, the API under /api/*,
   the tracker at /t.js, and runs the daily cron in-process.

   On Vercel you do not need this file: api/*.js are the functions and
   vercel.json carries the cron.

   PORT (default 8787). Set DISABLE_INTERNAL_CRON=1 if your platform calls
   /api/cron itself.
   ═══════════════════════════════════════════════════════════════════════════ */

import "./scripts/env.mjs";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import auth from "./server/auth.js";
import collect from "./server/collect.js";
import cron, { runDaily } from "./server/cron.js";
import ingest from "./server/ingest.js";
import query from "./server/query.js";
import webhook from "./server/webhook.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");

const ROUTES = { "/api/collect": collect, "/api/query": query, "/api/auth": auth,
                 "/api/ingest": ingest, "/api/webhook": webhook, "/api/cron": cron };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".ico": "image/x-icon", ".woff2": "font/woff2" };

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};

async function file(res, path, cache) {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    res.setHeader("Content-Type", TYPES[extname(path)] || "application/octet-stream");
    res.setHeader("Cache-Control", cache);
    res.end(await readFile(path));
    return true;
  } catch {
    return false;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    const url = new URL(req.url, "http://x");
    const route = ROUTES[url.pathname];
    try {
      if (route) return await route(req, res);
      if (url.pathname === "/t.js") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (await file(res, join(DIST, "t.js"), "public, max-age=3600")) return;
        if (await file(res, join(PUBLIC, "t.js"), "public, max-age=3600")) return;
      }
      if (url.pathname === "/healthz") { res.setHeader("Content-Type", "text/plain"); return res.end("ok"); }
      const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      if (safe !== "/" && (await file(res, join(DIST, safe), safe.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"))) return;
      if (await file(res, join(DIST, "index.html"), "no-cache")) return;
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain");
      res.end("Dashboard not built yet - run `npm run build`.");
    } catch (e) {
      console.error("server:", e);
      if (!res.headersSent) { res.statusCode = 500; res.end("error"); }
    }
  });
}

/* Daily at 02:30 UTC unless the platform runs /api/cron itself. */
function scheduleCron() {
  if (process.env.DISABLE_INTERNAL_CRON === "1") return;
  const next = () => {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30));
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    return t - now;
  };
  const loop = () => setTimeout(async () => {
    console.log("cron:", JSON.stringify(await runDaily()));
    loop();
  }, next()).unref();
  loop();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  /* Open the database before taking traffic: a bad DATABASE_URL fails here,
     loudly, and a local PGlite folder is locked to this process from the start. */
  try {
    await (await import("./server/lib/db.js")).db();
  } catch (e) {
    console.error(`Data 1-1: cannot open the database - ${e.message}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8787;
  createServer().listen(port, () => console.log(`Data 1-1 on http://localhost:${port}`));
  /* Ctrl-C / a platform stop: exit normally so the PGlite lock is released. */
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  scheduleCron();
}
