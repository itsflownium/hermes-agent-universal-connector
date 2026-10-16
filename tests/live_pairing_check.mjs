// Opt-in: two real Iroh endpoints, a connected real Hermes host, no inference.
// Start ./nectit app and connect its host before running this script.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLocalApp } from "../app/server.mjs";

const { values } = parseArgs({ options: {
  "app-data": { type: "string", default: "work/local-app" },
  "dumbpipe-bin": { type: "string", default: process.env.FLOWNIUM_IROH_BIN || "work/bin/dumbpipe" },
  resume: { type: "string" }, profile: { type: "string", default: "" },
} });
const access = JSON.parse(readFileSync(join(resolve(values["app-data"]), "cli-access.json")));
const host = async (path, body) => {
  const response = await fetch(access.origin + "/cli/" + path, {
    headers: { Authorization: "Bearer " + access.token, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Host check failed");
  return value;
};
const folder = mkdtempSync(join(tmpdir(), "nectit-live-pair-"));
const peer = createLocalApp({ dataDir: folder, hostState: join(folder, "host"), binary: resolve(values["dumbpipe-bin"]), port: 0 });
let pairedId, ws;
try {
  await new Promise((done) => peer.server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${peer.server.address().port}`;
  const request = async (path, data, cookie) => {
    const response = await fetch(origin + path, {
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { method: "POST", body: JSON.stringify(data) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Peer check failed");
    return { response, value };
  };
  const account = await request("/local/signin", { email: "pairing-check@example.com", password: "pairing-check-password" });
  const cookie = account.response.headers.get("set-cookie").split(";")[0];
  const code = await host("pair/code", {});
  await request("/local/connect", { kind: "pair", code: code.code, name: "Nectit verification device" }, cookie);
  pairedId = peer.settings.connection.pairId;
  const status = (await request("/local/status", null, cookie)).value;
  assert.equal(status.connected, true);
  assert.equal(status.connection.fingerprint, code.fingerprint);
  assert.equal(status.connection.paired, true);
  console.log("Real Iroh endpoints paired; authenticated Hermes API and desktop renderer verified.");

  if (values.resume) {
    const credential = JSON.parse(readFileSync(join(folder, "cli-access.json")));
    const params = new URLSearchParams({ token: credential.token, ...(values.profile ? { profile: values.profile } : {}) });
    ws = new WebSocket(origin.replace("http", "ws") + "/cli/api/ws?" + params);
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Shared session attachment timed out")), 15000);
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 91, method: "session.resume", params: {
        session_id: values.resume, ...(values.profile ? { profile: values.profile } : {}), defer_history: true,
      } }));
      ws.onmessage = ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.id !== 91) return;
        clearTimeout(timer);
        if (frame.error) reject(new Error(frame.error.message));
        else { assert.equal(frame.result.session_key, values.resume); done(); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("Shared session WebSocket failed")); };
    });
    console.log("The peer attached to the same Hermes conversation over Iroh.");
  }
  let closed;
  if (ws) closed = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Revoked socket stayed open")), 7000);
    ws.onclose = () => { clearTimeout(timer); done(); };
  });
  await host("pair/revoke", { id: pairedId });
  if (closed) await closed;
  assert.equal((await request("/local/status", null, cookie)).value.connected, false);
  console.log("Revocation closed the active socket and denied further access.");
} finally {
  ws?.close();
  if (pairedId) await host("pair/revoke", { id: pairedId }).catch(() => {});
  await peer.close();
  rmSync(folder, { recursive: true, force: true });
}
