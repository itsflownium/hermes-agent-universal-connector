import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const seconds = () => Math.floor(Date.now() / 1000);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class HTTPError extends Error {
  constructor(status, message, code = 'request_failed') { super(message); this.status = status; this.code = code; }
}

export class Store {
  // One-process prototype storage. Secrets are hashed; the RSA key is separate.
  constructor(file = null) {
    this.file = file;
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) :
      { users: {}, grants: {}, sessions: {}, oauth: {}, devices: {}, codes: {}, refresh: {} };
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.file), 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  clean() {
    for (const table of ['grants', 'sessions', 'oauth', 'codes', 'refresh']) {
      for (const [key, value] of Object.entries(this.data[table])) {
        if (value.expires <= seconds()) delete this.data[table][key];
      }
    }
  }
}

export function signingKey(file = null) {
  let privateKey;
  if (file && existsSync(file)) privateKey = createPrivateKey(readFileSync(file));
  else {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
  }
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = hash(jwk.n).slice(0, 20);
  return {
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
    jwt(claims) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const body = `${header}.${payload}`;
      return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
    },
  };
}

export class Cloudflare {
  constructor({ token, accountId, zoneId, workspaceDomain }, fetcher = fetch) {
    Object.assign(this, { token, accountId, zoneId, workspaceDomain, fetcher });
  }
  async api(path, method = 'GET', body) {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok || value.success !== true) throw new HTTPError(502, 'Cloudflare provisioning failed; retry after the operator checks its configuration.');
    return value.result;
  }
  async provision(device) {
    const base = `/accounts/${this.accountId}/cfd_tunnel`;
    let tunnelId, dnsId;
    try {
      const tunnel = await this.api(base, 'POST', { name: `flownium-${device.id}`, config_src: 'cloudflare', tunnel_secret: randomBytes(32).toString('base64') });
      tunnelId = tunnel.id;
      await this.api(`${base}/${tunnelId}/configurations`, 'PUT', { config: { ingress: [
        { hostname: device.hostname, service: `http://127.0.0.1:${device.port}`, originRequest: { httpHostHeader: device.hostname } },
        { service: 'http_status:404' },
      ] } });
      const tunnelToken = await this.api(`${base}/${tunnelId}/token`);
      if (typeof tunnelToken !== 'string' || !tunnelToken) throw new HTTPError(502, 'Cloudflare did not return a tunnel credential.');
      // Publish DNS last. The laptop separately verifies Hermes's OIDC gate
      // before starting this connector; no unauthenticated origin is published.
      const dns = await this.api(`/zones/${this.zoneId}/dns_records`, 'POST', { type: 'CNAME', name: device.hostname,
        content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });
      dnsId = dns.id;
      return { tunnelId, dnsId, tunnelToken };
    } catch (error) {
      if (dnsId) await this.api(`/zones/${this.zoneId}/dns_records/${dnsId}`, 'DELETE').catch(() => {});
      if (tunnelId) await this.api(`${base}/${tunnelId}`, 'DELETE').catch(() => {});
      throw error;
    }
  }
  token(device) { return this.api(`/accounts/${this.accountId}/cfd_tunnel/${device.tunnelId}/token`); }
  async revoke(device) {
    if (device.dnsId) await this.api(`/zones/${this.zoneId}/dns_records/${device.dnsId}`, 'DELETE');
    await this.api(`/accounts/${this.accountId}/cfd_tunnel/${device.tunnelId}/connections`, 'DELETE');
    await this.api(`/accounts/${this.accountId}/cfd_tunnel/${device.tunnelId}`, 'DELETE');
  }
}

export function githubProvider({ clientId, clientSecret, origin }, fetcher = fetch) {
  return {
    authorize(state, verifier) {
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: `${origin}/auth/callback`,
        scope: 'read:user user:email', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return `https://github.com/login/oauth/authorize?${query}`;
    },
    async identity(code, verifier) {
      const response = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: `${origin}/auth/callback` }) });
      const grant = await response.json();
      if (!response.ok || !grant.access_token) throw new HTTPError(401, 'GitHub sign-in failed.');
      const options = { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Flownium' } };
      const [profileResponse, emailsResponse] = await Promise.all([fetcher('https://api.github.com/user', options), fetcher('https://api.github.com/user/emails', options)]);
      if (!profileResponse.ok || !emailsResponse.ok) throw new HTTPError(401, 'GitHub could not verify this account.');
      const profile = await profileResponse.json();
      const emails = await emailsResponse.json();
      const email = emails.find(item => item.verified && item.primary)?.email;
      if (!profile.id || !email) throw new HTTPError(403, 'Use a GitHub account with a verified primary email address.');
      return { id: `github:${profile.id}`, login: profile.login, name: profile.name || profile.login, email };
    },
  };
}

function page(title, content) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Flownium</title><main><header>flownium<span style="color:#668e73">.</span></header>${content}</main></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const redirect = (url, cookies = []) => new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store', ...Object.fromEntries(cookies.map(value => ['Set-Cookie', value])) } });

export function createApp({ origin, workspaceDomain, store, signer, github, cloudflare, capabilities = {}, onRevoke = () => {} }) {
  origin = new URL(origin).origin;
  const secure = origin.startsWith('https:');
  const sessionName = secure ? '__Host-flownium' : 'flownium';
  const oauthName = secure ? '__Host-flownium-oauth' : 'flownium-oauth';
  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const cookieValue = (request, name) => (request.headers.get('cookie') || '').split(';').map(p => p.trim()).find(p => p.startsWith(name + '='))?.slice(name.length + 1);
  const session = request => {
    const token = cookieValue(request, sessionName);
    const value = token && store.data.sessions[hash(token)];
    return value?.kind === 'browser' && value.expires > seconds() ? value : null;
  };
  const bearer = request => {
    const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    const value = token && store.data.sessions[hash(token)];
    if (value?.kind !== 'cli' || value.expires <= seconds()) throw new HTTPError(401, 'Sign in with the Flownium CLI.');
    return value;
  };
  const csrf = (request, current, input) => {
    if (request.headers.get('Origin') !== origin || input.csrf !== current.csrf) throw new HTTPError(403, 'Reload this page before submitting.');
  };
  const signedIn = (request, next) => session(request) || redirect(`/login?next=${encodeURIComponent(next)}`);
  const readBody = async request => {
    const text = await request.text();
    if (text.length > 16384) throw new HTTPError(413, 'Request is too large.');
    try { return request.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); }
    catch { throw new HTTPError(400, 'Invalid request body.'); }
  };
  const rates = new Map();
  const rate = (key, limit, window = 60) => {
    if (rates.size > 10000) for (const [k, entry] of rates) if (entry.until < seconds()) rates.delete(k);
    const entry = rates.get(key);
    if (!entry || entry.until < seconds()) { rates.set(key, { count: 1, until: seconds() + window }); return; }
    if (++entry.count > limit) throw new HTTPError(429, 'Please wait before trying again.');
  };
  const provisioning = new Map();
  const tokens = (user, device, nonce) => {
    const now = seconds();
    const refresh = secret();
    store.data.refresh[hash(refresh)] = { user: user.id, device: device.id, expires: now + 30 * 86400 };
    store.save();
    return { token_type: 'Bearer', expires_in: 900, access_token: secret(), refresh_token: refresh,
      id_token: signer.jwt({ iss: origin, aud: device.id, sub: user.id, email: user.email, email_verified: true,
        name: user.name, preferred_username: user.login, iat: now, exp: now + 900, ...(nonce ? { nonce } : {}) }) };
  };

  async function route(request, clientIP) {
    store.clean();
    const url = new URL(request.url);
    const path = url.pathname;
    const current = session(request);
    if (request.method === 'GET' && path === '/health') return json({ service: 'flownium', status: 'ok', capabilities });
    if (request.method === 'GET' && path === '/v1/capabilities') return json({ protocol_version: 1, transports: ['iroh', 'cloudflare'], ...capabilities });
    if (request.method === 'GET' && path === '/') return json({ service: 'flownium-backend', version: 1, interface: 'api-only' });
    if (request.method === 'GET' && path === '/login') {
      rate(`login:${clientIP}`, 30, 300);
      const next = url.searchParams.get('next') || '/';
      if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\r\n]/.test(next)) throw new HTTPError(400, 'Invalid return location.');
      const state = secret(), verifier = secret(), binding = secret();
      store.data.oauth[hash(state)] = { verifier, binding: hash(binding), next, expires: seconds() + 600 };
      store.save();
      return redirect(github.authorize(state, verifier), [cookie(oauthName, binding, 600)]);
    }
    if (request.method === 'GET' && path === '/auth/callback') {
      const state = url.searchParams.get('state') || '';
      const flow = store.data.oauth[hash(state)];
      const binding = cookieValue(request, oauthName);
      if (!flow || !binding || flow.binding !== hash(binding) || flow.expires < seconds()) throw new HTTPError(401, 'Sign-in expired. Start again.');
      delete store.data.oauth[hash(state)]; store.save();
      const identity = await github.identity(url.searchParams.get('code') || '', flow.verifier);
      let user = store.data.users[identity.id];
      if (!user) {
        let slug = identity.login.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 38) || 'user';
        if (['www', 'api', 'app', 'auth', 'admin', 'support'].includes(slug) || Object.values(store.data.users).some(u => u.slug === slug)) slug += `-${hash(identity.id).slice(0, 8)}`;
        user = { ...identity, slug };
      } else user = { ...user, ...identity };
      store.data.users[user.id] = user;
      const token = secret();
      store.data.sessions[hash(token)] = { kind: 'browser', user: user.id, csrf: secret(), expires: seconds() + 7 * 86400 };
      store.save();
      return redirect(flow.next, [cookie(sessionName, token, 7 * 86400)]);
    }
    if (request.method === 'POST' && path === '/logout') {
      if (!current) throw new HTTPError(401, 'Sign in first.');
      csrf(request, current, await readBody(request));
      delete store.data.sessions[hash(cookieValue(request, sessionName))]; store.save();
      return redirect('/', [cookie(sessionName, '', 0)]);
    }
    if (request.method === 'POST' && path === '/v1/cli/device') {
      rate(`device:${clientIP}`, 10, 300);
      const body = await readBody(request);
      if (body.client_id !== 'flownium-cli') throw new HTTPError(400, 'Unknown client.');
      const code = secret(), userCode = randomBytes(4).toString('hex').toUpperCase();
      store.data.grants[hash(code)] = { userCode, name: String(body.device_name || 'Laptop').slice(0, 80),
        installation: String(body.installation_id || randomUUID()).slice(0, 80), expires: seconds() + 600, lastPoll: 0 };
      store.save();
      return json({ device_code: code, user_code: userCode, verification_uri: `${origin}/activate`, expires_in: 600, interval: 5 });
    }
    if (request.method === 'GET' && path === '/activate') {
      const auth = signedIn(request, path + url.search);
      if (auth instanceof Response) return auth;
      return page('Connect your laptop', `<h1>Connect your laptop.</h1><p>Enter the pairing code shown in your Flownium CLI.</p><form class="card" method="post" action="/activate"><input type="hidden" name="csrf" value="${auth.csrf}"><label for="code">Pairing code</label><input id="code" name="code" required autocomplete="off" maxlength="12"><button>Continue</button></form>`);
    }
    if (request.method === 'POST' && path === '/activate') {
      if (!current) throw new HTTPError(401, 'Sign in first.');
      rate(`activate:${current.user}`, 12, 300);
      const body = await readBody(request); csrf(request, current, body);
      const grant = Object.values(store.data.grants).find(g => g.userCode === String(body.code || '').replace(/[\s-]/g, '').toUpperCase() && !g.user && g.expires > seconds());
      if (!grant) throw new HTTPError(400, 'That pairing code is invalid or expired.');
      // Show the machine name and require a second, explicit confirmation before
      // binding it. Merely following a link never pairs a device.
      if (body.confirm !== 'yes') return page('Confirm laptop', `<h1>Pair this laptop?</h1><div class="card"><strong>${escape(grant.name)}</strong><p>Approve only the computer on which you just ran Flownium.</p><form method="post" action="/activate"><input type="hidden" name="csrf" value="${current.csrf}"><input type="hidden" name="code" value="${grant.userCode}"><input type="hidden" name="confirm" value="yes"><button>Pair laptop</button></form></div>`);
      grant.user = current.user; store.save();
      return page('Laptop paired', '<h1>Laptop paired.</h1><p>Return to your terminal to finish connecting Hermes.</p><a class="button" href="/">Your workspace</a>');
    }
    if (request.method === 'POST' && path === '/v1/cli/token') {
      rate(`poll:${clientIP}`, 90);
      const body = await readBody(request);
      if (body.client_id !== 'flownium-cli' || body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') throw new HTTPError(400, 'Invalid grant.');
      const key = hash(String(body.device_code || '')), grant = store.data.grants[key];
      if (!grant || grant.expires < seconds()) throw new HTTPError(400, 'Pairing code expired.', 'expired_token');
      if (seconds() - grant.lastPoll < 5) return json({ error: 'slow_down' }, 400);
      grant.lastPoll = seconds(); store.save();
      if (!grant.user) return json({ error: 'authorization_pending' }, 400);
      const token = secret();
      store.data.sessions[hash(token)] = { kind: 'cli', user: grant.user, installation: grant.installation, expires: seconds() + 30 * 86400 };
      delete store.data.grants[key]; store.save();
      return json({ access_token: token, token_type: 'Bearer', expires_in: 30 * 86400 });
    }
    if (request.method === 'POST' && path === '/v1/devices') {
      const auth = bearer(request), body = await readBody(request);
      if (body.kind !== 'hermes-dashboard' || !Number.isInteger(body.local_port) || body.local_port < 1024 || body.local_port > 65535) throw new HTTPError(400, 'Invalid Hermes local port.');
      const transport = body.transport || 'iroh';
      if (!['iroh', 'cloudflare'].includes(transport)) throw new HTTPError(400, 'Unknown connector transport.');
      const key = `${auth.user}:${auth.installation}`;
      if (!provisioning.has(key)) provisioning.set(key, (async () => {
        let device = Object.values(store.data.devices).find(d => d.user === auth.user && d.installation === auth.installation && !d.revoked);
        if (device && (device.port !== body.local_port || device.transport !== transport)) throw new HTTPError(409, 'This laptop is already registered with a different local port or transport.');
        let tunnelToken;
        if (!device) {
          const user = store.data.users[auth.user], id = randomUUID();
          const others = Object.values(store.data.devices).filter(d => d.user === auth.user && !d.revoked);
          if (others.length >= 5) throw new HTTPError(429, 'This account has reached its laptop limit.');
          const subdomain = others.length ? `${user.slug}-${id.slice(0, 8)}` : user.slug;
          const hostname = workspaceDomain ? `${subdomain}.${workspaceDomain}` : new URL(origin).hostname;
          device = { id, user: user.id, installation: auth.installation, hostname, transport,
            publicUrl: workspaceDomain ? `https://${hostname}` : `${origin}/remote/${id}`,
            name: String(body.name || 'Laptop').slice(0, 80), port: body.local_port, created: seconds() };
          if (transport === 'cloudflare') {
            if (!workspaceDomain) throw new HTTPError(503, 'Cloudflare is not configured yet.', 'transport_unconfigured');
            const provisioned = await cloudflare.provision(device);
            Object.assign(device, { tunnelId: provisioned.tunnelId, dnsId: provisioned.dnsId });
            tunnelToken = provisioned.tunnelToken;
          }
          store.data.devices[id] = device; store.save();
        } else if (transport === 'cloudflare') tunnelToken = await cloudflare.token(device);
        return { device_id: device.id, hostname: device.hostname, public_url: device.publicUrl, transport: device.transport,
          ...(tunnelToken ? { tunnel_token: tunnelToken } : {}),
          oidc_issuer: origin, oidc_client_id: device.id };
      })());
      const promise = provisioning.get(key);
      try { return json(await promise); }
      finally { if (provisioning.get(key) === promise) provisioning.delete(key); }
    }
    if (request.method === 'GET' && path === '/v1/devices') {
      const auth = current || bearer(request);
      return json({ devices: Object.values(store.data.devices).filter(d => d.user === auth.user && !d.revoked).map(d => ({
        device_id: d.id, name: d.name, transport: d.transport, public_url: d.publicUrl, hostname: d.hostname,
        last_seen: d.lastSeen || null, status: d.lastSeen && seconds() - d.lastSeen < 45 ? 'online' : 'offline',
        hermes_version: d.hermesVersion || null,
      })) });
    }
    if (request.method === 'POST' && /^\/v1\/devices\/[^/]+\/heartbeat$/.test(path)) {
      const auth = bearer(request), id = path.split('/')[3], device = store.data.devices[id];
      if (!device || device.revoked || device.user !== auth.user || device.installation !== auth.installation) throw new HTTPError(404, 'Laptop not found.');
      const body = await readBody(request);
      if (device.transport === 'iroh' && !/^(?:node|endpoint)[a-z2-7]{40,4096}$/.test(body.iroh_ticket || '')) throw new HTTPError(400, 'Invalid Iroh ticket.');
      if (device.transport === 'iroh') device.irohTicket = body.iroh_ticket;
      device.lastSeen = seconds(); device.hermesVersion = String(body.hermes_version || '').slice(0, 40);
      store.save(); return json({ accepted: true });
    }
    if (request.method === 'DELETE' && path.startsWith('/v1/devices/')) {
      const auth = bearer(request), id = path.slice('/v1/devices/'.length), device = store.data.devices[id];
      if (!device || device.user !== auth.user || device.installation !== auth.installation) throw new HTTPError(404, 'Laptop not found.');
      device.revoked = true; store.save(); // Immediately block new OIDC grants.
      onRevoke(device);
      if (device.transport === 'cloudflare') await cloudflare.revoke(device);
      delete device.irohTicket;
      for (const [key, value] of Object.entries(store.data.refresh)) if (value.device === id) delete store.data.refresh[key];
      store.save();
      return json({ revoked: true });
    }
    if (request.method === 'GET' && path === '/.well-known/openid-configuration') return json({ issuer: origin,
      authorization_endpoint: `${origin}/oidc/authorize`, token_endpoint: `${origin}/oidc/token`, jwks_uri: `${origin}/oidc/jwks`,
      revocation_endpoint: `${origin}/oidc/revoke`, response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'], grant_types_supported: ['authorization_code', 'refresh_token'] });
    if (request.method === 'GET' && path === '/oidc/jwks') return json(signer.jwks);
    if (request.method === 'GET' && path === '/oidc/authorize') {
      const device = store.data.devices[url.searchParams.get('client_id')];
      const callback = device && `${device.publicUrl || `https://${device.hostname}`}/auth/callback`;
      if (!device || device.revoked || url.searchParams.get('redirect_uri') !== callback || url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') || '') ||
          !url.searchParams.get('scope')?.split(' ').includes('openid')) throw new HTTPError(400, 'Invalid workspace sign-in request.');
      const auth = signedIn(request, path + url.search);
      if (auth instanceof Response) return auth;
      if (device.user !== auth.user) throw new HTTPError(403, 'This workspace belongs to another account.');
      const code = secret();
      store.data.codes[hash(code)] = { device: device.id, user: auth.user, redirect: callback,
        challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce'), expires: seconds() + 60 };
      store.save();
      const target = new URL(callback); target.searchParams.set('code', code);
      if (url.searchParams.has('state')) target.searchParams.set('state', url.searchParams.get('state'));
      return redirect(target.toString());
    }
    if (request.method === 'POST' && path === '/oidc/token') {
      rate(`oidc:${clientIP}`, 120);
      const body = await readBody(request), device = store.data.devices[body.client_id];
      if (!device || device.revoked) throw new HTTPError(400, 'Invalid client.', 'invalid_client');
      if (body.grant_type === 'refresh_token') {
        const key = hash(String(body.refresh_token || '')), grant = store.data.refresh[key];
        if (!grant || grant.device !== device.id || grant.expires < seconds()) throw new HTTPError(400, 'Invalid refresh token.', 'invalid_grant');
        delete store.data.refresh[key]; store.save();
        return json(tokens(store.data.users[grant.user], device));
      }
      const key = hash(String(body.code || '')), grant = store.data.codes[key];
      if (body.grant_type !== 'authorization_code' || !grant || grant.device !== device.id || grant.redirect !== body.redirect_uri ||
          grant.expires < seconds() || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || '') ||
          createHash('sha256').update(body.code_verifier).digest('base64url') !== grant.challenge) throw new HTTPError(400, 'Invalid authorization code.', 'invalid_grant');
      delete store.data.codes[key]; store.save();
      return json(tokens(store.data.users[grant.user], device, grant.nonce));
    }
    if (request.method === 'POST' && path === '/oidc/revoke') {
      const body = await readBody(request), key = hash(String(body.token || ''));
      if (store.data.refresh[key]?.device === body.client_id) delete store.data.refresh[key];
      store.save(); return json({});
    }
    throw new HTTPError(404, 'Page not found.');
  }

  return {
    authorizeDevice(request, device) {
      // Path-mounted laptops share the account service's browser origin. Gate
      // every response before proxying so another owner's laptop cannot serve
      // scripts under a visitor's account origin, even before Hermes sign-in.
      const auth = session(request);
      if (!auth) {
        if (request.method !== 'GET') return json({ error: 'authentication_required' }, 401);
        const url = new URL(request.url);
        return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      if (device.revoked || auth.user !== device.user) return json({ error: 'workspace_forbidden' }, 403);
      return null;
    },
    async fetch(request, clientIP = 'local') {
      try { return await route(request, clientIP); }
      catch (error) {
        // Never return provider bodies, API credentials, auth codes or stacks.
        if (error instanceof HTTPError) return json({ error: error.code, message: error.message }, error.status);
        return json({ error: 'internal_error', message: 'The service could not complete this request.' }, 500);
      }
    },
  };
}
