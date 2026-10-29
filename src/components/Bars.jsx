import { useState } from "react";
import { dayLabel } from "../lib/format.js";

/* One metric per day, as bars. The dashboard shows several of these side by
   side (small multiples) rather than one dual-axis chart: visitors, signups
   and money are three different scales, and two y-axes on one plot invite
   reading a crossing as meaning something.

   Zero baseline, recessive grid (one line at the max), a tooltip per day.
   The hit target is the whole day column, not the bar - a zero-height bar
   must still be hoverable. */
export default function Bars({ title, rows, value, format, total, note }) {
  const [hover, setHover] = useState(null);
  const W = 320, H = 96, PAD_T = 6, PAD_B = 18;
  const vals = rows.map((r) => Number(value(r)) || 0);
  const max = Math.max(1, ...vals);
  const n = Math.max(1, rows.length);
  const step = W / n;
  const bw = Math.max(2, Math.min(18, step - 2));
  const plotH = H - PAD_T - PAD_B;
  const h = hover == null ? null : rows[hover];

  return (
    <div className="card chart">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-total">{total}</span>
      </div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
             aria-label={`${title} per day`} onMouseLeave={() => setHover(null)}>
          <line x1="0" x2={W} y1={PAD_T} y2={PAD_T} className="grid" />
          <line x1="0" x2={W} y1={PAD_T + plotH} y2={PAD_T + plotH} className="axis" />
          {rows.map((r, i) => {
            const v = vals[i];
            const bh = v ? Math.max(2, (v / max) * plotH) : 0;
            const x = i * step + (step - bw) / 2;
            return (
              <g key={r.day}>
                {bh > 0 && (
                  <rect x={x} y={PAD_T + plotH - bh} width={bw} height={bh} rx={Math.min(3, bw / 2)}
                        className={hover === i ? "bar on" : "bar"} />
                )}
                <rect x={i * step} y="0" width={step} height={H} fill="transparent"
                      onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        <span className="y-max">{format(max)}</span>
        {rows.length > 0 && (
          <div className="x-ends">
            <span>{dayLabel(rows[0].day)}</span>
            <span>{dayLabel(rows[rows.length - 1].day)}</span>
          </div>
        )}
        {h && (
          <div className="tip" style={{ left: `${((hover + 0.5) / n) * 100}%` }}>
            <b>{dayLabel(h.day)}</b>
            <span>{format(value(h))}</span>
            {note && note(h) ? <small>{note(h)}</small> : null}
          </div>
        )}
      </div>
    </div>
  );
}
