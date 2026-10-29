/* The site config, validated once, plus the environment. Server-side only. */

import raw from "../../site.config.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Normalised config. Throws on a config that cannot work - better at boot
    than as a silent 204 on every beacon. Pure, so tests can feed it shapes. */
export function normalise(c) {
  const site = c.site || {};
  if (!ID_RE.test(String(site.id || ""))) throw new Error("site.config.js: site.id must be lowercase letters, digits, dashes");
  const domains = (site.domains || [])
    .map((d) => String(d).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
    .filter(Boolean);
  if (!domains.length) throw new Error("site.config.js: site.domains is empty");
  const m = c.modules || {};
  const survey = m.survey || {};
  return {
    site: {
      id: site.id,
      name: site.name || site.id,
      domains,
      timezone: site.timezone || "UTC",
      currency: (site.currency || "USD").toUpperCase(),
      locale: site.locale || "en-US",
      startDate: site.startDate || "2026-01-01",
    },
    dashboard: { liveMinutes: 10, logoLetter: "D", brandColor: "#2a78d6", ...(c.dashboard || {}) },
    actions: (c.actions || []).filter((a) => a && a.event).map((a) => ({ event: String(a.event), label: a.label || a.event })),
    modules: {
      revenue: { enabled: m.revenue?.enabled !== false, excludePlans: m.revenue?.excludePlans || [] },
      ads: { enabled: !!m.ads?.enabled, campaignMatch: m.ads?.campaignMatch || "" },
      replays: { enabled: !!m.replays?.enabled, region: m.replays?.region || "us" },
      survey: {
        enabled: !!survey.enabled,
        shownEvent: survey.shownEvent || "survey_shown",
        questions: (survey.questions || []).filter((q) => q && q.id),
      },
    },
  };
}

export const config = normalise(raw);

/** The browser origins allowed to post beacons directly (a proxied beacon is
    same-origin and needs none of this). */
export function origins(cfg = config) {
  const out = new Set();
  for (const d of cfg.site.domains) {
    out.add(`https://${d}`);
    out.add(`https://www.${d}`);
  }
  return out;
}

export function env(e = process.env) {
  const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    databaseUrl: (e.DATABASE_URL || "").trim(),
    salt: (e.ANALYTICS_SALT || "").trim(),
    ingestKey: (e.INGEST_KEY || "").trim(),
    sessionSecret: (e.SESSION_SECRET || "").trim(),
    adminEmails: list(e.ADMIN_EMAILS),
    adminPassword: e.ADMIN_PASSWORD || "",
    googleClientId: (e.GOOGLE_CLIENT_ID || "").trim(),
    cronSecret: (e.CRON_SECRET || "").trim(),
    trustProxy: Math.max(0, Number(e.TRUST_PROXY) || 0),
    clientIpHeader: (e.CLIENT_IP_HEADER || "x-client-ip").trim().toLowerCase(),
  };
}
