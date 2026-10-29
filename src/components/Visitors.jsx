import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import config from "../../site.config.js";
import { report } from "../lib/api.js";
import { ago, channelLabel, dash, dateTime, duration, num } from "../lib/format.js";
import { Timeline } from "./People.jsx";

/* Everyone who came, newest first, under the live list - signed in or not.
   25 a page; Load more asks for the 25 after the last row's (last_seen,
   person), so a page is never repeated or skipped. A row opens the timeline. */

const PAGE = 25;
const REPLAYS = !!config.modules?.replays?.enabled;

function cameFrom(p) {
  const bits = [channelLabel(p.channel)];
  if (p.source && p.source !== p.channel) bits.push(p.source);
  return bits.join(" · ");
}

export default function Visitors() {
  const [rows, setRows] = useState([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [signed, setSigned] = useState(false);
  const [open, setOpen] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async (after) => {
    const my = ++seq.current;
    setBusy(true);
    try {
      const r = await report("visitors", {
        limit: PAGE, signed: signed ? 1 : null,
        before: after ? after.last_seen : null, person: after ? after.person : null,
      });
      if (my !== seq.current) return;
      setRows((cur) => (after ? [...cur, ...r.people] : r.people));
      setDone(r.done);
      setError(null);
    } catch (e) {
      if (my === seq.current) setError(e.message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [signed]);

  useEffect(() => { setOpen(null); load(null); }, [load]);
  const cols = REPLAYS ? 11 : 10;

  return (
    <section className="card visitors">
      <div className="card-head">
        <h2>Earlier <span className="count">{rows.length ? num(rows.length) + (done ? "" : "+") : ""}</span></h2>
        <span className="muted small">
          everyone who came, newest first ·{" "}
          <button className="link" onClick={() => setSigned((s) => !s)}>{signed ? "show everyone" : "signed in only"}</button>
        </span>
      </div>
      {error ? <div className="error pad-s">Could not load: {error}</div> : null}
      {!rows.length && busy ? <div className="muted pad-s">Loading…</div> : null}
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Who</th><th>Last page</th><th>Came from</th><th>Where</th><th>Device</th>
              <th className="n">Visits</th><th className="n">Pages</th><th className="n">Time on site</th>
              <th>First seen</th><th className="n">Last seen</th>{REPLAYS ? <th>Replay</th> : null}</tr></thead>
            <tbody>
              {rows.map((p) => (
                <Fragment key={p.person}>
                  <tr className={open === p.person ? "open" : ""} onClick={() => setOpen(open === p.person ? null : p.person)}>
                    <td className="who"><span className="email">{p.email || (p.account_id ? p.account_id : "Visitor")}</span>
                      <span className="sub">{p.account_id ? "signed in" : "not signed in"}</span></td>
                    <td className="src">{p.last_path || p.landing_path || dash}
                      {p.landing_path && p.last_path && p.landing_path !== p.last_path
                        ? <span className="sub">landed on {p.landing_path}</span> : null}</td>
                    <td className="src">{cameFrom(p)}</td>
                    <td>{[p.city, p.country].filter(Boolean).join(", ") || dash}</td>
                    <td>{p.device || dash}</td>
                    <td className="n">{num(p.visits)}</td>
                    <td className="n">{num(p.pages)}</td>
                    <td className="n">{duration(p.seconds)}</td>
                    <td>{dateTime(p.first_seen)}</td>
                    <td className="n" title={dateTime(p.last_seen)}>{ago(p.last_seen)}</td>
                    {REPLAYS ? (
                      <td>{p.replay_url
                        ? <a href={p.replay_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            Watch{Number(p.replays) > 1 ? ` (${num(p.replays)})` : ""}</a>
                        : dash}</td>
                    ) : null}
                  </tr>
                  {open === p.person && (
                    <tr className="detail"><td colSpan={cols}>
                      {p.account_id ? <Timeline id={p.account_id} /> : <Timeline ids={p.visitor_ids} />}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {done
            ? <div className="muted small pad-s">That's everyone.</div>
            : <button className="show-all" disabled={busy} onClick={() => load(rows[rows.length - 1])}>{busy ? "Loading…" : "Load more"}</button>}
        </div>
      ) : !busy && !error ? <div className="muted pad-s">Nobody yet.</div> : null}
    </section>
  );
}
