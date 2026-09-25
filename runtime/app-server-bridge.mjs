// Consume one bounded credentials line and leave every subsequent byte intact.
export function readBootstrap(input, { maxBytes = 65536, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer); input.off('data', data); input.off('end', end); input.off('error', error);
    };
    const fail = () => { cleanup(); input.pause(); buffer = Buffer.alloc(0); reject(new Error('Invalid credential bootstrap.')); };
    const end = () => fail();
    const error = () => fail();
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = bytes.indexOf(10);
      const length = newline < 0 ? bytes.length : newline;
      if (buffer.length + length > maxBytes) return fail();
      buffer = Buffer.concat([buffer, bytes.subarray(0, length)]);
      if (newline < 0) return;
      input.pause(); cleanup();
      let credentials;
      try { credentials = JSON.parse(buffer.toString('utf8')); }
      catch { return fail(); }
      buffer = Buffer.alloc(0);
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return fail();
      if (newline + 1 < bytes.length) input.unshift(bytes.subarray(newline + 1));
      resolve(credentials);
    };
    const timer = setTimeout(fail, timeoutMs);
    input.on('data', data); input.once('end', end); input.once('error', error);
    if (input.readableEnded || input.destroyed) fail();
  });
}
