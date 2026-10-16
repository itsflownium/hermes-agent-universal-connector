import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { Pairing, decodePairingCode } from "./pairing.mjs";
import { createLocalApp } from "./server.mjs";

const ticket = "endpoint" + "a".repeat(80);
const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
test("pairing codes expire, are single-use, replace previous codes, and preserve only credential hashes", async () => {
  let now = Date.now();
  const settings = { setupComplete: true, connection: { kind: "host", id: "host", version: "fixture" } };
  const revoked = [];
  const pairing = new Pairing({ settings, save: () => {}, now: () => now,
    publisher: { start: async () => ticket, close: () => {} }, onRevoke: (id) => revoked.push(id) });
  const first = decodePairingCode((await pairing.code(8788)).code);
  const second = decodePairingCode((await pairing.code(8788)).code);
  assert.throws(() => pairing.claim(first.secret, "Old code"), /expired or was already used/);
  const device = pairing.claim(second.secret, "Laptop");
  assert.throws(() => pairing.claim(second.secret, "Replay"), /already used/);
  assert.ok(!JSON.stringify(settings).includes(device.token));
  assert.equal(pairing.authenticate(device.id + "." + device.token).name, "Laptop");
  const third = decodePairingCode((await pairing.code(8788)).code);
  const other = pairing.claim(third.secret, "Tablet gateway");
  pairing.revoke(device.id);
  assert.deepEqual(revoked, [device.id]);
  assert.throws(() => pairing.authenticate(device.id + "." + device.token), /no longer paired/);
  assert.equal(pairing.authenticate(other.id + "." + other.token).name, "Tablet gateway");
  const expired = decodePairingCode((await pairing.code(8788)).code);
  now += 300001;
  assert.throws(() => pairing.claim(expired.secret, "Expired"), /expired/);
  assert.ok(!JSON.stringify(pairing.devices()).includes(other.token));
  settings.connection.id = "replaced-host";
  assert.throws(() => pairing.authenticate(other.id + "." + other.token), /no longer paired/);
});

test("pairing decoder rejects expired and malformed destinations before any network connection", () => {
  const encode = (value) => "nectit1:" + Buffer.from(JSON.stringify(value)).toString("base64url");
  const valid = { ticket, port: 8788, secret: "a".repeat(64), expires: Date.now() + 300000 };
  for (const patch of [{ ticket: "https://foreign.test" }, { port: 80 }, { port: "8788" }, { secret: "short" }, { expires: 0 }])
    assert.throws(() => decodePairingCode(encode({ ...valid, ...patch })));
  assert.throws(() => decodePairingCode("nectit1:" + "a".repeat(12000)));
  assert.deepEqual(decodePairingCode(encode(valid)), valid);
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "nectit-pair-test-"));
  const app = createLocalApp({ dataDir, hostState: join(dataDir, "host"), port: 0,
    publisherFactory: () => ({ start: async () => ticket, close: () => {} }) });
  const port = await listen(app.server), origin = `http://127.0.0.1:${port}`;
  const request = (path, data, cookie, headers = {}) => fetch(origin + path, {
    method: data ? "POST" : "GET", redirect: "manual",
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const sign = await request("/local/signin", { email: "owner@example.com", password: "test-owner-password" });
  const cookie = sign.headers.get("set-cookie").split(";")[0];
  return { app, dataDir, origin, port, request, cookie,
    close: async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

function wireSocket(f, path, headers = {}) {
  const socket = net.connect(f.port, "127.0.0.1");
  const ready = new Promise((done, reject) => {
    let text = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("WebSocket fixture timed out")); }, 5000);
    socket.once("error", reject);
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") + "\r\nprobe"));
    socket.on("data", (chunk) => { text += chunk; if (text.includes("probe")) { clearTimeout(timer); done(text); } });
    socket.once("close", () => { clearTimeout(timer); if (!text.includes("probe")) reject(new Error("WebSocket fixture rejected")); });
  });
  return { socket, ready };
}

test("one-time pairing connects a second router, keeps the native cookie on the host and revokes active sockets", async () => {
  const nativeSockets = new Set();
  let holdTicket, heldResponse;
  const backend = http.createServer((request, response) => {
    assert.equal(request.headers.cookie, "hermes=native-private");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/status") response.end('{"version":"fixture"}');
    else if (request.url === "/api/auth/ws-ticket") {
      if (holdTicket) { heldResponse = response; holdTicket(); }
      else response.end('{"ticket":"single-use-native-ticket"}');
    }
    else if (request.url === "/") response.end('<html><head><script src="./assets/index-live.js"></script></head></html>');
    else { response.writeHead(404); response.end("{}"); }
  });
  backend.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.cookie, "hermes=native-private");
    assert.equal(new URL(request.url, "http://local").searchParams.get("ticket"), "single-use-native-ticket");
    nativeSockets.add(socket); socket.once("close", () => nativeSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const nativePort = await listen(backend);
  const host = await fixture(), client = await fixture();
  const transportSockets = new Set();
  const transport = net.createServer((socket) => {
    const upstream = net.connect(host.port, "127.0.0.1");
    for (const item of [socket, upstream]) {
      transportSockets.add(item);
      item.once("close", () => transportSockets.delete(item));
      item.on("error", () => { socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream).pipe(socket);
  });
  const transportPort = await listen(transport);
  try {
    host.app.settings.setupComplete = true;
    host.app.settings.connection = { id: "local-host", kind: "host", port: nativePort,
      cookie: "hermes=native-private", publicUrl: host.origin, version: "fixture" };
    // Only the external Iroh transport is a fixture. Both real app routers and their proxy/auth layers run.
    client.app.gateway.connect = async () => transportPort;
    const code = await (await host.request("/local/pair/code", {}, host.cookie)).json();
    assert.equal((await host.request("/paired/api/status")).status, 401);
    const connected = await client.request("/local/connect", { kind: "pair", code: code.code, name: "Test laptop" }, client.cookie);
    assert.equal(connected.status, 200, await connected.text());
    const state = client.app.settings.connection;
    assert.ok(state.cookie.startsWith("nectit-device="));
    assert.ok(!JSON.stringify(state).includes("native-private"));
    const status = await (await client.request("/local/status", null, client.cookie)).json();
    assert.equal(status.connected, true);
    assert.equal(status.connection.fingerprint, code.fingerprint);
    const replay = await host.request("/pair/claim", { secret: decodePairingCode(code.code).secret, name: "Replay" });
    assert.equal(replay.status, 410);
    const channel = wireSocket(client, "/hermes/api/ws", { Cookie: client.cookie, Origin: client.origin });
    assert.match(await channel.ready, /101 Switching Protocols/);
    const closed = new Promise((done) => channel.socket.once("close", done));
    const devices = (await (await host.request("/local/pair/devices", null, host.cookie)).json()).devices;
    assert.equal(devices[0].name, "Test laptop");
    assert.ok(!JSON.stringify(devices).includes("tokenHash"));
    const ticketRequested = new Promise((done) => { holdTicket = done; });
    const pending = wireSocket(host, "/paired/api/ws", { Cookie: state.cookie });
    const rejected = pending.ready.catch(() => {});
    await ticketRequested;
    const pendingClosed = new Promise((done) => pending.socket.once("close", done));
    await host.request("/local/pair/revoke", { id: devices[0].id }, host.cookie);
    let revokeTimer;
    try {
      await Promise.race([Promise.all([closed, pendingClosed, rejected]), new Promise((_, reject) => {
        revokeTimer = setTimeout(() => reject(new Error("Revoked socket stayed open")), 3000);
      })]);
    } finally { clearTimeout(revokeTimer); heldResponse?.end('{"ticket":"single-use-native-ticket"}'); }
    assert.equal((await client.request("/hermes/api/status", null, client.cookie)).status, 401);
    const bootstrap = await (await client.request("/local/bootstrap", null, client.cookie)).text();
    assert.ok(!bootstrap.includes(state.cookie));
  } finally {
    heldResponse?.end();
    await client.close(); await host.close();
    for (const socket of transportSockets) socket.destroy();
    await new Promise((done) => transport.close(done));
    for (const socket of nativeSockets) socket.destroy();
    await new Promise((done) => { backend.close(done); backend.closeAllConnections(); });
  }
});

test("terminal credentials are private, browser origins cannot use them, and CLI session links preserve profiles", async () => {
  const f = await fixture();
  const backend = http.createServer((request, response) => {
    assert.equal(request.headers.cookie, "native=private");
    const url = new URL(request.url, "http://local");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/sessions") {
      assert.equal(url.searchParams.get("sources"), "cli,tui");
      assert.equal(url.searchParams.get("profile"), "demo");
      response.end(JSON.stringify({ sessions: [{ id: "stored-cli", title: "My terminal chat", source: "cli", profile: "demo", message_count: 4, model_config: { api_key: "never-forward" } }] }));
    } else if (url.pathname === "/api/sessions/stored-cli") response.end('{"session":{"id":"stored-cli"}}');
    else response.end("{}");
  });
  const port = await listen(backend);
  try {
    f.app.settings.setupComplete = true;
    f.app.settings.connection = { id: "host", kind: "host", port, cookie: "native=private", publicUrl: f.origin };
    const file = join(f.dataDir, "cli-access.json"), access = JSON.parse(readFileSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const pointer = join(f.dataDir, "host", "app-connection.json");
    assert.equal(statSync(pointer).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(pointer)), { data_dir: f.dataDir, origin: f.origin });
    assert.equal((await f.request("/cli-access.json")).status, 404);
    assert.equal((await f.request("/cli/status")).status, 401);
    assert.equal((await f.request("/cli/status", null, null, { Authorization: "Bearer " + access.token })).status, 401);
    const cli = await fetch(f.origin + "/cli/status", { headers: { Authorization: "Bearer " + access.token } });
    assert.equal(cli.status, 200);
    assert.equal((await cli.json()).connected, true);
    const list = await (await f.request("/local/cli-sessions?profile=demo", null, f.cookie)).json();
    assert.equal(list.sessions[0].id, "stored-cli");
    assert.ok(!JSON.stringify(list).includes("never-forward"));
    assert.equal((await f.request("/local/cli-sessions?profile=../secret", null, f.cookie)).status, 400);
    assert.equal((await f.request("/local/cli-open", { id: "../secret" }, f.cookie)).status, 400);
    const link = await (await f.request("/local/cli-open", { id: "stored-cli", profile: "demo" }, f.cookie)).json();
    assert.equal(link.url, "/w/my-hermes?profile=demo#/stored-cli");
  } finally {
    await f.close();
    await new Promise((done) => { backend.close(done); backend.closeAllConnections(); });
  }
});
