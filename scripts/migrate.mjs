/* npm run migrate - apply sql/schema.sql and register your site.

   Idempotent: run it after every pull and after every change to
   site.config.js (domain, timezone, currency, excluded plans). */

import "./env.mjs";
import { readFileSync } from "node:fs";
import { config } from "../server/lib/config.js";
import { db } from "../server/lib/db.js";

export async function migrate(handle, cfg = config) {
  const sql = readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");
  await handle.exec(sql);
  const s = cfg.site;
  await handle.query(
    `insert into sitedata.sites (id, domain, name, timezone, currency, exclude_plans)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set domain = excluded.domain, name = excluded.name,
       timezone = excluded.timezone, currency = excluded.currency, exclude_plans = excluded.exclude_plans`,
    [s.id, s.domains[0], s.name, s.timezone, s.currency, cfg.modules.revenue.excludePlans],
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const h = await db();
    await migrate(h);
    console.log(`✓ schema applied, site "${config.site.id}" (${config.site.domains.join(", ")}, ${config.site.timezone}, ${config.site.currency}) registered`);
    await h.end();
  } catch (e) {
    console.error(`✗ migrate failed: ${e.message}`);
    process.exit(1);
  }
}
