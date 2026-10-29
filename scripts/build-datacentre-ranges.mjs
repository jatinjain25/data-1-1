/* Generate server/lib/datacentre-ranges.json from the ranges Meta, AWS and GCP
 * publish about their own networks.
 *
 *     npm run ranges
 *
 * WHY: ad-platform crawlers render your page, hold it visible, rotate real
 * user-agents and use one IP each - they pass every user-agent and burst rule.
 * On the site this was built for, about a third of the "paid" visitors from
 * Meta ads turned out to be Meta's own data-centre fleet. The network is the
 * thing actually being claimed ("this request came off a cloud"), so the test
 * is the published IP ranges - not a city list, which would flag real people
 * living in data-centre towns.
 *
 * A committed artifact, not a runtime fetch: a collector that asks a
 * third-party API whether to record a visit stops recording when it is down.
 *
 * Nothing warns when this goes stale. Clouds add ranges constantly, so it
 * decays toward UNDER-flagging, never toward flagging a real reader. Re-run it
 * every few months. Azure is not included: its file rotates URL weekly.
 *
 * The cost: a real person on a cloud-hosted VPN is flagged as a bot. Rows are
 * flagged, never deleted, so that stays reviewable.
 *
 * It verifies its own output: it refuses to write unless every source returned
 * a plausible count and every entry re-parses.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "lib", "datacentre-ranges.json");

/* Each entry is `asn` for the record and a floor on what a healthy answer looks
   like. The floors are ~40% of the counts measured on 2026-08-30: an ASN can
   legitimately re-aggregate its announcements, but it does not lose two thirds
   of them overnight, and a near-empty answer from a rate-limited API must not
   quietly become "Meta owns almost nothing". */
const SOURCES = [
  { asn: "AS32934", name: "Facebook", minV4: 90, minV6: 130 },
  { asn: "AS63293", name: "Facebook Offnet", minV4: 35, minV6: 30 },
];

/* Floors on what a healthy answer looks like, at roughly 40% of the counts
   measured on 2026-08-30. A publisher can legitimately re-aggregate its
   announcements; it does not lose two thirds of them overnight. Without these,
   a rate-limited or truncated response becomes "the cloud owns almost nothing"
   silently, and silent under-flagging reads exactly like clean data. */
const CLOUDS = [
  { name: "AWS", minV4: 6000, minV6: 3000 },
  { name: "GCP", minV4: 500, minV6: 15 },
];

const API = "https://stat.ripe.net/data/announced-prefixes/data.json?resource=";

/* ── IPv4 as a sorted list of [start, end] uint32 ranges ────────────────────
   The collector binary-searches this, so the shape is chosen at build time and
   the request path does no parsing at all. */
function v4ToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const b = Number(part);
    if (!Number.isInteger(b) || b < 0 || b > 255 || !/^\d{1,3}$/.test(part)) return null;
    n = n * 256 + b;
  }
  return n;
}

function v4Range(cidr) {
  const [ip, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const base = v4ToInt(ip);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return [start, start + size - 1];
}

/* ── IPv6 as normalised hex-nibble prefix strings ───────────────────────────
   Matching a v6 address against a /48 is a string comparison once both sides
   are expanded to full nibbles, and doing the expansion here means the
   collector never implements v6 arithmetic. Prefixes are stored to whole
   nibbles, so a length that is not a multiple of 4 is rounded DOWN to the
   nibble boundary - it widens the prefix rather than narrowing it, which errs
   toward flagging one extra address of Meta's rather than missing a block of
   it. Every prefix Meta announces is on a nibble boundary anyway (/32 /47 /48). */
function v6Nibbles(addr) {
  const [head, tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (h.length + t.length > 8) return null;
  const mid = addr.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  const groups = [...h, ...mid, ...t];
  if (groups.length !== 8) return null;
  let out = "";
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{0,4}$/.test(g)) return null;
    out += g.toLowerCase().padStart(4, "0");
  }
  return out;
}

function v6Prefix(cidr) {
  const [addr, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const nib = v6Nibbles(addr);
  if (nib === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  return nib.slice(0, Math.floor(bits / 4));
}

async function announced(asn) {
  const res = await fetch(API + asn, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${asn}: HTTP ${res.status}`);
  const json = await res.json();
  const rows = json?.data?.prefixes;
  if (!Array.isArray(rows)) throw new Error(`${asn}: no prefixes array in response`);
  return rows.map((r) => r.prefix).filter(Boolean);
}

async function awsPrefixes() {
  const res = await fetch("https://ip-ranges.amazonaws.com/ip-ranges.json");
  if (!res.ok) throw new Error(`AWS: HTTP ${res.status}`);
  const j = await res.json();
  return [
    ...(j.prefixes || []).map((p) => p.ip_prefix),
    ...(j.ipv6_prefixes || []).map((p) => p.ipv6_prefix),
  ].filter(Boolean);
}

async function gcpPrefixes() {
  const res = await fetch("https://www.gstatic.com/ipranges/cloud.json");
  if (!res.ok) throw new Error(`GCP: HTTP ${res.status}`);
  const j = await res.json();
  return (j.prefixes || []).map((p) => p.ipv4Prefix || p.ipv6Prefix).filter(Boolean);
}

const CLOUD_FETCH = { AWS: awsPrefixes, GCP: gcpPrefixes };

async function main() {
  const v4 = [];
  const v6 = new Set();

  /* One path for every publisher, so a floor is checked the same way whoever
     supplied the list and no source can quietly skip the gate. */
  const take = (label, prefixes, minV4, minV6) => {
    const mine4 = [];
    const mine6 = [];
    for (const p of prefixes) {
      if (p.includes(":")) {
        const n = v6Prefix(p);
        if (n !== null) mine6.push(n);
      } else {
        const r = v4Range(p);
        if (r !== null) mine4.push(r);
      }
    }
    if (mine4.length < minV4 || mine6.length < minV6) {
      throw new Error(
        `${label} returned ${mine4.length} IPv4 / ${mine6.length} IPv6, under the floor ` +
        `of ${minV4} / ${minV6}. Refusing to write a list that would silently stop ` +
        `flagging most of that network.`,
      );
    }
    console.log(`  ${label.padEnd(28)} ${String(mine4.length).padStart(5)} IPv4  ${String(mine6.length).padStart(5)} IPv6`);
    v4.push(...mine4);
    for (const n of mine6) v6.add(n);
  };

  for (const src of SOURCES) {
    take(`${src.asn} ${src.name}`, await announced(src.asn), src.minV4, src.minV6);
  }
  for (const c of CLOUDS) {
    take(c.name, await CLOUD_FETCH[c.name](), c.minV4, c.minV6);
  }

  /* Sorted and merged, so the collector's binary search is correct and so a
     re-run with unchanged upstream data produces a byte-identical file. */
  v4.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of v4) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  /* A shorter v6 prefix already covers every longer one under it; dropping the
     redundant ones keeps the file honest about what is actually being tested. */
  const all6 = [...v6].sort();
  const kept6 = all6.filter((p) => !all6.some((q) => q.length < p.length && p.startsWith(q)));

  /* v6 BUCKETED BY LENGTH, so the collector does a few Set lookups instead of
     scanning ~2,200 strings on every request. There are only a handful of
     distinct prefix lengths in practice (/29 /32 /36 /47 /48 ...). */
  const buckets = {};
  for (const p of kept6) (buckets[p.length] ||= []).push(p);
  const v6Buckets = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((len) => [len, buckets[len].sort()]);

  const out = {
    _comment:
      "GENERATED by scripts/build-datacentre-ranges.mjs - do not hand-edit. " +
      "Prefixes published by Meta, AWS and GCP, used to flag cloud-origin " +
      "requests at ingest. v4 is [start,end] uint32 ranges, sorted and merged, " +
      "for binary search. v6 is [nibbleLength, prefixes[]] buckets.",
    _sources: [...SOURCES.map((s) => `${s.asn} (${s.name})`), ...CLOUDS.map((c) => c.name)],
    _generated_from: [API + "<asn>", "ip-ranges.amazonaws.com", "gstatic.com/ipranges/cloud.json"],
    v4: merged,
    v6: v6Buckets,
  };

  /* Re-parse what we are about to ship, from the serialised bytes rather than
     from the objects in hand - that is the half that catches a JSON round-trip
     defect, and it is the check build-world-map.mjs wishes it had had first. */
  const text = JSON.stringify(out, null, 0) + "\n";
  const back = JSON.parse(text);
  if (!Array.isArray(back.v4) || !Array.isArray(back.v6)) throw new Error("round-trip lost an array");
  for (const r of back.v4) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] > r[1]) {
      throw new Error(`round-trip produced a bad v4 range: ${JSON.stringify(r)}`);
    }
  }
  for (const b of back.v6) {
    if (!Array.isArray(b) || b.length !== 2 || !Number.isInteger(b[0]) || !Array.isArray(b[1])) {
      throw new Error(`round-trip produced a bad v6 bucket: ${JSON.stringify(b).slice(0, 80)}`);
    }
    for (const p of b[1]) {
      if (typeof p !== "string" || p.length !== b[0] || !/^[0-9a-f]+$/.test(p)) {
        throw new Error(`bad v6 prefix in the ${b[0]}-nibble bucket: ${p}`);
      }
    }
  }

  const before = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  writeFileSync(OUT, text);
  console.log(`\n  ${merged.length} merged IPv4 ranges, ${kept6.length} IPv6 prefixes in ${v6Buckets.length} length buckets`);
  console.log(`  ${(text.length / 1024).toFixed(1)} KB -> server/lib/datacentre-ranges.json${before === text ? " (unchanged)" : ""}`);
}

main().catch((e) => {
  console.error(`\n  REFUSED: ${e.message}\n`);
  process.exit(1);
});
