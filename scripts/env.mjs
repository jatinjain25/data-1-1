/* Loads .env into process.env for local scripts (never overrides a variable
   that is already set). Hosts like Vercel inject env themselves. */

import { readFileSync, existsSync } from "node:fs";

const file = new URL("../.env", import.meta.url);
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
