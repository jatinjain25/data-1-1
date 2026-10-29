/* Survey answers are validated against site.config.js before they are stored:
   an unknown question or option is dropped, never written. The collector is
   public, so this whitelist is what stops it being a free-text dump. */

/** Pure. answers = {question_id: "value" | ["v1", "v2"], <id>_other: "typed"}.
    Returns the clean object (possibly {}) - or null when nothing survives. */
export function cleanAnswers(answers, questions) {
  if (!answers || typeof answers !== "object") return null;
  const out = {};
  for (const q of questions) {
    const opts = q.options || {};
    const allowed = (v) => typeof v === "string" && Object.prototype.hasOwnProperty.call(opts, v);
    const v = answers[q.id];
    if (q.type === "multi") {
      const list = Array.isArray(v) ? [...new Set(v.filter(allowed))].slice(0, 50) : [];
      if (list.length) out[q.id] = list;
    } else if (q.type === "text") {
      const s = typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200) : "";
      if (s) out[q.id] = s;
    } else if (allowed(v)) {
      out[q.id] = v;
    }
    if (q.other) {
      const typed = answers[`${q.id}_other`];
      const picked = out[q.id];
      const choseOther = picked === "other" || (Array.isArray(picked) && picked.includes("other"));
      if (choseOther && typeof typed === "string") {
        const s = typed.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
        if (s) out[`${q.id}_other`] = s;
      }
    }
  }
  return out;
}
