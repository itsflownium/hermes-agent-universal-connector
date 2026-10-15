# Hermes Agent Universal Connector

Flownium's **backend-only** connector for real Hermes Agent installations.
Iroh is the primary transport; Cloudflare Tunnel is optional and can be configured
later. No custom web interface is included. The browser pages in the account
service are limited to OAuth/device-pairing consent.

## Use it now: Iroh and a password

Requires Python 3.10+, an existing Hermes installation, and the official Iroh
`dumbpipe` executable. The host supports macOS, Linux, and Windows through WSL2.
Hermes's browser chat requires a POSIX PTY, so native Windows should run the host
inside WSL2. The Iroh transport itself has native Windows binaries.

Install the pinned, checksum-verified transport into the project directory:

```sh
python3 tools/install_iroh.py --directory work/bin
```

On the laptop with Hermes:

```sh
./flownium share --username arhaan --dumbpipe-bin ./work/bin/dumbpipe
```

Enter a sharing password at the hidden prompt. Flownium starts a dedicated real
Hermes dashboard, verifies its password gate, and then enables Iroh. It prints
an endpoint ticket, not a secret key. The password is stored as a salted scrypt
hash; secrets are never command-line arguments.

On another computer with this connector and `dumbpipe` installed:

```sh
./flownium access <endpoint-ticket> --dumbpipe-bin ./work/bin/dumbpipe
```

Open the printed loopback browser URL and sign in with the host's credentials.
The connection between the computers uses Iroh's authenticated encryption and
NAT traversal/relay support. **A registered domain and Cloudflare are not needed.**
Leave the access command running; Ctrl+C disconnects that client.

On the host:

```sh
./flownium status
./flownium off
./flownium on
./flownium doctor
```

`off` disables the processes Flownium started. It does not power off the laptop
or terminate independently running Hermes sessions. `on` reuses the saved sharing
configuration. The laptop must remain awake and connected. A native Hermes chat
tab controls its own PTY lifetime; tasks are not promised to survive closing it.

The host also supports `local`, `login`, `open`, and `logout`. Use `--profile NAME`
to select an existing Hermes profile or `--hermes-bin PATH` for another install.
State defaults to `~/.config/flownium`; override with global `--state-dir PATH`.
The controller uses a private Unix control socket rather than trusting stored
PIDs. Do not enable other dashboard auth providers in a password-sharing profile.

For a packaged command, install this source with `python3 -m pip install .`.

## Server/account backend

```sh
node service/server.mjs
```

The service boots without GitHub or Cloudflare credentials. `/health` and
`/v1/capabilities` report the configuration state; unconfigured integrations
return explicit errors. Use Node 22+ and run one service process per data directory.

With a deployed account-service origin and a GitHub OAuth app configured:

```sh
./flownium login --server https://your-provider-supplied-host --transport iroh
./flownium on
```

The operator sets `SERVICE_URL` in `flownium_distribution.py` before distributing
the package, so ordinary users can simply run `flownium login`. Users do not
configure DNS or supply platform credentials.

The service provides device-code pairing, account ownership, OIDC authorization
code/PKCE authentication for native Hermes, signed ID tokens, rotating refresh
tokens, scoped endpoint heartbeats, device status and revocation. The host uses
the existing Hermes model, tools, skills and conversations. It does not emulate
the agent or copy API keys to the platform.

The Iroh gateway forwards HTTP, streaming responses and WebSocket upgrades to
registered laptops. With no custom domain it routes by
`<service-origin>/remote/<device-id>/...`. This can use a hosting provider's default
HTTPS address. A regular browser needs this gateway or a local Iroh access client;
an Iroh endpoint ticket is not itself an HTTPS URL.

Optional personal subdomains can be enabled under a platform-owned namespace.
Cloudflare-specific configuration is also optional; use `--transport cloudflare`
after the operator supplies the account/zone credentials. Platform Cloudflare
credentials remain on the server; only device-scoped tunnel tokens reach laptops.

See [the backend protocol](docs/backend.md) and
[operator environment example](service/operator.env.example).

## Verification

```sh
python3 -m unittest discover -s tests -p test_cli.py -v
node --test service/core.test.mjs service/iroh-gateway.test.mjs
```

Opt-in checks against an installed real Hermes, with no model inference request:

```sh
python3 tests/live_hermes_check.py
node tests/live_oidc_check.mjs
python3 tests/live_iroh_check.py --dumbpipe-bin ./work/bin/dumbpipe
FLOWNIUM_IROH_BIN=./work/bin/dumbpipe node tests/live_gateway_check.mjs
```

The Iroh check uses two real endpoints and real Hermes password authentication;
it verifies rejected credentials and an authenticated chat page without a domain
or Cloudflare. The OIDC check uses real Hermes and the real local OIDC service,
with isolated fixtures only for external GitHub identity and Cloudflare.
CI runs host tests on Linux/macOS and service tests on Linux. Cross-region
connectivity and live Cloudflare/GitHub provisioning are not yet verified.

The account service currently uses a single-process JSON store and a persisted
RSA signing key. Multi-instance storage and signing-key rotation remain deployment
work before broad registration. A custom web interface remains a separate task.

References: [Hermes dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard),
[official Iroh dumbpipe](https://github.com/n0-computer/dumbpipe),
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).
