import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalApp } from "./server.mjs";

async function fixture(options = {}) {
  const folder = mkdtempSync(join(tmpdir(), "hermes-local-app-"));
  const app = createLocalApp({
    dataDir: folder,
    hostState: join(folder, "host"),
    port: 0,
    ...options,
  });
  await new Promise((done) => app.server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, data, cookie, extra = {}) =>
    fetch(origin + path, {
      headers: {
        Origin: origin,
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      ...(data ? { method: "POST", body: JSON.stringify(data) } : {}),
      redirect: "manual",
    });
  return {
    app,
    folder,
    origin,
    request,
    close: async () => {
      await app.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
test("local account stores only a hash, protects sessions and keeps native credentials private", async () => {
  const f = await fixture();
  try {
    const password = "test-local-password";
    const response = await f.request("/local/signin", {
      email: "localtest@example.com",
      password,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    assert.match(
      response.headers.get("set-cookie"),
      /HttpOnly; SameSite=Strict/,
    );
    assert.ok(
      !readFileSync(join(f.folder, "local.json"), "utf8").includes(password),
    );
    assert.equal(statSync(join(f.folder, "local.json")).mode & 0o777, 0o600);
    assert.equal((await f.request("/local/status")).status, 401);
    assert.equal((await f.request("/local/status", null, cookie)).status, 200);
    assert.equal(
      (
        await f.request("/local/signin", {
          email: "localtest@example.com",
          password: "incorrect-password",
        })
      ).status,
      401,
    );
    f.app.settings.connection = {
      cookie: "private-native-session",
      kind: "peer",
    };
    assert.ok(
      !JSON.stringify(
        await (await f.request("/local/bootstrap", null, cookie)).json(),
      ).includes("private-native-session"),
    );
    f.app.settings.connection = null;
    await f.request("/local/signout", {}, cookie);
    assert.equal((await f.request("/local/status", null, cookie)).status, 401);
  } finally {
    await f.close();
  }
});
test("loopback setup rejects foreign origins, host rebinding, invalid addresses and unauthenticated changes", async () => {
  const f = await fixture();
  try {
    const data = {
      email: "owner@example.com",
      password: "correct-test-password",
    };
    assert.equal(
      (
        await f.request("/local/signin", data, null, {
          Origin: "https://foreign.test",
        })
      ).status,
      403,
    );
    // fetch normalizes Host; use the wire-level API to exercise DNS rebinding.
    const rebound = await new Promise((done, reject) => {
      http
        .get(
          f.origin + "/local/bootstrap",
          { headers: { Host: "foreign.test" } },
          (response) => {
            response.resume();
            done(response.statusCode);
          },
        )
        .on("error", reject);
    });
    assert.equal(rebound, 403);
    assert.equal(
      (await f.request("/local/address", { slug: "owner@example.com" })).status,
      401,
    );
    const signed = await f.request("/local/signin", data),
      cookie = signed.headers.get("set-cookie").split(";")[0];
    for (const slug of [
      "../secret",
      "UPPER",
      "two words",
      "-bad",
      "x".repeat(33),
    ])
      assert.equal(
        (await f.request("/local/address", { slug }, cookie)).status,
        400,
      );
    assert.equal(
      (await f.request("/local/address", { slug: "my-hermes" }, cookie)).status,
      200,
    );
    assert.equal(
      (await (await f.request("/local/bootstrap", null, cookie)).json()).slug,
      "my-hermes",
    );
    assert.equal(
      (
        await f.request(
          "/local/connect",
          {
            kind: "peer",
            email: "owner@example.com",
            password: "correct-test-password",
            ticket: "arbitrary-host",
          },
          cookie,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("all three setup routes and local workspace serve without external scripts", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/setup/account",
      "/setup/address",
      "/setup/computer",
    ]) {
      const response = await f.request(path);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-security-policy"),
        /script-src 'self'/,
      );
      assert.match(await response.text(), /Nectit · Hermes Agent/);
    }
    assert.equal((await f.request("/style.css")).status, 200);
    assert.equal((await f.request("/app.js")).status, 200);
    assert.equal((await f.request("/local.json")).status, 404);
    assert.equal((await f.request("/assets/HERMES-LICENSE.txt")).status, 404);
  } finally {
    await f.close();
  }
});

test("configured GitHub sign-in binds OAuth state to the browser and the workspace owner", async () => {
  let identity = { id: "github:test-owner", email: "gitowner@example.com" };
  const f = await fixture({
    providerFactory: () => ({
      authorize: (state) =>
        "https://github.com/login/oauth/authorize?state=" + state,
      identity: async () => identity,
    }),
  }); // External identity is an explicit fixture.
  try {
    assert.equal(
      (await (await f.request("/local/bootstrap")).json()).providers.github,
      true,
    );
    const begin = await f.request("/login"),
      state = new URL(begin.headers.get("location")).searchParams.get("state");
    const binding = begin.headers.get("set-cookie").split(";")[0],
      path = "/auth/callback?code=fixture&state=" + state;
    assert.equal((await f.request(path)).status, 401);
    const callback = await f.request(path, null, binding);
    assert.equal(callback.status, 302);
    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("nectit-session-"))
      .split(";")[0];
    assert.equal(
      (await (await f.request("/local/bootstrap", null, cookie)).json()).email,
      "gitowner@example.com",
    );
    assert.equal((await f.request(path, null, binding)).status, 401);
    identity = { id: "github:other-owner", email: "someone@example.com" };
    const other = await f.request("/login"),
      otherState = new URL(other.headers.get("location")).searchParams.get(
        "state",
      );
    assert.equal(
      (
        await f.request(
          "/auth/callback?code=fixture&state=" + otherState,
          null,
          other.headers.get("set-cookie").split(";")[0],
        )
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("fresh visits stay signed out; completed email sign-in returns directly to the workspace", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await (await f.request("/local/bootstrap")).json()).signedIn,
      false,
    );
    assert.equal(
      (await f.request("/w/my-hermes")).headers.get("location"),
      "/setup/account",
    );
    for (const email of [
      "owner",
      "bad@",
      "@example.com",
      "a@local",
      "a b@example.com",
    ]) {
      assert.equal(
        (
          await f.request("/local/signin", {
            email,
            password: "correct-test-password",
          })
        ).status,
        400,
      );
    }
    const signed = await f.request("/local/signin", {
      email: "Owner+Device@Example.com",
      password: "correct-test-password",
    });
    assert.equal(signed.status, 200);
    assert.equal((await signed.json()).email, "owner+device@example.com");
    const cookie = signed.headers.get("set-cookie").split(";")[0];
    f.app.settings.setupComplete = true;
    await f.request("/local/signout", {}, cookie);
    const again = await f.request("/local/signin", {
      email: "owner+device@example.com",
      password: "correct-test-password",
    });
    assert.equal((await again.json()).next, "/w/my-hermes");
    const session = again.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (await f.request("/w/my-hermes", null, session)).headers.get("location"),
      "/setup/computer",
    );
    assert.equal(
      (
        await f.request(
          "/local/desktop-api",
          { path: "https://foreign.test/api/status" },
          session,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("Google OAuth is provider-bound, rejects foreign owners and returns completed owners to Hermes", async () => {
  let identity = { id: "google:owner", email: "owner@example.com" };
  const provider = (name) => () => ({
    authorize: (state) =>
      "https://accounts.google.com/authorize?state=" + state,
    identity: async () => ({ ...identity, id: name + ":owner" }),
  });
  const f = await fixture({
    googleFactory: provider("google"),
    providerFactory: provider("github"),
  });
  try {
    const begin = await f.request("/login/google");
    const state = new URL(begin.headers.get("location")).searchParams.get(
      "state",
    );
    const binding = begin.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await f.request(
          "/auth/callback?code=test&state=" + state,
          null,
          binding,
        )
      ).status,
      401,
    );
    const correct = await f.request(
      "/auth/google/callback?code=test&state=" + state,
      null,
      binding,
    );
    assert.equal(correct.headers.get("location"), "/setup/address");
    assert.equal(f.app.settings.account.email, "owner@example.com");
    f.app.settings.setupComplete = true;
    const start = await f.request("/login/google");
    const value = new URL(start.headers.get("location")).searchParams.get(
      "state",
    );
    assert.equal(
      (
        await f.request(
          "/auth/google/callback?code=test&state=" + value,
          null,
          start.headers.get("set-cookie").split(";")[0],
        )
      ).headers.get("location"),
      "/w/my-hermes",
    );
    assert.equal(
      (
        await f.request(
          "/auth/google/callback?code=test&state=" + value,
          null,
          binding,
        )
      ).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("desktop renderer is authenticated, loads current upstream build, and never exposes Electron bundles", async () => {
  let build = "one";
  const upstream = http.createServer((req, res) => {
    if (req.headers.cookie !== "native=private") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><html><head><title>Hermes</title><script type="module" src="./assets/index-${build}.js"></script></head><body></body></html>`,
    );
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const f = await fixture();
  try {
    const signed = await f.request("/local/signin", {
      email: "owner@example.com",
      password: "correct-test-password",
    });
    const cookie = signed.headers.get("set-cookie").split(";")[0];
    f.app.settings.setupComplete = true;
    f.app.settings.connection = {
      id: "fixture",
      kind: "host",
      port: upstream.address().port,
      cookie: "native=private",
      publicUrl: f.origin,
    };
    const first = await f.request("/w/my-hermes", null, cookie);
    const html = await first.text();
    assert.match(html, /<base href="\/hermes\/">/);
    assert.match(html, /src="\/desktop-bridge.js"/);
    assert.match(html, /nonce="[^"]+"/);
    assert.ok(!html.includes("native=private"));
    build = "two";
    const next = await (await f.request("/w/my-hermes", null, cookie)).text();
    assert.match(next, /index-two.js/);
    assert.notEqual(
      /nectit-renderer-revision" content="([^"]+)/.exec(html)[1],
      /nectit-renderer-revision" content="([^"]+)/.exec(next)[1],
    );
    for (const file of [
      "/hermes/electron-main.mjs",
      "/hermes/electron-preload.js",
      "/hermes/hermes-build.json",
    ])
      assert.equal((await f.request(file, null, cookie)).status, 404);
    assert.equal((await f.request("/hermes/assets/index-two.js")).status, 401);
  } finally {
    await f.close();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
});

test("hosted gateway pins its HTTPS origin and issues Secure cookies for any-device browser sessions", async () => {
  const f = await fixture({ publicOrigin: "https://nectit.example" });
  try {
    const wire = (host, origin) =>
      new Promise((done, reject) => {
        const body = JSON.stringify({
          email: "owner@example.com",
          password: "correct-test-password",
        });
        const req = http.request(
          f.origin + "/local/signin",
          {
            method: "POST",
            headers: {
              Host: host,
              Origin: origin,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              done({
                code: response.statusCode,
                cookies: response.headers["set-cookie"],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const accepted = await wire("nectit.example", "https://nectit.example");
    assert.equal(accepted.code, 200);
    assert.match(accepted.cookies[0], /; Secure/);
    assert.equal(
      (await wire("nectit.example", "https://foreign.test")).code,
      403,
    );
    assert.equal(
      (await wire("foreign.test", "https://foreign.test")).code,
      403,
    );
  } finally {
    await f.close();
  }
});

test("independent routers on different ports keep browser sessions isolated", async () => {
  const first = await fixture(),
    second = await fixture();
  try {
    const data = {
      email: "owner@example.com",
      password: "correct-test-password",
    };
    const a = (await first.request("/local/signin", data)).headers
      .get("set-cookie")
      .split(";")[0];
    const b = (await second.request("/local/signin", data)).headers
      .get("set-cookie")
      .split(";")[0];
    assert.notEqual(a.split("=")[0], b.split("=")[0]);
    assert.equal(
      (await first.request("/local/status", null, a + "; " + b)).status,
      200,
    );
    assert.equal(
      (await second.request("/local/status", null, a + "; " + b)).status,
      200,
    );
    assert.equal((await first.request("/local/status", null, b)).status, 401);
  } finally {
    await first.close();
    await second.close();
  }
});

test("provider popup completes OAuth with a real session cookie and a same-origin completion page", async () => {
  const f = await fixture({
    googleFactory: () => ({
      authorize: (state) =>
        "https://accounts.google.com/authorize?state=" + state,
      identity: async () => ({
        id: "google:popup-owner",
        email: "owner@example.com",
      }),
    }),
  });
  try {
    const begin = await f.request("/login/google?popup=1");
    assert.equal(
      new URL(begin.headers.get("location")).hostname,
      "accounts.google.com",
    );
    const state = new URL(begin.headers.get("location")).searchParams.get(
      "state",
    );
    const response = await f.request(
      "/auth/google/callback?code=test&state=" + state,
      null,
      begin.headers.get("set-cookie").split(";")[0],
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /nectit-auth-result" content="success"/);
    assert.match(html, /src="\/auth-window.js"/);
    assert.ok(!html.includes("test-secret"));
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("nectit-session-"))
      .split(";")[0];
    assert.equal(
      (await (await f.request("/local/bootstrap", null, cookie)).json())
        .signedIn,
      true,
    );
    const unconfigured = await f.request("/login/github?popup=1");
    assert.equal(unconfigured.status, 503);
    assert.match(
      await unconfigured.text(),
      /nectit-auth-result" content="configuration"/,
    );
  } finally {
    await f.close();
  }
});
