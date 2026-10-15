import assert from "node:assert/strict";
import test from "node:test";
import { googleProvider } from "./auth.mjs";

test("Google exchanges the bound code with PKCE and requires a verified email and stable subject", async () => {
  let info = { sub: "123", email: "owner@example.com", email_verified: true };
  const requests = [];
  const google = googleProvider(
    {
      clientId: "test-client",
      clientSecret: "test-secret",
      origin: "http://127.0.0.1:8788",
    },
    async (url, options) => {
      requests.push({ url, options });
      return Response.json(
        url.endsWith("/token") ? { access_token: "private-access" } : info,
      );
    },
  );
  const url = new URL(google.authorize("bound-state", "verifier"));
  assert.equal(url.searchParams.get("state"), "bound-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:8788/auth/google/callback",
  );
  assert.deepEqual(await google.identity("code", "verifier"), {
    id: "google:123",
    email: "owner@example.com",
    name: "owner@example.com",
  });
  assert.equal(requests[0].options.body.get("code_verifier"), "verifier");
  assert.equal(
    requests[1].options.headers.Authorization,
    "Bearer private-access",
  );
  for (const value of [
    { ...info, email_verified: false },
    { ...info, sub: null },
    { ...info, email: "bad" },
  ]) {
    info = value;
    await assert.rejects(google.identity("code", "verifier"));
  }
});
