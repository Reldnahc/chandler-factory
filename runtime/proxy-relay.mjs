import net from 'node:net';
import { pathToFileURL } from 'node:url';

// A network-none role has only loopback. This relay reaches the one mounted Unix
// socket; all destination authorization happens in the separate trusted proxy.
export async function startRelay({ socketPath = '/proxy/egress.sock', port = 3128 } = {}) {
  const server = net.createServer((client) => {
    const upstream = net.createConnection(socketPath);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.end());
    client.setTimeout(600_000, () => client.destroy());
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.once('connect', () => upstream.setTimeout(600_000));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 64;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startRelay();
}
