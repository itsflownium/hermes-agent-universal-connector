import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IrohGateway, remoteDevice } from './iroh-gateway.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const device = { id, transport: 'iroh', hostname: 'workspace.test', publicUrl: `https://gateway.test/remote/${id}` };
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const close = server => new Promise(done => { server.close(done); server.closeAllConnections(); });

test('routing uses registered devices and rejects revoked or unknown paths', () => {
  const store = { data: { devices: { [id]: { ...device } } } };
  const request = { url: `/remote/${id}/api/status`, headers: { host: 'gateway.test' } };
  assert.equal(remoteDevice(request, store).device.id, id);
  assert.equal(remoteDevice({ ...request, url: '/remote/unknown/api/status' }, store), null);
  store.data.devices[id].revoked = true;
  assert.equal(remoteDevice(request, store), null);
});

test('HTTP gateway strips platform cookies, streams responses, and scopes Hermes cookies', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flownium-gateway-'));
  let received;
  const upstream = http.createServer((request, response) => {
    received = { path: request.url, cookie: request.headers.cookie, host: request.headers.host };
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': [
      'hermes_session_at=example; Path=/; HttpOnly',
      `hermes_prefixed=example; Path=/remote/${id}/; HttpOnly`,
    ], Location: `/remote/${id}/chat?test=yes` });
    response.write('data: first\n\n'); setTimeout(() => response.end('data: second\n\n'), 5);
  });
  const upstreamPort = await listen(upstream);
  const gateway = new IrohGateway({ keyFile: join(folder, 'key'), origin: 'https://gateway.test' });
  gateway.connect = async () => upstreamPort; // Transport tested separately with two real Iroh endpoints.
  const server = http.createServer((req, res) => gateway.handle(req, res, { device, prefix: `/remote/${id}` }));
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/remote/${id}/api/status`, { headers: { Cookie: '__Host-flownium=private; flownium-oauth=private; hermes_session_at=example' } });
    assert.equal(await response.text(), 'data: first\n\ndata: second\n\n');
    assert.equal(received.path, '/api/status');
    assert.equal(received.host, 'gateway.test');
    assert.ok(!received.cookie.includes('private'));
    assert.ok(received.cookie.includes('hermes_session_at'));
    for (const cookie of response.headers.getSetCookie()) assert.match(cookie, new RegExp(`Path=/remote/${id}/;`));
    assert.equal(response.headers.get('location'), `/remote/${id}/chat?test=yes`);
  } finally { gateway.close(); await close(server); await close(upstream); rmSync(folder, { recursive: true }); }
});

test('WebSocket upgrade preserves initial bytes and bidirectional traffic', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'flownium-ws-'));
  const upstream = http.createServer();
  upstream.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/api/ws');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
    socket.on('end', () => socket.end());
  });
  const upstreamPort = await listen(upstream);
  const gateway = new IrohGateway({ keyFile: join(folder, 'key'), origin: 'https://gateway.test' });
  gateway.connect = async () => upstreamPort;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => gateway.upgrade(req, socket, head, { device, prefix: `/remote/${id}` }));
  const port = await listen(server);
  try {
    await new Promise((done, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket forwarding timed out')); }, 5000);
      let received = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`GET /remote/${id}/api/ws HTTP/1.1\r\nHost: gateway.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello`));
      socket.on('data', data => {
        received += data;
        if (received.includes('hello')) { assert.match(received, /101 Switching Protocols/); clearTimeout(timer); socket.destroy(); done(); }
      });
    });
  } finally { gateway.close(); await close(server); await close(upstream); rmSync(folder, { recursive: true }); }
});
