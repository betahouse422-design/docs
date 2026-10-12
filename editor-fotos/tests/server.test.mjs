// Pruebas del servidor local y del buzón (seguridad incluida). Uso: node --test tests/server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, isLocalRequest, safeUploadName, prettyCode, PHOTO_EXT } from '../tools/servidor.mjs';

const REMOTE = { 'x-forwarded-for': '203.0.113.9' }; // así se ve una petición que llega por un túnel
const mk = async (extra = {}) => {
  const inbox = mkdtempSync(join(tmpdir(), 'buzon-'));
  const srv = await startServer(0, '127.0.0.1', { inbox, code: 'ABCD2345', maxUpload: 1000, ...extra });
  return { ...srv, inbox, url: `http://127.0.0.1:${srv.port}` };
};
const up = (s, name, body, headers = {}) => fetch(`${s.url}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers });

test('isLocalRequest: solo cuenta lo que viene de esta computadora sin pasar por un túnel', () => {
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(isLocalRequest(req('127.0.0.1')), true); assert.equal(isLocalRequest(req('::1')), true); assert.equal(isLocalRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(isLocalRequest(req('192.168.1.40')), false, 'otro aparato de la red');
  for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'forwarded', 'x-forwarded-host']) assert.equal(isLocalRequest(req('127.0.0.1', { [h]: 'x' })), false, `túnel (${h})`);
});

test('nombres de subida: sin rutas, sin trucos, solo fotos, sin pisar archivos', () => {
  const none = () => false;
  assert.equal(safeUploadName('DSC001.JPG', none), 'DSC001.JPG');
  assert.equal(safeUploadName('../../etc/passwd.jpg', none), 'passwd.jpg');
  assert.equal(safeUploadName('C:\\fotos\\plato ñandú.png', none), 'plato_nandu.png');
  assert.equal(safeUploadName('.oculta.jpg', none), 'oculta.jpg');
  for (const bad of ['virus.exe', 'x.jpg.exe', 'foto', '', 'script.js', 'a.html', 'foto.jpg.', null, undefined]) assert.equal(safeUploadName(bad, none), null, String(bad));
  const taken = new Set(['a.jpg']);
  const n = safeUploadName('a.jpg', (x) => taken.has(x), new Date(2026, 0, 1, 10, 20, 30));
  assert.equal(n, 'a-102030.jpg');
  assert.ok(PHOTO_EXT.test('x.CR3') && PHOTO_EXT.test('x.dng') && !PHOTO_EXT.test('x.pdf'));
  assert.equal(prettyCode('ABCD2345'), 'ABCD-2345');
});

test('subir desde fuera exige el código; acepta guion y minúsculas; guarda el archivo completo', async () => {
  const s = await mk();
  try {
    const bytes = Buffer.from('contenido-de-foto-123');
    assert.equal((await up(s, 'a.jpg', bytes, REMOTE)).status, 403, 'sin código');
    assert.equal((await up(s, 'a.jpg', bytes, { ...REMOTE, 'x-code': 'ZZZZ-9999' })).status, 403, 'código equivocado');
    const ok = await up(s, 'a.jpg', bytes, { ...REMOTE, 'x-code': 'abcd-2345' });
    assert.equal(ok.status, 200); const j = await ok.json(); assert.deepEqual([j.ok, j.name, j.size], [true, 'a.jpg', bytes.length]);
    assert.equal(readFileSync(join(s.inbox, 'a.jpg')).equals(bytes), true);
    assert.deepEqual(readdirSync(s.inbox).filter((f) => f.endsWith('.subiendo')), [], 'no quedan temporales');
    // el mismo nombre otra vez no pisa el anterior
    const again = await (await up(s, 'a.jpg', Buffer.from('otra'), { ...REMOTE, 'x-code': 'ABCD2345' })).json();
    assert.notEqual(again.name, 'a.jpg'); assert.equal(readFileSync(join(s.inbox, 'a.jpg')).equals(bytes), true);
    // desde esta misma computadora no hace falta código
    assert.equal((await up(s, 'local.jpg', Buffer.from('x'))).status, 200);
  } finally { s.server.close(); }
});

test('subida: rechaza lo que no es foto, lo vacío y lo demasiado grande; los nombres con rutas quedan dentro del buzón', async () => {
  const s = await mk();
  const h = { ...REMOTE, 'x-code': 'ABCD2345' };
  try {
    assert.equal((await up(s, 'virus.exe', Buffer.from('MZ'), h)).status, 415);
    assert.equal((await up(s, 'a.jpg.exe', Buffer.from('MZ'), h)).status, 415);
    assert.equal((await up(s, 'a.jpg', Buffer.alloc(0), h)).status, 400, 'vacía');
    assert.equal((await up(s, 'grande.jpg', Buffer.alloc(1500), h)).status, 413, 'más de lo permitido (en la prueba, 1000 bytes)');
    assert.equal(existsSync(join(s.inbox, 'grande.jpg')), false);
    assert.deepEqual(readdirSync(s.inbox).filter((f) => f.includes('subiendo')), [], 'sin temporales tras el rechazo');
    const r = await (await up(s, '../../../tmp/mala.jpg', Buffer.from('x'), h)).json();
    assert.equal(r.name, 'mala.jpg'); assert.equal(existsSync(join(s.inbox, 'mala.jpg')), true);
    assert.equal(existsSync('/tmp/mala.jpg'), false);
  } finally { s.server.close(); }
});

test('leer el buzón solo se puede desde esta computadora, nunca por un túnel ni la red', async () => {
  const s = await mk();
  try {
    await up(s, 'foto1.jpg', Buffer.from('uno'));
    assert.equal((await fetch(`${s.url}/api/inbox`, { headers: REMOTE })).status, 403);
    assert.equal((await fetch(`${s.url}/api/info`, { headers: REMOTE })).status, 403, 'ni el código se ve desde fuera');
    assert.equal((await fetch(`${s.url}/api/inbox/file/foto1.jpg`, { headers: REMOTE })).status, 403);
    assert.equal((await fetch(`${s.url}/api/inbox`, { headers: { ...REMOTE, 'x-code': 'ABCD2345' } })).status, 403, 'tener el código no da permiso de lectura');
    const list = await (await fetch(`${s.url}/api/inbox`)).json();
    assert.deepEqual(list.map((e) => e.name), ['foto1.jpg']); assert.equal(list[0].size, 3);
    const info = await (await fetch(`${s.url}/api/info`)).json(); assert.equal(info.code, 'ABCD-2345');
    assert.equal(Buffer.from(await (await fetch(`${s.url}/api/inbox/file/foto1.jpg`)).arrayBuffer()).toString(), 'uno');
    // ni el archivo del código ni nada fuera del buzón
    assert.equal((await fetch(`${s.url}/api/inbox/file/.codigo`)).status, 404);
    assert.equal((await fetch(`${s.url}/api/inbox/file/..%2F..%2Fpackage.json`)).status, 404);
    assert.deepEqual((await (await fetch(`${s.url}/api/inbox`)).json()).map((e) => e.name), ['foto1.jpg'], '.codigo no se lista');
  } finally { s.server.close(); }
});

test('demasiados códigos equivocados desde la misma dirección: se bloquea un rato', async () => {
  const s = await mk();
  try {
    let last = 0;
    for (let i = 0; i < 17; i++) last = (await up(s, 'a.jpg', Buffer.from('x'), { ...REMOTE, 'x-code': `MALO${i}` })).status;
    assert.equal(last, 429);
    assert.equal((await up(s, 'a.jpg', Buffer.from('x'), { ...REMOTE, 'x-code': 'ABCD2345' })).status, 429, 'bloqueado aunque ahora acierte');
    assert.equal((await up(s, 'a.jpg', Buffer.from('x'), { 'x-forwarded-for': '198.51.100.7', 'x-code': 'ABCD2345' })).status, 200, 'otra dirección no se ve afectada');
  } finally { s.server.close(); }
});

test('el código se conserva entre reinicios y se genera uno legible si no hay', async () => {
  const inbox = mkdtempSync(join(tmpdir(), 'buzon-'));
  const a = await startServer(0, '127.0.0.1', { inbox }); a.server.close();
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'sin 0, O, 1, I, L');
  const b = await startServer(0, '127.0.0.1', { inbox }); b.server.close();
  assert.equal(b.code, a.code, 'mismo código tras reiniciar');
  const c = await startServer(0, '127.0.0.1', { inbox, code: 'QQQQ-2222' }); c.server.close();
  assert.equal(c.code, 'QQQQ-2222');
});

test('modo normal: solo se sirven los archivos de la app y la página de envío', async () => {
  const s = await mk({ restrict: true });
  try {
    for (const ok of ['/', '/index.html', '/enviar', '/src/main.js', '/styles.css', '/vendor/libraw-wasm/index.js']) assert.equal((await fetch(s.url + ok)).status, 200, ok);
    for (const no of ['/tests/serve.mjs', '/tests/harness.html', '/docs/INSTALACION.md', '/package.json', '/tools/servidor.mjs', '/README.md', '/.gitignore', '/node_modules/x', '/../package.json', '/%2e%2e/package.json']) assert.notEqual((await fetch(s.url + no)).status, 200, no);
    assert.match(await (await fetch(`${s.url}/enviar`)).text(), /Enviar foto a la computadora/);
  } finally { s.server.close(); }
});

test('sin buzón configurado no hay API (los tests de la app usan el servidor sin buzón)', async () => {
  const s = await startServer(0); // sin opciones
  try { assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/info`)).status, 404); assert.equal((await fetch(`http://127.0.0.1:${s.port}/tests/harness.html`)).status, 200); } finally { s.server.close(); }
});
