/* ═══════════════════════════════════════════════════════════════════════════
   Meta ads -> sitedata.ad_spend. Run daily by cron and by the dashboard's
   "refresh" when the numbers are older than two hours.

   Each ad's utm_campaign / utm_content is read from the creative's own link.
   That is what lets the dashboard put an ad's SPEND beside the people it
   actually brought (first touch), instead of trusting the pixel's claim -
   which is stored beside it, for comparison.

   Needs META_ADS_TOKEN (a system-user token with ads_read) and
   META_AD_ACCOUNT ("act_<digits>"). site.config.js modules.ads.campaignMatch
   keeps only the campaigns that belong to this site when one ad account runs
   several brands.
   ═══════════════════════════════════════════════════════════════════════════ */

import { config } from "../lib/config.js";
import { db } from "../lib/db.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Pure: utm_* out of whichever link a creative carries. */
export function creativeUtm(creative) {
  const c = creative || {};
  const oss = c.object_story_spec || {};
  const links = [
    oss.link_data && oss.link_data.link,
    oss.video_data?.call_to_action?.value?.link,
    ...((c.asset_feed_spec?.link_urls || []).map((l) => l && l.website_url)),
  ].filter(Boolean);
  const out = { utm_campaign: null, utm_content: null };
  for (const link of links) {
    try {
      const u = new URL(link);
      out.utm_campaign = out.utm_campaign || u.searchParams.get("utm_campaign");
      out.utm_content = out.utm_content || u.searchParams.get("utm_content");
    } catch { /* not a URL */ }
  }
  if (c.url_tags && (!out.utm_campaign || !out.utm_content)) {
    const t = new URLSearchParams(String(c.url_tags));
    out.utm_campaign = out.utm_campaign || t.get("utm_campaign");
    out.utm_content = out.utm_content || t.get("utm_content");
  }
  return out;
}

/** Pure: Meta reports one conversion under several action types; take the max, never the sum. */
export function actionCount(actions, types) {
  let n = 0;
  for (const a of actions || []) if (types.includes(a.action_type)) n = Math.max(n, Number(a.value) || 0);
  return n;
}

/** Pure: "YYYY-MM-DD" in a timezone, `daysAgo` days back. */
export function dayIn(tz, daysAgo = 0, now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(now - daysAgo * 86400e3));
}

async function graph(path, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  let url = `${GRAPH}/${path}?${qs}`;
  const rows = [];
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(`meta ${path}: ${body.error?.message || res.status}`);
    rows.push(...(body.data || []));
    url = body.paging && body.paging.next;
  }
  return rows;
}

/** Pull the last `days` days and upsert them. Re-pulling replaces a day -
    Meta revises spend for about 72 hours. */
export async function pullMetaAds({ days = 3, cfg = config } = {}) {
  const token = (process.env.META_ADS_TOKEN || "").trim();
  const account = (process.env.META_AD_ACCOUNT || "").trim();
  if (!token || !account) return { ok: false, error: "META_ADS_TOKEN or META_AD_ACCOUNT unset" };
  const acct = account.startsWith("act_") ? account : `act_${account}`;

  const since = dayIn(cfg.site.timezone, days - 1);
  const until = dayIn(cfg.site.timezone, 0);
  const match = cfg.modules.ads.campaignMatch ? new RegExp(cfg.modules.ads.campaignMatch, "i") : null;

  const [insights, ads, info] = await Promise.all([
    graph(`${acct}/insights`, {
      level: "ad", time_increment: "1", limit: "500",
      time_range: JSON.stringify({ since, until }),
      fields: "ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions",
    }, token),
    graph(`${acct}/ads`, { fields: "id,creative{url_tags,object_story_spec,asset_feed_spec}", limit: "200" }, token),
    fetch(`${GRAPH}/${acct}?fields=currency&access_token=${encodeURIComponent(token)}`).then((r) => r.json()).catch(() => ({})),
  ]);

  const currency = info.currency || cfg.site.currency;
  const utmByAd = new Map(ads.map((a) => [a.id, creativeUtm(a.creative)]));
  let n = 0;
  for (const r of insights) {
    if (match && !match.test(r.campaign_name || "")) continue;
    const utm = utmByAd.get(r.ad_id) || {};
    await upsertSpend(cfg.site.id, {
      day: r.date_start, ad_id: r.ad_id, ad_name: r.ad_name, adset_name: r.adset_name,
      campaign_id: r.campaign_id, campaign_name: r.campaign_name,
      utm_campaign: utm.utm_campaign || null, utm_content: utm.utm_content || null,
      spend: Number(r.spend) || 0, currency,
      impressions: Number(r.impressions) || 0, link_clicks: Number(r.inline_link_clicks) || 0,
      landing_views: actionCount(r.actions, ["landing_page_view"]),
      platform_signups: actionCount(r.actions, ["complete_registration", "offsite_conversion.fb_pixel_complete_registration"]),
      platform_purchases: actionCount(r.actions, ["purchase", "offsite_conversion.fb_pixel_purchase"]),
    });
    n++;
  }
  return { ok: true, rows: n, since, until, currency };
}

export async function upsertSpend(site, r, handle) {
  const h = handle || (await db());
  await h.query(
    `insert into sitedata.ad_spend (site_id, day, ad_id, ad_name, adset_name, campaign_id, campaign_name,
       utm_campaign, utm_content, spend, currency, impressions, link_clicks, landing_views,
       platform_signups, platform_purchases, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     on conflict (site_id, day, ad_id) do update set
       ad_name = excluded.ad_name, adset_name = excluded.adset_name, campaign_id = excluded.campaign_id,
       campaign_name = excluded.campaign_name, utm_campaign = excluded.utm_campaign,
       utm_content = excluded.utm_content, spend = excluded.spend, currency = excluded.currency,
       impressions = excluded.impressions, link_clicks = excluded.link_clicks,
       landing_views = excluded.landing_views, platform_signups = excluded.platform_signups,
       platform_purchases = excluded.platform_purchases, updated_at = now()`,
    [site, r.day, r.ad_id, r.ad_name, r.adset_name, r.campaign_id, r.campaign_name, r.utm_campaign,
     r.utm_content, r.spend, r.currency, r.impressions, r.link_clicks, r.landing_views,
     r.platform_signups, r.platform_purchases],
  );
}

export async function adsUpdatedAt(site) {
  const rows = await (await db()).query(
    "select max(updated_at) as at from sitedata.ad_spend where site_id = $1", [site]);
  return rows[0] ? rows[0].at : null;
}

