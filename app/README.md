# Nectit web workspace for Hermes Agent

Nectit signs you in, connects to your Hermes computer through Iroh, and loads
that computer's actual Hermes Desktop renderer in your browser. Chat, tabs,
model controls, sessions, layout and settings come from the installed Hermes
build; this repository does not contain a frozen copy of that interface.

## Start locally

Install/configure Hermes first, including its desktop app. A source installation
can prepare the desktop renderer with `hermes gui --build-only`.
Use Node.js 22+, Python 3.10+ and Git on macOS/Linux or WSL2:

```sh
git clone https://github.com/itsflownium/hermes-agent-universal-connector.git
cd hermes-agent-universal-connector
./setup --desktop
./nectit app
```

Choose **Share Hermes on this computer** and supply an email and sharing password.
Setup downloads the pinned official Iroh transport after verifying its checksum.
`./nectit app` opens <http://127.0.0.1:8788>. There is no frontend build or npm
install. Alternatively, run `./nectit app` first; its Computer page can prepare
and start the host connection. Existing independent Hermes processes are preserved.
The `flownium` launcher remains a compatibility alias.

The three setup pages are:

1. **Account:** create your email/password account on first setup. Return with
   the same email and password to sign in. A fresh visit stays signed out.
2. **Your URL:** choose `/w/<name>`. Locally this is an address on this computer;
   it does not reserve a subdomain or register DNS.
3. **Computer:** connect this computer, or paste another computer's endpoint
   ticket, sharing email and password. The router verifies Hermes authentication
   and the desktop build before opening the workspace.

Subsequent sign-in opens `/w/<name>` directly. An offline computer redirects to
connection recovery. Signing out invalidates the session and closes its sockets;
**Disconnect this computer** stops the managed host connection. The terminal and
website use the same controller state, so `./nectit off`, `on`, `status` and
`doctor` also control the connection created by the website. Closing the launcher
stops a host it started in that run, and preserves a host already running when
it connected. `--state-dir PATH` selects an isolated controller.

## Pair another computer with a code

Keep `./nectit app` running on the computer with Hermes connected. In another
terminal on that host:

```sh
./nectit pair code
```

On the other computer, clone the repository and run `./nectit app`. Create its
own local account, choose **Pair a computer**, paste the code, name the device,
and open Hermes. No sharing password has to be copied. The code works once and
expires in five minutes; requesting another replaces an unused code. Compare the
host fingerprint shown on both computers. The connected Computer page also has
**Create pairing code** and **Revoke** controls.

```sh
./nectit pair devices
./nectit pair revoke DEVICE_ID
```

Each device gets its own random credential; only its hash is kept on the host.
Revocation closes that device's active sockets/streams and rejects later
requests. Codes and device credentials grant access to your Hermes computer,
so share them only with devices you trust. Keep both local Nectit apps running.
Closing the host app closes its pairing listener. It does not publish a public
website or create DNS.

The endpoint-ticket/email/password connection remains available as **Endpoint
ticket**. The older `./setup --mode client` / `./nectit access` commands are for
the native Hermes dashboard and should use a host started without `--desktop`.

## Continue the same terminal chat on the website

With the Nectit app connected, start an actual Hermes TUI in another terminal:

```sh
./nectit cli
# Resume an existing conversation on that same backend:
./nectit cli --resume SESSION_ID
# Select a profile when needed:
./nectit cli --resume SESSION_ID --profile PROFILE_NAME
```

In the web workspace, select **CLI chats**, choose the matching profile, find
the conversation and click **Continue**. Send its first message before refreshing
the picker: unused drafts are not saved by Hermes. The TUI and desktop renderer
attach to the same Hermes runtime; messages and streamed replies appear in both.
The local terminal credential is a private `0600` file, kept out of HTML, public
API responses, process arguments and printed output. `--app-data PATH` selects
another app directory; the launcher normally discovers its app automatically.

**An already-running standalone `hermes` process needs a handoff.** Wait for its
current turn to finish, run `/exit` in that terminal, then select the saved chat
from **CLI chats**. Its conversation history is resumed without copying or
forking the chat. Hermes's writer-ownership checks remain enforced; Nectit never
kills the original process, takes its lease or claims to attach to a process
that exposes no shared runtime. Launch subsequent shared chats with
`./nectit cli`. A changed renderer/transport contract in future Hermes versions
may need a Nectit adapter update.

## How desktop updates reach the website

The controller discovers the installed `apps/desktop/dist` or packaged desktop
renderer, and exposes it through a private stable symlink to Hermes' web server.
`HERMES_DESKTOP_DIST=/absolute/path/to/dist` explicitly selects a different build;
`HERMES_AGENT_ROOT` selects a nonstandard Hermes checkout. No installed Hermes
source or global configuration is modified.

Authenticated HTML, hashed assets, REST APIs and ticket-authenticated WebSockets
travel through the same connection. Nectit's browser adapter replaces Electron's
transport and window hooks; Hermes still renders the UI and handles sessions,
streaming, reasoning and approvals. Native cookies remain on the gateway.

The controller checks for a newer complete installed build every 15 seconds, including when the updater changes directories. Every workspace navigation reads the current installed HTML. A revision check
on focus, reconnect and a 45-second interval offers **Reload workspace** when
that HTML changes. Updating Hermes on the host therefore updates the web UI
when reopened/reloaded, including through Iroh. A backend change may also need
`./nectit off && ./nectit on` to restart that managed Python process. No automatic
reload interrupts an open draft. A future incompatible Electron bridge change
may require a Nectit adapter update; this is not a promise of arbitrary future
API compatibility.

OS-only features such as HUD windows, tray controls and native dialogs are not
browser features. HUD is hidden; unsupported native actions fail explicitly.
Browser-compatible Hermes REST/JSON-RPC features are forwarded to the real host.

## Email and password

Create your account with an email address and a password of at least 12
characters. Later visits show **Sign in** and open the configured Hermes
workspace after authentication. Passwords are stored as salted scrypt hashes.
No external sign-in registration or provider credentials are needed.

This local prototype has one owner per data directory. It has no mail delivery,
email verification or password-reset service. Use a separate data directory for
a different owner. Optional router settings can go in the ignored
`work/local-app.env` using `app/local.env.example`; `./nectit app` loads it
automatically when present.

## Browser access on any device

Iroh connects native gateways; ordinary browsers cannot directly open an Iroh
endpoint ticket. A reachable HTTPS Nectit gateway is the browser entry point:

```text
Phone / tablet / computer browser
        ↓ HTTPS, Nectit account
Hosted Nectit gateway (Node, no model keys)
        ↓ encrypted Iroh connection
Your awake laptop → Hermes backend + current desktop renderer
```

Complete the owner account setup locally before exposing a gateway. The same app can run on a gateway machine with `NECTIT_PUBLIC_ORIGIN` set to its
actual HTTPS origin. Put it behind a TLS reverse proxy preserving `Host` and
WebSocket upgrades to `127.0.0.1:8788`, and use **Another computer** to
connect the laptop. Cookies then require
HTTPS. A hosting provider's HTTPS address is sufficient; your own subdomain can
be added later. This PR does not deploy a gateway, create DNS or claim that the
localhost preview is already reachable from the internet.

For now this gateway is single-owner. The separate account backend in
`docs/backend.md` provides the multi-user device registry/pairing groundwork;
shared public enrollment, automatic subdomain allocation and deployment remain
platform work, not functionality simulated by this local preview.

## Development and private data

```sh
node --test app/server.test.mjs app/pairing.test.mjs
```

App state and the native session cookie are private files under `work/local-app`
(directory `0700`, files `0600`). Raw sharing passwords go only through stdin
and the native password-login request, never argv or saved settings. Session
cookies are HttpOnly/SameSite, and Secure on the configured public origin. Host
and Origin checks reject rebinding and cross-site mutations. Private files and
Electron executable/preload bundles are not exposed by the static routes.

`FLOWNIUM_APP_PORT`, `FLOWNIUM_APP_DATA`, `FLOWNIUM_APP_HOST_STATE`,
`FLOWNIUM_IROH_BIN`, and `FLOWNIUM_PYTHON` remain compatible environment overrides.
Restart Node after server changes; setup assets are read from source on refresh.

An opt-in integration check pairs two real Iroh endpoints against an already
connected host, validates the current Hermes API/renderer, and revokes the peer:

```sh
node tests/live_pairing_check.mjs --app-data work/local-app
# Also verify read-only attachment to a known conversation (no inference):
node tests/live_pairing_check.mjs --app-data work/local-app --resume SESSION_ID --profile PROFILE_NAME
```

The supplied screenshots and [Io](https://coralinelabs.io) informed the restrained
centered setup layout. Nectit uses its own branding, composition and colors.
[Hermes Agent](https://github.com/NousResearch/hermes-agent) is by Nous Research,
licensed under MIT; its renderer is served from the user's installation.
