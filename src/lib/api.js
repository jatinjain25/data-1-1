/* The dashboard's only way to reach the server. The session is an httpOnly
   cookie set by /api/auth, so there is no token in this page for a script to
   steal - and after one sign-in on a laptop the dashboard simply opens. */

function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** A failed report is an ERROR, never an empty array: an empty chart and a
    broken query look identical on screen. */
export async function report(name, params = {}) {
  const qs = new URLSearchParams({ r: name });
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  const res = await fetch(`/api/query?${qs}`, { credentials: "same-origin" });
  if (res.ok) return res.json();
  let body = {};
  try { body = await res.json(); } catch { /* not json */ }
  throw failure(body.error || String(res.status), body.code || String(res.status), { status: res.status, email: body.email });
}

export async function authState() {
  const res = await fetch("/api/auth", { credentials: "same-origin" });
  if (!res.ok) throw failure(`auth ${res.status}`, "auth_error");
  return res.json();
}

async function post(body) {
  const res = await fetch("/api/auth", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(out.error || String(res.status), out.code, { email: out.email, status: res.status });
  return out;
}

export const signInWithGoogle = (credential) => post({ credential });
export const signInWithPassword = (password) => post({ password });
export const signOut = () => fetch("/api/auth", { method: "DELETE", credentials: "same-origin" }).then(() => location.reload());
