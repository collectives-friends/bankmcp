// The few HTML pages this server shows a human: the OAuth sign-in, the
// result of a bank connection, and a status page. No external assets.
import { config } from "./config.ts";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Kind = "ok" | "error" | "neutral";

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
};

export function shell(title: string, body: string, opts: { kind?: Kind; pill?: string } = {}): string {
  const name = config.appName;
  const tab = title === name ? name : `${title} · ${name}`;
  const pill = opts.pill ? `<div class="pill ${opts.kind ?? "neutral"}">${esc(opts.pill)}</div>` : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(tab)}</title>
<style>
  :root{--bg:#f4f3ef;--card:#fff;--ink:#141414;--muted:#6f6e69;--line:#e6e4dd;--ok:#1f7a4d;--err:#b3261e}
  @media (prefers-color-scheme:dark){:root{--bg:#111110;--card:#1b1b1a;--ink:#f2f1ec;--muted:#9b9a94;--line:#2c2b29;--ok:#5cc08a;--err:#ff8a7a}}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  .wrap{max-width:460px;margin:0 auto;padding:12vh 20px 48px}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 22px;font-weight:800;font-size:20px;letter-spacing:-.02em}
  .brand .mark{width:28px;height:28px;border-radius:8px;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-size:15px;font-weight:900}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 28px 26px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 12px}
  .pill::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--muted)}
  .pill.ok{color:var(--ok)}.pill.ok::before{background:var(--ok)}
  .pill.error{color:var(--err)}.pill.error::before{background:var(--err)}
  h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 12px}
  p{margin:0 0 12px}.muted{color:var(--muted)}.error{color:var(--err)}
  ul.rows{list-style:none;padding:0;margin:18px 0 6px}
  ul.rows li{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--line)}
  ul.rows li:last-child{border-bottom:1px solid var(--line)}
  ul.rows .r{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  label{display:block;font-weight:600;font-size:14px;margin:18px 0 6px}
  input{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
  input:focus{outline:2px solid var(--ink);outline-offset:1px;border-color:transparent}
  button{width:100%;margin-top:14px;font:inherit;font-weight:700;padding:13px 16px;border:0;border-radius:10px;background:var(--ink);color:var(--bg);cursor:pointer}
  button:hover{opacity:.92}
  code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);padding:6px 10px;border-radius:8px;display:inline-block;word-break:break-all}
  footer{margin-top:20px;font-size:12px;color:var(--muted)}
  footer a{color:inherit}
</style>
<body><div class="wrap">
  <div class="brand"><span class="mark">${esc(name.replace(/[™®]/g, "").trim().charAt(0).toUpperCase() || "B")}</span><span>${esc(name)}</span></div>
  <div class="card">${pill}<h1>${esc(title)}</h1>${body}</div>
  <footer>${esc(name)} · read-only · self-hosted · <a href="/privacy">privacy</a> · <a href="/terms">terms</a></footer>
</div></body></html>`;
}

export function loginPage(opts: { requestId: string; clientName?: string; returnTo?: string; error?: string }): string {
  const who = opts.clientName ? `<b>${esc(opts.clientName)}</b>` : "An app";
  const back = opts.returnTo ? `<p class="muted">After signing in you are sent back to <b>${esc(opts.returnTo)}</b>. Stop if that is not where you came from.</p>` : "";
  return shell(
    "Allow access?",
    `<p>${who} wants read-only access to your bank accounts through this server. It can see balances and transactions. It cannot move money.</p>${back}
     ${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ""}
     <form method="post" action="/login">
       <input type="hidden" name="request" value="${esc(opts.requestId)}">
       <label for="pw">Password</label>
       <input id="pw" type="password" name="password" autofocus autocomplete="current-password" required>
       <button type="submit">Allow access</button>
     </form>`,
    { kind: "neutral", pill: "Sign-in request" },
  );
}

export function connectedPage(session: { aspsp: { name: string }; access: { valid_until: string }; accounts: Array<{ uid: string; name?: string; product?: string; currency: string }> }): string {
  const n = session.accounts.length;
  return shell(
    `${session.aspsp.name} is linked`,
    `<p>${n} account${n === 1 ? "" : "s"} shared, read-only.</p>
     <ul class="rows">${session.accounts.map((a) => `<li><span>${esc([a.name, a.product].filter(Boolean).join(" · ") || a.uid)}</span><span class="r">${esc(a.currency)}</span></li>`).join("")}</ul>
     <p class="muted">Consent valid until ${esc(fmtDate(session.access.valid_until))}. You can close this tab and go back to Claude.</p>`,
    { kind: "ok", pill: "Connected" },
  );
}

export function failedPage(message: string): string {
  return shell("Bank not connected", `<p class="error">${esc(message)}</p><p class="muted">Go back to Claude and start again.</p>`, { kind: "error", pill: "Not connected" });
}

export function statusPage(input: { problems: string[]; mcpUrl: string }): string {
  if (input.problems.length) {
    return shell(
      "Not configured yet",
      `<ul class="rows">${input.problems.map((p) => `<li><span>${esc(p)}</span></li>`).join("")}</ul><p class="muted">Set the environment variables and restart. The README has the list.</p>`,
      { kind: "error", pill: "Setup incomplete" },
    );
  }
  // Deliberately says nothing about which banks or accounts are connected:
  // this page is reachable without a password. Ask consent_status in Claude.
  return shell(
    config.appName,
    `<p>Running. Add this URL as a custom connector in Claude and sign in with the admin password:</p><p><code>${esc(input.mcpUrl)}</code></p>`,
    { kind: "ok", pill: "Running" },
  );
}

export const privacyPage = () =>
  shell(
    "Privacy",
    `<p>This server is operated by its owner to access the owner's own bank accounts. It is not offered as a service to anyone else.</p>
     <p>Account identifiers and consent references from Enable Banking are stored on the server so the owner's assistant can fetch balances and transactions on request. Transactions and balances themselves are not stored. No data is shared with third parties and nothing is collected about visitors.</p>`,
  );

export const termsPage = () =>
  shell("Terms", `<p>Personal software run by its owner for their own non-commercial use, under Enable Banking's terms for individual use of their production environment.</p>`);
