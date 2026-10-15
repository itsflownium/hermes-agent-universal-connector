// Real installed Hermes + real Flownium OIDC endpoints on localhost.
// External GitHub identity and the Cloudflare connection are isolated fixtures.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store, createApp, signingKey } from '../service/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'flownium-oidc-'));
const python = process.env.FLOWNIUM_TEST_PYTHON || 'python3';
const cli = (...args) => new Promise((done, reject) => {
  const child = spawn(python, [join(root, 'flownium_cli.py'), '--state-dir', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => error += data);
  child.on('error', reject);
  child.on('close', code => code ? reject(new Error(error || 'Flownium command failed')) : done(output));
});
const port = () => new Promise(done => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => done(value)); });
});
let app;
const server = http.createServer(async (incoming, outgoing) => {
  const parts = [];
  for await (const part of incoming) parts.push(part);
  const response = await app.fetch(new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
    method: incoming.method, headers: incoming.headers,
    ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(parts) }),
  }));
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});

try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hermesPort = await port(), metricsPort = await port();
  const id = randomUUID(), hostname = 'hermes.flownium.test', user = 'local-oidc-test';
  const store = new Store();
  store.data.users[user] = { id: user, login: 'localtest', name: 'Local test', email: 'localtest@example.test' };
  store.data.devices[id] = { id, user, hostname };
  const browserToken = 'isolated-browser-session';
  store.data.sessions[createHash('sha256').update(browserToken).digest('hex')] = { kind: 'browser', user, expires: Math.floor(Date.now() / 1000) + 600 };
  app = createApp({ origin, workspaceDomain: 'flownium.test', store, signer: signingKey(), github: {}, cloudflare: {} });
  const connector = join(directory, 'cloudflared-fixture');
  // The fixture has no external connection code and cannot create a public URL.
  const interpreter = (await new Promise((done, reject) => {
    const child = spawn(python, ['-c', 'import sys; print(sys.executable)']);
    let value = ''; child.stdout.on('data', data => value += data);
    child.on('close', code => code ? reject(new Error('Python is unavailable')) : done(value.trim()));
  }));
  writeFileSync(connector, `#!${interpreter}\nimport http.server, sys\nport = int(sys.argv[sys.argv.index('--metrics') + 1].rsplit(':', 1)[1])\nclass Handler(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'ok')\n def log_message(self, *args): pass\nhttp.server.HTTPServer(('127.0.0.1', port), Handler).serve_forever()\n`, { mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ mode: 'remote', port: hermesPort, metrics_port: metricsPort,
    hermes_bin: 'hermes', cloudflared_bin: connector, workspace: root, startup_timeout: 120,
    hostname, device_id: id, oidc_issuer: origin, oidc_client_id: id }), { mode: 0o600 });
  writeFileSync(join(directory, 'tunnel-token'), 'isolated-fixture-token', { mode: 0o600 });
  await cli('on');
  const status = JSON.parse(await cli('status', '--json'));
  assert.ok(status.auth_providers.includes('self-hosted'));
  const headers = { Host: hostname, 'X-Forwarded-Proto': 'https' };
  const initial = await fetch(`http://127.0.0.1:${hermesPort}/auth/login?provider=self-hosted`, { headers, redirect: 'manual' });
  assert.equal(initial.status, 302, 'Hermes must start a real OIDC sign-in');
  const pkceCookie = initial.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const authorization = await fetch(initial.headers.get('location'), { headers: { Cookie: `flownium=${browserToken}` }, redirect: 'manual' });
  assert.equal(authorization.status, 302, 'Flownium must authorize the owning account');
  const callback = new URL(authorization.headers.get('location'));
  const completed = await fetch(`http://127.0.0.1:${hermesPort}${callback.pathname}${callback.search}`, {
    headers: { ...headers, Cookie: pkceCookie }, redirect: 'manual' });
  assert.equal(completed.status, 302, 'Hermes must accept the Flownium-signed ID token');
  const authCookie = completed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const me = await fetch(`http://127.0.0.1:${hermesPort}/api/auth/me`, { headers: { ...headers, Cookie: authCookie } });
  assert.equal(me.status, 200, 'The authenticated Hermes session must work');
  const identity = await me.json();
  assert.equal(identity.provider, 'self-hosted');
  const chat = await fetch(`http://127.0.0.1:${hermesPort}/chat`, { headers: { ...headers, Cookie: authCookie } });
  assert.equal(chat.status, 200);
  assert.match(await chat.text(), /<html/i);
  console.log(JSON.stringify({ real_hermes: true, hermes_version: status.hermes_version,
    real_flownium_oidc: true, authenticated_chat_page_served: true,
    external_identity: 'isolated local fixture', cloudflare: 'isolated local fixture', model_inference_tested: false }));
} finally {
  await cli('off').catch(() => {});
  await new Promise(done => server.close(done));
  rmSync(directory, { recursive: true, force: true });
}
