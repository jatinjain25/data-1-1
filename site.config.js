/* ═══════════════════════════════════════════════════════════════════════════
   site.config.js - every choice that is about YOUR site, in one file.

   This file is imported by the server AND bundled into the dashboard, so it
   must never hold a secret. Secrets live in .env (see .env.example).

   AFTER CHANGING IT: `npm run migrate` (the database keeps a copy of
   timezone/currency/domain), then rebuild and restart - `npm run build` and
   restart `node server.js`, or redeploy on Vercel.

   Agents: AGENTS.md step 3 says how to fill this in. Every field has a
   working default except `site.domains`.
   ═══════════════════════════════════════════════════════════════════════════ */

export default {
  site: {
    /* A short id for this site. Letters, digits, dash. Stored on every row. */
    id: "mysite",
    /* What the dashboard calls it. */
    name: "My Site",
    /* Every domain the tracker runs on, without "www." or https:// -
       www.<domain> is accepted automatically. Beacons from anything else are
       dropped, so a copied tag on someone else's site cannot write here. */
    domains: ["example.com"],
    /* IANA timezone. Decides where "today" starts and which calendar day a
       visit, a payment or an ad's spend lands on. */
    timezone: "UTC",
    /* ISO 4217 currency of your revenue and ad spend. Amounts are stored in
       the currency's minor unit (cents, paise). */
    currency: "USD",
    /* Number and date formatting in the dashboard, e.g. "en-US", "en-IN", "de-DE". */
    locale: "en-US",
    /* When your data starts - the "All time" range begins here. */
    startDate: "2026-01-01",
  },

  dashboard: {
    /* The letter in the square logo, and its colour. */
    logoLetter: "D",
    brandColor: "#2a78d6",
    /* "On the site now" counts people with any activity in this many minutes. */
    liveMinutes: 10,
  },

  /* Events that matter in your product. Each becomes a column in the People
     table, counts as "being active", and appears in a person's timeline.
     Send them from the browser - siteData.track("question_asked") - or from
     your server - POST /api/ingest {type:"event", ...}. Empty is fine. */
  actions: [
    // { event: "question_asked", label: "Questions" },
    // { event: "project_created", label: "Projects" },
  ],

  modules: {
    /* Payments from Stripe / Razorpay / Dodo webhooks, or your own server. */
    revenue: {
      enabled: true,
      /* Plans whose payments are NOT counted (another product on the same account). */
      excludePlans: [],
    },

    /* Meta (Facebook/Instagram) ad spend, pulled daily, matched to the people
       each ad brought by the utm_campaign/utm_content on the ad's link. */
    ads: {
      enabled: false,
      /* Only campaigns whose name matches this regex are counted. "" = all. */
      campaignMatch: "",
    },

    /* "Watch replay" links from Mixpanel Session Replay. Needs Mixpanel on the
       site and a service account (see AGENTS.md, step 7e). */
    replays: {
      enabled: false,
      region: "us", // "us" | "eu" | "in"
    },

    /* A short first-visit questionnaire - what visitors want. Your site shows
       the questions; siteData.answer(...) sends the answers. The dashboard
       draws a ranked table per question. */
    survey: {
      enabled: false,
      /* The custom event your site fires when the questions are shown, so the
         dashboard can say how many saw them vs answered. */
      shownEvent: "survey_shown",
      questions: [
        // {
        //   id: "goal", label: "What brings you here", type: "multi",
        //   options: { learn: "Learning", hire: "Hiring", other: "Other" },
        //   other: true,              // accepts a typed answer under "other"
        // },
        // { id: "role", label: "Role", type: "single",
        //   options: { student: "Student", pro: "Professional" } },
      ],
    },
  },
};
