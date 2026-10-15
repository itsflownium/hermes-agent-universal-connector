// Real Hermes + real Iroh + the actual Node HTTP gateway. No model inference.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { IrohGateway } from '../service/iroh-gateway.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = mkdtempSync(join(tmpdir(), 'flownium-real-gateway-'));
const binary = process.env.FLOWNIUM_IROH_BIN || 'dumbpipe';
const python = process.env.FLOWNIUM_TEST_PYTHON || 'python3';
function command(args, input) {
  return new Promise((done, reject) => {
    const child = spawn(python, [join(root, 'flownium_cli.py'), '--state-dir', state, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    child.on('error', reject); child.on('close', code => code ? reject(new Error(error || 'Controller failed')) : done(output));
    child.stdin.end(input);
  });
}
const port = () => new Promise(done => { const server = http.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => done(p)); }); });
let server, gateway;
try {
  const password = randomBytes(24).toString('base64url');
  await command(['share', '--username', 'gatewaytest', '--password-stdin', '--dumbpipe-bin', binary,
    '--port', String(await port()), '--metrics-port', String(await port()), '--timeout', '120'], password + '\n');
  const stateInfo = JSON.parse(await command(['status', '--json']));
  const device = { id: randomUUID(), irohTicket: stateInfo.iroh_ticket };
  const gatewayPort = await port(), origin = `http://127.0.0.1:${gatewayPort}`;
  const prefix = `/remote/${device.id}`, base = origin + prefix;
  device.publicUrl = base;
  gateway = new IrohGateway({ binary, keyFile: join(state, 'gateway-key'), origin });
  server = http.createServer((request, response) => gateway.handle(request, response, { device, prefix }));
  await new Promise(done => server.listen(gatewayPort, '127.0.0.1', done));
  const statusResponse = await fetch(base + '/api/status');
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.auth_required, true);
  const login = value => fetch(base + '/auth/password-login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'basic', username: 'gatewaytest', password: value }) });
  assert.equal((await login('incorrect-password')).status, 401);
  const response = await login(password);
  assert.equal(response.status, 200);
  for (const cookie of response.headers.getSetCookie()) {
    assert.match(cookie, new RegExp(`Path=${prefix}/?(?:;|$)`));
    assert.ok(!cookie.includes(prefix + prefix));
  }
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  const chat = await fetch(base + '/chat', { headers: { Cookie: cookie } });
  assert.equal(chat.status, 200); assert.match(await chat.text(), /<html/i);
  console.log(JSON.stringify({ real_hermes: true, real_iroh: true, real_http_gateway: true,
    hermes_version: status.version, wrong_password_rejected: true, authenticated_chat_page_served: true, path_routing_verified: true,
    domain_or_cloudflare_used: false, model_inference_tested: false, cross_region_tested: false }));
} finally {
  gateway?.close();
  if (server) await new Promise(done => { server.close(done); server.closeAllConnections(); });
  await command(['off']).catch(() => {});
  rmSync(state, { recursive: true, force: true });
}
