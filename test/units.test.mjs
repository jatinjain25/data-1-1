/* Pure helpers: ranges, formatting, live merge, visitors cursor, ads, Mixpanel, ingest. */

import test from "node:test";
import assert from "node:assert/strict";
import { dashboardCalls, parseRange } from "../server/query.js";
import { actionCount, creativeUtm, dayIn } from "../server/modules/meta.js";
import { mergeLive } from "../server/modules/live.js";
import { parseVisitorIds, parseVisitorsQuery, visitorsPage } from "../server/modules/visitors.js";
import { credentials, mixpanelCfg, parseExport, pickWorkspace, replayRows, replayUrl, userOf } from "../server/modules/mixpanel.js";
import { plan } from "../server/ingest.js";
import { normalise } from "../server/lib/config.js";
import { adRates, delta, duration, pct2, tzOffsetMs, zonedMidnight } from "../src/lib/format.js";

test("a range is refused rather than defaulted when it cannot be honoured", () => {
  assert.equal(parseRange({}), null);
  assert.equal(parseRange({ from: "garbage" }), null);
  assert.equal(parseRange({ from: "2026-10-27T00:00:00Z", to: "2026-10-26T00:00:00Z" }), null);
  assert.equal(parseRange({ from: "2020-01-01T00:00:00Z", to: "2026-10-26T00:00:00Z" }), null);
  assert.equal(parseRange({ from: "2026-10-20T00:00:00Z", to: "2026-10-27T00:00:00Z" }).prevFrom, "2026-10-13T00:00:00.000Z");
});

test("the dashboard asks for the ads panel only when the module is on", () => {
  const r = parseRange({ from: "2026-10-20T00:00:00Z", to: "2026-10-27T00:00:00Z" });
  const off = normalise({ site: { id: "s", domains: ["s.io"] } }).modules;
  const on = normalise({ site: { id: "s", domains: ["s.io"] }, modules: { ads: { enabled: true } } }).modules;
  assert.deepEqual(Object.keys(dashboardCalls("s", r, "channel", off)).sort(), ["current", "daily", "previous", "sources"]);
  assert.ok(dashboardCalls("s", r, "channel", on).ads);
  assert.equal(dashboardCalls("s", r, "channel", off).previous[1].p_to, r.from);
});

test("config refuses what cannot work", () => {
  assert.throws(() => normalise({ site: { id: "Bad Id", domains: ["a.io"] } }));
  assert.throws(() => normalise({ site: { id: "ok", domains: [] } }));
  assert.deepEqual(normalise({ site: { id: "ok", domains: ["https://www.A.io/path"] } }).site.domains, ["a.io"]);
});

test("midnight in the site's timezone, DST included", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  assert.equal(zonedMidnight(0, "Asia/Kolkata", now).toISOString(), "2026-10-26T18:30:00.000Z");
  assert.equal(zonedMidnight(6, "Asia/Kolkata", now).toISOString(), "2026-10-20T18:30:00.000Z");
  assert.equal(zonedMidnight(0, "UTC", now).toISOString(), "2026-10-27T00:00:00.000Z");
  assert.equal(zonedMidnight(0, "America/New_York", now).toISOString(), "2026-10-27T04:00:00.000Z");
  // the day after US DST ends (1 Nov 2026), midnight is 05:00 UTC
  assert.equal(zonedMidnight(0, "America/New_York", Date.parse("2026-11-02T12:00:00Z")).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(tzOffsetMs("Asia/Kolkata", new Date(now)), 5.5 * 3600e3);
  assert.equal(dayIn("Asia/Kolkata", 0, Date.parse("2026-10-27T19:00:00Z")), "2026-10-28");
});

test("formatting", () => {
  assert.equal(duration(0), "–");
  assert.equal(duration(35), "35s");
  assert.equal(duration(245), "4m 05s");
  assert.equal(duration(4320), "1h 12m");
  assert.equal(delta(10, 0), null);
  assert.equal(delta(15, 10), 50);
  const k = adRates(256.52, 3496, 98);
  assert.equal(pct2(k.ctr), "2.80%");
  assert.deepEqual(adRates(50, 0, 0), { ctr: null, cpc: null, cpm: null });
});

test("ad UTMs come from whichever link the creative carries; duplicates are not summed", () => {
  assert.deepEqual(creativeUtm({ object_story_spec: { link_data: { link: "https://x.io/?utm_campaign=c1&utm_content=carousel" } } }),
    { utm_campaign: "c1", utm_content: "carousel" });
  assert.deepEqual(creativeUtm({ object_story_spec: { video_data: { call_to_action: { value: { link: "https://x.io/?utm_campaign=c&utm_content=v3" } } } } }),
    { utm_campaign: "c", utm_content: "v3" });
  assert.deepEqual(creativeUtm({ url_tags: "utm_campaign=x&utm_content=y" }), { utm_campaign: "x", utm_content: "y" });
  assert.deepEqual(creativeUtm({}), { utm_campaign: null, utm_content: null });
  assert.equal(actionCount([{ action_type: "complete_registration", value: "2" },
    { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "2" }],
    ["complete_registration", "offsite_conversion.fb_pixel_complete_registration"]), 2);
});

test("live: one person per account, a page AND a reading ping are one person, newest first", () => {
  const people = mergeLive([
    { signal: "page", visitor_id: "vA", account_id: "u1", path: "/pricing", at: "2026-10-27T14:03:00Z" },
    { signal: "reading", visitor_id: "vA", account_id: "u1", at: "2026-10-27T14:04:00Z" },
    { signal: "page", visitor_id: "vPhone", account_id: "u1", at: "2026-10-27T14:01:00Z" },
    { signal: "page", visitor_id: "vB", at: new Date("2026-10-27T14:05:00Z") },
  ]);
  assert.equal(people.length, 2);
  assert.equal(people[0].visitor_id, "vB");
  assert.deepEqual(people[1].signals.sort(), ["page", "reading"]);
  assert.equal(people[1].path, "/pricing");
});

test("visitors cursor: refused not defaulted, clamped, keyset", async () => {
  assert.deepEqual(parseVisitorsQuery({}), { p_before: null, p_person: null, p_limit: 25, p_signed_in: false });
  assert.equal(parseVisitorsQuery({ before: "yesterday-ish" }), null);
  assert.equal(parseVisitorsQuery({ before: "2026-10-28T10:00:00Z", person: "x' or 1=1" }), null);
  assert.equal(parseVisitorsQuery({ person: "abc" }), null);
  assert.equal(parseVisitorsQuery({ limit: "5000" }).p_limit, 100);
  assert.deepEqual(parseVisitorIds("a1,b2"), ["a1", "b2"]);
  assert.equal(parseVisitorIds(Array.from({ length: 21 }, (_, i) => `v${i}`).join(",")), null);

  const calls = [];
  const cfg = normalise({ site: { id: "s", domains: ["s.io"] } });
  const now = Date.parse("2026-10-28T12:00:00Z");
  const r = await visitorsPage(parseVisitorsQuery({}), { cfg, now, rpc: async (fn, a) => { calls.push(a); return [{ person: "p1" }]; } });
  assert.equal(calls[0].p_before, "2026-10-28T11:50:00.000Z");   // starts where the live card stops
  assert.equal(r.done, true);
});

test("Mixpanel: region host, replay link, refused error bodies, swapped credentials", () => {
  const cfg = mixpanelCfg({ MIXPANEL_SA_USER: "u.1.mp-service-account", MIXPANEL_SA_SECRET: "s", MIXPANEL_PROJECT_ID: "123", MIXPANEL_WORKSPACE_ID: "9" }, "eu");
  assert.equal(cfg.exportHost, "https://data-eu.mixpanel.com");
  assert.equal(replayUrl("abc", cfg), "https://eu.mixpanel.com/project/123/view/9/app/replay/abc");
  assert.equal(mixpanelCfg({}, "us").exportHost, "https://data.mixpanel.com");
  assert.throws(() => parseExport('{"request":"/api/2.0/export","error":"Your plan does not allow API calls"}'));
  assert.deepEqual(credentials("secret", "name.abc.mp-service-account"), { user: "name.abc.mp-service-account", secret: "secret" });
  assert.equal(pickWorkspace({ results: { workspaces: { a: { id: 1, project_id: 5 }, b: { id: 2, project_id: 5, is_global: true } } } }, 5), "2");
  assert.equal(userOf({ distinct_id: "$device:abc", $device_id: "abc" }), null);
  assert.equal(userOf({ $user_id: "user_9", distinct_id: "user_9" }), "user_9");
  const rows = replayRows([
    { event: "a", properties: { time: 100, $mp_replay_id: "r1", site_visitor_id: "vX", $device_id: "d" } },
    { event: "b", properties: { time: 160, $mp_replay_id: "r1" } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visitor_id, "vX");
  assert.equal(rows[0].length_ms, 60000);
});

test("server ingest items are validated before anything is written", () => {
  assert.equal(plan({ type: "account", account_id: "u1", email: "A@B.co" })[1].p_email, "a@b.co");
  assert.equal(plan({ type: "account", account_id: "u1" })[1].p_server, true);
  assert.ok(plan({ type: "account" }).error);
  assert.ok(plan({ type: "account", account_id: "u1", signed_up_at: "nope" }).error);
  assert.equal(plan({ type: "event", account_id: "u1", name: "x" })[0], "record_event");
  assert.ok(plan({ type: "payment", external_id: "p", amount_minor: 0, currency: "USD" }).error);
  assert.ok(plan({ type: "payment", external_id: "p", amount_minor: 100, currency: "dollars" }).error);
  assert.equal(plan({ type: "payment", external_id: "p", amount_minor: 100, currency: "usd" })[1].provider, "manual");
  assert.ok(plan({ type: "drop table" }).error);
});
