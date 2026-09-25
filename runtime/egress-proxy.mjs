import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { chmod } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// This policy is baked into the trusted image, never loaded from a task checkout.
// CONNECT limits destinations, not encrypted application content or GitHub actions.
export const ALLOWED_HOSTS = Object.freeze([
  'chatgpt.com', 'auth.openai.com', 'api.openai.com', 'api.github.com', 'github.com',
]);
const allowedHosts = new Set(ALLOWED_HOSTS);
const blockedRanges = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const ipv4Number = (address) => address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);

// IPv4-only deliberately rejects IPv6, IPv4-mapped IPv6, alternate literal forms,
// private, link-local, documentation, multicast and reserved address ranges.
export function isPublicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const value = ipv4Number(address);
  return !blockedRanges.some(([prefix, bits]) =>
    Math.floor(value / 2 ** (32 - bits)) === Math.floor(ipv4Number(prefix) / 2 ** (32 - bits)));
}

export function allowedAuthority(authority) {
  const match = /^([a-z0-9.-]+):443$/i.exec(authority ?? '');
  const host = match?.[1].toLowerCase();
  return allowedHosts.has(host) ? host : null;
}

function refuse(socket, status) {
  if (!socket.destroyed && !socket.writableEnded) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }
}

async function deadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Dependencies are injectable for offline adversarial tests; production uses only
// the fixed defaults below. The launcher never supplies executable configuration.
export function createProxy({ resolve = lookup, connect = net.createConnection,
  connectionTimeoutMs = 10_000, idleTimeoutMs = 600_000 } = {}) {
  const server = http.createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => refuse(socket, '405 Method Not Allowed'));
  server.on('connect', async (request, client, head) => {
    client.pause();
    let upstream;
    let established = false;
    client.on('error', () => upstream?.destroy());
    client.on('close', () => upstream?.destroy());
    const host = allowedAuthority(request.url);
    if (!host || request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined) {
      refuse(client, '403 Forbidden');
      return;
    }
    try {
      const answers = await deadline(resolve(host, { family: 4, all: true }), connectionTimeoutMs);
      if (!Array.isArray(answers) || answers.length === 0 ||
          answers.some(({ address, family }) => family !== 4 || !isPublicIPv4(address))) {
        refuse(client, '403 Forbidden');
        return;
      }
      if (client.destroyed) return;
      // Connect to this numeric address, never resolve the hostname a second time.
      upstream = connect({ host: answers[0].address, family: 4, port: 443 });
      upstream.on('error', () => {
        if (established) client.destroy();
        else refuse(client, '502 Bad Gateway');
      });
      upstream.on('close', () => {
        if (established) client.end();
        else refuse(client, '502 Bad Gateway');
      });
      upstream.setTimeout(connectionTimeoutMs, () => upstream.destroy(new Error('timeout')));
      upstream.once('connect', () => {
        if (client.destroyed) return upstream.destroy();
        established = true;
        upstream.setTimeout(idleTimeoutMs);
        client.setTimeout(idleTimeoutMs, () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    } catch {
      refuse(client, '502 Bad Gateway');
      upstream?.destroy();
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o007);
  const server = createProxy();
  server.on('error', () => { process.stderr.write('Egress proxy failed to start.\n'); process.exitCode = 1; });
  server.listen('/proxy/egress.sock', async () => {
    try {
      await chmod('/proxy/egress.sock', 0o660);
      process.stdout.write('Egress proxy ready.\n');
    } catch {
      server.close();
      process.exitCode = 1;
    }
  });
}
