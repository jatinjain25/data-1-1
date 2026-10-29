import { Fragment, useMemo, useState } from "react";
import config from "../../site.config.js";
import { ago, dash, dateTime, num, shortId } from "../lib/format.js";
import { Timeline } from "./People.jsx";

/* The first-visit survey: totals and one ranked table per question (in the
   dashboard's range), then everyone who answered (all time), one row per
   browser, signed in or not. Questions and labels come from site.config.js. */

const QUESTIONS = config.modules?.survey?.questions || [];

function share(n, of) {
  return of ? `${Math.round((n / of) * 100)}%` : dash;
}

const label = (q, key) => (q.options && q.options[key]) || key;

function Ranked({ q, rows, of }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <table className="sources">
      <thead><tr><th>{q.label || q.id}</th><th className="n">People</th><th className="n">Share</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="bar-cell">
              <span className="row-bar" style={{ width: `${(r.n / max) * 100}%` }} />
              <span className="row-label">{label(q, r.key)}</span>
            </td>
            <td className="n">{num(r.n)}</td>
            <td className="n">{share(r.n, of)}</td>
          </tr>
        ))}
        {!rows.length ? <tr><td colSpan="3" className="muted">Nobody yet in this range.</td></tr> : null}
      </tbody>
    </table>
  );
}

export function SurveySummary({ data, error }) {
  if (error) {
    return (
      <section className="card">
        <div className="card-head"><h2>What visitors want</h2></div>
        <p className="muted small pad-s">Could not load: {error}</p>
      </section>
    );
  }
  if (!data) return null;
  const answered = data.answered || 0;
  const skipped = Object.entries(data.skipped || {}).map(([step, n]) => `${num(n)} skipped at step ${step}`);
  return (
    <section className="card">
      <div className="card-head">
        <h2>What visitors want</h2>
        <span className="muted small">
          the first-visit questions, in this range · {num(data.shown)} saw them, {num(answered)} answered,{" "}
          {num(data.finished)} finished{skipped.length ? `, ${skipped.join(", ")}` : ""} · {num(data.signed_in)} signed in
        </span>
      </div>
      <div className="split-2">
        {QUESTIONS.map((q) => (
          <div className="table-scroll" key={q.id}>
            <Ranked q={q} rows={(data.questions || {})[q.id] || []} of={answered} />
            {q.other && (data.typed || {})[q.id]?.length ? (
              <table className="sources">
                <thead><tr><th>Typed under “{label(q, "other")}”</th><th className="n">People</th><th /></tr></thead>
                <tbody>
                  {data.typed[q.id].map((r) => (
                    <tr key={r.key}><td>{r.key}</td><td className="n">{num(r.n)}</td><td /></tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function answerText(q, v, data) {
  if (v == null) return dash;
  const list = Array.isArray(v) ? v : [v];
  return list.map((k) => (k === "other" && data[`${q.id}_other`] ? `${data[`${q.id}_other`]} (typed)` : label(q, k))).join(", ");
}

export function SurveyPeople({ rows, error }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter((r) => !needle ||
      [r.visitor_id, r.email, r.city, JSON.stringify(r.data)].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <section className="card people">
      <div className="card-head">
        <h2>Everyone who answered <span className="count">{rows ? num(rows.length) : ""}</span></h2>
        <span className="muted small">one row per browser, signed in or not</span>
        <input type="search" placeholder="Search answers, ID, email, city" value={q}
               onChange={(e) => setQ(e.target.value)} aria-label="Search answers" />
      </div>
      {error ? <div className="error pad-s">Could not load answers: {error}</div> : null}
      {rows && rows.length ? (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Person</th>{QUESTIONS.map((x) => <th key={x.id}>{x.label || x.id}</th>)}<th>Where</th><th>Answered</th></tr></thead>
            <tbody>
              {(all || q ? shown : shown.slice(0, 25)).map((r) => (
                <Fragment key={r.visitor_id}>
                  <tr className={open === r.visitor_id ? "open" : ""} onClick={() => setOpen(open === r.visitor_id ? null : r.visitor_id)}>
                    <td className="who">
                      <span className="email" title={r.visitor_id}>{r.email || `ID ${shortId(r.visitor_id)}`}</span>
                      <span className="sub">{r.account_id ? "signed in" : r.has_account ? "went to sign in" : "not signed in"}
                        {r.skipped_at ? ` · skipped at step ${r.skipped_at}` : ""}</span>
                    </td>
                    {QUESTIONS.map((x) => <td key={x.id} className="src">{answerText(x, (r.data || {})[x.id], r.data || {})}</td>)}
                    <td className="src">{[r.city, r.device].filter(Boolean).join(" · ") || dash}<span className="sub">{r.path || ""}</span></td>
                    <td title={dateTime(r.updated_at)}>{ago(r.updated_at)}</td>
                  </tr>
                  {open === r.visitor_id && (
                    <tr className="detail"><td colSpan={QUESTIONS.length + 3}>
                      {r.account_id ? <Timeline id={r.account_id} /> : <Timeline ids={[r.visitor_id]} />}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!all && !q && shown.length > 25 ? (
            <button className="show-all" onClick={() => setAll(true)}>Show all {num(shown.length)} answers</button>
          ) : null}
        </div>
      ) : rows ? <div className="muted pad-s">Nobody has answered yet.</div> : null}
    </section>
  );
}
