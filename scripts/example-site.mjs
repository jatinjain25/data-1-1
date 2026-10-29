/* npm run example - serves examples/static-site on http://localhost:8080 with
   the two rewrites a real site needs:
       /ke.js -> <dashboard>/t.js          (the tracker)
       /ke    -> <dashboard>/api/collect   (the beacons)
   so you can watch the whole loop locally with `npm run dev` running.

   The tag's domain is set to your first site.domains entry, because
   "localhost" is (rightly) not a domain the collector accepts. */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../server/lib/config.js";

const API = process.env.API_URL || "http://localhost:8787";
const ROOT = new URL("../examples/static-site/", import.meta.url).pathname;
const DOMAIN = config.site.domains[0];

async function proxy(req, res, target) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await fetch(API + target, {
    method: req.method,
    headers: {
      "content-type": req.headers["content-type"] || "text/plain",
      "user-agent": req.headers["user-agent"] || "",
      /* Every proxy must forward the visitor's address (AGENTS.md step 6). */
      "x-client-ip": (req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
    },
    body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
  });
  res.statusCode = r.status;
  const type = r.headers.get("content-type");
  if (type) res.setHeader("content-type", type);
  res.end(Buffer.from(await r.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    if (path === "/ke.js") return await proxy(req, res, "/t.js");
    if (path === "/ke") return await proxy(req, res, "/api/collect");
    const file = join(ROOT, path === "/" ? "index.html" : path.replace(/\.\./g, ""));
    let html = await readFile(file, "utf8");
    html = html.replace('data-endpoint="/ke"', `data-endpoint="/ke" data-domain="${DOMAIN}"`);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(8080, () => console.log(`Example site on http://localhost:8080 (beacons -> ${API}, as ${DOMAIN})`));
