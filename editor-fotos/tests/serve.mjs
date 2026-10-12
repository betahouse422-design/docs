// Servidor estático mínimo para desarrollo y pruebas. Uso: node tests/serve.mjs [puerto]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

export function startServer(port = 0, host = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('prohibido'); }
      const st = await stat(file);
      if (!st.isFile()) throw new Error('no es archivo');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('no encontrado'); }
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ server, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // node tests/serve.mjs 8080          -> solo esta computadora (localhost)
  // node tests/serve.mjs 8080 --lan    -> también otros aparatos de la misma red Wi-Fi (el teléfono)
  const lan = process.argv.includes('--lan');
  const { port } = await startServer(Number(process.argv.find((a) => /^\d+$/.test(a))) || 8080, lan ? '0.0.0.0' : '127.0.0.1');
  console.log(`En esta computadora:  http://localhost:${port}/`);
  if (lan) {
    const { networkInterfaces } = await import('node:os');
    const ips = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
    if (ips.length) for (const ip of ips) console.log(`En tu teléfono (mismo Wi-Fi):  http://${ip}:${port}/`);
    else console.log('No encontré una red Wi-Fi activa.');
    console.log('Cualquier aparato de tu red puede abrir esa dirección mientras esto esté en marcha. Ciérralo (Ctrl+C) al terminar.');
  }
}
