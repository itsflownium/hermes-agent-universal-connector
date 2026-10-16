import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { Readable } from "node:stream";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const endpointTicket = (value) =>
  typeof value === "string" && /^(?:node|endpoint)[a-z2-7]{40,4096}$/.test(value);
export const profileName = (value) =>
  !value || (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value));
export const sessionId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const equal = (value, expected) =>
  typeof value === "string" && typeof expected === "string" &&
  timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expected));

// Iroh's local TCP listener uses a different port than the host router. Node's
// fetch deliberately rewrites Host; the wire-level API preserves the host's
// exact authority so its DNS-rebinding gate can remain strict.
export function transportFetch(url, options = {}) {
  return new Promise((done, reject) => {
    const request = http.request(url, { method: options.method || "GET", headers: options.headers, signal: options.signal }, (response) => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      const body = [204, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
      done(new Response(body, { status: response.statusCode, headers }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

export function decodePairingCode(value) {
  if (typeof value !== "string" || value.length > 12000 || !/^nectit1:[A-Za-z0-9_-]+$/.test(value.trim()))
    throw fail("Paste a Nectit pairing code from the host computer.");
  let code;
  try { code = JSON.parse(Buffer.from(value.trim().slice(8), "base64url")); }
  catch { throw fail("This pairing code is not valid."); }
  if (!endpointTicket(code.ticket) || !/^[a-f0-9]{64}$/.test(code.secret || "") ||
      !Number.isInteger(code.port) || code.port < 1024 || code.port > 65535 ||
      !Number.isSafeInteger(code.expires))
    throw fail("This pairing code is not valid.");
  if (code.expires <= Date.now()) throw fail("This pairing code expired. Generate another on the host.", 410);
  return code;
}

// One on-demand listener exposes only this router's authenticated paired routes.
// Its private identity is separate from the outbound Iroh gateway identity.
export class IrohPublisher {
  constructor({ binary, dataDir, port }) {
    Object.assign(this, { binary, port });
    const keyFile = join(dataDir, "pairing-iroh-key");
    this.key = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : randomBytes(32).toString("hex");
    if (!existsSync(keyFile)) writeFileSync(keyFile, this.key, { mode: 0o600 });
  }
  start() {
    if (this.pending) return this.pending;
    this.pending = new Promise((done, reject) => {
      const child = spawn(this.binary, ["listen-tcp", "--host", `127.0.0.1:${this.port}`], {
        env: { ...process.env, IROH_SECRET: this.key }, stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      let output = "", settled = false;
      const failed = () => {
        clearTimeout(timer);
        this.pending = null;
        if (!settled) { settled = true; reject(fail("Iroh sharing could not start. Check the transport installation.", 503)); }
      };
      const timer = setTimeout(() => { child.kill("SIGTERM"); failed(); }, 20000);
      const read = (chunk) => {
        output = (output + chunk).slice(-16000);
        const complete = output.slice(0, output.lastIndexOf("\n") + 1);
        const ticket = complete.match(/(?:node|endpoint)[a-z2-7]{40,4096}/)?.[0];
        if (!settled && ticket) { settled = true; clearTimeout(timer); done(ticket); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", failed);
      child.once("exit", failed);
    });
    return this.pending;
  }
  close() { this.child?.kill("SIGTERM"); this.pending = null; }
}

export class Pairing {
  constructor({ settings, save, publisher, now = Date.now, onRevoke = () => {} }) {
    Object.assign(this, { settings, save, publisher, now, onRevoke });
    this.codes = new Map();
  }
  host() {
    if (this.settings.connection?.kind !== "host" || !this.settings.setupComplete)
      throw fail("Connect Hermes on this computer before sharing it.", 409);
    return this.settings.connection;
  }
  async code(port) {
    const host = this.host();
    const ticket = await this.publisher.start();
    if (this.host().id !== host.id) throw fail("The computer connection changed. Try again.", 409);
    const secret = randomBytes(32).toString("hex"), expires = this.now() + 300000;
    // A newly requested code replaces any outstanding code, never paired devices.
    this.codes.clear();
    this.codes.set(digest(secret), { expires, connectionId: host.id });
    return {
      code: "nectit1:" + Buffer.from(JSON.stringify({ ticket, port, secret, expires })).toString("base64url"),
      expires, fingerprint: digest(ticket).slice(0, 16),
    };
  }
  claim(secret, name) {
    const key = typeof secret === "string" ? digest(secret) : "";
    const code = this.codes.get(key);
    if (!code || code.expires <= this.now() || this.host().id !== code.connectionId)
      throw fail("This pairing code expired or was already used. Generate another on the host.", 410);
    const devices = this.settings.pairedDevices ||= {};
    if (Object.values(devices).filter((d) => !d.revoked).length >= 25)
      throw fail("Revoke an unused device before pairing another.", 409);
    if (typeof name !== "string" || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f]/.test(name))
      throw fail("Use a device name of 1–64 characters.");
    this.codes.delete(key); // Synchronous consumption fences concurrent claims.
    const token = randomBytes(32).toString("hex"), id = randomUUID();
    devices[id] = { id, name: name.trim(), tokenHash: digest(token), connectionId: code.connectionId,
      created: this.now(), lastSeen: this.now(), revoked: false };
    this.save();
    return { id, token, version: this.settings.connection.version };
  }
  authenticate(raw) {
    const [id, token, extra] = String(raw || "").split(".");
    const device = this.settings.pairedDevices?.[id];
    if (extra || !device || device.revoked || !equal(token, device.tokenHash) ||
        device.connectionId !== this.settings.connection?.id)
      throw fail("This device is no longer paired. Pair it again from the host.", 401);
    if (this.now() - device.lastSeen > 60000) { device.lastSeen = this.now(); this.save(); }
    return device;
  }
  devices() {
    return Object.values(this.settings.pairedDevices || {}).map(({ id, name, created, lastSeen, revoked }) =>
      ({ id, name, created, lastSeen, revoked }));
  }
  revoke(id) {
    const device = this.settings.pairedDevices?.[id];
    if (!device) throw fail("Device not found.", 404);
    device.revoked = true;
    this.save();
    this.onRevoke(id);
  }
  close() { this.codes.clear(); this.publisher.close(); }
}
