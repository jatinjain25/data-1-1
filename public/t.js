/* ═══════════════════════════════════════════════════════════════════════════
   Data 1-1 tracker. ~4 KB minified (~2 KB gzipped), no dependencies, no cookies banner needed for the
   data it sends: no IP is stored, no fingerprinting, Do Not Track honoured.

   <script defer src="/ke.js" data-endpoint="/ke"></script>      (proxied - recommended)
   <script defer src="https://data.example.com/t.js"></script>   (direct)

   window.siteData.track("signup_started", { plan: "pro" })
   window.siteData.identify(user.id, { email: user.email, name: user.name })
   window.siteData.answer({ goal: ["learn"], role: "student" }, { skipped: 2 })
   window.siteData.visitorId()      // pass to your checkout as metadata.site_visitor_id

   ES5 on purpose: it is pasted into every kind of site, old build tools included.

   ── THE THINGS THAT ARE EASY TO GET WRONG ────────────────────────────────
   1. SPAs change pages with history.pushState, which fires no event. A tag
      that only listens for load counts one page per visit and looks healthy.
      pushState/replaceState are wrapped and popstate is heard.
   2. The last beacon is sent while the tab closes; fetch() is cancelled on
      unload. sendBeacon outlives the page, so it is the main path.
   3. Do Not Track and self-exclusion are checked BEFORE any id is minted.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;
  /* Exclude your own browser:  localStorage.sd_exclude = "1"  */
  try { if (window.localStorage.getItem("sd_exclude") === "1") return; } catch (e) { /* private mode */ }

  var script = document.currentScript;
  function attr(name) { return script && script.getAttribute(name); }
  function defaultEndpoint() {
    try { return new URL(script.src).origin + "/api/collect"; } catch (e) { return "/api/collect"; }
  }

  var DOMAIN = attr("data-domain") || location.hostname;
  var ENDPOINT = attr("data-endpoint") || defaultEndpoint();
  var VID = "sd_vid", SID = "sd_sid", SID_TS = "sd_sid_ts";
  var SESSION_MS = 30 * 60 * 1000;

  function mintId(prefix) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var out = "", i, n = 20;
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint8Array(n);
      window.crypto.getRandomValues(buf);
      for (i = 0; i < n; i++) out += chars[buf[i] % chars.length];
    } else {
      for (i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
    }
    return prefix + out;
  }

  /* Cookie AND localStorage, read whichever survives: Safari caps script
     cookies at 7 days, private windows lose localStorage. */
  function readStore(key) {
    var m = document.cookie.match(new RegExp("(^| )" + key + "=([^;]+)"));
    if (m && m[2]) return decodeURIComponent(m[2]);
    try { return window.localStorage.getItem(key) || null; } catch (e) { return null; }
  }
  function writeStore(key, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = key + "=" + encodeURIComponent(value) + ";expires=" + d.toUTCString() +
      ";path=/;SameSite=Lax" + (location.protocol === "https:" ? ";Secure" : "");
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function visitorId() {
    var v = readStore(VID);
    if (!v) v = mintId("v");
    writeStore(VID, v, 730);
    return v;
  }

  /* A session ends after 30 minutes with no events (sliding). */
  function sessionId() {
    var now = Date.now();
    var s = readStore(SID);
    var t = parseInt(readStore(SID_TS) || "0", 10);
    if (!s || !t || now - t > SESSION_MS) s = mintId("s");
    writeStore(SID, s, 1);
    writeStore(SID_TS, String(now), 1);
    return s;
  }

  function params() {
    try { return new URLSearchParams(location.search); }
    catch (e) { return { get: function () { return null; } }; }
  }

  /* Ad clicks often carry a click id and NO utm tags; without this, paid
     traffic lands as "facebook.com referral". Only the NAME is sent. */
  function clickSource(q) {
    var ids = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "twclid", "li_fat_id", "msclkid"];
    for (var i = 0; i < ids.length; i++) if (q.get(ids[i])) return ids[i];
    return null;
  }

  function send(kind, name, meta) {
    var q = params();
    var payload = JSON.stringify({
      d: DOMAIN, v: visitorId(), s: sessionId(), k: kind, n: name || null,
      p: location.pathname, h: location.hostname, r: document.referrer || null,
      us: q.get("utm_source"), um: q.get("utm_medium"), uc: q.get("utm_campaign"),
      uo: q.get("utm_content"), ut: q.get("utm_term"), cs: clickSource(q),
      /* Playwright, Selenium, Puppeteer announce themselves. */
      w: navigator.webdriver === true,
      m: meta || null
    });
    /* text/plain is a CORS-simple type: no preflight, one round trip. */
    if (navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "text/plain;charset=UTF-8" }))) return;
      } catch (e) { /* fall through */ }
    }
    try {
      fetch(ENDPOINT, { method: "POST", body: payload, keepalive: true, credentials: "omit",
        headers: { "Content-Type": "text/plain;charset=UTF-8" } }).catch(function () {});
    } catch (e) { /* nothing more to try */ }
  }

  /* ── pageviews, including client-side routes; deduplicated on the path ── */
  var lastPath = null;
  function pageview() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    send("pageview", null, null);
  }
  function wrap(method) {
    var original = history[method];
    if (typeof original !== "function") return;
    history[method] = function () {
      var out = original.apply(this, arguments);
      window.setTimeout(pageview, 0);
      return out;
    };
  }
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", function () { window.setTimeout(pageview, 0); });
  if (document.readyState === "complete" || document.readyState === "interactive") pageview();
  else document.addEventListener("DOMContentLoaded", pageview);

  /* ── the humanity heartbeat ──────────────────────────────────────────────
     ONE `engage` after 5 continuous seconds of VISIBLE page. A reader who
     bounces still idles five seconds; a load-and-leave scraper does not.
     Reports count only browsers that sent it. The timer restarts on becoming
     visible - ten half-seconds do not add up to it. */
  var engaged = false, engageTimer = null;
  function armEngage() {
    if (engaged || engageTimer) return;
    engageTimer = window.setTimeout(function () {
      engageTimer = null;
      if (engaged || document.visibilityState !== "visible") return;
      engaged = true;
      send("engage", null, null);
    }, 5000);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") armEngage();
    else if (engageTimer) { window.clearTimeout(engageTimer); engageTimer = null; }
  });
  if (document.visibilityState === "visible") armEngage();

  /* ── time spent ──────────────────────────────────────────────────────────
     A `ping` carrying seconds that were BOTH visible AND in use (input in the
     last 60 s) - a tab left open overnight is not eight hours of reading.
     Sent every ~30 s and flushed when hidden or closed. The server caps it. */
  var IDLE_MS = 60000, TICK_MS = 5000, FLUSH_AT = 30;
  var lastInput = Date.now(), lastTick = Date.now(), activeSecs = 0;
  function touched() { lastInput = Date.now(); }
  var inputs = ["keydown", "pointerdown", "touchstart", "scroll", "mousemove", "wheel"];
  for (var ii = 0; ii < inputs.length; ii++) {
    window.addEventListener(inputs[ii], touched, { passive: true, capture: true });
  }
  function flushTime() {
    var secs = Math.floor(activeSecs);
    if (secs < 1) return;
    activeSecs -= secs;
    send("ping", String(secs), null);
  }
  window.setInterval(function () {
    var now = Date.now();
    var gap = Math.min(now - lastTick, TICK_MS * 2);   // a throttled timer must not bank an hour
    lastTick = now;
    if (document.visibilityState === "visible" && now - lastInput < IDLE_MS) {
      activeSecs += gap / 1000;
      if (activeSecs >= FLUSH_AT) flushTime();
    }
  }, TICK_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushTime();
    else { lastTick = Date.now(); lastInput = Date.now(); }
  });
  window.addEventListener("pagehide", flushTime);

  /* ── outbound links (capture phase, never delays the navigation) ── */
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    if (/^(javascript|mailto|tel):/i.test(a.getAttribute("href") || "")) return;
    var host;
    try { host = new URL(a.href, location.href).hostname; } catch (err) { return; }
    if (!host || host === location.hostname) return;
    send("exit", host.replace(/^www\./, ""), null);
  }, true);

  /* ── the public surface ─────────────────────────────────────────────────── */
  var api = window.siteData = window.siteData || {};
  api.visitorId = visitorId;
  api.track = function (name, props) {
    if (!name) return;
    send("custom", String(name).slice(0, 120), props || null);
  };
  /* Link this browser to your user id. Safe to call on every page load and
     auth change: the server only fills blanks. email/name/signedUpAt are
     optional - your server's /api/ingest is the authoritative source. */
  api.identify = function (accountId, traits) {
    var id = String(accountId == null ? "" : accountId);
    if (!id) return;
    var t = traits || {};
    send("identify", id, { email: t.email || null, name: t.name || null,
                           signed_up_at: t.signedUpAt || t.signed_up_at || null });
  };
  /* Survey answers: { questionId: "option" | ["a","b"], questionId_other: "typed" }.
     opts.skipped = the step they skipped at; opts.account = they went to sign in. */
  api.answer = function (answers, opts) {
    var o = opts || {};
    send("answer", null, { answers: answers || {}, skipped: o.skipped || null, account: o.account === true });
  };
})();
