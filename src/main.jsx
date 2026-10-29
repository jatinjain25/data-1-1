import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import config from "../site.config.js";
import { authState, report, signInWithGoogle, signInWithPassword, signOut } from "./lib/api.js";
import {
  RANGES, TZ, adRates, ago, channelLabel, dash, delta, duration, money, money0, money2, moneyMajor, num, pct2,
} from "./lib/format.js";
import Bars from "./components/Bars.jsx";
import People from "./components/People.jsx";
import Visitors from "./components/Visitors.jsx";
import { SurveyPeople, SurveySummary } from "./components/Survey.jsx";
import "./app.css";

const SITE = config.site;
const DASH = { logoLetter: "D", brandColor: "#2a78d6", liveMinutes: 10, ...(config.dashboard || {}) };
const MOD = {
  revenue: config.modules?.revenue?.enabled !== false,
  ads: !!config.modules?.ads?.enabled,
  survey: !!config.modules?.survey?.enabled,
};
document.documentElement.style.setProperty("--brand", DASH.brandColor);
document.title = `${SITE.name} · Data`;

/* ── stat strip ────────────────────────────────────────────────────────── */

function Stat({ label, value, cur, prev, hint, invert }) {
  const d = delta(cur, prev);
  const good = d == null ? null : invert ? d < 0 : d > 0;
  return (
    <div className="stat" title={hint || ""}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className={`stat-delta ${good == null ? "" : good ? "up" : "down"}`}>
        {d == null ? " " : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}%`}
      </span>
    </div>
  );
}

function Strip({ c, p, live }) {
  if (!c) return null;
  const P = p || {};
  const n = live ? live.count : null;
  const stats = [
    <div className="stat live-stat" key="live" title={`Visitors with activity in the last ${DASH.liveMinutes} minutes`}>
      <span className="stat-label"><i className={n ? "dot on" : "dot"} />Live now</span>
      <span className="stat-value">{n == null ? dash : num(n)}</span>
      <span className="stat-delta">on {SITE.domains[0]}</span>
    </div>,
    <Stat key="v" label="Visitors" value={num(c.visitors)} cur={c.visitors} prev={P.visitors}
          hint="Browsers that stayed at least 5 seconds - bots and data-centre traffic removed" />,
    <Stat key="a" label="People active" value={num(c.active_people)} cur={c.active_people} prev={P.active_people}
          hint={`Used the site or your product in this range - ${num(c.signed_in_active)} signed in`} />,
    <Stat key="s" label="Signups" value={num(c.signups)} cur={c.signups} prev={P.signups} />,
  ];
  if (MOD.revenue) {
    stats.push(
      <Stat key="p" label="Paying" value={num(c.paying)} cur={c.paying} prev={P.paying} hint={`${num(c.payments)} payments`} />,
      <Stat key="r" label="Revenue" value={money(c.revenue_minor)} cur={c.revenue_minor} prev={P.revenue_minor}
            hint={Number(c.other_currency_payments) ? `${num(c.other_currency_payments)} payments in another currency are not in this total` : "As charged, tax included"} />,
    );
  }
  stats.push(<Stat key="t" label="Time per person" value={duration(c.seconds_per_active)}
                   cur={c.seconds_per_active} prev={P.seconds_per_active}
                   hint="Visible, in-use time on the site, averaged over people with any" />);
  if (MOD.ads) stats.push(<Stat key="ad" label="Ad spend" value={moneyMajor(c.ad_spend)} cur={c.ad_spend} prev={P.ad_spend} invert />);
  return <div className="strip" style={{ "--cols": stats.length }}>{stats}</div>;
}

/* ── where from ────────────────────────────────────────────────────────── */

const DIM_TABS = [
  ["channel", "Channel"], ["utm_source", "Source"], ["utm_campaign", "Campaign"],
  ["utm_content", "Ad / content"], ["referrer", "Referrer"], ["landing", "Landing page"],
  ["city", "City"], ["country", "Country"], ["device", "Device"],
];

function Sources({ rows, dim, setDim, loading }) {
  const max = Math.max(1, ...(rows || []).map((r) => Number(r.visitors) + Number(r.signups)));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Where people come from</h2>
        <span className="muted small">first touch · the visitors, signups{MOD.revenue ? " and money" : ""} each source produced</span>
      </div>
      <div className="tabs" role="tablist">
        {DIM_TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={dim === k} className={dim === k ? "on" : ""} onClick={() => setDim(k)}>{label}</button>
        ))}
      </div>
      <div className={`table-scroll ${loading ? "dim" : ""}`}>
        <table className="sources">
          <thead><tr><th>{DIM_TABS.find((t) => t[0] === dim)[1]}</th><th className="n">Visitors</th>
            <th className="n">Signups</th>{MOD.revenue ? <><th className="n">Paying</th><th className="n">Revenue</th></> : null}</tr></thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.value}>
                <td className="bar-cell">
                  <span className="row-bar" style={{ width: `${((Number(r.visitors) + Number(r.signups)) / max) * 100}%` }} />
                  <span className="row-label">{dim === "channel" ? channelLabel(r.value) : r.value}</span>
                </td>
                <td className="n">{num(r.visitors)}</td>
                <td className="n">{num(r.signups)}</td>
                {MOD.revenue ? <><td className="n">{num(r.paying)}</td>
                  <td className="n">{Number(r.revenue_minor) ? money(r.revenue_minor) : dash}</td></> : null}
              </tr>
            ))}
            {rows && !rows.length ? <tr><td colSpan="5" className="muted">Nothing in this range.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── ads ───────────────────────────────────────────────────────────────── */

function Ads({ rows, updatedAt, onRefresh, refreshing }) {
  const tot = (rows || []).reduce((a, r) => ({
    spend: a.spend + Number(r.spend || 0), signups: a.signups + Number(r.signups || 0),
    revenue: a.revenue + Number(r.revenue_minor || 0), imp: a.imp + Number(r.impressions || 0),
    clicks: a.clicks + Number(r.link_clicks || 0), lpv: a.lpv + Number(r.landing_views || 0),
  }), { spend: 0, signups: 0, revenue: 0, imp: 0, clicks: 0, lpv: 0 });
  const totRates = adRates(tot.spend, tot.imp, tot.clicks);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Meta ads</h2>
        <span className="muted small">
          {updatedAt ? `updated ${ago(updatedAt)}` : "not pulled yet"} ·{" "}
          <button className="link" onClick={onRefresh} disabled={refreshing}>{refreshing ? "pulling…" : "refresh"}</button>
          {" "}· each ad's spend beside the people its link brought (first touch)
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Ad</th><th className="n">Spend</th><th className="n">Link clicks</th><th className="n">Landed (Meta)</th>
            <th className="n" title="Link clicks ÷ impressions">CTR</th><th className="n" title="Spend ÷ link clicks">CPC</th>
            <th className="n" title="Spend ÷ impressions × 1,000">CPM</th><th className="n">Visitors (ours)</th>
            <th className="n">Signups</th><th className="n">Cost per signup</th>
            {MOD.revenue ? <><th className="n">Paying</th><th className="n">Revenue</th></> : null}
            <th className="n">Meta says signups / buys</th></tr></thead>
          <tbody>
            {(rows || []).map((r) => { const k = adRates(r.spend, r.impressions, r.link_clicks); return (
              <tr key={r.ad_id}>
                <td className="who"><span className="email">{r.ad_name}</span>
                  <span className="sub">{r.utm_content ? `utm_content=${r.utm_content}` : "no utm_content on the link - cannot match people"}</span></td>
                <td className="n">{moneyMajor(r.spend)}</td>
                <td className="n">{num(r.link_clicks)}</td>
                <td className="n">{num(r.landing_views)}</td>
                <td className="n">{pct2(k.ctr)}</td>
                <td className="n">{money2(k.cpc)}</td>
                <td className="n">{money0(k.cpm)}</td>
                <td className="n">{r.visitors == null ? dash : num(r.visitors)}</td>
                <td className="n">{r.signups == null ? dash : num(r.signups)}</td>
                <td className="n">{Number(r.signups) ? moneyMajor(Number(r.spend) / Number(r.signups)) : dash}</td>
                {MOD.revenue ? <><td className="n">{r.paying == null ? dash : num(r.paying)}</td>
                  <td className="n">{Number(r.revenue_minor) ? money(r.revenue_minor) : dash}</td></> : null}
                <td className="n muted">{num(r.platform_signups)} / {num(r.platform_purchases)}</td>
              </tr>
            ); })}
            {rows && rows.length ? (
              <tr className="total"><td>Total</td><td className="n">{moneyMajor(tot.spend)}</td>
                <td className="n">{num(tot.clicks)}</td><td className="n">{num(tot.lpv)}</td>
                <td className="n">{pct2(totRates.ctr)}</td><td className="n">{money2(totRates.cpc)}</td>
                <td className="n">{money0(totRates.cpm)}</td><td />
                <td className="n">{num(tot.signups)}</td>
                <td className="n">{tot.signups ? moneyMajor(tot.spend / tot.signups) : dash}</td>
                {MOD.revenue ? <><td /><td className="n">{tot.revenue ? money(tot.revenue) : dash}</td></> : null}<td /></tr>
            ) : null}
            {rows && !rows.length ? <tr><td colSpan="13" className="muted">No ad spend in this range.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── live ──────────────────────────────────────────────────────────────── */

function LiveCard({ live }) {
  const people = (live && live.people) || [];
  return (
    <section className="card live-card">
      <div className="card-head">
        <h2><i className={people.length ? "dot on" : "dot"} /> On the site now <span className="count">{people.length}</span></h2>
        <span className="muted small">activity in the last {DASH.liveMinutes} minutes · refreshes every 5 s</span>
      </div>
      {people.length ? (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Who</th><th>Page</th><th>Came from</th><th>Where</th><th>Device</th><th className="n">On for</th><th className="n">Last seen</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.key}>
                  <td className="who"><span className="email">{p.email || (p.account_id ? p.account_id : "Visitor")}</span>
                    <span className="sub">{p.account_id ? "signed in" : "not signed in"}{p.signals.includes("reading") ? " · reading" : ""}</span></td>
                  <td className="src">{p.path || dash}</td>
                  <td className="src">{p.source ? channelLabel(p.source) : dash}</td>
                  <td>{[p.city, p.country].filter(Boolean).join(", ") || dash}</td>
                  <td>{p.device || dash}</td>
                  <td className="n">{p.since ? duration((Date.now() - new Date(p.since).getTime()) / 1000) : dash}</td>
                  <td className="n">{ago(p.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="muted pad-s">Nobody right now.</div>}
    </section>
  );
}

/* ── the dashboard ─────────────────────────────────────────────────────── */

function store(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function Dashboard({ email }) {
  const [range, setRange] = useState(() => store("d11_range", "30d"));
  const [dim, setDim] = useState("channel");
  const [data, setData] = useState(null);
  const [users, setUsers] = useState(null);
  const [usersErr, setUsersErr] = useState(null);
  const [survey, setSurvey] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(null);
  const seq = useRef(0);

  const window_ = useCallback(() => {
    const preset = RANGES.find((r) => r.key === range) || RANGES[3];
    return { from: preset.from().toISOString(), to: (preset.to ? preset.to() : new Date()).toISOString() };
  }, [range]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await report("dashboard", { ...window_(), dim });
      if (my === seq.current) { setData(d); setError(null); if (d.live) setLive(d.live); }
    } catch (e) {
      if (my === seq.current) setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [window_, dim]);

  const loadUsers = useCallback(() =>
    report("people").then((u) => { setUsers(u); setUsersErr(null); }).catch((e) => setUsersErr(e.message)), []);

  const loadSurvey = useCallback(() => {
    if (!MOD.survey) return;
    Promise.all([report("survey", window_()), report("survey_people", { limit: 5000 })])
      .then(([summary, people]) => setSurvey({ summary, people }))
      .catch((e) => setSurvey({ error: e.message }));
  }, [window_]);

  const refreshAds = useCallback(async (force) => {
    if (!MOD.ads) return;
    setRefreshing(true);
    try {
      const r = await report("ads_refresh", force ? { force: 1 } : {});
      if (!r.fresh) await load();
    } catch { /* the panel keeps its last numbers; the timestamp says how old */ }
    setRefreshing(false);
  }, [load]);

  useEffect(() => { try { localStorage.setItem("d11_range", range); } catch { /* fine */ } }, [range]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  useEffect(() => { loadUsers(); const t = setInterval(loadUsers, 120000); return () => clearInterval(t); }, [loadUsers]);
  useEffect(() => { loadSurvey(); const t = setInterval(loadSurvey, 120000); return () => clearInterval(t); }, [loadSurvey]);
  useEffect(() => { refreshAds(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      report("live").then(setLive).catch(() => { /* keep the last answer */ });
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const daily = (data && data.daily) || [];
  const c = data && data.current;

  return (
    <div className="page">
      <header className="top">
        <div className="brand"><span className="mark">{DASH.logoLetter}</span><b>{SITE.name}</b><span className="muted">Data</span></div>
        <div className="ranges" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>{r.label}</button>
          ))}
        </div>
        <div className="right"><button className="link" onClick={() => signOut()} title={email}>Sign out</button></div>
      </header>

      {error ? (
        <div className="banner">Could not load: {error.message}{error.code ? ` (${error.code})` : ""}.{" "}
          <button className="link" onClick={load}>Try again</button></div>
      ) : null}
      {!data && !error ? <div className="muted pad">Loading…</div> : null}

      {data && (
        <main className={loading ? "dim" : ""}>
          <Strip c={c} p={data.previous} live={live} />
          <LiveCard live={live} />
          <Visitors />
          <div className="charts">
            <Bars title="Visitors" rows={daily} value={(r) => r.visitors} format={num} total={num(c && c.visitors)} />
            <Bars title="People active per day" rows={daily} value={(r) => r.active_people} format={num}
                  total={`${c ? c.avg_dau : dash}/day`} note={(r) => `${num(r.signed_in_active)} signed in`} />
            <Bars title="Signups" rows={daily} value={(r) => r.signups} format={num} total={num(c && c.signups)} />
            {MOD.revenue ? (
              <Bars title="Revenue" rows={daily} value={(r) => Number(r.revenue_minor)} format={money}
                    total={money(c && c.revenue_minor)} note={(r) => `${num(r.payments)} payments`} />
            ) : null}
            <Bars title="Time on site" rows={daily} value={(r) => Number(r.active_seconds)} format={duration}
                  total={duration(c && c.active_seconds)}
                  note={(r) => (r.active_people ? `${duration(r.active_seconds / r.active_people)} per person` : "")} />
            {MOD.ads ? (
              <Bars title="Ad spend" rows={daily} value={(r) => Number(r.ad_spend)} format={moneyMajor} total={moneyMajor(c && c.ad_spend)} />
            ) : null}
          </div>
          <People users={users} error={usersErr} />
          <Sources rows={data.sources} dim={dim} setDim={setDim} loading={loading} />
          {MOD.ads ? <Ads rows={data.ads} updatedAt={data.ads_updated_at} onRefresh={() => refreshAds(true)} refreshing={refreshing} /> : null}
          {MOD.survey ? <SurveySummary data={survey.summary} error={survey.error} /> : null}
          {MOD.survey ? <SurveyPeople rows={survey.people} error={survey.error} /> : null}
          <p className="foot muted small">
            Days are {TZ}. Visitors count only browsers that stayed 5 seconds; bots and data-centre traffic are
            flagged, never deleted. Time on site counts only while the page is visible and in use.
          </p>
        </main>
      )}
    </div>
  );
}

/* ── sign-in ───────────────────────────────────────────────────────────── */

function GoogleButton({ clientId, onCredential }) {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google?.accounts?.id || !ref.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => onCredential(r.credential) });
      window.google.accounts.id.renderButton(ref.current, { theme: "outline", size: "large", shape: "pill", text: "continue_with" });
    };
    if (window.google?.accounts?.id) render();
    else {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = render;
      document.head.appendChild(s);
    }
    return () => { cancelled = true; };
  }, [clientId, onCredential]);
  return <div ref={ref} className="gbtn" />;
}

function SignIn({ state, onDone }) {
  const [err, setErr] = useState(state.code === "not_allowlisted" ? `${state.email} is not in ADMIN_EMAILS.` : null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (fn) => {
    setBusy(true);
    try { await fn(); onDone(); } catch (e) {
      setErr(e.code === "not_allowlisted" ? `${e.email || "This account"} is not in ADMIN_EMAILS.` : e.message);
    }
    setBusy(false);
  };
  const onCredential = useCallback((cred) => go(() => signInWithGoogle(cred)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="signin">
      <div className="signin-card">
        <span className="mark big">{DASH.logoLetter}</span>
        <h1>{SITE.name} · Data</h1>
        <p className="muted">Private. Only the accounts in ADMIN_EMAILS.</p>
        {!state.configured ? (
          <p className="error">The server has no SESSION_SECRET, or neither ADMIN_EMAILS nor ADMIN_PASSWORD. See AGENTS.md step 4.</p>
        ) : null}
        {state.google_client_id ? <GoogleButton clientId={state.google_client_id} onCredential={onCredential} /> : null}
        {state.password ? (
          <form className="pw" onSubmit={(e) => { e.preventDefault(); go(() => signInWithPassword(pw)); }}>
            <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
            <button disabled={busy || !pw}>{busy ? "…" : "Sign in"}</button>
          </form>
        ) : null}
        {err ? <p className="error">{err}</p> : null}
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState(undefined);
  const check = useCallback(() => authState().then(setState).catch((e) => setState({ error: e.message })), []);
  useEffect(() => { check(); }, [check]);
  if (state === undefined) return null;
  if (state.error) return <div className="banner">Could not reach the server: {state.error}</div>;
  return state.signed_in ? <Dashboard email={state.email} /> : <SignIn state={state} onDone={check} />;
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
