# AGENTS.md — set up Data 1-1 for a website

You are a coding agent. Your owner gave you this repository so you can give **their** website its own analytics: who is on the site right now, where every visitor came from, what they did, how long they read, who signed up, who paid, and what each ad earned. This file is the whole procedure. Follow it top to bottom.

**Done means** all four of these are true:
1. The dashboard is deployed at a URL the owner can open.
2. The owner can sign in, and nobody else can.
3. The owner's site sends beacons through a same-origin proxy.
4. `npm run doctor -- --url <dashboard> --site <site>` ends with `✓ all good`.

**For a local trial** (the owner says "don't deploy yet"), use PGlite and `ADMIN_PASSWORD`, and treat `node server.js` on localhost as the deployment. Steps 4 and 5 are then skipped; everything else applies.

## Rules

- **Never commit secrets.** `.env` is gitignored. On a host, secrets go in its environment settings.
- **Never weaken the sign-in gate.** Don't add a default allowlist, don't skip the check on any `/api/query` report, and don't make `/api/collect` return data.
- **Ask the owner before anything that costs money or touches production.** That means creating paid resources, changing DNS, or editing their live site's config.
- **Don't invent values.** If you can't find a domain, an account id or a secret, ask the owner for it.
- **Keep the owner's site working.** Add the tracker and the proxy rules; change nothing else on the site.
- **Run `npm test` after any code change you make here.**

## 0. Try it locally first (2 minutes, nothing to install but Node 18+)

```
npm install
npm run seed-demo
npm run dev
```

Open http://localhost:5180 and sign in with the password `dev`. This shows the dashboard on 60 days of demo data, using PGlite, a real Postgres running in-process from `./.data`. If it works, the code is fine and every later problem is configuration.

**Before the real setup:** stop `npm run dev` and `rm -rf .data`, so the demo's rows and its `mysite` site don't mix with the owner's.

**PGlite is one process at a time.** While `npm run dev` or `node server.js` holds `./.data`, `migrate` and `seed-demo` refuse to open it: stop the server first. `doctor` checks through the server when you pass `--url`. Real Postgres has no such limit.

## 1. Ask the owner

Ask these in one message. Each has a default you can propose.

| # | Question | Goes to | Default |
|---|---|---|---|
| 1 | The site's domain(s)? | `site.domains` | — (required) |
| 2 | What should the dashboard call it? | `site.name` | the domain |
| 3 | Your timezone? This decides where "today" starts. | `site.timezone` (IANA name) | `UTC` |
| 4 | Currency of your revenue and ad spend? | `site.currency` | `USD` |
| 5 | Which Google account(s) may open the dashboard? | `ADMIN_EMAILS` | — (or use a password) |
| 6 | Where should the dashboard live? | step 5 | Vercel at `data.<domain>` |
| 7 | Which Postgres? Neon, Supabase, Railway, your own, or let me create one? | `DATABASE_URL` | Neon free tier |
| 8 | Where is the site hosted, and with which framework? | step 6 | — |
| 9 | Do users sign in? With what (Supabase, Firebase, Clerk, Auth0, NextAuth, your own)? | step 7a | — |
| 10 | Do you take payments? With Stripe, Razorpay, Dodo, or another provider? | step 7c, `modules.revenue` | revenue on |
| 11 | Do you run Meta ads? If so, the ad account id. | step 7d, `modules.ads` | off |
| 12 | Which in-product actions matter (e.g. "created a project")? | `actions` | none |
| 13 | Do you use Mixpanel Session Replay? | step 7e, `modules.replays` | off |
| 14 | Do you want a short "what brings you here" question for first-time visitors? | step 7f, `modules.survey` | off |

Choose these yourself unless the owner cares:
- `site.id`: the domain without its TLD, lowercase with dashes, e.g. `acme-notes`. It's stored on every row, so don't change it later.
- `locale`: matches the owner's country (`en-US`, `en-GB`, `en-IN`, `de-DE`).
- `startDate`: today.
- `dashboard.logoLetter`: the site name's first letter.

Turn `modules.revenue` off if they take no payments yet; it can be switched on later.

## 2. Get a Postgres database

You need any Postgres 14 or later. Use the **pooled** connection string on serverless hosts such as Vercel.

- **Neon** (free): create a project at https://console.neon.tech, then Connection Details → "Pooled connection". Copy the string; it already ends in `?sslmode=require`.
- **Supabase**: Project Settings → Database → Connection string → "Transaction pooler" (port 6543). All tables live in their own `sitedata` schema, so they never collide with the app's tables.
- **Railway / Render / your own server**: use the `DATABASE_URL` it gives you.
- **The app already has Postgres**: you can reuse it. Everything stays inside the `sitedata` schema, and `drop schema sitedata cascade` removes it all.

## 3. Configure and migrate

1. Edit `site.config.js` with the answers from step 1. It holds no secrets; every field is commented.
2. `cp .env.example .env`, then fill in `DATABASE_URL`, `ADMIN_EMAILS` and/or `ADMIN_PASSWORD`, and these four, each from its own `npm run secret`:
   - `SESSION_SECRET`
   - `ANALYTICS_SALT`
   - `INGEST_KEY`
   - `CRON_SECRET`

   If you use `ADMIN_PASSWORD`, generate that with `npm run secret` too, and give it to the owner.
3. Run `npm run migrate`. It applies `sql/schema.sql` and registers the site. It's safe to re-run. **After every change to `site.config.js`**, re-run it, then `npm run build` and restart the server (on Vercel, redeploy): the config is read at boot and bundled into the dashboard.
4. Run `npm run doctor`. Sections 1–3 should pass.

## 4. Sign-in (Google)

The dashboard uses Google Identity Services. You need a client id only; there is no client secret and no redirect URL.

1. https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID**. Pick any project, or create one.
2. If asked, configure the consent screen: External, the app name, and the owner's email. Testing mode is fine; add the admin emails as test users.
3. Application type **Web application**. Under **Authorized JavaScript origins**, add the dashboard URL, e.g. `https://data.example.com`. For local use also add `http://localhost:5180` and `http://localhost`.
4. Put the client id (`…apps.googleusercontent.com`) in `GOOGLE_CLIENT_ID`.

`ADMIN_EMAILS` is checked on every request, not only at sign-in, so removing an email locks that person out. If the owner doesn't want Google, set `ADMIN_PASSWORD` instead. Both can be set.

## 5. Deploy the dashboard

### A. Vercel (recommended)

```
npm i -g vercel
vercel link
vercel env add DATABASE_URL production
vercel env add SESSION_SECRET production
vercel env add ADMIN_EMAILS production
vercel env add GOOGLE_CLIENT_ID production
vercel env add ANALYTICS_SALT production
vercel env add INGEST_KEY production
vercel env add CRON_SECRET production
vercel env add NODEJS_HELPERS production
vercel deploy --prod
```

- **Run `vercel link` from this folder**, and create a new project for it.
- **Add the remaining variables the same way**: any webhook, Meta or Mixpanel ones you need.
- **Set `NODEJS_HELPERS` to `0`.** Payment webhook signatures need the raw request body.
- **`vercel.json` already declares** the functions, the daily cron (02:30 UTC; Vercel sends `CRON_SECRET` automatically) and the security headers.
- **Add a domain:** Vercel → Project → Settings → Domains → `data.<domain>`. Then add that origin to the Google client (step 4).

### B. Any Node host or Docker (Railway, Render, Fly.io, a VPS)

```
docker build -t data-1-1 .
docker run -p 8787:8787 --env-file .env data-1-1
```

- **Without Docker:** `npm ci && npm run build && npm run migrate && node server.js`.
- **The server** serves the dashboard, `/api/*` and `/t.js`, and runs the daily job itself. If the platform has its own cron calling `GET /api/cron` with `Authorization: Bearer $CRON_SECRET`, set `DISABLE_INTERNAL_CRON=1`.
- **Behind your own load balancer**, set `TRUST_PROXY=1`.

Then check the deployment:

```
npm run doctor -- --url https://data.example.com
```

## 6. Install the tracker on the owner's site

Add one tag to every page, in the `<head>`. In an SPA, the root layout is enough.

```html
<script defer src="/ke.js" data-endpoint="/ke"></script>
```

Add **two same-origin proxy rules** on the owner's site, so ad blockers don't see an analytics host:

| Path on the owner's site | Proxies to |
|---|---|
| `/ke.js` | `https://data.example.com/t.js` |
| `/ke` | `https://data.example.com/api/collect` |

**The proxy must forward the visitor's IP** in an `x-client-ip` header. Without it, every visitor looks like one cloud address, everyone is flagged as a bot, and the dashboard shows nobody. `npm run doctor` catches this. The one exception: a site on Vercel rewriting to a dashboard on Vercel forwards the IP automatically.

**Vercel or Next.js on Vercel**: in `vercel.json` (or `next.config.js` → `async rewrites()`):
```json
{ "rewrites": [
  { "source": "/ke.js", "destination": "https://data.example.com/t.js" },
  { "source": "/ke", "destination": "https://data.example.com/api/collect" }
] }
```

**Next.js, self-hosted**: create `app/ke/route.js` like this (and add a `/ke.js` route the same way, or use the direct tag below):
```js
export async function POST(req) {
  const r = await fetch("https://data.example.com/api/collect", {
    method: "POST", body: await req.text(),
    headers: { "content-type": "text/plain", "user-agent": req.headers.get("user-agent") || "",
               "x-client-ip": (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() },
  });
  return new Response(null, { status: r.status });
}
```

**Netlify**: `netlify.toml`:
```toml
[[redirects]]
  from = "/ke.js"
  to = "https://data.example.com/t.js"
  status = 200
[[redirects]]
  from = "/ke"
  to = "https://data.example.com/api/collect"
  status = 200
```
Netlify passes the visitor's address to proxied requests as `x-nf-client-connection-ip`. Set `CLIENT_IP_HEADER=x-nf-client-connection-ip` on the dashboard and redeploy. If doctor still reports one shared IP, use a Netlify Edge Function on `/ke` that forwards the request with `x-client-ip: context.ip`.

**Cloudflare (Worker on the site's zone)**:
```js
export default { async fetch(req) {
  const url = new URL(req.url);
  const target = url.pathname === "/ke.js" ? "https://data.example.com/t.js" : "https://data.example.com/api/collect";
  const h = new Headers(req.headers);
  h.set("x-client-ip", req.headers.get("cf-connecting-ip") || "");
  h.set("x-client-country", req.cf?.country || ""); h.set("x-client-city", req.cf?.city || "");
  return fetch(target, { method: req.method, headers: h, body: req.method === "POST" ? await req.text() : undefined });
} };
```
Route `example.com/ke*` to it.

**nginx**:
```nginx
location = /ke.js { proxy_pass https://data.example.com/t.js; proxy_ssl_server_name on; }
location = /ke    { proxy_pass https://data.example.com/api/collect; proxy_ssl_server_name on;
                    proxy_set_header Host data.example.com; proxy_set_header X-Client-Ip $remote_addr; }
```

**Express**: a route `app.post("/ke", express.text({ type: "*/*" }), …)` that forwards `req.body` with `x-client-ip: req.ip`, as in the Next.js example.

**Plain Node (`node:http`) or anything else**: [`scripts/example-site.mjs`](scripts/example-site.mjs) is a complete working reference: a static site with both proxy routes and the `x-client-ip` header. `npm run example` runs it against a local dashboard.

**Staging, previews and localhost**: the tracker reports the page's hostname, and beacons from a hostname that isn't in `site.domains` are dropped. That's on purpose: a copied tag can't write into your data. To test a copy on another host, set the real domain on the tag with `data-domain="example.com"`; doctor reads it too. Don't add `localhost` to `site.domains`.

**If no proxy is possible**, load it directly: `<script defer src="https://data.example.com/t.js"></script>`. It works, but browsers with ad blockers won't be counted.

**Content-Security-Policy**: with the proxy, nothing changes. When loading directly, add the dashboard origin to `script-src` and `connect-src`.

Check it with `npm run doctor -- --url https://data.example.com --site https://example.com`. This sends one test beacon through the site's `/ke`, flagged as a bot so it's never counted, and confirms it reached the database.

## 7. Connect what matters

### 7a. Who is signed in (identify)

Call `siteData.identify` once the user is known: on page load and on every sign-in. It's safe to repeat.

```js
window.siteData?.identify(user.id, { email: user.email, name: user.name });
```

- **Supabase**: `supabase.auth.onAuthStateChange((_e, s) => s && siteData?.identify(s.user.id, { email: s.user.email }))`.
- **Firebase**: `onAuthStateChanged(auth, (u) => u && siteData?.identify(u.uid, { email: u.email, name: u.displayName }))`.
- **Clerk**: `useUser()` → `user.id`, `user.primaryEmailAddress?.emailAddress`.
- **NextAuth / Auth0 / your own auth**: whatever stable user id you already have.

**The tag is `defer`, so inline scripts in the page run before it exists.** Wrap every call:
```js
function sd(fn) {
  if (window.siteData) fn(window.siteData);
  else addEventListener("DOMContentLoaded", () => window.siteData && fn(window.siteData));
}
sd((s) => s.identify(user.id, { email: user.email }));
```
Code in a bundled app that runs after hydration can call `window.siteData?.identify(...)` directly.

**No backend?** The browser can still record sign-up time: `identify(id, { email, signedUpAt: new Date().toISOString() })` at the moment of sign-up, plus `track("account_created")`. Your server, when you have one, remains the better source.

The browser can only **fill in** missing details. Your server is authoritative: at sign-up, send the account so "Signups" counts the real date.

```
curl -X POST https://data.example.com/api/ingest \
  -H "Authorization: Bearer $INGEST_KEY" -H "content-type: application/json" \
  -d '{"type":"account","account_id":"user_123","email":"a@b.com","name":"Ann","signed_up_at":"2026-10-01T10:00:00Z"}'
```

**Existing users:** backfill them in batches of up to 500 with `{"items":[{"type":"account",…}, …]}`. Otherwise everyone who identifies on the first day counts as a signup that day.

### 7b. What they do (actions)

List the actions in `site.config.js` under `actions: [{ event: "project_created", label: "Projects" }]`. Each one gets a column in People, counts as being active, and shows in that person's timeline.

Send them from the browser:
```js
siteData.track("project_created", { template: "blank" })
```

Or, more reliably, from your server:
```
POST /api/ingest {"type":"event","account_id":"user_123","name":"project_created","detail":"blank"}
```

Any other `siteData.track()` call is recorded too, and shows in timelines.

### 7c. Payments (`modules.revenue`, on by default)

**Attribution:** at checkout, put these in the payment's metadata (Stripe `metadata`, or `subscription_data.metadata` for subscriptions; Razorpay `notes`; Dodo `metadata`):
- `account_id`: your user id
- `site_visitor_id`: `window.siteData.visitorId()`, read in the browser
- `plan`

Then a payment is credited to the ad or link that first brought the buyer, even if they never signed in. A payment with only an email is matched to the account with that email.

| Provider | Webhook URL | Events | Secret |
|---|---|---|---|
| Stripe | `https://data.example.com/api/webhook?provider=stripe` | `checkout.session.completed`, `invoice.paid` | signing secret → `STRIPE_WEBHOOK_SECRET` |
| Razorpay | `…/api/webhook?provider=razorpay` | `payment.captured`, `subscription.charged` | webhook secret → `RAZORPAY_WEBHOOK_SECRET` |
| Dodo Payments | `…/api/webhook?provider=dodo` | `payment.succeeded` | `whsec_…` → `DODO_WEBHOOK_SECRET` |
| Anything else | your server → `POST /api/ingest {"type":"payment","provider":"paddle","external_id":"…","amount_minor":4900,"currency":"USD","account_id":"…"}` | | `INGEST_KEY` |

- **Duplicates:** each charge is counted once, by the provider's payment id, so retries and duplicate events never double-count.
- **Units:** amounts are in the currency's minor unit, cents or paise, tax included as charged.
- **Other currencies:** payments in a currency other than `site.currency` are kept but not added to Revenue; the tile says how many.
- **Exclusions:** use `excludePlans` for products on the same payment account that aren't this site.

### 7d. Meta ad spend (`modules.ads`)

1. In Meta Business Settings → System users, create one, give it the ad account, and generate a token with `ads_read`. Put it in `META_ADS_TOKEN`, and `act_<id>` in `META_AD_ACCOUNT`.
2. Set `modules.ads.enabled: true`. If the account runs other brands, set `campaignMatch` (a regex on the campaign name).
3. **Every ad's link must carry `utm_campaign` and `utm_content`**, e.g. `?utm_source=meta&utm_medium=paid&utm_campaign=launch&utm_content=video_1`. That's how the dashboard puts each ad's spend beside the visitors, signups and revenue it brought. An ad without `utm_content` shows "cannot match people".
4. Spend is pulled daily (the last 7 days, because Meta revises them), and again when the dashboard opens on data more than 2 hours old.

### 7e. Session replays (`modules.replays`, Mixpanel)

1. The site needs Mixpanel with Session Replay. Right after `mixpanel.init(...)`, register the tracker's visitor id on every event:
   ```js
   mixpanel.register({ site_visitor_id: window.siteData?.visitorId() });
   ```
   For signed-in users, also call `mixpanel.identify(user.id)`, using the same id you pass to `siteData.identify`.
2. Mixpanel → Organization settings → Service accounts: create one with access to the project. Set `MIXPANEL_SA_USER`, `MIXPANEL_SA_SECRET` and `MIXPANEL_PROJECT_ID`.
3. Set `modules.replays: { enabled: true, region: "us" | "eu" | "in" }`. **The region must match the project's data residency**; the wrong region returns zero rows with no error.
4. Replays sync nightly for the two days before today; Mixpanel's export refuses today. The Visitors list then shows a "Watch" link.

### 7f. First-visit survey (`modules.survey`)

1. Define the questions in `site.config.js`:
   - `id`, `label`
   - `type`: `"single"`, `"multi"` or `"text"`
   - `options: { key: "Label" }`
   - `other: true` to allow a typed answer under the `other` key

   The collector drops any answer the config doesn't allow.
2. In the site, build the UI however you like. When it appears, call `siteData.track("survey_shown")`. When answered:
   ```js
   siteData.answer({ goal: ["learn", "other"], goal_other: "A podcast", role: "student" }, { skipped: 2 /* step skipped, if any */ });
   ```
3. The dashboard shows how many saw the survey, answered, finished or skipped, a ranked table per question, and everyone who answered.

## 8. Verify and hand over

```
npm run doctor -- --url https://data.example.com --site https://example.com
```

Fix every `✗`. Then open the site in a normal browser, stay 5 seconds, and click two pages. The dashboard's "On the site now" should show the visit within 5 seconds. Automated browsers are flagged on purpose: Playwright and Selenium set `navigator.webdriver`, and headless Chrome says so in its user agent.

Tell the owner:
- the dashboard URL
- who can sign in
- what each module needs from them that you couldn't do yourself: Meta token, webhook secrets, existing-user backfill
- `localStorage.sd_exclude = "1"` in their own browser's console stops their own visits being counted

## 9. Troubleshooting

| Symptom | Cause, and fix |
|---|---|
| Dashboard shows 0 visitors, but beacons return 204 | (a) The domain isn't in `site.domains`, or the tag's `data-domain` is wrong, so the beacon is dropped. (b) The proxy doesn't forward `x-client-ip`, so everyone is flagged as a bot; doctor says so. (c) Visits under 5 seconds: those browsers never "engage" and aren't counted. (d) The burst rule: several new browsers from one IP within minutes are flagged, which can happen when testing from one machine. Wait a few minutes between test browsers. |
| `migrate` or `seed-demo` says the folder "is open in another process" | PGlite is one process at a time. Stop `node server.js` or `npm run dev`, run the command, start it again. |
| `/ke` returns 404 or 405 on the site | The proxy rule is missing, or it rewrites `/ke` to `/t.js`. `/ke` → `/api/collect`, `/ke.js` → `/t.js`. |
| Google button: "origin mismatch" or nothing happens | The dashboard origin isn't in the client's Authorized JavaScript origins (step 4). Changes take a few minutes. |
| "not in ADMIN_EMAILS" | Add the email. On Vercel, redeploy after changing environment variables. |
| Webhook returns 400 "bad signature" | Wrong secret; Stripe uses a different secret per endpoint and per mode. On Vercel, set `NODEJS_HELPERS=0` and redeploy. |
| Revenue is missing a payment | It's in another currency (see the tile's tooltip), its plan is in `excludePlans`, or it's an event type that isn't counted (table in 7c). |
| "Today" is empty right after midnight | Days use `site.timezone`. Check it, then `npm run migrate`. |
| Ad spend never appears | `META_*` aren't set, the cron isn't authorised (`CRON_SECRET`), or `campaignMatch` excludes the campaigns. Click "refresh" on the Ads card to see the error. |
| Your own visits inflate the numbers | Run `localStorage.sd_exclude = "1"` in your browser. |

## Reference

### How each number is defined

| Number | Definition |
|---|---|
| **Visitors** | Browsers with at least one non-bot event in the range that have ever stayed 5 seconds on a visible page (`engage`). |
| **People active** | One per account, or per browser for anonymous visitors, with any site event, reading time or server action in the range. |
| **Live now** | People with a page event or a reading ping in the last `liveMinutes`. |
| **Time on site** | Seconds that were both visible and in use (input in the last 60 s), sent every ~30 s. The server caps each ping at 60 s and at the real time elapsed. |
| **Signups** | Accounts whose `signed_up_at` falls in the range. |
| **Paying, Revenue** | Distinct payers and the sum of charges in `site.currency`. |
| **Where people come from** | First touch: the source of a person's first visit gets credit for their signup and their money, whenever those happen. |
| **Channel** | Paid (an ad click id or a paid `utm_medium`), then Email, Direct or Campaign (no referrer), Social, Search, Referral. |

### Bots

Bots are flagged, never deleted. A browser is flagged when:
- its user agent says crawler;
- `navigator.webdriver` is set;
- its address is in a published Meta, AWS or GCP range (`npm run ranges` refreshes the list);
- or it's part of a burst: 3 new ids from one hashed IP within 5 minutes.

### Privacy

- Raw IPs are never stored, only a salted hash.
- Query strings are dropped from paths.
- Only the referrer's host is kept.
- Ad click ids are kept by name only.
- Do Not Track is honoured before any id is created.

### Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/collect` | public; always 204 | Beacons from `t.js` |
| `GET /api/query?r=…` | session cookie | Every dashboard report |
| `GET/POST/DELETE /api/auth` | — | Sign-in state, sign in, sign out |
| `POST /api/ingest` | `Bearer INGEST_KEY` | `account`, `identify`, `event` and `payment` items from your server |
| `POST /api/webhook?provider=` | provider signature | Stripe, Razorpay, Dodo |
| `GET /api/cron` | `Bearer CRON_SECRET` | Daily: ads, replays, retention |

### Data

All of it lives in the `sitedata` schema (`sql/schema.sql`):
- `visitors`
- `sessions`
- `events`
- `active_time`
- `accounts`
- `account_events`
- `payments`
- `ad_spend`
- `replays`
- `answers`

Reports are SQL functions you can query yourself, e.g. `select * from sitedata.window_stats('mysite', now() - interval '7 days', now())`.
