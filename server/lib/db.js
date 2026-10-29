/* ═══════════════════════════════════════════════════════════════════════════
   The one door to Postgres.

   DATABASE_URL is any Postgres 14+ connection string (Neon, Supabase,
   Railway, RDS, your own box). On serverless hosts use the provider's POOLED
   string - every function instance opens its own connection.

   DATABASE_URL=pglite://./.data runs an in-process Postgres (PGlite, WASM)
   stored in that folder: a demo with nothing to install. Not for production -
   it is one process, one connection.

   Every report is a SQL function in the `sitedata` schema, called with NAMED
   arguments (p_site => $1, ...) so argument order can never silently swap.
   ═══════════════════════════════════════════════════════════════════════════ */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./config.js";

let current = null;
const DATE_OID = 1082;

/* PGLITE IS ONE PROCESS. A second process opening the same folder while the
   server runs reads a stale copy and can corrupt the store on close. So the
   first opener writes <dir>.lock (beside the folder - Postgres refuses to
   initialise a data folder that is not empty) with its pid, and anyone else is refused
   with a message that says what to do. A lock left by a dead process is
   taken over. */
function lockPglite(dir) {
  const file = `${dir.replace(/\/+$/, "")}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    let alive = false;
    try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive) {
      throw Object.assign(new Error(
        `${dir} is open in another process (pid ${pid}). PGlite is single-process: stop that process first ` +
        "(or, for doctor, pass --url so it checks through the running server)."), { code: "pglite_locked", pid });
    }
  }
  writeFileSync(file, String(process.pid));
  const release = () => { try { if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file); } catch { /* gone */ } };
  process.once("exit", release);
  return release;
}

async function open(url) {
  if (url.startsWith("pglite://")) {
    /* Through a variable so serverless bundlers do not pack 10 MB of WASM
       into every function that never uses it. */
    const mod = "@electric-sql/pglite";
    const { PGlite } = await import(mod);
    const dir = url.slice("pglite://".length);
    const release = dir && dir !== "memory" ? lockPglite(dir) : () => {};
    const opts = { parsers: { [DATE_OID]: (v) => v } };
    const db = dir && dir !== "memory" ? new PGlite(dir, opts) : new PGlite(opts);
    await db.waitReady;
    return {
      kind: "pglite",
      query: async (sql, params = []) => (await db.query(sql, params)).rows,
      exec: (sql) => db.exec(sql),
      end: async () => { await db.close(); release(); },
    };
  }
  const { default: pg } = await import("pg");
  /* bigint/numeric arrive as strings from pg by default; the dashboard does
     Number() on everything it shows, so that is left alone. A DATE, though,
     would become a JS Date at LOCAL midnight - one day early anywhere east of
     UTC once serialised - so calendar days stay the "YYYY-MM-DD" strings
     Postgres computed in the site's timezone. */
  pg.types.setTypeParser(DATE_OID, (v) => v);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    ssl: /sslmode=(require|verify)/.test(url) || /neon\.tech|supabase\.co|supabase\.com/.test(url)
      ? { rejectUnauthorized: false } : undefined,
  });
  return {
    kind: "pg",
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    exec: (sql) => pool.query(sql),
    end: () => pool.end(),
  };
}

/** The shared handle. Throws `not_configured` when there is no DATABASE_URL. */
export async function db() {
  if (current) return current;
  const url = env().databaseUrl;
  if (!url) throw Object.assign(new Error("DATABASE_URL is not set"), { code: "not_configured" });
  current = open(url).catch((e) => { current = null; throw e; });
  return current;
}

/** For tests: use this handle instead of DATABASE_URL. */
export function useDb(handle) {
  current = Promise.resolve(handle);
}

export async function openDb(url) {
  return open(url);
}

const FN_RE = /^[a-z_][a-z0-9_]*$/;
const ARG_RE = /^p_[a-z0-9_]+$/;

/** select * from sitedata.<fn>(p_a => $1, p_b => $2). Values that are plain
    objects are sent as JSON (for jsonb arguments). */
export async function call(fn, args = {}, handle) {
  if (!FN_RE.test(fn)) throw new Error(`bad function name ${fn}`);
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  for (const k of keys) if (!ARG_RE.test(k)) throw new Error(`bad argument name ${k}`);
  const values = keys.map((k) => {
    const v = args[k];
    return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  const sql = `select * from sitedata.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
  const h = handle || (await db());
  try {
    return await h.query(sql, values);
  } catch (e) {
    throw Object.assign(new Error(`${fn}: ${e.message}`), { fn });
  }
}
