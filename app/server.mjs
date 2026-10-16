import http from "node:http";
import net from "node:net";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { IrohGateway } from "../service/iroh-gateway.mjs";
import { emailAddress } from "./auth.mjs";
import { Pairing, IrohPublisher, decodePairingCode, profileName, sessionId, transportFetch } from "./pairing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function validSlug(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)
  );
}

export function createLocalApp({
  dataDir = resolve(root, "work/local-app"),
  hostState = join(homedir(), ".config/flownium"),
  binary = process.env.FLOWNIUM_IROH_BIN || join(root, "work/bin/dumbpipe"),
  python = process.env.FLOWNIUM_PYTHON || "python3",
  port = 8788,
  publicOrigin = process.env.NECTIT_PUBLIC_ORIGIN || null,
  publisherFactory = null,
} = {}) {
  if (publicOrigin) {
    const external = new URL(publicOrigin);
    if (
      external.protocol !== "https:" ||
      external.username ||
      external.password ||
      external.pathname !== "/" ||
      external.search ||
      external.hash
    )
      throw new Error("NECTIT_PUBLIC_ORIGIN must be a bare HTTPS origin.");
    publicOrigin = external.origin;
  }
  const secureCookie = publicOrigin ? "; Secure" : "";
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const file = join(dataDir, "local.json");
  const settings = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const sessions = new Map(),
    sockets = new Set(),
    cliSockets = new Set(),
    pairedTraffic = new Map(),
    attempts = new Map();
  const destination = () =>
    settings.setupComplete ? "/w/" + settings.slug : "/setup/address";
  const cookieValue = (request, name) =>
    (request.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(name + "="))
      ?.slice(name.length + 1);
  // Cookies are host-scoped, not port-scoped. Keep independent local routers
  // from overwriting each other's login.
  const sessionName = () => `nectit-session-${server.address().port}`;
  const sessionCookie = () => {
    for (const [key, expires] of sessions)
      if (expires < Date.now()) sessions.delete(key);
    const token = randomBytes(32).toString("base64url");
    sessions.set(hash(token), Date.now() + 7 * 86400_000);
    return `${sessionName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie}`;
  };
  function rate(key) {
    const item = attempts.get(key);
    if (!item || item.until < Date.now())
      attempts.set(key, { count: 1, until: Date.now() + 60_000 });
    else if (++item.count > 15)
      throw fail("Please wait a minute before trying again.", 429);
  }
  let starting = false,
    startedHost = null,
    errorMessage = null;
  const save = () => {
    const temp = file + ".tmp";
    writeFileSync(temp, JSON.stringify(settings), { mode: 0o600 });
    renameSync(temp, file);
  };
  const cliToken = randomBytes(32).toString("hex");
  const cliFile = join(dataDir, "cli-access.json");
  const cliAuth = (request, token = null) => {
    const peer = request.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) || request.headers.origin ||
        !timingSafeEqual(Buffer.from(hash(token || request.headers.authorization?.replace(/^Bearer /, "") || "")), Buffer.from(hash(cliToken))))
      throw fail("Local terminal access denied.", 401);
  };
  let publisher;
  const pairing = new Pairing({ settings, save,
    publisher: {
      start: () => {
        publisher ||= publisherFactory
          ? publisherFactory({ port: server.address().port, binary, dataDir })
          : new IrohPublisher({ port: server.address().port, binary, dataDir });
        return publisher.start();
      },
      close: () => publisher?.close(),
    },
    onRevoke: (id) => {
      for (const item of pairedTraffic.get(id) || []) item.destroy();
      pairedTraffic.delete(id);
    },
  });
  function trackPaired(id, item) {
    if (!pairedTraffic.has(id)) pairedTraffic.set(id, new Set());
    pairedTraffic.get(id).add(item);
    item.once("close", () => pairedTraffic.get(id)?.delete(item));
  }
  const pairedCredential = (request) => cookieValue(request, "nectit-device");
  const nativePathAllowed = (path) =>
    /^\/(?:api\/|assets\/|fonts\/|fonts-terminal\/|ds-assets\/|emojibase\/|hermes-frames\/)/.test(path) ||
    /^\/(?:hermes(?:-sprite)?\.png|nous-girl(?:-dark)?\.png|apple-touch-icon\.png)$/.test(path);
  const gateway = new IrohGateway({
    binary,
    keyFile: join(dataDir, "iroh-key"),
    origin: publicOrigin || `http://127.0.0.1:${port}`,
  });
  const irohConnect = gateway.connect.bind(gateway);
  gateway.connect = (device) =>
    device.kind === "host" ? Promise.resolve(device.port) : irohConnect(device);
  const command = (args, input = "", setup = false) =>
    new Promise((done, reject) => {
      const child = spawn(
        python,
        [
          join(root, setup ? "tools/setup.py" : "flownium_cli.py"),
          "--state-dir",
          hostState,
          ...args,
        ],
        { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "",
        error = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(fail("Setup timed out. Check the private controller log.", 504));
      }, 200_000);
      child.stdout.on("data", (data) => {
        output = (output + data).slice(-100_000);
      });
      child.stderr.on("data", (data) => {
        error = (error + data).slice(-8000);
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(fail("Python could not start. Install Python 3.10+.", 503));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        code
          ? reject(
              fail(
                error.trim() ||
                  "Hermes could not start. Check the private logs.",
                503,
              ),
            )
          : done(output);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  const freePort = () =>
    new Promise((done, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const number = probe.address().port;
        probe.close(() => done(number));
      });
    });
  function origin(request) {
    const host = request.headers.host || "";
    if (publicOrigin && host === new URL(publicOrigin).host)
      return publicOrigin;
    if (
      ![
        "127.0.0.1:" + server.address().port,
        "localhost:" + server.address().port,
      ].includes(host)
    )
      throw fail("Invalid local host.", 403);
    return "http://" + host;
  }
  function authenticate(request) {
    const raw = cookieValue(request, sessionName());
    const expires = raw && sessions.get(hash(raw));
    if (!expires || expires < Date.now())
      throw fail("Sign in to your local workspace.", 401);
  }
  function checkPassword(value) {
    if (
      !settings.account?.digest ||
      typeof value !== "string" ||
      value.length > 1024
    )
      return false;
    const digest = scryptSync(value, settings.account.salt, 32);
    return timingSafeEqual(digest, Buffer.from(settings.account.digest, "hex"));
  }
  async function body(request) {
    let size = 0;
    const parts = [];
    for await (const part of request) {
      size += part.length;
      if (size > 16384) throw fail("Request is too large.", 413);
      parts.push(part);
    }
    try {
      return JSON.parse(Buffer.concat(parts));
    } catch {
      throw fail("Invalid request.");
    }
  }
  async function native(
    path,
    { method = "GET", data, cookie = settings.connection?.cookie } = {},
  ) {
    const device = settings.connection;
    if (!device) throw fail("Connect a Hermes computer first.", 409);
    const targetPort = await gateway.connect(device);
    const fetcher = device.pathPrefix ? transportFetch : fetch;
    const response = await fetcher(`http://127.0.0.1:${targetPort}${device.pathPrefix || ""}${path}`, {
      method,
      headers: {
        Origin: `http://127.0.0.1:${targetPort}`,
        ...(device.pathPrefix ? { Host: new URL(device.publicUrl).host } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw fail(
        path === "/auth/password-login"
          ? "Hermes rejected the sharing email or password."
          : response.status === 401 || response.status === 403
            ? device.pathPrefix ? "This device was disconnected or revoked. Pair it again from the host." : "Hermes sign-in expired. Reconnect your computer."
            : "Hermes is unavailable. Check that its computer is awake and online.",
        response.status === 401 ? 409 : 503,
      );
    return response;
  }
  async function connect(input, currentOrigin) {
    if (starting) throw fail("A connection is already starting.", 409);
    if (input.kind === "pair") return connectPaired(input, currentOrigin);
    if (input.kind !== "host" && input.kind !== "peer")
      throw fail("Choose a computer.");
    if (
      typeof input.password !== "string" ||
      input.password.length < 12 ||
      input.password.length > 1024
    )
      throw fail("Use a sharing password of at least 12 characters.");
    const email = emailAddress(input.email);
    if (!email) throw fail("Enter a valid sharing email address.");
    if (
      input.kind === "peer" &&
      !/^(?:node|endpoint)[a-z2-7]{40,4096}$/.test(input.ticket || "")
    )
      throw fail("Enter a valid Iroh endpoint ticket.");
    starting = true;
    errorMessage = null;
    const previous = settings.connection;
    let device,
      newHost = false;
    try {
      if (binary === join(root, "work/bin/dumbpipe") && !existsSync(binary))
        await command(["--prepare-only"], "", true);
      device = {
        id: randomUUID(),
        kind: input.kind,
        publicUrl: currentOrigin,
      };
      if (input.kind === "host") {
        const status = JSON.parse(await command(["status", "--json"]));
        const configPath = join(hostState, "config.json");
        const config = existsSync(configPath)
          ? JSON.parse(readFileSync(configPath, "utf8"))
          : null;
        if (config && config.mode !== "peer")
          throw fail(
            "This controller uses a different connection mode. Use a separate --state-dir for Nectit, or disconnect that account explicitly first.",
            409,
          );
        if (config) {
          device.port = config.port;
          if (status.phase !== "online" || !config.desktop_renderer) {
            await command(["on", "--desktop"]);
            if (status.phase !== "online") {
              newHost = true;
            }
          }
        } else {
          device.port = await freePort();
          await command(
            [
              "--mode",
              "host",
              "--desktop",
              "--email",
              email,
              "--password-stdin",
              "--port",
              String(device.port),
              "--metrics-port",
              String(await freePort()),
              "--dumbpipe-bin",
              binary,
            ],
            input.password + "\n",
            true,
          );
          newHost = true;
        }
        const hostStatus = JSON.parse(await command(["status", "--json"]));
        device.irohTicket = hostStatus.iroh_ticket;
        if (newHost) startedHost = hostStatus.run_id;
      } else device.irohTicket = input.ticket;
      settings.connection = device;
      const response = await native("/auth/password-login", {
        method: "POST",
        cookie: "",
        data: {
          provider: "basic",
          username: email,
          password: input.password,
        },
      });
      device.cookie = response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      if (!device.cookie)
        throw fail("Hermes did not establish a session.", 503);
      const status = await (await native("/api/status")).json();
      device.version = status.version;
      device.email = email;
      const html = await (await native("/")).text();
      if (!isDesktop(html))
        throw fail(
          "The connected router needs a Hermes Desktop build. Run ./setup again with the current Nectit checkout. Set HERMES_DESKTOP_DIST if your build is elsewhere.",
          409,
        );
      settings.setupComplete = true;
      save();
      if (previous?.kind === "peer") gateway.disconnect(previous.id);
    } catch (error) {
      if (device?.kind === "peer") gateway.disconnect(device.id);
      if (newHost && startedHost)
        await command(["off", "--if-run-id", startedHost]).catch(() => {});
      settings.connection = previous;
      errorMessage = error.message;
      throw error;
    } finally {
      starting = false;
    }
  }
  async function connectPaired(input, currentOrigin) {
    const code = decodePairingCode(input.code);
    starting = true;
    errorMessage = null;
    const previous = settings.connection;
    const device = { id: randomUUID(), kind: "peer", irohTicket: code.ticket,
      publicUrl: `http://127.0.0.1:${code.port}`, pathPrefix: "/paired" };
    try {
      if (binary === join(root, "work/bin/dumbpipe") && !existsSync(binary))
        await command(["--prepare-only"], "", true);
      const targetPort = await gateway.connect(device);
      const response = await transportFetch(`http://127.0.0.1:${targetPort}/pair/claim`, {
        method: "POST", headers: { "Content-Type": "application/json", Host: `127.0.0.1:${code.port}` },
        body: JSON.stringify({ secret: code.secret, name: input.name || "Browser device" }),
        redirect: "manual", signal: AbortSignal.timeout(15000),
      });
      const grant = await response.json();
      if (!response.ok) throw fail(grant.error || "The host could not pair this device.", response.status);
      if (!/^[a-f0-9-]{36}$/.test(grant.id || "") || !/^[a-f0-9]{64}$/.test(grant.token || ""))
        throw fail("The host returned an invalid pairing response.", 503);
      device.cookie = `nectit-device=${grant.id}.${grant.token}`;
      device.pairId = grant.id;
      device.fingerprint = hash(code.ticket).slice(0, 16);
      settings.connection = device;
      const status = await (await native("/api/status")).json();
      device.version = status.version;
      if (!isDesktop(await (await native("/")).text()))
        throw fail("The host needs the Nectit desktop renderer enabled.", 409);
      settings.setupComplete = true;
      save();
      if (previous?.kind === "peer") gateway.disconnect(previous.id);
    } catch (problem) {
      settings.connection = previous;
      gateway.disconnect(device.id);
      errorMessage = problem.message;
      throw problem;
    } finally { starting = false; }
  }
  function isDesktop(html) {
    return /<script[^>]+src=["']\.\/assets\/index-/.test(html);
  }
  async function renderer() {
    const html = await (await native("/")).text();
    if (!isDesktop(html))
      throw fail(
        "Hermes Desktop is not built on the connected computer. Run hermes gui --build-only, then ./nectit off and ./nectit on.",
        409,
      );
    return { html, revision: hash(html) };
  }
  const json = (response, value, status = 200, headers = {}) => {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    try {
      const currentOrigin = origin(request),
        url = new URL(request.url, currentOrigin),
        path = url.pathname;
      if (!request.url.startsWith("/") || request.url.startsWith("//"))
        throw fail("Invalid path.");
      if (path === "/pair/claim" && request.method === "POST") {
        rate("pair-claim");
        const input = await body(request);
        json(response, pairing.claim(input.secret, input.name));
        return;
      }
      if (path.startsWith("/paired/")) {
        const device = pairing.authenticate(pairedCredential(request));
        const inner = path.slice("/paired".length);
        if (inner !== "/" && !nativePathAllowed(inner)) throw fail("Not found.", 404);
        trackPaired(device.id, response);
        request.headers.cookie = settings.connection?.cookie || "";
        request.headers.origin = settings.connection?.publicUrl || currentOrigin;
        await gateway.handle(request, response, { device: settings.connection, prefix: "/paired" });
        return;
      }
      if (path.startsWith("/cli/")) cliAuth(request);
      if (path === "/cli/status" && request.method === "GET") {
        json(response, { connected: !!settings.connection && !!settings.setupComplete,
          url: `${currentOrigin}/w/${settings.slug || "my-hermes"}` });
        return;
      }
      const privatePair = path.startsWith("/cli/pair/");
      if (path.startsWith("/local/pair/")) authenticate(request);
      if ((privatePair || path.startsWith("/local/pair/")) && request.method === "GET" && path.endsWith("/devices")) {
        json(response, { devices: pairing.devices() }); return;
      }
      if (privatePair && request.method === "POST") {
        if (path.endsWith("/code")) { await native("/api/status"); json(response, await pairing.code(server.address().port)); }
        else if (path.endsWith("/revoke")) { pairing.revoke((await body(request)).id); json(response, { revoked: true }); }
        else throw fail("Not found.", 404);
        return;
      }
      if (request.method !== "GET" && request.headers.origin !== currentOrigin)
        throw fail("Reload this page before submitting.", 403);
      if (path === "/local/bootstrap" && request.method === "GET") {
        let signedIn = false;
        try {
          authenticate(request);
          signedIn = true;
        } catch {}
        json(response, {
          product: "nectit",
          features: { pairing: true, cliChats: true },
          configured: !!settings.account,
          signedIn,
          email: signedIn ? settings.account.email : "",
          setupComplete: signedIn && !!settings.setupComplete,
          slug: signedIn ? settings.slug : "",
          localOnly: !publicOrigin,
        });
        return;
      }
      if (path === "/local/signin" && request.method === "POST") {
        rate("password");
        const input = await body(request);
        const email = emailAddress(input.email);
        if (
          !email ||
          typeof input.password !== "string" ||
          input.password.length < 12 ||
          input.password.length > 1024
        )
          throw fail(
            "Enter your email and a password of at least 12 characters.",
          );
        if (!settings.account) {
          const salt = randomBytes(16).toString("hex");
          settings.account = {
            email,
            salt,
            digest: scryptSync(input.password, salt, 32).toString("hex"),
          };
          settings.slug = "my-hermes";
          save();
        } else if (
          email !== settings.account.email ||
          !checkPassword(input.password)
        )
          throw fail("Incorrect email or password.", 401);
        json(
          response,
          {
            email: settings.account.email,
            slug: settings.slug,
            setupComplete: !!settings.setupComplete,
            next: destination(),
          },
          200,
          { "Set-Cookie": sessionCookie() },
        );
        return;
      }
      if (path.startsWith("/local/") || path.startsWith("/hermes/"))
        authenticate(request);
      if (path === "/local/pair/code" && request.method === "POST") {
        rate("pair-code"); await native("/api/status"); json(response, await pairing.code(server.address().port)); return;
      }
      if (path === "/local/pair/revoke" && request.method === "POST") {
        pairing.revoke((await body(request)).id); json(response, { revoked: true }); return;
      }
      if (path === "/local/cli-sessions" && request.method === "GET") {
        const profile = url.searchParams.get("profile") || "";
        if (!profileName(profile)) throw fail("Invalid Hermes profile.");
        const query = new URLSearchParams({ sources: "cli,tui", limit: "50", order: "recent", min_messages: "1" });
        if (profile) query.set("profile", profile);
        const result = await (await native("/api/sessions?" + query)).json();
        const rows = (Array.isArray(result.sessions) ? result.sessions : []).filter((s) => sessionId(s.id));
        json(response, { sessions: rows.map((s) => ({ id: s.id, title: String(s.title || "Untitled CLI chat").slice(0, 200),
          source: s.source, profile: profile || s.profile || "", lastActive: s.last_active || s.started_at,
          messageCount: s.message_count || 0 })) });
        return;
      }
      if (path === "/local/cli-open" && request.method === "POST") {
        const input = await body(request);
        if (!sessionId(input.id) || !profileName(input.profile)) throw fail("Invalid chat or profile.");
        const query = input.profile ? "?profile=" + encodeURIComponent(input.profile) : "";
        const result = await (await native("/api/sessions/" + encodeURIComponent(input.id) + query)).json();
        const row = result.session || result;
        if (row.id !== input.id) throw fail("This chat is no longer available. Refresh the list.", 404);
        json(response, { url: "/w/" + settings.slug + query + "#/" + encodeURIComponent(input.id) });
        return;
      }
      if (path === "/local/renderer" && request.method === "GET") {
        const { revision } = await renderer();
        const status = await (await native("/api/status")).json();
        json(response, { revision, version: status.version });
        return;
      }
      if (path === "/local/desktop-api" && request.method === "POST") {
        const input = await body(request);
        if (
          typeof input.path !== "string" ||
          !input.path.startsWith("/api/") ||
          input.path.includes("..") ||
          input.path.includes("\\") ||
          !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
            input.method || "GET",
          )
        )
          throw fail("Invalid Hermes API request.");
        const target = new URL(input.path, "http://hermes.invalid");
        if (
          target.origin !== "http://hermes.invalid" ||
          !target.pathname.startsWith("/api/")
        )
          throw fail("Invalid Hermes API path.");
        if (input.profile) {
          if (typeof input.profile !== "string" || input.profile.length > 128)
            throw fail("Invalid Hermes profile.");
          target.searchParams.set("profile", input.profile);
        }
        const upstream = await native(target.pathname + target.search, {
          method: input.method || "GET",
          data: input.body,
        });
        const data = await upstream.json();
        json(response, data);
        return;
      }
      if (path.startsWith("/hermes/")) {
        // The laptop's renderer and APIs stay behind the Nectit session. Native
        // cookies never enter the browser; only this router sends them upstream.
        const inner = path.slice("/hermes".length);
        if (!nativePathAllowed(inner)) throw fail("Not found.", 404);
        request.headers.cookie = settings.connection?.cookie || "";
        await gateway.handle(request, response, {
          device: settings.connection,
          prefix: "/hermes",
        });
        return;
      }
      if (path === "/local/address" && request.method === "POST") {
        const input = await body(request);
        if (!validSlug(input.slug))
          throw fail("Use 1–32 lowercase letters, numbers or hyphens.");
        settings.slug = input.slug;
        save();
        json(response, {
          slug: settings.slug,
          url: `${currentOrigin}/w/${settings.slug}`,
        });
        return;
      }
      if (path === "/local/status" && request.method === "GET") {
        let available = false;
        if (settings.connection)
          try {
            await native("/api/status");
            available = true;
          } catch {}
        const connection = settings.connection;
        json(response, {
          starting,
          error: errorMessage,
          connected: available,
          email: settings.account.email,
          slug: settings.slug,
          connection: connection
            ? {
                kind: connection.kind,
                version: connection.version,
                ticket: connection.irohTicket,
                email: connection.email,
                paired: !!connection.pathPrefix,
                fingerprint: connection.fingerprint,
              }
            : null,
        });
        return;
      }
      if (path === "/local/connect" && request.method === "POST") {
        await connect(await body(request), currentOrigin);
        json(response, { connected: true });
        return;
      }
      if (path === "/local/disconnect" && request.method === "POST") {
        if (starting) throw fail("Wait for setup to finish.", 409);
        if (settings.connection?.kind === "host") await command(["off"]);
        if (settings.connection) gateway.disconnect(settings.connection.id);
        for (const socket of [...sockets, ...cliSockets]) socket.destroy();
        for (const device of pairing.devices()) if (!device.revoked) pairing.revoke(device.id);
        settings.connection = null;
        save();
        json(response, { disconnected: true });
        return;
      }
      if (path === "/local/signout" && request.method === "POST") {
        sessions.clear();
        for (const socket of sockets) socket.destroy();
        json(response, {}, 200, {
          "Set-Cookie": `${sessionName()}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`,
        });
        return;
      }
      if (path.startsWith("/local/") || path.startsWith("/hermes/") || path.startsWith("/cli/"))
        throw fail("Not found.", 404);
      if (request.method !== "GET") throw fail("Not found.", 404);
      if (/^\/w\/[a-z0-9-]+\/?$/.test(path)) {
        try {
          authenticate(request);
        } catch {
          response.writeHead(302, {
            Location: "/setup/account",
            "Cache-Control": "no-store",
          });
          response.end();
          return;
        }
        if (!settings.setupComplete || !settings.connection) {
          response.writeHead(302, {
            Location: "/setup/computer",
            "Cache-Control": "no-store",
          });
          response.end();
          return;
        }
        if (path.replace(/\/$/, "") !== "/w/" + settings.slug) {
          response.writeHead(302, { Location: "/w/" + settings.slug });
          response.end();
          return;
        }
        let rendered;
        try {
          rendered = await renderer();
        } catch {
          response.writeHead(302, {
            Location: "/setup/computer?notice=offline",
            "Cache-Control": "no-store",
          });
          response.end();
          return;
        }
        const profile = url.searchParams.get("profile") || "";
        if (!profileName(profile)) throw fail("Invalid Hermes profile.");
        const { html, revision } = rendered,
          nonce = randomBytes(18).toString("base64");
        const boot =
          '<base href="/hermes/"><meta name="nectit-profile" content="' + profile + '"><meta name="nectit-renderer-revision" content="' +
          revision +
          '"><script nonce="' +
          nonce +
          '" src="/desktop-bridge.js"></script><link rel="stylesheet" href="/desktop.css">';
        const document = html
          .replace(/<head>/i, "<head>" + boot)
          .replace(/<script(?![^>]*nonce=)/gi, '<script nonce="' + nonce + '"');
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "same-origin",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: https:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
        });
        response.end(document);
        return;
      }
      const staticFiles = {
        "/desktop-bridge.js": ["desktop-bridge.js", "text/javascript"],
        "/cli-dialog.js": ["cli-dialog.js", "text/javascript"],
        "/desktop.css": ["desktop.css", "text/css"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/assets/favicon.svg": ["assets/favicon.svg", "image/svg+xml"],
      };
      const asset = staticFiles[path];
      if (
        !asset &&
        path !== "/" &&
        !/^\/setup\/(account|address|computer)$/.test(path) &&
        !/^\/w\/[a-z0-9-]+$/.test(path)
      )
        throw fail("Not found.", 404);
      response.writeHead(200, {
        "Content-Type": asset?.[1] || "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      response.end(readFileSync(join(root, "app", asset?.[0] || "index.html")));
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          {
            error: error.status
              ? error.message
              : "The local service could not complete this request.",
          },
          error.status || 500,
        );
      else response.destroy();
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const currentOrigin = origin(request);
      const incoming = new URL(request.url, currentOrigin);
      const terminal = incoming.pathname === "/cli/api/ws";
      const paired = incoming.pathname === "/paired/api/ws";
      let pairedDevice;
      if (terminal) cliAuth(request, incoming.searchParams.get("token"));
      else if (paired) pairedDevice = pairing.authenticate(pairedCredential(request));
      else {
        authenticate(request);
        if (request.headers.origin !== currentOrigin ||
            !/^\/hermes\/api\/(ws|pub|events|pty|console)(?:\?|$)/.test(request.url))
          throw fail("Forbidden.", 403);
      }
      const { ticket } = await (
        await native("/api/auth/ws-ticket", { method: "POST" })
      ).json();
      const wsUrl = new URL(request.url, currentOrigin);
      wsUrl.searchParams.delete("token");
      wsUrl.searchParams.delete("access");
      wsUrl.searchParams.set("ticket", ticket);
      request.url = wsUrl.pathname + wsUrl.search;
      request.headers.cookie = settings.connection.cookie;
      const clients = terminal ? cliSockets : sockets;
      clients.add(socket);
      socket.once("close", () => clients.delete(socket));
      if (pairedDevice) trackPaired(pairedDevice.id, socket);
      request.headers.origin = settings.connection.publicUrl;

      await gateway.upgrade(request, socket, head, {
        device: settings.connection,
        prefix: terminal ? "/cli" : paired ? "/paired" : "/hermes",
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.once("listening", () => {
    writeFileSync(cliFile, JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, token: cliToken }), { mode: 0o600 });
    chmodSync(cliFile, 0o600);
    mkdirSync(hostState, { recursive: true, mode: 0o700 });
    const pointer = join(hostState, "app-connection.json");
    writeFileSync(pointer, JSON.stringify({ data_dir: dataDir, origin: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
    chmodSync(pointer, 0o600);
  });
  server.requestTimeout = 210_000;
  server.headersTimeout = 15_000;
  return {
    server,
    settings,
    gateway,
    pairing,
    async close() {
      for (const socket of [...sockets, ...cliSockets]) socket.destroy();
      for (const items of pairedTraffic.values()) for (const item of items) item.destroy();
      pairing.close();
      gateway.close();
      if (startedHost)
        await command(["off", "--if-run-id", startedHost]).catch(() => {});
      await new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      });
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.FLOWNIUM_APP_PORT || 8788);
  const app = createLocalApp({
    port,
    ...(process.env.FLOWNIUM_APP_DATA
      ? { dataDir: resolve(process.env.FLOWNIUM_APP_DATA) }
      : {}),
    ...(process.env.FLOWNIUM_APP_HOST_STATE
      ? { hostState: resolve(process.env.FLOWNIUM_APP_HOST_STATE) }
      : {}),
  });
  app.server.listen(port, "127.0.0.1", () =>
    console.log(`Nectit for Hermes Agent: http://127.0.0.1:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
