import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createProxy, allowedAuthority, isPublicIPv4 } from '../runtime/egress-proxy.mjs';
import { startRelay } from '../runtime/proxy-relay.mjs';
import { PassThrough } from 'node:stream';

const publicAnswer = [{ address: '1.1.1.1', family: 4 }];

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

async function exchange(port, request, until = '\r\n\r\n') {
  const client = net.createConnection({ host: '127.0.0.1', port });
  const chunks = [];
  client.setTimeout(2000, () => client.destroy(new Error('test socket timed out')));
  return await new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('connect', () => client.write(request));
    client.on('data', (chunk) => {
      chunks.push(chunk);
      const result = Buffer.concat(chunks).toString();
      if (result.includes(until)) { client.destroy(); resolve(result); }
    });
    client.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

test('only exact trusted host authorities on port 443 are admitted', () => {
  assert.equal(allowedAuthority('API.GITHUB.COM:443'), 'api.github.com');
  for (const authority of ['localhost:443', '127.0.0.1:443', '[::1]:443', 'host.docker.internal:443',
    'api.github.com:80', 'api.github.com:0443', 'api.github.com', 'api.github.com.:443',
    'evil.api.github.com:443', 'api.github.com.evil.test:443', 'api.github.com@evil.test:443',
    'https://api.github.com:443', 'api.github.com:443/path', 'api.github.com:443\n']) {
    assert.equal(allowedAuthority(authority), null, authority);
  }
});

test('public-only IPv4 policy rejects every protected address category and alternate forms', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '140.82.112.4']) assert.equal(isPublicIPv4(address), true);
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1',
    '::ffff:8.8.8.8', '2001:4860:4860::8888', '2130706433', '0177.0.0.1', '127.1', '0x7f000001']) {
    assert.equal(isPublicIPv4(address), false, address);
  }
});

test('untrusted destinations and ordinary HTTP cannot trigger DNS or upstream connection', async (t) => {
  const proxy = createProxy({ resolve: () => assert.fail('DNS must not run'), connect: () => assert.fail('connect must not run') });
  const port = await listen(t, proxy);
  assert.match(await exchange(port, 'CONNECT host.docker.internal:443 HTTP/1.1\r\nHost: host.docker.internal:443\r\n\r\n'), /^HTTP\/1.1 403/);
  assert.match(await exchange(port, 'GET https://api.github.com/ HTTP/1.1\r\nHost: api.github.com\r\n\r\n'), /^HTTP\/1.1 405/);
  assert.match(await exchange(port, 'GET / HTTP/1.1\r\nHost: api.github.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'), /^HTTP\/1.1 405/);
  assert.match(await exchange(port, 'CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: 1\r\n\r\nx'), /^HTTP\/1.1 403/);
});

test('DNS private, mapped, empty, and mixed public/private answers fail closed', async (t) => {
  for (const answers of [[{ address: '127.0.0.1', family: 4 }], [{ address: '::ffff:1.1.1.1', family: 6 }],
    [], [...publicAnswer, { address: '10.0.0.1', family: 4 }]]) {
    const proxy = createProxy({ resolve: async () => answers, connect: () => assert.fail('connect must not run') });
    const port = await listen(t, proxy);
    assert.match(await exchange(port, 'CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com\r\n\r\n'), /^HTTP\/1.1 403/);
  }
});

test('DNS failure and timeout return a closed failure response', async (t) => {
  for (const resolve of [async () => { throw new Error('DNS failed'); }, () => new Promise(() => {})]) {
    const port = await listen(t, createProxy({ resolve, connectionTimeoutMs: 20 }));
    assert.match(await exchange(port, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com\r\n\r\n'), /^HTTP\/1.1 502/);
  }
});

test('valid CONNECT forwards bytes to the validated numeric address without another DNS lookup', async (t) => {
  const upstreamPort = await listen(t, net.createServer((socket) => socket.pipe(socket)));
  let resolutions = 0;
  const proxy = createProxy({
    resolve: async (host, options) => { resolutions++; assert.equal(host, 'api.github.com'); assert.deepEqual(options, { family: 4, all: true }); return publicAnswer; },
    connect: (options) => { assert.deepEqual(options, { host: '1.1.1.1', family: 4, port: 443 }); return net.createConnection({ host: '127.0.0.1', port: upstreamPort }); },
  });
  const port = await listen(t, proxy);
  const reply = await exchange(port, 'CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com\r\n\r\nopaque-tunnel-bytes', 'opaque-tunnel-bytes');
  assert.equal(reply, 'HTTP/1.1 200 Connection Established\r\n\r\nopaque-tunnel-bytes');
  assert.equal(resolutions, 1);
});

test('an upstream failure before connection returns 502, never a successful tunnel', async (t) => {
  const proxy = createProxy({ resolve: async () => publicAnswer, connect: () => {
    const stream = new PassThrough();
    stream.setTimeout = () => {};
    queueMicrotask(() => stream.destroy(new Error('connection failed')));
    return stream;
  } });
  const port = await listen(t, proxy);
  assert.match(await exchange(port, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com\r\n\r\n'), /^HTTP\/1.1 502/);
});

test('loopback relay forwards only to its configured local socket', async (t) => {
  // A Windows named pipe exercises the same Node local-socket API as Unix in CI.
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\factory-proxy-test-${process.pid}` : `/tmp/factory-proxy-test-${process.pid}.sock`;
  const upstream = net.createServer((socket) => socket.pipe(socket));
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.listen(socketPath);
  await once(upstream, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => upstream.close(resolve)); });
  const relay = await startRelay({ socketPath, port: 0 });
  t.after(() => new Promise(resolve => relay.close(resolve)));
  assert.equal(relay.address().address, '127.0.0.1');
  assert.equal(await exchange(relay.address().port, 'relay-echo', 'relay-echo'), 'relay-echo');
});
