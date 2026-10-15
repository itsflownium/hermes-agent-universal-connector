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
};
const icon = (name, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphs[name] || glyphs.arrow}"/></svg>`;
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
    return `<div class="page-heading"><span class="eyebrow">A space for your agent</span><h1>You’re signed in.</h1><p>Your account connects you to the Hermes on your computer.</p></div><div class="identity"><span class="avatar">${esc(profile.email[0]?.toUpperCase())}</span><div><strong>${esc(profile.email)}</strong><span>Email account</span></div>${icon("check")}</div><button class="text-button" type="button" data-action="signout">Use another account</button>`;
  return `<div class="page-heading"><h1>${profile.configured ? "Welcome back." : "Your Hermes, anywhere."}</h1><p>${profile.configured ? "Sign in to return to your Hermes workspace." : "Create your account to connect to Hermes on your computer."}</p></div><div class="email-fields">${input("email", "Email address", "you@example.com", 'type="email" autocomplete="email" maxlength="254" autocapitalize="none" spellcheck="false"')}${input("password", "Password", profile.configured ? "Your password" : "At least 12 characters", `type="password" autocomplete="${profile.configured ? "current-password" : "new-password"}" minlength="12" maxlength="1024"`)}</div><p class="privacy-note">${icon("lock", 12)} Your agent and files stay on your computer.</p>`;
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
  root.innerHTML = `<div class="setup-shell"><header class="site-header"><a href="/" class="brand" aria-label="Nectit home">${brand}</a><span class="header-note">for Hermes Agent</span></header><main><section class="setup-card" aria-label="Set up Nectit"><nav class="steps" aria-label="Setup progress">${["Account", "Your URL", "Computer"].map((label, i) => `<div class="step ${i <= index ? "reached" : ""} ${i === index ? "current" : ""}" ${i === index ? 'aria-current="step"' : ""}><span class="step-bar"></span><span>${label}</span></div>`).join("")}</nav><form id="setup-form"><div class="step-content">${step === "account" ? accountPage() : step === "address" ? addressPage() : computerPage()}${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ""}${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}</div><footer class="card-footer">${index ? `<button class="text-button" type="button" data-action="back" ${busy ? "disabled" : ""}>${icon("back", 16)} Back</button>` : '<span class="step-count">Step 1 of 3</span>'}<button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Connecting…" : step === "computer" ? "Open Hermes" : step === "account" && !profile.signedIn ? (profile.configured ? "Sign in" : "Create account") : "Continue"}${!busy ? icon("arrow", 16) : '<span class="spinner"></span>'}</button></footer></form></section><p class="below-card">Hermes on your computer. A workspace that goes with you.</p></main><footer class="site-footer"><span><span class="status-dot"></span>${profile.localOnly ? " Local preview" : " Secure workspace"}</span><a href="https://github.com/itsflownium/hermes-agent-universal-connector" target="_blank" rel="noreferrer">Open source ${icon("arrow", 12)}</a></footer></div>`;
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
    route("/setup/" + step, true);
    render();
  } catch {
    root.innerHTML =
      '<main class="unavailable"><h1>Nectit is unavailable.</h1><p>Start the local router with <code>./nectit app</code>, then reload this page.</p><button onclick="location.reload()">Reload</button></main>';
  }
}
window.addEventListener("popstate", boot);
void boot();
