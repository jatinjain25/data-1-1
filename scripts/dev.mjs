/* npm run dev - the whole thing locally, nothing to install.

   With no DATABASE_URL it uses PGlite in ./.data (a real Postgres in WASM).
   With no SESSION_SECRET / ADMIN_* it signs you in with the password "dev".
   API on :8787, dashboard with hot reload on :5180. */

import "./env.mjs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.DATABASE_URL ||= "pglite://./.data";
process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString("hex");
if (!process.env.ADMIN_EMAILS && !process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = "dev";
process.env.ANALYTICS_SALT ||= "dev-salt";
process.env.DISABLE_INTERNAL_CRON ||= "1";

const { db } = await import("../server/lib/db.js");
const { migrate } = await import("./migrate.mjs");
await migrate(await db());

const { createServer } = await import("../server.js");
createServer().listen(8787, () => {
  console.log("\n  API        http://localhost:8787");
  console.log("  Dashboard  http://localhost:5180");
  if (process.env.ADMIN_PASSWORD === "dev") console.log('  Sign in    password "dev"');
  console.log(`  Database   ${process.env.DATABASE_URL.startsWith("pglite") ? process.env.DATABASE_URL + " (local)" : "DATABASE_URL"}\n`);
});

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit", env: process.env });
const stop = () => { vite.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
