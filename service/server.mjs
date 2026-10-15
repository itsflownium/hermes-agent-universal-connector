import http from 'node:http';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cloudflare, HTTPError, Store, createApp, githubProvider, signingKey } from './core.mjs';
import { IrohGateway, remoteDevice } from './iroh-gateway.mjs';

const originURL = new URL(process.env.FLOWNIUM_ORIGIN || 'http://127.0.0.1:8787');
if (originURL.protocol !== 'https:' && !(originURL.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(originURL.hostname))) throw new Error('Use HTTPS, or loopback HTTP for development.');
const workspaceDomain = process.env.FLOWNIUM_WORKSPACE_DOMAIN || null;
if (workspaceDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(workspaceDomain)) throw new Error('Invalid workspace namespace.');
const data = resolve(process.env.FLOWNIUM_SERVICE_DATA || './work/flownium-service');
const store = new Store(resolve(data, 'state.json'));
const githubReady = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
const cloudflareReady = !!(workspaceDomain && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ZONE_ID);
const irohBinary = process.env.FLOWNIUM_IROH_BIN || 'dumbpipe';
const irohReady = spawnSync(irohBinary, ['--help'], { stdio: 'ignore', timeout: 3000 }).status === 0;
const notConfigured = name => () => { throw new HTTPError(503, name + ' is not configured yet.', 'configuration_required'); };
const cloudflare = cloudflareReady ? new Cloudflare({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  zoneId: process.env.CLOUDFLARE_ZONE_ID, workspaceDomain }) : { provision: notConfigured('Cloudflare'), token: notConfigured('Cloudflare'), revoke: notConfigured('Cloudflare') };
const app = createApp({ origin: originURL.origin, workspaceDomain, store, signer: signingKey(resolve(data, 'oidc-private.pem')),
  github: githubReady ? githubProvider({ origin: originURL.origin, clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }) :
    { authorize: notConfigured('GitHub sign-in'), identity: notConfigured('GitHub sign-in') },
  cloudflare, onRevoke: device => gateway.disconnect(device.id),
  capabilities: { provider_login: githubReady, cloudflare: cloudflareReady, iroh: irohReady, custom_domain_required: false },
});
const gateway = new IrohGateway({ binary: irohBinary, keyFile: resolve(data, 'gateway-iroh-key'), origin: originURL.origin });
function gatewayGuard(incoming, route) {
  if (!route.prefix) return null; // Separate subdomains have their own origin and native OIDC gate.
  return app.authorizeDevice(new Request(new URL(incoming.url, originURL.origin), { headers: incoming.headers,
    method: incoming.headers.upgrade ? 'POST' : incoming.method }), route.device);
}
const server = http.createServer(async (incoming, outgoing) => {
  try {
    if (!incoming.url.startsWith('/') || incoming.url.startsWith('//')) { outgoing.writeHead(400).end(); return; }
    const route = remoteDevice(incoming, store);
    if (route) {
      const denied = gatewayGuard(incoming, route);
      if (denied) { outgoing.writeHead(denied.status, Object.fromEntries(denied.headers)); outgoing.end(Buffer.from(await denied.arrayBuffer())); return; }
      await gateway.handle(incoming, outgoing, route); return;
    }
    let size = 0; const parts = [];
    for await (const part of incoming) {
      size += part.length;
      if (size > 16384) { outgoing.writeHead(413).end(); incoming.destroy(); return; }
      parts.push(part);
    }
    const request = new Request(new URL(incoming.url, originURL.origin), { method: incoming.method, headers: incoming.headers,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(parts) }) });
    const response = await app.fetch(request, incoming.socket.remoteAddress);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"internal_error"}'); }
});
server.on('upgrade', (request, socket, head) => {
  const route = remoteDevice(request, store);
  if (!route) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
  const denied = gatewayGuard(request, route);
  if (denied) { socket.end(`HTTP/1.1 ${denied.status} Rejected\r\nConnection: close\r\n\r\n`); return; }
  gateway.upgrade(request, socket, head, route);
});
server.requestTimeout = 30000; server.headersTimeout = 15000;
server.listen(Number(process.env.PORT || 8787), process.env.BIND_HOST || '127.0.0.1', () => console.log('Flownium backend listening; GET /health reports configured capabilities.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { gateway.close(); server.close(() => process.exit(0)); });
