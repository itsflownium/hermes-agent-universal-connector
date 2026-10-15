const root = document.querySelector("#root");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const glyphs = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  back: "m14 6-6 6 6 6",
  check: "m5 12 4 4L19 6",
  copy: "M9 9h11v11H9zM5 15H3V3h12v2",
  computer: "M3 4h18v13H3zM8 21h8M12 17v4",
  globe:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z",
  github:
    "M9 19c-4 1-4-2-6-2m12 5v-4c0-1 .1-2-1-3 4 0 7-2 7-6 0-2-1-3-2-4 0-1 0-2-1-3-2 0-4 1-5 1s-3-1-5-1c-1 1-1 2-1 3-1 1-2 2-2 4 0 4 3 6 7 6-1 1-1 2-1 3v4",
};
const icon = (name, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphs[name] || glyphs.arrow}"/></svg>`;
const google =
  '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.7 4.7 0 0 1-2 3.1 6.4 6.4 0 1 1 1.2-9.7l3-3A10.6 10.6 0 1 0 12 22.5c6.1 0 9.6-4.2 9.6-10.3z"/></svg>';
const brand =
  '<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M5 20V8a3 3 0 0 1 6 0v10a3 3 0 0 0 6 0V6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="21" cy="6" r="2" fill="currentColor"/></svg><span>nectit</span>';
let profile,
  status,
  step = "account",
  kind = "host",
  busy = false,
  error = "",
  notice = "",
  toastTimer;
let authPopup = null,
  authPending = null,
  authTimer = null,
  authResumeUntil = 0;
function endAuth() {
  clearInterval(authTimer);
  authTimer = null;
  authPending = null;
  authPopup = null;
}
async function finishAuth() {
  const next = await api("/local/bootstrap");
  if (!next.signedIn) return false;
  endAuth();
  location.assign(next.setupComplete ? "/w/" + next.slug : "/setup/address");
  return true;
}
function beginAuth(provider) {
  if (authPending) {
    authPopup?.focus();
    return;
  }
  const width = 500,
    height = 700;
  const left = Math.max(0, screenX + (outerWidth - width) / 2);
  const top = Math.max(0, screenY + (outerHeight - height) / 2);
  // Open synchronously from the user's click so normal popup rules allow it.
  authPopup = window.open(
    "/login/" + provider + "?popup=1",
    "nectit-signin-" + location.port,
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
  if (!authPopup) {
    location.assign("/login/" + provider);
    return;
  }
  authPending = provider;
  authResumeUntil = Date.now() + 600000;
  notice = "Complete sign-in in the window that opened.";
  render();
  const deadline = Date.now() + 600000;
  authTimer = setInterval(async () => {
    // Providers can isolate their window using COOP; server-side cookie polling
    // recovers completion even when window.opener/closed become unavailable.
    try {
      if (await finishAuth()) return;
    } catch {}
    if (authPopup?.closed) {
      endAuth();
      notice = "The sign-in window closed. You can try again.";
      render();
      return;
    }
    if (Date.now() > deadline) {
      endAuth();
      notice = "Sign-in timed out. Please try again.";
      render();
    }
  }, 2000);
}
window.addEventListener("message", async (event) => {
  if (
    !authPending ||
    event.origin !== location.origin ||
    event.source !== authPopup ||
    event.data?.type !== "nectit-auth" ||
    event.data.provider !== authPending
  )
    return;
  if (event.data.result === "success") {
    try {
      await finishAuth();
    } catch {
      error = "Sign-in could not finish. Please try again.";
      endAuth();
      render();
    }
    return;
  }
  const provider = authPending === "google" ? "Google" : "GitHub";
  endAuth();
  notice =
    event.data.result === "configuration"
      ? `${provider} requires Nectit’s registered OAuth client ID and secret. Add them to the local environment file to enable the real provider sign-in.`
      : event.data.result === "cancelled"
        ? "Sign-in was cancelled. You can try again."
        : "Sign-in could not finish. Please try again.";
  render();
});
window.addEventListener("focus", () => {
  if (
    profile &&
    !profile.signedIn &&
    (authPending || Date.now() < authResumeUntil)
  )
    void finishAuth().catch(() => {});
});
const clone =
  "git clone --branch hermes-agent-local-app https://github.com/itsflownium/hermes-agent-universal-connector.git";
const setup = "cd hermes-agent-universal-connector && ./setup --desktop";
async function api(path, data) {
  const response = await fetch(
    path,
    data
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : {},
  );
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || "The local service is unavailable.");
  return value;
}
function route(path, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", path);
}
function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 2800);
}
function input(name, label, placeholder, extra = "") {
  return `<label class="field">${label}<input name="${name}" placeholder="${placeholder}" ${extra} ${busy ? "disabled" : ""} required></label>`;
}
function accountPage() {
  if (profile.signedIn)
    return `<div class="page-heading"><span class="eyebrow">A space for your agent</span><h1>You’re signed in.</h1><p>Your account connects you to the Hermes on your computer.</p></div><div class="identity"><span class="avatar">${esc(profile.email[0]?.toUpperCase())}</span><div><strong>${esc(profile.email)}</strong><span>${profile.accountProvider === "local" ? "Email account" : profile.accountProvider === "github" ? "GitHub account" : "Google account"}</span></div>${icon("check")}</div><button class="text-button" type="button" data-action="signout">Use another account</button>`;
  return `<div class="page-heading"><h1>${profile.configured ? "Welcome back." : "Your Hermes, anywhere."}</h1><p>${profile.configured ? "Sign in to return to your Hermes workspace." : "Sign in to a workspace powered by your computer."}</p></div><div class="providers"><button class="provider" type="button" data-action="github">${icon("github")} Continue with GitHub</button><button class="provider" type="button" data-action="google">${google} Continue with Google</button></div><div class="divider"><span>or use your email</span></div><div class="email-fields">${input("email", "Email address", "you@example.com", 'type="email" autocomplete="email" maxlength="254" autocapitalize="none" spellcheck="false"')}${input("password", "Password", profile.configured ? "Your password" : "At least 12 characters", `type="password" autocomplete="${profile.configured ? "current-password" : "new-password"}" minlength="12" maxlength="1024"`)}</div><p class="privacy-note">${icon("lock", 12)} Your agent and files stay on your computer.</p>`;
}
function addressPage() {
  return `<div class="page-heading"><span class="eyebrow">A place to return to</span><h1>A URL of your own.</h1><p>Give your workspace a name. Keep it simple, make it yours.</p></div><label class="field" for="address">Workspace address</label><div class="address-input"><span>${esc(location.host)}/w/</span><input id="address" name="slug" aria-label="Workspace name" value="${esc(profile.slug || "my-hermes")}" pattern="[a-z0-9](?:[a-z0-9\\-]{0,30}[a-z0-9])?" maxlength="32" required spellcheck="false" autocapitalize="none"></div><p class="availability">${icon("check", 14)}<span id="address-status">Available on this computer</span></p><div class="explanation"><span class="explanation-icon">${icon("globe", 20)}</span><div><strong>One address. Your whole workspace.</strong><p>${profile.localOnly ? "This preview uses a local URL. A hosted gateway will give you a secure browser link for other devices; Iroh connects it to your laptop." : "Open this secure address from any device. Iroh connects this gateway to your Hermes computer."}</p></div></div><div class="address-preview"><span class="preview-dot"></span><span>${icon("computer", 16)} Your Hermes computer</span><span class="preview-line"></span><span>${icon("globe", 16)} Your browser</span></div>`;
}
function command(value, action) {
  return `<div class="command"><code>${esc(value)}</code><button type="button" data-action="${action}" aria-label="Copy ${action === "copy-clone" ? "clone" : "setup"} command">${icon("copy", 14)} Copy</button></div>`;
}
function computerPage() {
  if (status?.connected)
    return `<div class="page-heading"><span class="eyebrow">Everything in its place</span><h1>Hermes is ready.</h1><p>Your computer is connected. Open the same desktop workspace, right here in your browser.</p></div><div class="ready-computer">${icon("computer", 48)}<div><strong>Hermes Agent</strong><span>Version ${esc(status.connection?.version || "")}</span></div><span class="status-dot"></span></div><div class="explanation"><span class="explanation-icon">${icon("check", 20)}</span><div><strong>Your desktop, kept current.</strong><p>Nectit loads the Hermes interface from your connected computer. Update Hermes there, then reload your web workspace to use the new build.</p></div></div><button type="button" data-action="disconnect" class="text-button">Disconnect this computer</button>`;
  return `<div class="page-heading"><span class="eyebrow">Your computer does the work</span><h1>Bring Hermes along.</h1><p>Connect the computer that runs Hermes. Keep it awake and online to reach your agent from other devices.</p></div><div class="connection-choice"><button type="button" data-action="host" class="${kind === "host" ? "selected" : ""}" aria-pressed="${kind === "host"}">${icon("computer", 16)} This computer</button><button type="button" data-action="peer" class="${kind === "peer" ? "selected" : ""}" aria-pressed="${kind === "peer"}">${icon("globe", 16)} Another computer</button></div><div class="connection-fields">${kind === "peer" ? input("ticket", "Iroh endpoint ticket", "endpoint…", 'spellcheck="false" class="mono"') : ""}${input("email", "Sharing email", "you@example.com", `type="email" value="${esc(kind === "host" ? profile.email : "")}" autocomplete="email" maxlength="254"`)}${input("password", kind === "host" ? "Sharing password" : "Password from your computer", "At least 12 characters", 'type="password" autocomplete="current-password" minlength="12" maxlength="1024"')}<p class="field-hint">${kind === "host" ? "Use your existing sharing credentials, or choose them here for a new connection." : "Use the email and password you chose in terminal setup on the host."}</p></div><details class="terminal-setup" ${kind === "peer" ? "open" : ""}><summary>Set up your computer from the terminal</summary><p>Run these on the computer with Hermes installed. Setup prints an endpoint ticket to connect another device.</p>${command(clone, "copy-clone")}${command(setup, "copy-setup")}<p class="field-hint">Then run <code>./nectit app</code> to open this website locally. Start or stop the connection with <code>./nectit on</code> and <code>./nectit off</code>.</p></details><p class="connection-status"><span class="status-dot ${busy ? "pulse" : "off"}"></span>${busy ? "Starting Hermes and checking the connection…" : "Your workspace opens after the connection is verified."}</p>`;
}
function render() {
  const index = ["account", "address", "computer"].indexOf(step);
  document.title =
    ["Sign in", "Your URL", "Your computer"][index] + " · Nectit";
  root.innerHTML = `<div class="setup-shell"><header class="site-header"><a href="/" class="brand" aria-label="Nectit home">${brand}</a><span class="header-note">for Hermes Agent</span></header><main><section class="setup-card" aria-label="Set up Nectit"><nav class="steps" aria-label="Setup progress">${["Account", "Your URL", "Computer"].map((label, i) => `<div class="step ${i <= index ? "reached" : ""} ${i === index ? "current" : ""}" ${i === index ? 'aria-current="step"' : ""}><span class="step-bar"></span><span>${label}</span></div>`).join("")}</nav><form id="setup-form"><div class="step-content">${step === "account" ? accountPage() : step === "address" ? addressPage() : computerPage()}${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}</div><footer class="card-footer">${index ? `<button class="text-button" type="button" data-action="back" ${busy ? "disabled" : ""}>${icon("back", 16)} Back</button>` : '<span class="step-count">Step 1 of 3</span>'}<button class="primary" type="submit" ${busy || authPending ? "disabled" : ""}>${authPending ? "Signing in…" : busy ? "Connecting…" : step === "computer" ? "Open Hermes" : step === "account" && !profile.signedIn ? (profile.configured ? "Sign in" : "Create account") : "Continue"}${!busy ? icon("arrow", 16) : '<span class="spinner"></span>'}</button></footer></form></section><p class="below-card">Hermes on your computer. A workspace that goes with you.</p></main><footer class="site-footer"><span><span class="status-dot"></span>${profile.localOnly ? " Local preview" : " Secure workspace"}</span><a href="https://github.com/itsflownium/hermes-agent-universal-connector" target="_blank" rel="noreferrer">Open source ${icon("arrow", 12)}</a></footer></div>`;
  document.querySelector("#setup-form").addEventListener("submit", submit);
  root
    .querySelectorAll("[data-action]")
    .forEach((element) =>
      element.addEventListener("click", () => action(element.dataset.action)),
    );
  document.querySelector("#address")?.addEventListener("input", (event) => {
    const good = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(
      event.target.value,
    );
    document.querySelector("#address-status").textContent = good
      ? "Available on this computer"
      : "Use lowercase letters, numbers and hyphens";
  });
}
async function action(name) {
  if (busy) return;
  if (["github", "google"].includes(name)) {
    beginAuth(name);
    return;
  }
  if (name.startsWith("copy-")) {
    try {
      await navigator.clipboard.writeText(
        name === "copy-clone" ? clone : setup,
      );
      toast("Command copied");
    } catch {
      toast("Select the command to copy it.");
    }
    return;
  }
  try {
    if (name === "back") step = step === "computer" ? "address" : "account";
    if (name === "host" || name === "peer") kind = name;
    if (name === "disconnect") {
      await api("/local/disconnect", {});
      status = await api("/local/status");
    }
    if (name === "signout") {
      await api("/local/signout", {});
      profile = await api("/local/bootstrap");
      status = null;
      step = "account";
    }
    error = "";
    notice = "";
    route("/setup/" + step);
    render();
  } catch (problem) {
    error = problem.message;
    render();
  }
}
async function submit(event) {
  event.preventDefault();
  if (busy) return;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  error = "";
  notice = "";
  try {
    if (step === "account") {
      if (!profile.signedIn)
        Object.assign(profile, await api("/local/signin", data), {
          signedIn: true,
          configured: true,
        });
      if (profile.setupComplete) {
        location.assign("/w/" + profile.slug);
        return;
      }
      step = "address";
    } else if (step === "address") {
      Object.assign(profile, await api("/local/address", data));
      step = "computer";
    } else {
      if (!status?.connected) {
        busy = true;
        render();
        await api("/local/connect", { ...data, kind });
      }
      location.assign("/w/" + profile.slug);
      return;
    }
    route("/setup/" + step);
    render();
  } catch (problem) {
    busy = false;
    error = problem.message;
    render();
  }
}
async function boot() {
  try {
    profile = await api("/local/bootstrap");
    const path = location.pathname;
    if (
      profile.signedIn &&
      profile.setupComplete &&
      (path === "/" || path === "/setup/account")
    ) {
      location.replace("/w/" + profile.slug);
      return;
    }
    step = profile.signedIn
      ? /\/setup\/(address|computer)$/.exec(path)?.[1] || "address"
      : "account";
    if (step === "computer") status = await api("/local/status");
    const hint = new URLSearchParams(location.search).get("notice");
    if (hint === "offline")
      notice =
        "Your computer is offline or the router needs to reconnect. Check the connection below.";
    if (hint === "cancelled")
      notice = "Sign-in was cancelled. You can try again.";
    if (hint === "github" || hint === "google")
      notice =
        "Configure the provider in your local environment file to enable this sign-in option.";
    route("/setup/" + step, true);
    render();
  } catch {
    root.innerHTML =
      '<main class="unavailable"><h1>Nectit is unavailable.</h1><p>Start the local router with <code>./nectit app</code>, then reload this page.</p><button onclick="location.reload()">Reload</button></main>';
  }
}
window.addEventListener("popstate", boot);
void boot();
