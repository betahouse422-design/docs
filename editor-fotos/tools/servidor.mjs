// Servidor local del editor: sirve la app y un "buzón" donde el teléfono (u otro aparato) sube fotos.
//
//   node tests/serve.mjs 8080                 solo esta computadora
//   node tests/serve.mjs 8080 --lan           también el Wi-Fi de la casa
//   node tests/serve.mjs 8080 --buzon=/ruta   carpeta del buzón (por defecto ./buzon)
//
// Seguridad (el servidor puede quedar expuesto con un túnel público):
//  - Subir fotos desde fuera exige un CÓDIGO; sin él se rechaza. Hay límite de intentos fallidos.
//  - LEER el buzón (listar y bajar fotos) solo se permite desde esta misma computadora, nunca a través de un túnel
//    ni desde la red.
//  - En modo normal solo se sirven los archivos de la app; no tests, docs, herramientas ni la carpeta del buzón.
import http from 'node:http';
import { readFile, stat, readdir, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, timingSafeEqual } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

// En modo normal solo estos caminos son públicos.
const PUBLIC_PATHS = /^\/(index\.html|enviar|styles\.css|manifest\.webmanifest|sw\.js|icons\/|src\/|vendor\/|presets\/)/;

// Extensiones que el buzón acepta (fotos y RAW). Todo lo demás se rechaza.
export const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp|arw|sr2|srf|cr2|cr3|crw|nef|nrw|dng|raf|orf|rw2|rwl|pef|srw|3fr|fff|erf|kdc|dcr|mrw|iiq|mef|mos|x3f)$/i;
export const MAX_UPLOAD = 120 * 1024 * 1024; // 120 MB (un RAW grande cabe)

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L: fácil de teclear
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
export const prettyCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ¿La petición viene de esta misma computadora, sin pasar por un túnel ni por la red?
export function isLocalRequest(req) {
  const a = req.socket.remoteAddress || '';
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const proxied = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-proto']
    .some((h) => req.headers[h] !== undefined);
  return loop && !proxied;
}

// Nombre de archivo seguro: sin rutas, sin caracteres raros, y sin pisar uno existente.
export function safeUploadName(raw, exists = () => false, now = new Date()) {
  let n = basename(String(raw || '').replace(/\\/g, '/')).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80);
  if (!n) n = 'foto';
  if (!PHOTO_EXT.test(n)) return null;
  if (!exists(n)) return n;
  const dot = n.lastIndexOf('.'); const stem = n.slice(0, dot); const ext = n.slice(dot);
  const stamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  for (let i = 0; i < 1000; i++) { const c = `${stem}-${stamp}${i ? '-' + i : ''}${ext}`; if (!exists(c)) return c; }
  return null;
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

// opts: { inbox: carpeta del buzón (si falta, no hay API), code, restrict: solo archivos de la app, maxUpload: bytes }
export async function startServer(port = 0, host = '127.0.0.1', opts = {}) {
  const inbox = opts.inbox ? resolve(opts.inbox) : null;
  const maxUpload = opts.maxUpload || MAX_UPLOAD;
  let code = '';
  if (inbox) {
    await mkdir(inbox, { recursive: true });
    const f = join(inbox, '.codigo');
    code = normCode(opts.code) || (existsSync(f) ? normCode(await readFile(f, 'utf8')) : '');
    if (code.length < 6) { code = newCode(); await writeFile(f, code + '\n'); }
  }
  const fails = new Map(); // ip -> { n, since }: límite de intentos con código equivocado
  const tooMany = (ip) => { const e = fails.get(ip); return e && Date.now() - e.since < 600000 && e.n >= 15; };
  const fail = (ip) => { const e = fails.get(ip); if (!e || Date.now() - e.since > 600000) fails.set(ip, { n: 1, since: Date.now() }); else e.n++; };
  const codeOk = (given) => { const a = Buffer.from(normCode(given)); const b = Buffer.from(code); return a.length === b.length && a.length > 0 && timingSafeEqual(a, b); };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();

      // ---------- API del buzón ----------
      if (inbox && p.startsWith('/api/')) {
        if (p === '/api/upload' && req.method === 'POST') {
          if (!isLocalRequest(req)) {
            if (tooMany(ip)) return json(res, 429, { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
            if (!codeOk(req.headers['x-code'] || url.searchParams.get('code'))) { fail(ip); return json(res, 403, { ok: false, error: 'Código incorrecto.' }); }
          }
          const len = Number(req.headers['content-length'] || 0);
          if (len > maxUpload) return json(res, 413, { ok: false, error: 'La foto es demasiado grande (máximo 120 MB).' });
          const name = safeUploadName(url.searchParams.get('name'), (n) => existsSync(join(inbox, n)));
          if (!name) return json(res, 415, { ok: false, error: 'Ese tipo de archivo no es una foto.' });
          const tmp = join(inbox, `.${name}.subiendo`); const dest = join(inbox, name);
          let size = 0; let tooBig = false;
          try {
            const out = createWriteStream(tmp);
            req.on('data', (c) => { size += c.length; if (size > maxUpload && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); } });
            req.pipe(out);
            await new Promise((ok, bad) => { out.on('finish', ok); out.on('error', bad); req.on('error', bad); req.on('aborted', () => bad(new Error('cortado'))); req.on('end', () => { if (tooBig) bad(new Error('grande')); }); });
          } catch (err) {
            await rm(tmp, { force: true });
            return json(res, tooBig ? 413 : 400, { ok: false, error: tooBig ? 'La foto es demasiado grande (máximo 120 MB).' : 'La subida se cortó. Intenta de nuevo.' });
          }
          if (size === 0) { await rm(tmp, { force: true }); return json(res, 400, { ok: false, error: 'La foto llegó vacía.' }); }
          await rename(tmp, dest); // el archivo aparece completo de golpe: el vigilante nunca ve uno a medias
          return json(res, 200, { ok: true, name, size });
        }
        if (!isLocalRequest(req)) return json(res, 403, { ok: false, error: 'Solo desde la computadora del buzón.' });
        if (p === '/api/info') return json(res, 200, { ok: true, code: prettyCode(code), inbox, max: MAX_UPLOAD });
        if (p === '/api/inbox') {
          const out = [];
          for (const n of await readdir(inbox)) {
            if (n.startsWith('.') || !PHOTO_EXT.test(n)) continue;
            const st = await stat(join(inbox, n)); if (st.isFile()) out.push({ name: n, size: st.size, mtime: Math.round(st.mtimeMs) });
          }
          return json(res, 200, out);
        }
        if (p.startsWith('/api/inbox/file/')) {
          const n = basename(decodeURIComponent(p.slice('/api/inbox/file/'.length)));
          if (n.startsWith('.') || !PHOTO_EXT.test(n)) return json(res, 404, { ok: false });
          const data = await readFile(join(inbox, n));
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
          return res.end(data);
        }
        return json(res, 404, { ok: false });
      }

      // ---------- archivos estáticos ----------
      if (p === '/enviar') p = '/enviar.html';
      if (p.endsWith('/')) p += 'index.html';
      if (opts.restrict && !PUBLIC_PATHS.test(p)) { res.writeHead(404); return res.end('no encontrado'); }
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('prohibido'); }
      if (inbox && file.startsWith(inbox)) { res.writeHead(404); return res.end('no encontrado'); }
      const st = await stat(file);
      if (!st.isFile()) throw new Error('no es archivo');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch { /* ya cerrada */ } return; }
      res.writeHead(404); res.end('no encontrado');
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ server, port: server.address().port, code: prettyCode(code), inbox })));
}

export async function cli(argv) {
  const lan = argv.includes('--lan');
  const buzonArg = argv.find((a) => a.startsWith('--buzon='));
  const inbox = buzonArg ? buzonArg.slice('--buzon='.length) : join(ROOT, 'buzon');
  const portArg = Number(argv.find((a) => /^\d+$/.test(a))) || 8080;
  const { port, code } = await startServer(portArg, lan ? '0.0.0.0' : '127.0.0.1', { inbox, restrict: true });
  console.log(`En esta computadora:  http://localhost:${port}/`);
  if (lan) {
    const { networkInterfaces } = await import('node:os');
    const ips = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
    if (ips.length) for (const ip of ips) console.log(`En tu teléfono (mismo Wi-Fi):  http://${ip}:${port}/`);
    else console.log('No encontré una red Wi-Fi activa.');
    console.log('Cualquier aparato de tu red puede abrir esa dirección mientras esto esté en marcha. Ciérralo (Ctrl+C) al terminar.');
  }
  console.log(`\nBuzón de fotos: ${inbox}`);
  console.log(`Código para enviar fotos desde el teléfono:  ${code}`);
  console.log(`Página de envío (en el teléfono): <dirección del túnel o de la red>/enviar`);
}
