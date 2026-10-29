-- ═══════════════════════════════════════════════════════════════════════════
-- Data 1-1 · the whole database, one idempotent file.
--
--   npm run migrate        (applies this, then upserts your site from site.config.js)
--
-- Plain Postgres 14+. Everything lives in its own schema, `sitedata`, so it can
-- share a database with your app without a single name collision, and
-- `drop schema sitedata cascade` removes it completely.
--
-- Safe to re-run: tables are `create ... if not exists`, functions are
-- `create or replace`. Upgrades add columns with `add column if not exists`.
--
-- THE RULES THIS FILE KEEPS
--   * A raw IP address never reaches a table - only a salted hash (net.js).
--   * Bots are FLAGGED, never deleted, so every exclusion stays reviewable.
--   * A visitor counts as a person only after `verified` (5 s of visible page).
--   * Days are the SITE's calendar days (sites.timezone), never the server's.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists sitedata;

-- ── tables ──────────────────────────────────────────────────────────────────

create table if not exists sitedata.sites (
  id            text primary key,
  domain        text not null,
  name          text not null,
  timezone      text not null default 'UTC',
  currency      text not null default 'USD',
  exclude_plans text[] not null default '{}',
  created_at    timestamptz not null default now()
);

create table if not exists sitedata.visitors (
  visitor_id          text primary key,
  site_id             text not null references sitedata.sites(id),
  ip_hash             text,
  first_seen          timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  first_referrer      text,
  first_referrer_host text,
  first_utm_source    text,
  first_utm_medium    text,
  first_utm_campaign  text,
  first_utm_content   text,
  first_utm_term      text,
  first_landing_path  text,
  first_channel       text,
  first_click_source  text,
  last_referrer_host  text,
  last_utm_source     text,
  last_utm_campaign   text,
  country             text,
  region              text,
  city                text,
  device              text,
  browser             text,
  os                  text,
  account_id          text,               -- your app's user id, once identify() runs
  verified            boolean not null default false,
  is_bot              boolean not null default false,
  pageview_count      integer not null default 0,
  session_count       integer not null default 0
);
-- Why a browser was flagged: 'automation' (webdriver / data centre) or 'burst'.
alter table sitedata.visitors add column if not exists bot_reason text;
create index if not exists visitors_site_first on sitedata.visitors (site_id, first_seen desc);
create index if not exists visitors_site_last  on sitedata.visitors (site_id, last_seen desc);
create index if not exists visitors_account    on sitedata.visitors (site_id, account_id) where account_id is not null;
create index if not exists visitors_ip_hash    on sitedata.visitors (ip_hash) where ip_hash is not null;

create table if not exists sitedata.sessions (
  session_id     text primary key,
  visitor_id     text not null references sitedata.visitors(visitor_id) on delete cascade,
  site_id        text not null references sitedata.sites(id),
  started_at     timestamptz not null default now(),
  last_event_at  timestamptz not null default now(),
  entry_path     text,
  exit_path      text,
  pageview_count integer not null default 0,
  event_count    integer not null default 0,
  referrer       text,
  referrer_host  text,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  utm_term       text,
  country        text,
  region         text,
  city           text,
  device         text,
  browser        text,
  os             text,
  hostname       text,
  channel        text,
  click_source   text,
  is_bot         boolean not null default false
);
create index if not exists sessions_site_started on sitedata.sessions (site_id, started_at desc);
create index if not exists sessions_visitor      on sitedata.sessions (visitor_id, started_at desc);
create index if not exists sessions_live         on sitedata.sessions (site_id, last_event_at desc);

create table if not exists sitedata.events (
  id            bigint generated always as identity primary key,
  site_id       text not null references sitedata.sites(id),
  visitor_id    text not null,
  session_id    text not null,
  kind          text not null default 'pageview',   -- pageview | custom | exit
  name          text,
  path          text,
  referrer_host text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  country       text,
  region        text,
  city          text,
  device        text,
  browser       text,
  os            text,
  meta          jsonb,
  hostname      text,
  channel       text,
  keyword       text,
  click_source  text,
  is_bot        boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists events_site_created on sitedata.events (site_id, created_at desc) where not is_bot;
create index if not exists events_visitor      on sitedata.events (visitor_id, created_at desc);
create index if not exists events_name         on sitedata.events (site_id, name, created_at desc) where kind = 'custom';

-- Reading time. One row per browser per day per source, credited by the
-- tracker's ~30 s `ping` (visible AND in use). Session length cannot answer
-- "how long did they read": one long read of one page is a zero-length session.
create table if not exists sitedata.active_time (
  site_id      text not null references sitedata.sites(id),
  visitor_id   text not null,
  day          date not null,
  source       text not null default 'tag',   -- tag | mixpanel
  account_id   text,
  seconds      integer not null default 0 check (seconds between 0 and 86400),
  pings        integer not null default 0,
  last_ping_at timestamptz,
  primary key (site_id, visitor_id, day, source)
);
create index if not exists active_time_day on sitedata.active_time (site_id, day);

-- Your app's users. Filled by identify() from the tracker (fill-only) or by
-- POST /api/ingest from your server (authoritative).
create table if not exists sitedata.accounts (
  site_id      text not null references sitedata.sites(id),
  account_id   text not null,
  email        text,
  name         text,
  plan         text,
  signed_up_at timestamptz not null default now(),
  meta         jsonb,
  source       text not null default 'client',   -- client | server
  updated_at   timestamptz not null default now(),
  primary key (site_id, account_id)
);
create index if not exists accounts_signed_up on sitedata.accounts (site_id, signed_up_at desc);
create index if not exists accounts_email     on sitedata.accounts (site_id, lower(email)) where email is not null;

-- Things people did inside your product, reported by your server
-- (POST /api/ingest {type:"event"}). Browser-side ones are events.kind='custom'.
create table if not exists sitedata.account_events (
  id         bigint generated always as identity primary key,
  site_id    text not null references sitedata.sites(id),
  account_id text not null,
  name       text not null,
  detail     text,
  at         timestamptz not null default now()
);
create index if not exists account_events_account on sitedata.account_events (site_id, account_id, at desc);
create index if not exists account_events_at      on sitedata.account_events (site_id, at desc);

-- Money in. One row per successful charge, whatever the provider.
create table if not exists sitedata.payments (
  site_id      text not null references sitedata.sites(id),
  provider     text not null,          -- stripe | razorpay | dodo | manual | ...
  external_id  text not null,          -- the provider's payment id: retries are no-ops
  account_id   text,
  visitor_id   text,                   -- passed through checkout metadata: attribution without sign-in
  email        text,
  amount_minor bigint not null,        -- cents / paise, tax included as charged
  currency     text not null,
  plan         text,
  paid_at      timestamptz not null default now(),
  raw          jsonb,
  created_at   timestamptz not null default now(),
  primary key (site_id, provider, external_id)
);
create index if not exists payments_paid on sitedata.payments (site_id, paid_at desc);

-- Meta ad spend, one row per ad per day.
create table if not exists sitedata.ad_spend (
  site_id            text not null references sitedata.sites(id),
  day                date not null,
  ad_id              text not null,
  ad_name            text,
  adset_name         text,
  campaign_id        text,
  campaign_name      text,
  utm_campaign       text,                 -- parsed from the ad's own link
  utm_content        text,
  spend              numeric(14,2) not null default 0,
  currency           text,
  impressions        integer not null default 0,
  link_clicks        integer not null default 0,
  landing_views      integer not null default 0,
  platform_signups   integer not null default 0,   -- Meta's own pixel claim, for comparison only
  platform_purchases integer not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (site_id, day, ad_id)
);

-- Session replays (Mixpanel), linked by the visitor id the tracker registers.
create table if not exists sitedata.replays (
  site_id     text not null references sitedata.sites(id),
  replay_id   text not null,
  distinct_id text,
  account_id  text,
  visitor_id  text,
  device_id   text,
  started_at  timestamptz not null,
  length_ms   integer,
  updated_at  timestamptz not null default now(),
  primary key (site_id, replay_id)
);
create index if not exists replays_visitor on sitedata.replays (site_id, visitor_id, started_at desc) where visitor_id is not null;
create index if not exists replays_account on sitedata.replays (site_id, account_id, started_at desc) where account_id is not null;

-- First-visit survey answers, one row per browser per survey. `data` holds
-- {question_id: "value" | ["v1","v2"]}, already validated against
-- site.config.js by the collector.
create table if not exists sitedata.answers (
  site_id     text not null references sitedata.sites(id),
  visitor_id  text not null,
  survey      text not null default 'survey',
  data        jsonb not null default '{}',
  skipped_at  smallint,            -- null = finished; n = skipped on step n
  has_account boolean not null default false,
  path        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (site_id, visitor_id, survey)
);
create index if not exists answers_updated on sitedata.answers (site_id, updated_at desc);

-- Fixed-window counters (failed dashboard sign-ins).
create table if not exists sitedata.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);

-- ── small helpers ───────────────────────────────────────────────────────────

create or replace function sitedata.tz(p_site text) returns text
language sql stable as $$
  select coalesce((select timezone from sitedata.sites where id = p_site), 'UTC');
$$;

/* Channel from first principles, the same for every report:
   paid (an ad click id, or a paid medium) > email > direct/campaign (no
   referrer) > organic_social > organic_search > referral. */
create or replace function sitedata.channel(
  p_referrer_host text, p_utm_medium text, p_utm_source text, p_click_source text
) returns text
language plpgsql immutable as $$
declare
  v_medium text := lower(coalesce(p_utm_medium, ''));
  v_source text := lower(coalesce(p_utm_source, ''));
  v_host   text := lower(coalesce(p_referrer_host, ''));
  social constant text[] := array[
    'facebook.com','instagram.com','x.com','twitter.com','t.co','linkedin.com','lnkd.in',
    'reddit.com','news.ycombinator.com','youtube.com','tiktok.com','threads.net',
    'whatsapp.com','t.me','discord.com','discord.gg','pinterest.com','quora.com'];
  search constant text[] := array[
    'google.com','bing.com','duckduckgo.com','yahoo.com','baidu.com','yandex.ru',
    'ecosia.org','brave.com','startpage.com','perplexity.ai','chatgpt.com','kagi.com'];
  h text;
begin
  if coalesce(p_click_source, '') <> '' then return 'paid'; end if;
  if v_medium ~ '^(cpc|ppc|cpm|cpv|paid.*|display|retargeting)$' then return 'paid'; end if;
  if v_medium = 'email' or v_source in ('email', 'newsletter') then return 'email'; end if;
  if v_host = '' then
    return case when v_medium <> '' or v_source <> '' then 'campaign' else 'direct' end;
  end if;
  foreach h in array social loop
    if v_host = h or v_host like '%.' || h then return 'organic_social'; end if;
  end loop;
  foreach h in array search loop
    -- google.com, news.google.com, and the country domains: google.co.in, google.de
    if v_host = h or v_host like '%.' || h or v_host ~ ('(^|\.)' || split_part(h, '.', 1) || '\.[a-z]{2,3}(\.[a-z]{2})?$') then
      return 'organic_search';
    end if;
  end loop;
  return 'referral';
end;
$$;

create or replace function sitedata.rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  integer;
begin
  delete from sitedata.rate_limits where window_start < now() - interval '2 days';
  insert into sitedata.rate_limits (bucket, window_start, count) values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set count = sitedata.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

/* Many fresh visitor ids from ONE hashed IP in a few minutes is a scraper
   rotating cookies, not a family. 3 in 5 minutes, or 2 in 60 seconds. */
create or replace function sitedata.flag_burst(p_ip_hash text) returns integer
language plpgsql as $$
declare
  v_ids text[];
  v_n   integer;
begin
  if coalesce(p_ip_hash, '') = '' then return 0; end if;
  -- Browsers flagged for ANOTHER reason (automation, a data centre - or
  -- doctor's test beacon) do not count: a known bot sharing an office IP
  -- must not drag the next real visitor down with it. Browsers this rule
  -- already flagged DO count, so the third scraper of a burst is caught too.
  select array_agg(visitor_id) into v_ids from sitedata.visitors
   where ip_hash = p_ip_hash and (not is_bot or bot_reason = 'burst')
     and first_seen > now() - interval '5 minutes';
  v_n := coalesce(cardinality(v_ids), 0);
  if v_n < 3 then
    select array_agg(visitor_id) into v_ids from sitedata.visitors
     where ip_hash = p_ip_hash and (not is_bot or bot_reason = 'burst')
       and first_seen > now() - interval '60 seconds';
    v_n := coalesce(cardinality(v_ids), 0);
    if v_n < 2 then return 0; end if;
  end if;
  update sitedata.visitors set is_bot = true, verified = false, bot_reason = 'burst'
   where visitor_id = any (v_ids) and not is_bot;
  update sitedata.sessions set is_bot = true where visitor_id = any (v_ids) and not is_bot;
  update sitedata.events   set is_bot = true where visitor_id = any (v_ids) and not is_bot;
  return v_n;
end;
$$;

-- ── writes (called by the collector and the server-side ingest) ─────────────

/* One beacon: upsert visitor (first touch is written once and never
   changed), upsert session, write the event. */
create or replace function sitedata.ingest(
  p_site text, p_visitor text, p_session text, p_kind text, p_name text, p_path text,
  p_referrer text, p_referrer_host text,
  p_utm_source text, p_utm_medium text, p_utm_campaign text, p_utm_content text, p_utm_term text,
  p_country text, p_region text, p_city text, p_device text, p_browser text, p_os text,
  p_ip_hash text, p_meta jsonb default null, p_hostname text default null,
  p_click_source text default null, p_bot boolean default false
) returns void
language plpgsql as $$
declare
  v_pageview    boolean := (p_kind = 'pageview');
  v_new_visitor boolean := false;
  v_new_session boolean := false;
  v_channel     text;
  v_bot         boolean := coalesce(p_bot, false);
  v_n           integer;
begin
  if not exists (select 1 from sitedata.sites where id = p_site) then
    raise exception 'unknown site %', p_site using errcode = '22023';
  end if;
  -- An exit click for a session we never saw start is noise.
  if p_kind = 'exit' and not exists (select 1 from sitedata.sessions where session_id = p_session) then
    return;
  end if;

  v_channel := sitedata.channel(p_referrer_host, p_utm_medium, p_utm_source, p_click_source);

  insert into sitedata.visitors (
    visitor_id, site_id, ip_hash, first_referrer, first_referrer_host,
    first_utm_source, first_utm_medium, first_utm_campaign, first_utm_content, first_utm_term,
    first_landing_path, first_channel, first_click_source,
    last_referrer_host, last_utm_source, last_utm_campaign,
    country, region, city, device, browser, os, is_bot, bot_reason
  ) values (
    p_visitor, p_site, p_ip_hash, p_referrer, p_referrer_host,
    p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_path, v_channel, p_click_source,
    p_referrer_host, p_utm_source, p_utm_campaign,
    p_country, p_region, p_city, p_device, p_browser, p_os, v_bot,
    case when v_bot then 'automation' end
  ) on conflict (visitor_id) do nothing;
  get diagnostics v_n = row_count;
  v_new_visitor := v_n > 0;

  if v_new_visitor and not v_bot and sitedata.flag_burst(p_ip_hash) > 0 then
    v_bot := true;
  end if;
  if not v_bot then
    select is_bot into v_bot from sitedata.visitors where visitor_id = p_visitor;
    v_bot := coalesce(v_bot, false);
  end if;

  insert into sitedata.sessions (
    session_id, visitor_id, site_id, entry_path, exit_path,
    referrer, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    country, region, city, device, browser, os, hostname, channel, click_source, is_bot,
    pageview_count, event_count
  ) values (
    p_session, p_visitor, p_site, p_path, p_path,
    p_referrer, p_referrer_host, p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_country, p_region, p_city, p_device, p_browser, p_os, p_hostname, v_channel, p_click_source, v_bot,
    case when v_pageview then 1 else 0 end, 1
  ) on conflict (session_id) do update
     set last_event_at  = now(),
         exit_path      = case when v_pageview then coalesce(excluded.exit_path, sitedata.sessions.exit_path)
                               else sitedata.sessions.exit_path end,
         pageview_count = sitedata.sessions.pageview_count + case when v_pageview then 1 else 0 end,
         event_count    = sitedata.sessions.event_count + 1,
         is_bot         = sitedata.sessions.is_bot or v_bot;

  select (event_count = 1) into v_new_session from sitedata.sessions where session_id = p_session;

  update sitedata.visitors
     set last_seen          = now(),
         last_referrer_host = coalesce(p_referrer_host, last_referrer_host),
         last_utm_source    = coalesce(p_utm_source, last_utm_source),
         last_utm_campaign  = coalesce(p_utm_campaign, last_utm_campaign),
         country            = coalesce(country, p_country),
         region             = coalesce(region, p_region),
         city               = coalesce(city, p_city),
         device             = coalesce(device, p_device),
         browser            = coalesce(browser, p_browser),
         os                 = coalesce(os, p_os),
         ip_hash            = coalesce(ip_hash, p_ip_hash),
         first_click_source = coalesce(first_click_source, p_click_source),
         bot_reason         = coalesce(bot_reason, case when v_bot and not is_bot then 'automation' end),
         is_bot             = is_bot or v_bot,
         verified           = verified and not (is_bot or v_bot),
         pageview_count     = pageview_count + case when v_pageview then 1 else 0 end,
         session_count      = session_count + case when v_new_session then 1 else 0 end
   where visitor_id = p_visitor;

  insert into sitedata.events (
    site_id, visitor_id, session_id, kind, name, path, referrer_host,
    utm_source, utm_medium, utm_campaign, country, region, city, device, browser, os, meta,
    hostname, channel, keyword, click_source, is_bot
  ) values (
    p_site, p_visitor, p_session, p_kind, p_name, p_path, p_referrer_host,
    p_utm_source, p_utm_medium, p_utm_campaign, p_country, p_region, p_city, p_device, p_browser, p_os, p_meta,
    p_hostname, v_channel, p_utm_term, p_click_source, v_bot
  );
end;
$$;

/* Five continuous seconds of visible page: the browser belongs to a person.
   Every report counts only verified visitors. */
create or replace function sitedata.verify(p_site text, p_visitor text) returns void
language sql as $$
  update sitedata.visitors set verified = true
   where visitor_id = p_visitor and site_id = p_site and not is_bot;
$$;

/* Credit reading time. Capped twice: 60 s per ping, and never more than the
   wall-clock time since this browser's previous ping (+5 s slack) - a
   replayed or forged ping cannot bank hours. */
create or replace function sitedata.add_time(p_site text, p_visitor text, p_seconds integer) returns void
language plpgsql as $$
declare
  v_day  date := (now() at time zone sitedata.tz(p_site))::date;
  v_secs integer := greatest(0, least(coalesce(p_seconds, 0), 60));
  v_acct text;
begin
  if v_secs = 0 then return; end if;
  select account_id into v_acct from sitedata.visitors
   where visitor_id = p_visitor and site_id = p_site and not is_bot;
  if not found then return; end if;
  insert into sitedata.active_time as t (site_id, visitor_id, day, source, account_id, seconds, pings, last_ping_at)
  values (p_site, p_visitor, v_day, 'tag', v_acct, v_secs, 1, now())
  on conflict (site_id, visitor_id, day, source) do update
     set seconds = least(86400, t.seconds + least(excluded.seconds,
                   greatest(0, ceil(extract(epoch from now() - coalesce(t.last_ping_at, now() - interval '1 hour')))::int + 5))),
         pings = t.pings + 1,
         last_ping_at = now(),
         account_id = coalesce(t.account_id, excluded.account_id);
end;
$$;

/* An account. p_server = true (your server, authenticated) overwrites what it
   is given; false (the browser) only fills blanks - a page can be edited by
   anyone, so it never gets to rename an existing account. */
create or replace function sitedata.upsert_account(
  p_site text, p_account text, p_email text default null, p_name text default null,
  p_plan text default null, p_signed_up_at timestamptz default null, p_meta jsonb default null,
  p_server boolean default false
) returns void
language sql as $$
  insert into sitedata.accounts as a (site_id, account_id, email, name, plan, signed_up_at, meta, source)
  values (p_site, p_account, lower(nullif(btrim(p_email), '')), nullif(btrim(p_name), ''), p_plan,
          coalesce(p_signed_up_at, now()), p_meta, case when p_server then 'server' else 'client' end)
  on conflict (site_id, account_id) do update
     set email        = case when p_server then coalesce(excluded.email, a.email) else coalesce(a.email, excluded.email) end,
         name         = case when p_server then coalesce(excluded.name, a.name)   else coalesce(a.name, excluded.name) end,
         plan         = case when p_server then coalesce(excluded.plan, a.plan)   else a.plan end,
         signed_up_at = case when p_server and p_signed_up_at is not null then p_signed_up_at
                             else least(a.signed_up_at, coalesce(p_signed_up_at, a.signed_up_at)) end,
         meta         = case when p_server then coalesce(excluded.meta, a.meta)   else coalesce(a.meta, excluded.meta) end,
         source       = case when p_server then 'server' else a.source end,
         updated_at   = now();
$$;

/* Link this browser to an account. Only fills a blank: the first account a
   browser signs into is the one its first touch is credited to. */
create or replace function sitedata.identify(
  p_site text, p_visitor text, p_account text,
  p_email text default null, p_name text default null, p_signed_up_at timestamptz default null
) returns void
language plpgsql as $$
begin
  update sitedata.visitors set account_id = coalesce(account_id, p_account)
   where visitor_id = p_visitor and site_id = p_site;
  update sitedata.active_time set account_id = coalesce(account_id, p_account)
   where visitor_id = p_visitor and site_id = p_site;
  perform sitedata.upsert_account(p_site, p_account, p_email, p_name, null, p_signed_up_at, null, false);
end;
$$;

create or replace function sitedata.record_event(
  p_site text, p_account text, p_name text, p_detail text default null, p_at timestamptz default null
) returns void
language sql as $$
  insert into sitedata.accounts (site_id, account_id, source) values (p_site, p_account, 'server')
  on conflict do nothing;
  insert into sitedata.account_events (site_id, account_id, name, detail, at)
  values (p_site, p_account, left(p_name, 120), left(p_detail, 500), coalesce(p_at, now()));
$$;

create or replace function sitedata.record_payment(
  p_site text, p_provider text, p_external_id text, p_amount_minor bigint, p_currency text,
  p_account text default null, p_visitor text default null, p_email text default null,
  p_plan text default null, p_paid_at timestamptz default null, p_raw jsonb default null
) returns boolean
language plpgsql as $$
declare v_new boolean;
begin
  -- The same charge can arrive twice (a provider retry, or two event types
  -- for one payment, only one of which carries your metadata). The second
  -- copy never changes the amount; it only fills what the first left blank.
  insert into sitedata.payments as p (site_id, provider, external_id, account_id, visitor_id, email,
                                      amount_minor, currency, plan, paid_at, raw)
  values (p_site, p_provider, p_external_id, p_account, p_visitor, lower(nullif(btrim(p_email), '')),
          p_amount_minor, upper(p_currency), p_plan, coalesce(p_paid_at, now()), p_raw)
  on conflict (site_id, provider, external_id) do update
     set account_id = coalesce(p.account_id, excluded.account_id),
         visitor_id = coalesce(p.visitor_id, excluded.visitor_id),
         email      = coalesce(p.email, excluded.email),
         plan       = coalesce(p.plan, excluded.plan)
  returning (xmax = 0) into v_new;
  return v_new;
end;
$$;

create or replace function sitedata.save_answers(
  p_site text, p_visitor text, p_survey text, p_data jsonb,
  p_skipped_at smallint default null, p_account boolean default false, p_path text default null
) returns void
language sql as $$
  insert into sitedata.answers as a (site_id, visitor_id, survey, data, skipped_at, has_account, path)
  values (p_site, p_visitor, p_survey, coalesce(p_data, '{}'), p_skipped_at, coalesce(p_account, false), left(p_path, 512))
  on conflict (site_id, visitor_id, survey) do update
     set data        = a.data || excluded.data,
         skipped_at  = excluded.skipped_at,
         has_account = a.has_account or excluded.has_account,
         updated_at  = now();
$$;

-- ── reading blocks ──────────────────────────────────────────────────────────

/* The first touch of every account: its EARLIEST browser's arrival. */
create or replace function sitedata.first_touch(p_site text)
returns table (account_id text, visitor_id text, first_seen timestamptz, channel text,
               referrer_host text, utm_source text, utm_medium text, utm_campaign text,
               utm_content text, landing_path text, click_source text,
               country text, city text, device text)
language sql stable as $$
  select distinct on (v.account_id)
         v.account_id, v.visitor_id, v.first_seen, v.first_channel, v.first_referrer_host,
         v.first_utm_source, v.first_utm_medium, v.first_utm_campaign, v.first_utm_content,
         v.first_landing_path, v.first_click_source, v.country, v.city, v.device
    from sitedata.visitors v
   where v.site_id = p_site and v.account_id is not null and not v.is_bot
   order by v.account_id, v.first_seen;
$$;

/* Every counted payment, with WHO paid and WHICH browser to credit:
   account (given, or matched by email, or the paying browser's account),
   then that account's first browser - else the browser the checkout carried. */
create or replace function sitedata.paid(p_site text)
returns table (paid_at timestamptz, person text, account_id text, visitor_id text,
               amount_minor bigint, currency text, plan text, provider text, external_id text,
               in_currency boolean)
language sql stable as $$
  with s as (select * from sitedata.sites where id = p_site),
  ft as (select f.account_id, f.visitor_id from sitedata.first_touch(p_site) f),
  p as (
    select pm.*,
           coalesce(pm.account_id,
                    (select a.account_id from sitedata.accounts a
                      where a.site_id = pm.site_id and pm.email is not null and lower(a.email) = pm.email
                      order by a.signed_up_at limit 1),
                    (select v.account_id from sitedata.visitors v where v.visitor_id = pm.visitor_id)) as acct
      from sitedata.payments pm, s
     where pm.site_id = p_site
       and not (coalesce(pm.plan, '') = any (s.exclude_plans))
  )
  select p.paid_at,
         coalesce(p.acct, p.visitor_id, 'pay:' || p.provider || ':' || p.external_id),
         p.acct,
         coalesce(ft.visitor_id, p.visitor_id),
         p.amount_minor, p.currency, p.plan, p.provider, p.external_id,
         upper(p.currency) = upper((select currency from s))
    from p left join ft on ft.account_id = p.acct;
$$;

/* Who was active on which day: site events (verified people), reading time,
   and your server's account events. `person` = account id, else browser id. */
create or replace function sitedata.activity(p_site text, p_from timestamptz, p_to timestamptz)
returns table (day date, person text, account_id text, seconds bigint)
language sql stable as $$
  with tz as (select sitedata.tz(p_site) as z),
  raw as (
    select (e.created_at at time zone tz.z)::date as day,
           coalesce(v.account_id, e.visitor_id) as person, v.account_id, 0::bigint as seconds
      from sitedata.events e
      join sitedata.visitors v on v.visitor_id = e.visitor_id
      cross join tz
     where e.site_id = p_site and e.created_at >= p_from and e.created_at < p_to
       and not e.is_bot and v.verified and not v.is_bot
    union all
    select t.day, coalesce(t.account_id, v.account_id, t.visitor_id),
           coalesce(t.account_id, v.account_id), t.seconds::bigint
      from sitedata.active_time t
      left join sitedata.visitors v on v.visitor_id = t.visitor_id
      cross join tz
     where t.site_id = p_site
       and t.day >= (p_from at time zone tz.z)::date
       and t.day <= ((p_to - interval '1 microsecond') at time zone tz.z)::date
       and not coalesce(v.is_bot, false)
    union all
    select (ae.at at time zone tz.z)::date, ae.account_id, ae.account_id, 0
      from sitedata.account_events ae cross join tz
     where ae.site_id = p_site and ae.at >= p_from and ae.at < p_to
  )
  select day, person, max(account_id), sum(seconds)::bigint from raw group by day, person;
$$;

-- ── reports (one per dashboard panel) ───────────────────────────────────────

create or replace function sitedata.window_stats(p_site text, p_from timestamptz, p_to timestamptz)
returns table (visitors bigint, active_people bigint, signed_in_active bigint, avg_dau numeric,
               signups bigint, paying bigint, payments bigint, revenue_minor bigint,
               other_currency_payments bigint, active_seconds bigint, seconds_per_active numeric,
               ad_spend numeric)
language sql stable as $$
  with tz as (select sitedata.tz(p_site) as z),
  act as (select * from sitedata.activity(p_site, p_from, p_to)),
  pay as (select * from sitedata.paid(p_site) where paid_at >= p_from and paid_at < p_to),
  days as (select greatest(1, ((p_to - interval '1 microsecond') at time zone tz.z)::date
                              - (p_from at time zone tz.z)::date + 1) as n from tz)
  select
    (select count(distinct e.visitor_id) from sitedata.events e
       join sitedata.visitors v on v.visitor_id = e.visitor_id
      where e.site_id = p_site and e.created_at >= p_from and e.created_at < p_to
        and not e.is_bot and v.verified and not v.is_bot),
    (select count(distinct person) from act),
    (select count(distinct person) from act where account_id is not null),
    (select round(count(*)::numeric / (select n from days), 1) from (select distinct day, person from act) d),
    (select count(*) from sitedata.accounts a where a.site_id = p_site and a.signed_up_at >= p_from and a.signed_up_at < p_to),
    (select count(distinct person) from pay where in_currency),
    (select count(*) from pay where in_currency),
    (select coalesce(sum(amount_minor), 0)::bigint from pay where in_currency),
    (select count(*) from pay where not in_currency),
    (select coalesce(sum(seconds), 0)::bigint from act),
    (select round(coalesce(sum(seconds), 0)::numeric / nullif(count(distinct person) filter (where seconds > 0), 0), 0) from act),
    (select coalesce(sum(spend), 0) from sitedata.ad_spend s, tz
      where s.site_id = p_site and s.day >= (p_from at time zone tz.z)::date
        and s.day <= ((p_to - interval '1 microsecond') at time zone tz.z)::date);
$$;

create or replace function sitedata.daily(p_site text, p_from timestamptz, p_to timestamptz)
returns table (day date, visitors bigint, active_people bigint, signed_in_active bigint,
               signups bigint, payments bigint, revenue_minor bigint, active_seconds bigint, ad_spend numeric)
language sql stable as $$
  with tz as (select sitedata.tz(p_site) as z),
  d as (select generate_series((p_from at time zone tz.z)::date,
                               ((p_to - interval '1 microsecond') at time zone tz.z)::date,
                               interval '1 day')::date as day from tz),
  act as (select * from sitedata.activity(p_site, p_from, p_to)),
  actd as (select a.day, count(distinct a.person) as n,
                  count(distinct a.person) filter (where a.account_id is not null) as signed,
                  sum(a.seconds) as secs
             from act a group by 1),
  vis as (
    select (e.created_at at time zone tz.z)::date as day, count(distinct e.visitor_id) as n
      from sitedata.events e
      join sitedata.visitors v on v.visitor_id = e.visitor_id cross join tz
     where e.site_id = p_site and e.created_at >= p_from and e.created_at < p_to
       and not e.is_bot and v.verified and not v.is_bot
     group by 1),
  sig as (select (a.signed_up_at at time zone tz.z)::date as day, count(*) as n
            from sitedata.accounts a cross join tz
           where a.site_id = p_site and a.signed_up_at >= p_from and a.signed_up_at < p_to group by 1),
  pay as (select (p.paid_at at time zone tz.z)::date as day, count(*) as n, sum(p.amount_minor) as amt
            from sitedata.paid(p_site) p cross join tz
           where p.in_currency and p.paid_at >= p_from and p.paid_at < p_to group by 1),
  ads as (select s.day, sum(s.spend) as amt from sitedata.ad_spend s where s.site_id = p_site group by 1)
  select d.day, coalesce(vis.n, 0), coalesce(actd.n, 0), coalesce(actd.signed, 0),
         coalesce(sig.n, 0), coalesce(pay.n, 0), coalesce(pay.amt, 0)::bigint,
         coalesce(actd.secs, 0)::bigint, coalesce(ads.amt, 0)
    from d
    left join vis  on vis.day = d.day
    left join actd on actd.day = d.day
    left join sig  on sig.day = d.day
    left join pay  on pay.day = d.day
    left join ads  on ads.day = d.day
   order by d.day;
$$;

/* Where people come from, by FIRST touch: visitors first seen in the range,
   accounts signed up in the range, and money paid in the range, each credited
   to the source that originally brought that person. */
create or replace function sitedata.sources(p_site text, p_from timestamptz, p_to timestamptz, p_dim text)
returns table (value text, visitors bigint, signups bigint, paying bigint, revenue_minor bigint)
language plpgsql stable as $$
#variable_conflict use_column
begin
  if p_dim not in ('channel', 'referrer', 'utm_source', 'utm_campaign', 'utm_content',
                   'landing', 'country', 'city', 'device') then
    raise exception 'unknown dimension %', p_dim using errcode = '22023';
  end if;
  return query
  with
  pick as (
    select x.visitor_id,
           case p_dim
             when 'channel' then x.first_channel when 'referrer' then x.first_referrer_host
             when 'utm_source' then x.first_utm_source when 'utm_campaign' then x.first_utm_campaign
             when 'utm_content' then x.first_utm_content when 'landing' then x.first_landing_path
             when 'country' then x.country when 'city' then x.city when 'device' then x.device end as val
      from sitedata.visitors x where x.site_id = p_site),
  v as (
    select pick.val from pick join sitedata.visitors x on x.visitor_id = pick.visitor_id
     where x.verified and not x.is_bot and x.first_seen >= p_from and x.first_seen < p_to),
  ft as (select f.account_id, pick.val from sitedata.first_touch(p_site) f join pick on pick.visitor_id = f.visitor_id),
  s as (
    select coalesce(ft.val, case when ft.account_id is null then '(not tracked)' end) as val
      from sitedata.accounts a left join ft on ft.account_id = a.account_id
     where a.site_id = p_site and a.signed_up_at >= p_from and a.signed_up_at < p_to),
  p as (
    select coalesce(pick.val, case when pd.visitor_id is null then '(not tracked)' end) as val,
           pd.person, pd.amount_minor
      from sitedata.paid(p_site) pd left join pick on pick.visitor_id = pd.visitor_id
     where pd.in_currency and pd.paid_at >= p_from and pd.paid_at < p_to),
  vals as (select coalesce(val, '(none)') as val from v union select coalesce(val, '(none)') from s
           union select coalesce(val, '(none)') from p)
  select vals.val,
         (select count(*) from v where coalesce(v.val, '(none)') = vals.val),
         (select count(*) from s where coalesce(s.val, '(none)') = vals.val),
         (select count(distinct p.person) from p where coalesce(p.val, '(none)') = vals.val),
         (select coalesce(sum(p.amount_minor), 0) from p where coalesce(p.val, '(none)') = vals.val)::bigint
    from vals
   order by 5 desc, 3 desc, 2 desc
   limit 100;
end;
$$;

/* Each ad's spend beside the people it brought: matched on the ad link's own
   utm_campaign + utm_content against first touch. An ad whose link carries no
   utm_content cannot be matched, and says so (nulls, not zeros). */
create or replace function sitedata.ads(p_site text, p_from timestamptz, p_to timestamptz)
returns table (ad_id text, ad_name text, campaign_name text, utm_campaign text, utm_content text,
               spend numeric, impressions bigint, link_clicks bigint, landing_views bigint,
               platform_signups bigint, platform_purchases bigint,
               visitors bigint, signups bigint, paying bigint, revenue_minor bigint)
language sql stable as $$
  with tz as (select sitedata.tz(p_site) as z),
  a as (
    select s.ad_id, max(s.ad_name) as ad_name, max(s.campaign_name) as campaign_name,
           max(s.utm_campaign) as utm_campaign, max(s.utm_content) as utm_content,
           sum(s.spend) as spend, sum(s.impressions) as imp, sum(s.link_clicks) as clicks,
           sum(s.landing_views) as lpv, sum(s.platform_signups) as psig, sum(s.platform_purchases) as ppur
      from sitedata.ad_spend s cross join tz
     where s.site_id = p_site and s.day >= (p_from at time zone tz.z)::date
       and s.day <= ((p_to - interval '1 microsecond') at time zone tz.z)::date
     group by s.ad_id),
  ft as (select * from sitedata.first_touch(p_site)),
  pay as (select pd.*, v.first_utm_content as uc, v.first_utm_campaign as ucamp
            from sitedata.paid(p_site) pd left join sitedata.visitors v on v.visitor_id = pd.visitor_id
           where pd.in_currency and pd.paid_at >= p_from and pd.paid_at < p_to)
  select a.ad_id, a.ad_name, a.campaign_name, a.utm_campaign, a.utm_content,
         a.spend, a.imp, a.clicks, a.lpv, a.psig, a.ppur,
         case when a.utm_content is null then null else
           (select count(*) from sitedata.visitors v
             where v.site_id = p_site and v.verified and not v.is_bot
               and v.first_seen >= p_from and v.first_seen < p_to
               and v.first_utm_content = a.utm_content
               and v.first_utm_campaign is not distinct from a.utm_campaign) end,
         case when a.utm_content is null then null else
           (select count(*) from sitedata.accounts ac join ft on ft.account_id = ac.account_id
             where ac.site_id = p_site and ac.signed_up_at >= p_from and ac.signed_up_at < p_to
               and ft.utm_content = a.utm_content and ft.utm_campaign is not distinct from a.utm_campaign) end,
         case when a.utm_content is null then null else
           (select count(distinct pay.person) from pay
             where pay.uc = a.utm_content and pay.ucamp is not distinct from a.utm_campaign) end,
         case when a.utm_content is null then null else
           (select coalesce(sum(pay.amount_minor), 0) from pay
             where pay.uc = a.utm_content and pay.ucamp is not distinct from a.utm_campaign)::bigint end
    from a
   order by a.spend desc;
$$;

/* The People table: every account, with what it did and what it paid.
   p_actions = the event names from site.config.js `actions`; counted from
   the browser (custom events of the account's browsers) and the server
   (account_events), returned as {"event": n}. */
create or replace function sitedata.people(p_site text, p_actions text[] default '{}', p_limit integer default 5000)
returns table (account_id text, email text, name text, plan text, signed_up_at timestamptz,
               actions jsonb, seconds_total bigint, seconds_7d bigint, active_days bigint,
               last_active_at timestamptz, devices bigint,
               channel text, referrer_host text, utm_source text, utm_campaign text, utm_content text,
               landing_path text, country text, city text, payments bigint, revenue_minor bigint)
language sql stable as $$
  with tz as (select sitedata.tz(p_site) as z),
  acc as (select * from sitedata.accounts a where a.site_id = p_site
           order by a.signed_up_at desc limit greatest(1, least(coalesce(p_limit, 5000), 20000))),
  ft as (select * from sitedata.first_touch(p_site)),
  vis as (select v.account_id, count(*) as n, max(v.last_seen) as last
            from sitedata.visitors v where v.site_id = p_site and v.account_id is not null and not v.is_bot
           group by 1),
  t as (select at.account_id, sum(at.seconds) as total,
               sum(at.seconds) filter (where at.day > (now() at time zone tz.z)::date - 7) as week,
               max(at.last_ping_at) as last
          from sitedata.active_time at cross join tz
         where at.site_id = p_site and at.account_id is not null group by 1),
  days as (select a.account_id, count(distinct a.day) as n
             from sitedata.activity(p_site, now() - interval '400 days', now() + interval '1 day') a
            where a.account_id is not null group by 1),
  pay as (select pd.account_id, count(*) as n, sum(pd.amount_minor) as amt,
                 (array_agg(pd.plan order by pd.paid_at desc))[1] as plan
            from sitedata.paid(p_site) pd where pd.account_id is not null and pd.in_currency group by 1),
  acts as (
    select x.account_id, x.name, count(*) as n, max(x.at) as last from (
      select v.account_id, e.name, e.created_at as at
        from sitedata.events e join sitedata.visitors v on v.visitor_id = e.visitor_id
       where e.site_id = p_site and e.kind = 'custom' and v.account_id is not null and e.name = any (p_actions)
      union all
      select ae.account_id, ae.name, ae.at from sitedata.account_events ae
       where ae.site_id = p_site
    ) x group by 1, 2),
  actj as (select account_id, jsonb_object_agg(name, n) filter (where name = any (p_actions)) as j, max(last) as last
             from acts group by 1)
  select acc.account_id, acc.email, acc.name, coalesce(acc.plan, pay.plan), acc.signed_up_at,
         coalesce(actj.j, '{}'::jsonb),
         coalesce(t.total, 0)::bigint, coalesce(t.week, 0)::bigint, coalesce(days.n, 0),
         nullif(greatest(coalesce(t.last, '-infinity'), coalesce(vis.last, '-infinity'),
                         coalesce(actj.last, '-infinity')), '-infinity'::timestamptz),
         coalesce(vis.n, 0),
         coalesce(ft.channel, '(not tracked)'), ft.referrer_host, ft.utm_source, ft.utm_campaign, ft.utm_content,
         ft.landing_path, ft.country, ft.city,
         coalesce(pay.n, 0), coalesce(pay.amt, 0)::bigint
    from acc
    left join ft   on ft.account_id = acc.account_id
    left join vis  on vis.account_id = acc.account_id
    left join t    on t.account_id = acc.account_id
    left join days on days.account_id = acc.account_id
    left join pay  on pay.account_id = acc.account_id
    left join actj on actj.account_id = acc.account_id
   order by acc.signed_up_at desc;
$$;

/* One account's story, newest first: pages, clicks out, browser events and
   server events, across every browser it signed in on. */
create or replace function sitedata.person_timeline(p_site text, p_account text, p_limit integer default 400)
returns table (at timestamptz, kind text, detail text, path text, source text)
language sql stable as $$
  select * from (
    select e.created_at, e.kind, e.name, e.path, coalesce(e.utm_source, e.referrer_host, e.click_source)
      from sitedata.events e join sitedata.visitors v on v.visitor_id = e.visitor_id
     where v.account_id = p_account and e.site_id = p_site
    union all
    select ae.at, 'action', ae.name || coalesce(' - ' || ae.detail, ''), null, null
      from sitedata.account_events ae where ae.site_id = p_site and ae.account_id = p_account
    union all
    select p.paid_at, 'payment', p.provider || ' ' || to_char(p.amount_minor / 100.0, 'FM999999999990.00') || ' ' || p.currency
             || coalesce(' - ' || p.plan, ''), null, null
      from sitedata.payments p
     where p.site_id = p_site and (p.account_id = p_account
       or p.visitor_id in (select visitor_id from sitedata.visitors where account_id = p_account)
       or (p.account_id is null and p.email is not null and p.email =
           (select lower(a.email) from sitedata.accounts a where a.site_id = p_site and a.account_id = p_account)))
  ) x
  order by 1 desc
  limit greatest(1, least(coalesce(p_limit, 400), 2000));
$$;

create or replace function sitedata.visitor_timeline(p_site text, p_visitors text[], p_limit integer default 400)
returns table (at timestamptz, kind text, detail text, path text, source text)
language sql stable as $$
  select e.created_at, e.kind, e.name, e.path, coalesce(e.utm_source, e.referrer_host, e.click_source)
    from sitedata.events e
   where e.visitor_id = any (p_visitors) and e.site_id = p_site
   order by 1 desc
   limit greatest(1, least(coalesce(p_limit, 400), 2000));
$$;

/* Live: every browser with a page event or a reading ping in the last N
   minutes, enriched; the server merges them into one row per person. */
create or replace function sitedata.live(p_site text, p_minutes integer default 10)
returns table (signal text, visitor_id text, account_id text, email text, at timestamptz, since timestamptz,
               path text, country text, city text, device text, source text)
language sql stable as $$
  with since as (select now() - make_interval(mins => greatest(1, least(coalesce(p_minutes, 10), 1440))) as t),
  s as (
    select 'page'::text as signal, s.visitor_id, s.last_event_at as at, s.started_at as since, s.exit_path as path,
           coalesce(s.utm_source, s.referrer_host) as src
      from sitedata.sessions s, since
     where s.site_id = p_site and not s.is_bot and s.last_event_at > since.t),
  r as (
    select 'reading'::text, t.visitor_id, t.last_ping_at, ls.started_at, ls.exit_path, null::text
      from sitedata.active_time t
      cross join since
      left join lateral (select x.started_at, x.exit_path from sitedata.sessions x
                          where x.visitor_id = t.visitor_id order by x.last_event_at desc limit 1) ls on true
     where t.site_id = p_site and t.source = 'tag' and t.last_ping_at > since.t),
  both_ as (select * from s union all select * from r)
  select b.signal, b.visitor_id, v.account_id, a.email, b.at, b.since, b.path,
         v.country, v.city, v.device,
         coalesce(b.src, v.first_utm_source, v.first_referrer_host, v.first_channel)
    from both_ b
    join sitedata.visitors v on v.visitor_id = b.visitor_id and not v.is_bot
    left join sitedata.accounts a on a.site_id = p_site and a.account_id = v.account_id
   order by b.at desc
   limit 500;
$$;

/* Everyone who came, newest first, one row per PERSON (account when signed
   in, else browser). Keyset paged on (last_seen, person) so Load more never
   repeats or skips a row while new visitors arrive. */
create or replace function sitedata.visitors_page(
  p_site text, p_before timestamptz default now(), p_person text default null,
  p_limit integer default 25, p_signed_in boolean default false)
returns table (person text, account_id text, email text, visitor_ids text[], first_seen timestamptz,
               last_seen timestamptz, visits bigint, pages bigint, seconds bigint,
               landing_path text, last_path text, channel text, source text,
               city text, country text, device text, replay_id text, replays bigint)
language sql stable as $$
  with t as (
    select t.visitor_id, sum(t.seconds)::bigint as secs, max(t.last_ping_at) as last_ping
      from sitedata.active_time t where t.site_id = p_site group by 1),
  v as (
    select v.*, t.secs, t.last_ping
      from sitedata.visitors v left join t on t.visitor_id = v.visitor_id
     where v.site_id = p_site and v.verified and not v.is_bot),
  people as (
    select coalesce(v.account_id, v.visitor_id) as person,
           max(v.account_id) as acct,
           array_agg(v.visitor_id order by v.first_seen) as vids,
           min(v.first_seen) as first_seen,
           greatest(max(v.last_seen), max(v.last_ping)) as last_seen,
           coalesce(sum(v.secs), 0)::bigint as secs,
           (array_agg(v.first_landing_path order by v.first_seen))[1] as landing,
           (array_agg(v.first_channel order by v.first_seen))[1] as channel,
           (array_agg(coalesce(v.first_utm_content, v.first_utm_campaign, v.first_utm_source, v.first_referrer_host)
                      order by v.first_seen))[1] as source,
           (array_agg(v.city order by v.last_seen desc) filter (where v.city is not null))[1] as city,
           (array_agg(v.country order by v.last_seen desc) filter (where v.country is not null))[1] as country,
           (array_agg(v.device order by v.last_seen desc) filter (where v.device is not null))[1] as device
      from v group by 1),
  page as (
    select * from people p
     where (p.last_seen, p.person) < (coalesce(p_before, now()), coalesce(p_person, ''))
       and (not coalesce(p_signed_in, false) or p.acct is not null)
     order by p.last_seen desc, p.person desc
     limit greatest(1, least(coalesce(p_limit, 25), 100))),
  s as (
    select p.person, count(*)::bigint as visits, coalesce(sum(s.pageview_count), 0)::bigint as pages,
           (array_agg(s.exit_path order by s.last_event_at desc))[1] as last_path
      from page p join sitedata.sessions s on s.visitor_id = any (p.vids) and s.site_id = p_site
     group by 1),
  r as (
    select p.person, count(*)::bigint as n, (array_agg(r.replay_id order by r.started_at desc))[1] as latest
      from page p join sitedata.replays r
        on r.site_id = p_site and ((p.acct is not null and r.account_id = p.acct) or r.visitor_id = any (p.vids))
     group by 1)
  select p.person, p.acct, a.email, p.vids, p.first_seen, p.last_seen,
         coalesce(s.visits, 0), coalesce(s.pages, 0), p.secs,
         p.landing, s.last_path, p.channel, p.source, p.city, p.country, p.device,
         r.latest, coalesce(r.n, 0)
    from page p
    left join s on s.person = p.person
    left join r on r.person = p.person
    left join sitedata.accounts a on a.site_id = p_site and a.account_id = p.acct
   order by p.last_seen desc, p.person desc;
$$;

/* Survey totals in a range: how many saw / answered / finished / skipped,
   and for every question a ranked count of each value (multi-choice answers
   count once per option). Typed "other" text is grouped case-insensitively. */
create or replace function sitedata.answers_summary(
  p_site text, p_survey text, p_shown_event text, p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable as $$
  with o as (
    select a.*, v.account_id
      from sitedata.answers a
      left join sitedata.visitors v on v.visitor_id = a.visitor_id
     where a.site_id = p_site and a.survey = p_survey
       and a.created_at >= p_from and a.created_at < p_to
       and not coalesce(v.is_bot, false)),
  vals as (
    select kv.key as q,
           case when jsonb_typeof(kv.value) = 'array' then el.value else kv.value #>> '{}' end as val
      from o
      cross join lateral jsonb_each(o.data) kv(key, value)
      left join lateral jsonb_array_elements_text(case when jsonb_typeof(kv.value) = 'array' then kv.value else '[]' end) el(value) on true
     where kv.key not like '%\_other' escape '\'
       and (jsonb_typeof(kv.value) <> 'array' or el.value is not null)),
  counted as (select q, val, count(*)::int as n from vals where val is not null and val <> '' group by 1, 2),
  typed as (
    select regexp_replace(kv.key, '_other$', '') as q, min(kv.value #>> '{}') as val, count(*)::int as n
      from o cross join lateral jsonb_each(o.data) kv(key, value)
     where kv.key like '%\_other' escape '\' and coalesce(kv.value #>> '{}', '') <> ''
     group by 1, lower(kv.value #>> '{}'))
  select jsonb_build_object(
    'shown', (select count(distinct e.visitor_id)::int from sitedata.events e
               where e.site_id = p_site and e.kind = 'custom' and e.name = p_shown_event
                 and e.created_at >= p_from and e.created_at < p_to and not e.is_bot),
    'answered',    (select count(*) from o),
    'finished',    (select count(*) from o where skipped_at is null),
    'skipped',     coalesce((select jsonb_object_agg(skipped_at::text, n)
                               from (select skipped_at, count(*)::int as n from o where skipped_at is not null group by 1) x), '{}'),
    'has_account', (select count(*) from o where has_account),
    'signed_in',   (select count(*) from o where account_id is not null),
    'questions',   coalesce((select jsonb_object_agg(q, items) from (
                     select q, jsonb_agg(jsonb_build_object('key', val, 'n', n) order by n desc, val) as items
                       from counted group by q) x), '{}'),
    'typed',       coalesce((select jsonb_object_agg(q, items) from (
                     select q, jsonb_agg(jsonb_build_object('key', val, 'n', n) order by n desc, val) as items
                       from (select * from typed order by n desc limit 200) t group by q) x), '{}')
  );
$$;

create or replace function sitedata.answers_people(
  p_site text, p_survey text, p_before timestamptz default null, p_limit integer default 50, p_q text default null)
returns table (visitor_id text, account_id text, email text, data jsonb, skipped_at smallint, has_account boolean,
               city text, country text, device text, path text, created_at timestamptz, updated_at timestamptz)
language sql stable as $$
  select a.visitor_id, v.account_id, ac.email, a.data, a.skipped_at, a.has_account,
         v.city, v.country, v.device, a.path, a.created_at, a.updated_at
    from sitedata.answers a
    left join sitedata.visitors v on v.visitor_id = a.visitor_id
    left join sitedata.accounts ac on ac.site_id = p_site and ac.account_id = v.account_id
   where a.site_id = p_site and a.survey = p_survey
     and not coalesce(v.is_bot, false)
     and a.updated_at < coalesce(p_before, now() + interval '1 minute')
     and (nullif(btrim(p_q), '') is null
          or a.data::text ilike '%' || btrim(p_q) || '%'
          or a.visitor_id ilike '%' || btrim(p_q) || '%'
          or ac.email ilike '%' || btrim(p_q) || '%')
   order by a.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 5000));
$$;

/* Optional retention: delete raw events/sessions older than p_keep_days.
   Off unless you call it (cron does when RETAIN_DAYS is set). Reports read
   raw events, so pruning shortens how far back "All time" can see. */
create or replace function sitedata.prune(p_site text, p_keep_days integer) returns integer
language plpgsql as $$
declare v_n integer;
begin
  if p_keep_days is null or p_keep_days < 30 then raise exception 'keep at least 30 days'; end if;
  delete from sitedata.events where site_id = p_site and created_at < now() - make_interval(days => p_keep_days);
  get diagnostics v_n = row_count;
  delete from sitedata.sessions where site_id = p_site and last_event_at < now() - make_interval(days => p_keep_days);
  return v_n;
end;
$$;
