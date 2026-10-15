import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { Cloudflare, Store, createApp, signingKey } from './core.mjs';

const origin = 'https://app.flownium.test';
function fixture(workspaceDomain = 'flownium.test') {
  const store = new Store(), signer = signingKey();
  let identity = { id: 'github:1', login: 'arhaan', name: 'Arhaan', email: 'owner@example.test' };
  const calls = [];
  const cloudflare = {
    async provision(device) { calls.push(device); return { tunnelId: 'test-tunnel', dnsId: 'test-dns', tunnelToken: 'test-scoped-token' }; },
    async token() { return 'test-scoped-token'; },
    async revoke(device) { calls.push({ revoked: device.id }); },
  };
  const app = createApp({ origin, workspaceDomain, store, signer, cloudflare,
    github: { authorize(state) { return `https://github.com/login/oauth/authorize?state=${state}`; }, async identity() { return identity; } } });
  async function request(path, { method = 'GET', body, cookie, token, form = false } = {}) {
    return app.fetch(new Request(origin + path, { method, headers: { Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      ...(body ? { body: form ? new URLSearchParams(body) : JSON.stringify(body) } : {}) }));
  }
  async function browserLogin(other) {
    if (other) identity = other;
    const login = await request('/login');
    const binding = login.headers.get('set-cookie').split(';')[0];
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const callback = await request(`/auth/callback?code=fixture-code&state=${state}`, { cookie: binding });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.get('set-cookie').split(';')[0];
    const userSession = Object.values(store.data.sessions).find(s => s.kind === 'browser' && s.user === identity.id);
    return { cookie, csrf: userSession.csrf, user: identity.id };
  }
  async function enroll(browser, installation = 'test-installation', transport = 'cloudflare') {
    const start = await (await request('/v1/cli/device', { method: 'POST', body: { client_id: 'flownium-cli', device_name: 'Main laptop', installation_id: installation } })).json();
    const prompt = await request('/activate', { method: 'POST', cookie: browser.cookie, form: true, body: { csrf: browser.csrf, code: start.user_code } });
    assert.match(await prompt.text(), /Pair this laptop/);
    const approved = await request('/activate', { method: 'POST', cookie: browser.cookie, form: true, body: { csrf: browser.csrf, code: start.user_code, confirm: 'yes' } });
    assert.equal(approved.status, 200);
    const grant = await (await request('/v1/cli/token', { method: 'POST', body: { client_id: 'flownium-cli', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.device_code } })).json();
    const response = await request('/v1/devices', { method: 'POST', token: grant.access_token, body: { name: 'Main laptop', local_port: 19119, kind: 'hermes-dashboard', transport } });
    assert.equal(response.status, 200);
    return { ...(await response.json()), access_token: grant.access_token };
  }
  return { app, store, signer, calls, request, browserLogin, enroll };
}

test('pairing provisions an account-owned subdomain; repeat enrollment is idempotent', async () => {
  const f = fixture(), browser = await f.browserLogin(), device = await f.enroll(browser);
  assert.equal(device.hostname, 'arhaan.flownium.test');
  assert.equal(device.oidc_issuer, origin);
  assert.equal(device.oidc_client_id, device.device_id);
  const again = await f.request('/v1/devices', { method: 'POST', token: device.access_token, body: { name: 'Main laptop', local_port: 19119, kind: 'hermes-dashboard', transport: 'cloudflare' } });
  assert.equal((await again.json()).device_id, device.device_id);
  assert.equal(f.calls.length, 1);
  const serialized = JSON.stringify(f.store.data);
  assert.ok(!serialized.includes(device.access_token));
  assert.ok(!serialized.includes(device.tunnel_token));
});

test('CSRF and an unbound OAuth callback cannot pair an account', async () => {
  const f = fixture(), browser = await f.browserLogin();
  const denied = await f.request('/activate', { method: 'POST', cookie: browser.cookie, body: { csrf: 'wrong', code: '00000000', confirm: 'yes' } });
  assert.equal(denied.status, 403);
  const login = await f.request('/login');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.equal((await f.request(`/auth/callback?code=anything&state=${state}`)).status, 401);
});

test('OIDC is bound to the laptop owner, audience, PKCE and one-time code', async () => {
  const f = fixture(), owner = await f.browserLogin(), device = await f.enroll(owner);
  const verifier = 'v'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id: device.device_id, redirect_uri: `https://${device.hostname}/auth/callback`,
    response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, scope: 'openid profile email', state: 'caller-state', nonce: 'caller-nonce' });
  const other = await f.browserLogin({ id: 'github:2', login: 'someone', name: 'Someone', email: 'other@example.test' });
  assert.equal((await f.request(`/oidc/authorize?${params}`, { cookie: other.cookie })).status, 403);
  const authorized = await f.request(`/oidc/authorize?${params}`, { cookie: owner.cookie });
  assert.equal(authorized.status, 302);
  const callback = new URL(authorized.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'caller-state');
  const body = { grant_type: 'authorization_code', client_id: device.device_id, redirect_uri: params.get('redirect_uri'), code: callback.searchParams.get('code'), code_verifier: verifier };
  assert.equal((await f.request('/oidc/token', { method: 'POST', form: true, body: { ...body, code_verifier: 'x'.repeat(43) } })).status, 400);
  const response = await f.request('/oidc/token', { method: 'POST', form: true, body });
  assert.equal(response.status, 200);
  const tokens = await response.json(), [header, payload, signature] = tokens.id_token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.sub, owner.user);
  assert.equal(claims.aud, device.device_id);
  assert.equal(claims.iss, origin);
  assert.equal(claims.nonce, 'caller-nonce');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ format: 'jwk', key: f.signer.jwks.keys[0] }), Buffer.from(signature, 'base64url')));
  assert.equal((await f.request('/oidc/token', { method: 'POST', form: true, body })).status, 400);
  const refreshed = await f.request('/oidc/token', { method: 'POST', form: true, body: { grant_type: 'refresh_token', client_id: device.device_id, refresh_token: tokens.refresh_token } });
  assert.equal(refreshed.status, 200);
  assert.notEqual((await refreshed.json()).refresh_token, tokens.refresh_token);
  assert.equal((await f.request('/oidc/token', { method: 'POST', form: true, body: { grant_type: 'refresh_token', client_id: device.device_id, refresh_token: tokens.refresh_token } })).status, 400);
});

test('a foreign CLI account cannot revoke another laptop', async () => {
  const f = fixture(), a = await f.browserLogin(), deviceA = await f.enroll(a);
  const b = await f.browserLogin({ id: 'github:2', login: 'another', name: 'Another', email: 'another@example.test' });
  const deviceB = await f.enroll(b, 'other-installation');
  assert.equal((await f.request(`/v1/devices/${deviceA.device_id}`, { method: 'DELETE', token: deviceB.access_token })).status, 404);
  assert.equal((await f.request(`/v1/devices/${deviceA.device_id}`, { method: 'DELETE', token: deviceA.access_token })).status, 200);
  assert.ok(f.store.data.devices[deviceA.device_id].revoked);
});

test('OIDC rejects callback and client changes before redirecting', async () => {
  const f = fixture(), owner = await f.browserLogin(), device = await f.enroll(owner);
  const response = await f.request('/oidc/authorize?' + new URLSearchParams({ client_id: device.device_id,
    redirect_uri: 'https://attacker.test/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'x'.repeat(43), scope: 'openid' }), { cookie: owner.cookie });
  assert.equal(response.status, 400);
  assert.ok(!response.headers.has('location'));
});

test('Cloudflare adapter sends only the selected loopback port and hostname', async () => {
  const calls = [];
  const provider = new Cloudflare({ token: 'operator-token', accountId: 'account', zoneId: 'zone' }, async (url, options) => {
    calls.push({ url, options });
    const result = url.endsWith('/token') ? 'scoped-token' : url.includes('/dns_records') ? { id: 'dns-id' } : { id: 'tunnel-id' };
    return Response.json({ success: true, result });
  });
  const result = await provider.provision({ id: 'device-id', hostname: 'arhaan.flownium.test', port: 19119 });
  assert.equal(result.tunnelToken, 'scoped-token');
  const config = JSON.parse(calls.find(call => call.url.endsWith('/configurations')).options.body);
  assert.equal(config.config.ingress[0].service, 'http://127.0.0.1:19119');
  assert.equal(config.config.ingress[0].hostname, 'arhaan.flownium.test');
  assert.deepEqual(config.config.ingress[1], { service: 'http_status:404' });
  assert.ok(calls.at(-1).url.includes('/dns_records'));
});

test('Iroh enrollment works without a custom domain or Cloudflare and scopes heartbeats', async () => {
  const f = fixture(null), owner = await f.browserLogin(), device = await f.enroll(owner, 'iroh-installation', 'iroh');
  assert.equal(device.transport, 'iroh');
  assert.equal(device.public_url, `${origin}/remote/${device.device_id}`);
  assert.equal(f.calls.length, 0);
  assert.ok(!device.tunnel_token);
  const heartbeat = await f.request(`/v1/devices/${device.device_id}/heartbeat`, { method: 'POST', token: device.access_token,
    body: { iroh_ticket: 'endpoint' + 'a'.repeat(80), hermes_version: 'test-version' } });
  assert.equal(heartbeat.status, 200);
  const list = await (await f.request('/v1/devices', { token: device.access_token })).json();
  assert.equal(list.devices[0].status, 'online');
  assert.ok(!JSON.stringify(list).includes('endpoint'));
  const other = await f.browserLogin({ id: 'github:2', login: 'other', name: 'Other', email: 'other@example.test' });
  const another = await f.enroll(other, 'other-iroh-installation', 'iroh');
  assert.equal((await f.request(`/v1/devices/${device.device_id}/heartbeat`, { method: 'POST', token: another.access_token,
    body: { iroh_ticket: 'endpoint' + 'a'.repeat(80) } })).status, 404);
});

test('shared-origin gateway only serves laptop content to its account owner', async () => {
  const f = fixture(null), owner = await f.browserLogin(), enrolled = await f.enroll(owner, 'private-gateway', 'iroh');
  const device = f.store.data.devices[enrolled.device_id];
  const request = cookie => new Request(enrolled.public_url + '/chat', { headers: cookie ? { Cookie: cookie } : {} });
  const anonymous = f.app.authorizeDevice(request(), device);
  assert.equal(anonymous.status, 302);
  assert.ok(anonymous.headers.get('location').startsWith('/login?next='));
  assert.equal(f.app.authorizeDevice(new Request(enrolled.public_url, { method: 'POST' }), device).status, 401);
  assert.equal(f.app.authorizeDevice(request(owner.cookie), device), null);
  const other = await f.browserLogin({ id: 'github:2', login: 'visitor', name: 'Visitor', email: 'visitor@example.test' });
  assert.equal(f.app.authorizeDevice(request(other.cookie), device).status, 403);
  device.revoked = true;
  assert.equal(f.app.authorizeDevice(request(owner.cookie), device).status, 403);
});

test('failed Cloudflare DNS provisioning rolls back the newly created tunnel', async () => {
  const calls = [];
  const provider = new Cloudflare({ token: 'operator-token', accountId: 'account', zoneId: 'zone' }, async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.includes('/dns_records')) return Response.json({ success: false }, { status: 403 });
    return Response.json({ success: true, result: url.endsWith('/token') ? 'scoped-token' : { id: 'tunnel-id' } });
  });
  await assert.rejects(provider.provision({ id: 'device', hostname: 'arhaan.flownium.test', port: 19119 }));
  assert.deepEqual(calls.at(-1), { url: 'https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel/tunnel-id', method: 'DELETE' });
});
