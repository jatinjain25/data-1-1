import { Fragment, useEffect, useMemo, useState } from "react";
import config from "../../site.config.js";
import { report } from "../lib/api.js";
import { ago, channelLabel, dash, dateTime, duration, money, num } from "../lib/format.js";

/* Every account: search, sort by any column, click a row for that person's
   timeline across every browser they signed in on. The action columns come
   from site.config.js `actions`. */

const ACTIONS = (config.actions || []).filter((a) => a && a.event);
const REVENUE = config.modules?.revenue?.enabled !== false;

const COLS = [
  { key: "email", label: "Person", sort: (u) => (u.email || u.account_id || "").toLowerCase() },
  { key: "signed_up_at", label: "Signed up", sort: (u) => u.signed_up_at || "" },
  { key: "channel", label: "Came from", sort: (u) => u.channel || "" },
  { key: "seconds_total", label: "Time spent", sort: (u) => Number(u.seconds_total) },
  { key: "seconds_7d", label: "Last 7 days", sort: (u) => Number(u.seconds_7d) },
  { key: "active_days", label: "Days active", sort: (u) => Number(u.active_days) },
  ...ACTIONS.map((a) => ({ key: `a:${a.event}`, label: a.label || a.event, sort: (u) => Number(u.actions?.[a.event] || 0) })),
  { key: "last_active_at", label: "Last active", sort: (u) => u.last_active_at || "" },
  ...(REVENUE ? [{ key: "revenue_minor", label: "Paid", sort: (u) => Number(u.revenue_minor) }] : []),
];

function source(u) {
  const bits = [channelLabel(u.channel)];
  const detail = u.utm_content || u.utm_campaign || u.utm_source || u.referrer_host;
  if (detail && u.channel !== "(not tracked)") bits.push(detail);
  return bits.join(" · ");
}

/** A signed-in person by account (`id`), or an anonymous one by browser ids (`ids`). */
export function Timeline({ id, ids }) {
  const [state, setState] = useState({ loading: true });
  const key = id || (ids || []).join(",");
  useEffect(() => {
    (id ? report("person", { id }) : report("visitor", { ids: key }))
      .then((rows) => setState({ rows }))
      .catch((e) => setState({ error: e.message }));
  }, [id, key]);
  if (state.loading) return <div className="timeline muted">Loading…</div>;
  if (state.error) return <div className="timeline error">Could not load: {state.error}</div>;
  if (!state.rows.length) return <div className="timeline muted">Nothing recorded for this person yet.</div>;
  return (
    <ol className="timeline">
      {state.rows.map((r, i) => (
        <li key={i}>
          <time>{dateTime(r.at)}</time>
          <span className={`kind k-${r.kind}`}>{r.kind}</span>
          <span className="what">{r.kind === "pageview" ? r.path : r.detail || r.path || dash}</span>
          {r.source ? <span className="muted">{r.source}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function cell(c, u) {
  if (c.key.startsWith("a:")) return <td key={c.key} className="n">{num(u.actions?.[c.key.slice(2)] || 0)}</td>;
  switch (c.key) {
    case "email":
      return (
        <td key={c.key} className="who">
          <span className="email">{u.email || u.account_id}</span>
          <span className="sub">{[u.name, u.city].filter(Boolean).join(" · ") || dash}</span>
        </td>
      );
    case "signed_up_at": return <td key={c.key}>{dateTime(u.signed_up_at)}</td>;
    case "channel": return <td key={c.key} className="src">{source(u)}</td>;
    case "seconds_total": return <td key={c.key} className="n">{duration(u.seconds_total)}</td>;
    case "seconds_7d": return <td key={c.key} className="n">{duration(u.seconds_7d)}</td>;
    case "active_days": return <td key={c.key} className="n">{num(u.active_days)}</td>;
    case "last_active_at": return <td key={c.key}>{ago(u.last_active_at)}</td>;
    case "revenue_minor":
      return (
        <td key={c.key} className="n">
          {Number(u.revenue_minor) ? <span className="paid">{money(u.revenue_minor)}</span> : dash}
          {u.plan ? <span className="sub">{u.plan}</span> : null}
        </td>
      );
    default: return <td key={c.key} />;
  }
}

export default function People({ users, error }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "signed_up_at", dir: -1 });
  const [open, setOpen] = useState(null);
  const [all, setAll] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const col = COLS.find((c) => c.key === sort.key) || COLS[1];
    return (users || [])
      .filter((u) => !needle || `${u.email || ""} ${u.account_id} ${u.name || ""} ${u.city || ""}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
      });
  }, [users, q, sort]);

  const click = (key) =>
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "email" || key === "channel" ? 1 : -1 }));

  return (
    <section className="card people">
      <div className="card-head">
        <h2>People <span className="count">{users ? num(users.length) : ""}</span></h2>
        <span className="muted small">everyone with an account · click a row for their timeline</span>
        <input type="search" placeholder="Search email, name, city" value={q}
               onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      </div>
      {error ? <div className="error pad-s">Could not load people: {error}</div> : null}
      {!users && !error ? <div className="muted pad-s">Loading…</div> : null}
      {users && !users.length ? (
        <div className="muted pad-s">No accounts yet. They appear when your site calls siteData.identify() or your server posts to /api/ingest.</div>
      ) : null}
      {users && users.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} onClick={() => click(c.key)} className={`${sort.key === c.key ? "sorted" : ""} ${c.key === "email" || c.key === "channel" || c.key === "signed_up_at" || c.key === "last_active_at" ? "" : "n"}`}
                      aria-sort={sort.key === c.key ? (sort.dir > 0 ? "ascending" : "descending") : "none"}>
                    {c.label}{sort.key === c.key ? (sort.dir > 0 ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(all || q ? rows : rows.slice(0, 25)).map((u) => (
                <Fragment key={u.account_id}>
                  <tr className={open === u.account_id ? "open" : ""}
                      onClick={() => setOpen(open === u.account_id ? null : u.account_id)}>
                    {COLS.map((c) => cell(c, u))}
                  </tr>
                  {open === u.account_id && (
                    <tr className="detail"><td colSpan={COLS.length}><Timeline id={u.account_id} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!all && !q && rows.length > 25 ? (
            <button className="show-all" onClick={() => setAll(true)}>Show all {num(rows.length)} people</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
