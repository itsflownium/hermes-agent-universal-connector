import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function remoteDevice(request, store) {
  const path = new URL(request.url, 'http://localhost').pathname;
  const match = /^\/remote\/([a-f0-9-]{36})(?:\/|$)/.exec(path);
  const host = (request.headers.host || '').split(':')[0].toLowerCase();
  const device = match ? store.data.devices[match[1]] : Object.values(store.data.devices).find(d => d.hostname === host && !d.publicUrl?.includes('/remote/'));
  return device && !device.revoked && device.transport === 'iroh' ? { device, prefix: match ? `/remote/${device.id}` : '' } : null;
}

export class IrohGateway {
  constructor({ binary = 'dumbpipe', keyFile, origin }) {
    Object.assign(this, { binary, origin });
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    this.key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : randomBytes(32).toString('hex');
    if (!existsSync(keyFile)) writeFileSync(keyFile, this.key, { mode: 0o600 });
    this.connectors = new Map();
  }
  async connect(device) {
    if (!/^(?:node|endpoint)[a-z2-7]{40,4096}$/.test(device.irohTicket || '')) throw new Error('Laptop has not advertised an Iroh endpoint.');
    const existing = this.connectors.get(device.id);
    if (existing?.ticket === device.irohTicket) return existing.promise;
    if (existing) existing.child?.kill('SIGTERM');
    if (this.connectors.size >= 32 && !existing) throw new Error('Gateway connector capacity reached.');
    const entry = { ticket: device.irohTicket, child: null };
    entry.promise = (async () => {
      const port = await new Promise((done, reject) => {
        const probe = net.createServer(); probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => done(p)); });
      });
      const child = spawn(this.binary, ['connect-tcp', '--addr', `127.0.0.1:${port}`, device.irohTicket],
        { env: { ...process.env, IROH_SECRET: this.key }, stdio: ['ignore', 'ignore', 'ignore'] });
      entry.child = child;
      let failed = false;
      child.once('error', () => { failed = true; });
      child.once('exit', () => { failed = true; if (this.connectors.get(device.id) === entry) this.connectors.delete(device.id); });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !failed) {
        const ready = await new Promise(done => {
          const probe = net.connect({ host: '127.0.0.1', port });
          probe.once('connect', () => { probe.destroy(); done(true); });
          probe.once('error', () => done(false));
        });
        if (ready) return port;
        await new Promise(done => setTimeout(done, 100));
      }
      child.kill('SIGTERM');
      throw new Error('Iroh connector is unavailable.');
    })();
    this.connectors.set(device.id, entry);
    try { return await entry.promise; }
    catch (error) { if (this.connectors.get(device.id) === entry) this.connectors.delete(device.id); throw error; }
  }
  options(request, port, { device, prefix }) {
    const target = new URL(device.publicUrl);
    const headers = { ...request.headers, host: target.host, 'x-forwarded-host': target.host,
      'x-forwarded-proto': new URL(this.origin).protocol.slice(0, -1), 'x-forwarded-for': request.socket.remoteAddress };
    if (prefix) headers['x-forwarded-prefix'] = prefix;
    else delete headers['x-forwarded-prefix'];
    if (headers.cookie) headers.cookie = headers.cookie.split(';').filter(c => !/^(?:__Host-)?flownium(?:-oauth)?=/.test(c.trim())).join(';');
    return { host: '127.0.0.1', port, method: request.method, path: (device.pathPrefix || '') + (request.url.slice(prefix.length) || '/'), headers };
  }
  async handle(request, response, route) {
    try {
      const port = await this.connect(route.device);
      if (route.device.revoked) throw new Error('Laptop was revoked.');
      const proxy = http.request(this.options(request, port, route), upstream => {
        const headers = { ...upstream.headers };
        const scoped = path => path === route.prefix || path.startsWith(route.prefix + '/');
        if (headers['set-cookie'] && route.prefix) headers['set-cookie'] = headers['set-cookie'].map(c =>
          c.replace(/;\s*Path=(\/[^;]*)/i, (attribute, path) => scoped(path) ? attribute : `; Path=${route.prefix}${path}`));
        if (headers.location?.startsWith('/') && !headers.location.startsWith('//') && route.prefix &&
            !scoped(headers.location.split(/[?#]/, 1)[0])) headers.location = route.prefix + headers.location;
        response.writeHead(upstream.statusCode, headers);
        upstream.pipe(response);
      });
      proxy.on('error', () => {
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(502, { 'Content-Type': 'application/json' }); response.end('{"error":"laptop_unavailable"}');
      });
      request.on('aborted', () => proxy.destroy());
      response.on('close', () => proxy.destroy());
      request.pipe(proxy);
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"error":"laptop_unavailable"}');
    }
  }
  async upgrade(request, socket, head, route) {
    try {
      const port = await this.connect(route.device);
      if (route.device.revoked) throw new Error('Laptop was revoked.');
      const proxy = http.request(this.options(request, port, route));
      proxy.once('upgrade', (response, upstream, upstreamHead) => {
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
          Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
        socket.once('close', () => upstream.destroy());
        upstream.once('close', () => socket.destroy());
      });
      proxy.once('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
      proxy.once('error', () => socket.destroy()); proxy.end();
    } catch { socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'); }
  }
  disconnect(id) { this.connectors.get(id)?.child?.kill('SIGTERM'); this.connectors.delete(id); }
  close() { for (const id of this.connectors.keys()) this.disconnect(id); }
}
