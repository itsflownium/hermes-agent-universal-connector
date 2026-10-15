# Backend contract

No application frontend is included. OAuth/pairing consent is part of the backend
authentication protocol. Live integration credentials are optional during development.

## Components

1. The Python host controller supervises a dedicated real Hermes dashboard and
   either an Iroh listener or a Cloudflare connector. It verifies the login gate
   before starting the transport and continues checking it while running.
2. Private Iroh mode uses native Hermes username/password authentication. The
   remote access command exposes only a loopback TCP listener and forwards its
   traffic over Iroh. Endpoint tickets locate a peer; they do not replace login.
3. The Node account service pairs installations with provider identities and
   issues OIDC tokens bound to each device's client ID and exact callback URL.
4. The Node gateway maps registered device routes to Iroh endpoint tickets. It
   streams HTTP and forwards WebSocket upgrades without interpreting agent commands.

## API

| Method | Route | Authentication / behavior |
|---|---|---|
| GET | `/health` | Service health and configured integrations |
| GET | `/v1/capabilities` | Protocol version and supported transports |
| POST | `/v1/cli/device` | Create an expiring device-code grant; rate limited |
| GET/POST | `/activate` | Provider session plus CSRF; explicit pairing confirmation |
| POST | `/v1/cli/token` | Poll a device-code grant; single-use token exchange |
| POST | `/v1/devices` | CLI bearer token; register the installation idempotently |
| GET | `/v1/devices` | Account session/bearer; public metadata for owned devices |
| POST | `/v1/devices/:id/heartbeat` | Installation-scoped bearer; advertise endpoint and version |
| DELETE | `/v1/devices/:id` | Installation-scoped bearer; revoke transport and OIDC grants |
| GET | `/.well-known/openid-configuration` | OIDC discovery |
| GET | `/oidc/jwks` | Public RS256 signing key |
| GET | `/oidc/authorize` | Registered device, owning account, exact callback and PKCE |
| POST | `/oidc/token` | Code exchange or rotating refresh grant |
| POST | `/oidc/revoke` | Refresh-token revocation |
| any / upgrade | `/remote/:id/*` | Iroh forwarding; native Hermes authenticates the workspace |

`POST /v1/devices` accepts:

```json
{"name":"My laptop","local_port":19119,"kind":"hermes-dashboard","transport":"iroh"}
```

It returns `device_id`, `transport`, `public_url`, `hostname`, `oidc_issuer` and
`oidc_client_id`. Cloudflare mode additionally returns a device-scoped
`tunnel_token`; Iroh mode never requires a Cloudflare token.

Iroh heartbeats carry `iroh_ticket` and `hermes_version`. Endpoint tickets and
transport credentials are omitted from device-list responses. A heartbeat is a
liveness indication, not proof of end-to-end global connectivity.

## Connection behavior

Host processes bind Hermes to loopback. Iroh handles device discovery, NAT
traversal and relay fallback; no region or home IP is hard-coded. A sleeping or
offline laptop cannot execute tasks. Transport failure stops the managed session
or produces an explicit unavailable response; no fake successful responses or
automatic command replays are generated.

Gateway routing uses registered device IDs/hostnames, never arbitrary client
TCP destinations. Paths sharing the account service's origin require that
device's owning browser session before any laptop response is forwarded; foreign
accounts are rejected. Separate workspace subdomains use native Hermes OIDC.
Platform session cookies are removed before forwarding to a
laptop. Native Hermes cookies are scoped to a device's gateway path. Revocation
disconnects an active Iroh gateway connector and stops future OIDC grants.

The account service origin must be HTTPS outside loopback development. Its
provider-supplied hostname is enough; buying a domain is optional. Native Iroh
clients do not require a public HTTP gateway or a registered domain.

## Operator deployment

Run `node service/server.mjs` with Node 22+, or build the optional container with
`docker build -f service/Dockerfile .`. The container includes the pinned Iroh
connector and needs a persistent `/data` volume. The container build has not been
executed in this workspace.

To prepare a checkout for an account server:

```sh
./setup --prepare-only
mkdir -p work
cp service/operator.env.example work/operator.env
chmod 600 work/operator.env
```

Edit `work/operator.env`: set `FLOWNIUM_ORIGIN` to the server's HTTPS origin and
`FLOWNIUM_IROH_BIN` to the absolute path of `work/bin/dumbpipe`. Set the GitHub
OAuth app values for provider sign-in; Cloudflare values and the workspace domain
can remain empty for Iroh. Then start the server with Node's built-in env loader:

```sh
node --env-file=work/operator.env service/server.mjs
```

Use an HTTPS reverse proxy or hosting provider in front of this process, with
HTTP streaming and WebSocket upgrades enabled. The default listener is loopback;
set `BIND_HOST=0.0.0.0` only when the deployment network requires it. Persist
`FLOWNIUM_SERVICE_DATA`. `/health` reports which integrations are configured.
On each Hermes computer, run `./setup --mode account --server <HTTPS-origin>`,
complete the browser pairing, and keep the computer online. Setup starts the
transport after approval. Subsequent `./flownium off` and `./flownium on` reuse
that computer's saved configuration.

Supply GitHub OAuth settings only when enabling provider-account pairing. Its
callback is `<FLOWNIUM_ORIGIN>/auth/callback`. Supply Cloudflare settings only when
enabling the optional Cloudflare transport. Do not put credentials into source,
PR bodies or CLI arguments. Basic Iroh sharing works without either integration.

The current store is single-process JSON. Keep its private state directory and
RSA key persistent. Horizontal scaling needs transactional storage and key
rotation; do not run concurrent service instances against the same JSON file.
