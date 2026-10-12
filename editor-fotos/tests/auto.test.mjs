// Flujo automático: una carpeta de cámara (simulada con el sistema de archivos privado del navegador, que usa la
// misma API que una carpeta real) -> preset -> marco -> carpeta de salida / impresora / aprobación.
// Uso: node tests/auto.test.mjs [carpeta-para-capturas]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';
import { startServer as startInboxServer } from '../tools/servidor.mjs';
import { makeDng, patchesColor } from './make-dng.mjs';
import { extractIccFromJpeg, readIccHeader } from '../src/icc.js';

const shotsDir = process.argv[2];
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find(existsSync);
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const errors = [];

async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html?nosw`);
  await page.waitForFunction(() => window.__appReady === true);
  // dos carpetas "reales": la de la cámara y la de salida
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const n of ['cam', 'salida']) { try { await root.removeEntry(n, { recursive: true }); } catch { /* no existía */ } }
    window.__cam = await root.getDirectoryHandle('cam', { create: true });
    window.__out = await root.getDirectoryHandle('salida', { create: true });
    window.__drop = async (name, b64) => { const fh = await window.__cam.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close(); };
    window.__outFiles = async () => { const out = []; for await (const h of window.__out.values()) out.push(h.name); return out.sort(); };
    window.__readOut = async (name) => { const f = await (await window.__out.getFileHandle(name)).getFile(); return btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))); };
    window.__app.autoUI.setFolders(window.__cam, window.__out);
  });
  return { page, ctx };
}
const png = (page, w, h, bg) => page.evaluate(({ w, h, bg }) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = '#ffffff'; g.fillRect(w * 0.4, h * 0.4, w * 0.2, h * 0.2);
  return c.toDataURL('image/png').split(',')[1];
}, { w, h, bg });
const config = (page, patch) => page.evaluate((p) => window.__app.autoUI.setConfig(p), patch);
const counts = (page) => page.evaluate(() => window.__app.autoUI.queue.counts());
const names = (page) => page.evaluate(() => window.__app.autoUI.queue.items.map((i) => `${i.name}:${i.status}`));
const waitDone = (page, n, timeout = 120000) => page.waitForFunction((n) => window.__app.autoUI.queue.counts().done >= n, n, { timeout });

let passed = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);

t('de la carpeta de la cámara a la carpeta de salida: preset, marco, JPEG y PDF con perfil; ignora lo que ya estaba y no repite', async () => {
  const { page, ctx } = await newPage();
  await page.evaluate(() => window.__app.setMode('auto'));
  await page.evaluate(async (b64) => window.__drop('vieja.png', b64), await png(page, 600, 400, '#c05030')); // ya estaba antes de empezar
  await config(page, { collection: 'starter', presetId: 'bn', output: 'folder', format: 'both', requireApproval: false, autoTone: false });
  await page.locator('#autoBody').waitFor();
  await page.click('#btnAutoStart');
  await page.waitForFunction(() => window.__app.autoUI.state.running === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains('auto-running')), true);
  assert.equal(await page.locator('#btnAutoStart').innerText(), 'Detener');
  // llegan dos fotos: un PNG y un RAW (DNG), como si la cámara las copiara
  await page.evaluate(async ([a, b]) => { await window.__drop('DSC001.png', a); await window.__drop('DSC002.dng', b); }, [await png(page, 1200, 800, '#c05030'), makeDng({ width: 192, height: 128, color: patchesColor(192, 128) }).toString('base64')]);
  await waitDone(page, 2);
  const q = await names(page);
  assert.deepEqual(q.sort(), ['DSC001.png:done', 'DSC002.dng:done'], 'solo las dos nuevas; la vieja se ignora');
  const files = await page.evaluate(() => window.__outFiles());
  assert.equal(files.length, 4, files.join(', '));
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 2); assert.equal(files.filter((f) => f.endsWith('.pdf')).length, 2);
  assert.ok(files.every((f) => /^\d{8}-\d{6}_\d{3,}_/.test(f)), 'nombres ordenados por fecha: ' + files[0]);
  // el JPEG: tamaño de la hoja a 300 ppp, perfil sRGB incrustado y el preset blanco y negro aplicado (fuera del marco blanco)
  const jpgName = files.find((f) => f.endsWith('.jpg') && /DSC001/.test(f));
  const jpg = Buffer.from(await page.evaluate((n) => window.__readOut(n), jpgName), 'base64');
  assert.equal(readIccHeader(extractIccFromJpeg(jpg)).description, 'sRGB (Editor de fotos)');
  const info = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob()); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    const px = (fx, fy) => [...g.getImageData(Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1).data.slice(0, 3)];
    return { w: bmp.width, h: bmp.height, photo: px(0.25, 0.3), corner: px(0.01, 0.01) };
  }, jpg.toString('base64'));
  assert.deepEqual([info.w, info.h], [1800, 1200], 'hoja 10×15 cm horizontal a 300 ppp');
  assert.ok(Math.max(...info.photo) - Math.min(...info.photo) < 12, `la foto (naranja) quedó en blanco y negro: ${info.photo}`);
  assert.ok(info.corner.every((v) => v > 240), 'el borde del marco es blanco');
  // el PDF se abre
  const pdfName = files.find((f) => f.endsWith('.pdf') && /DSC001/.test(f));
  const pdf = Buffer.from(await page.evaluate((n) => window.__readOut(n), pdfName), 'base64');
  const dir = mkdtempSync(join(tmpdir(), 'auto-')); const pf = join(dir, 'a.pdf'); writeFileSync(pf, pdf);
  try { assert.match(execFileSync('pdfinfo', [pf]).toString(), /Pages:\s+1/); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // en la biblioteca quedan aprobadas y con el preset
  const lib = await page.evaluate(async () => { const s = await import('/src/storage.js'); const all = await s.listPhotos(); return all.map((r) => ({ n: r.name, st: r.status, sat: r.edits.color.saturation, raw: !!r.isRaw })); });
  assert.equal(lib.length, 2, 'la foto vieja no se importó');
  lib.forEach((r) => { assert.equal(r.st, 'approved'); assert.equal(r.sat, -100, 'preset blanco y negro'); });
  assert.ok(lib.some((r) => r.raw));
  assert.equal(/\bnull\b/.test(await page.locator('#autoBody').innerText() + await page.locator('#autoWrap').innerText()), false, 'sin la palabra "null" suelta en la pantalla');
  await shot(page, '30-automatico');
  // no se repite aunque pase el tiempo
  await page.waitForTimeout(3500);
  assert.equal((await counts(page)).done, 2);
  assert.equal((await page.evaluate(() => window.__outFiles())).length, 4);
  // detener
  await page.click('#btnAutoStart');
  await page.waitForFunction(() => window.__app.autoUI.state.running === false);
  assert.equal(await page.evaluate(() => document.body.classList.contains('auto-running')), false);
  await ctx.close();
});
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: `${shotsDir}/${name}.png` }); };

t('con aprobación: las fotos esperan, aprobar entrega solo esa, descartar no entrega nada', async () => {
  const { page, ctx } = await newPage();
  await page.evaluate(() => window.__app.setMode('auto'));
  await config(page, { presetId: 'natural', output: 'folder', format: 'jpg', requireApproval: true });
  await page.click('#btnAutoStart'); await page.waitForFunction(() => window.__app.autoUI.state.running === true);
  await page.evaluate(async ([a, b]) => { await window.__drop('A.png', a); await window.__drop('B.png', b); }, [await png(page, 900, 600, '#3050c0'), await png(page, 900, 600, '#30a050')]);
  await page.waitForFunction(() => window.__app.autoUI.queue.counts().review === 2, null, { timeout: 120000 });
  assert.equal((await page.evaluate(() => window.__outFiles())).length, 0, 'nada se entrega sin aprobar');
  assert.equal(await page.locator('.autorow[data-status="review"]').count(), 2);
  assert.equal(await page.locator('.autorow[data-status="review"] img.autothumb').count(), 2, 'se ve cómo saldrá la hoja');
  await shot(page, '31-automatico-aprobar');
  await page.locator('.autorow:has(.autoname:text-is("A.png"))').locator('[data-act="approve"]').click();
  await waitDone(page, 1);
  await page.locator('.autorow:has(.autoname:text-is("B.png"))').locator('[data-act="discard"]').click();
  const files = await page.evaluate(() => window.__outFiles());
  assert.equal(files.length, 1); assert.match(files[0], /_A\.jpg$/);
  assert.deepEqual((await names(page)).sort(), ['A.png:done', 'B.png:discarded']);
  await ctx.close();
});

t('imprimir directo: manda las hojas al diálogo de impresión (con el tamaño de papel) sin tocar la carpeta de salida', async () => {
  const { page, ctx } = await newPage();
  await page.evaluate(() => { window.__printed = []; window.print = () => { window.__printed.push([...document.querySelectorAll('#printSheet img')].map((i) => i.className)); }; window.__app.setMode('auto'); });
  await config(page, { presetId: 'calido', output: 'print', requireApproval: false });
  await page.click('#btnAutoStart'); await page.waitForFunction(() => window.__app.autoUI.state.running === true);
  await page.evaluate(async (b) => window.__drop('P1.png', b), await png(page, 1200, 800, '#c05030'));
  await waitDone(page, 1);
  const printed = await page.evaluate(() => window.__printed);
  assert.equal(printed.length, 1, 'una impresión por foto'); assert.equal(printed[0].length, 1, 'una hoja');
  assert.equal((await page.evaluate(() => window.__outFiles())).length, 0);
  await ctx.close();
});

t('una foto dañada da error claro, no frena a las demás y se puede reintentar; cambiar de modo está bloqueado mientras corre', async () => {
  const { page, ctx } = await newPage();
  await page.evaluate(() => window.__app.setMode('auto'));
  await config(page, { presetId: 'natural', output: 'hold', requireApproval: false });
  await page.click('#btnAutoStart'); await page.waitForFunction(() => window.__app.autoUI.state.running === true);
  await page.evaluate(async ([b64]) => { await window.__drop('roto.jpg', btoa('esto no es una foto de verdad')); await window.__drop('buena.png', b64); }, [await png(page, 900, 600, '#c05030')]);
  await page.waitForFunction(() => { const c = window.__app.autoUI.queue.counts(); return c.error === 1 && c.done === 1; }, null, { timeout: 120000 });
  assert.equal(await page.locator('.autorow[data-status="error"] .autoerr').count(), 1);
  assert.equal(await page.locator('.autorow[data-status="error"] [data-act="retry"]').count(), 1);
  // bloqueo de modos mientras corre
  await page.click('#modeSwitch button[data-mode="edit"]', { force: true }).catch(() => {});
  await page.evaluate(() => window.__app.setMode('edit'));
  assert.equal(await page.evaluate(() => window.__app.ui.mode), 'auto');
  await page.click('#btnAutoStart');
  await page.evaluate(() => window.__app.setMode('edit'));
  assert.equal(await page.evaluate(() => window.__app.ui.mode), 'edit', 'detenido, ya se puede cambiar');
  await ctx.close();
});

t('probar con una foto de la computadora usa el mismo camino; sin carpeta de salida avisa; y la configuración se recuerda', async () => {
  const { page, ctx } = await newPage();
  await page.evaluate(() => window.__app.setMode('auto'));
  await config(page, { presetId: 'vivido', output: 'folder', format: 'jpg', intensity: 60, requireApproval: false, cropToFrame: true });
  await page.locator('#fileAutoTest').setInputFiles({ name: 'prueba.png', mimeType: 'image/png', buffer: Buffer.from(await png(page, 900, 600, '#c05030'), 'base64') });
  await waitDone(page, 1);
  assert.equal((await page.evaluate(() => window.__outFiles())).length, 1);
  // la intensidad del preset se usó (60 %): vivido tiene saturación 22 -> 13.2
  const sat = await page.evaluate(async () => { const s = await import('/src/storage.js'); return (await s.listPhotos())[0].edits.color.saturation; });
  assert.ok(Math.abs(sat - 13.2) < 0.2, `saturación ${sat}`);
  // la configuración sobrevive a recargar
  await page.waitForTimeout(300);
  await page.reload(); await page.waitForFunction(() => window.__appReady === true);
  const cfg = await page.evaluate(() => ({ ...window.__app.autoUI.state.cfg }));
  assert.equal(cfg.presetId, 'vivido'); assert.equal(cfg.intensity, 60); assert.equal(cfg.format, 'jpg');
  await ctx.close();
});

t('del teléfono a la computadora: el teléfono sube la foto con el código, el buzón la entrega y el flujo la procesa', async () => {
  const inbox = mkdtempSync(join(tmpdir(), 'buzon-'));
  const srv = await startInboxServer(0, '127.0.0.1', { inbox, code: 'ABCD2345', restrict: true });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    // la computadora: la app abierta en localhost, modo automático, fuente = buzón
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dpage = await desk.newPage();
    dpage.on('pageerror', (e) => errors.push('pageerror: ' + e));
    await dpage.goto(`${base}/index.html?nosw`);
    await dpage.waitForFunction(() => window.__appReady === true);
    await dpage.evaluate(() => window.__app.setMode('auto'));
    assert.equal(await dpage.evaluate(() => window.__app.autoUI.state.cfg.source), 'inbox', 'con servidor local, la fuente por defecto es el buzón');
    assert.equal(await dpage.locator('#inboxCode').innerText(), 'ABCD-2345');
    await dpage.locator('#autoTunnel').fill('https://prueba.trycloudflare.com'); await dpage.locator('#autoTunnel').dispatchEvent('change');
    await dpage.waitForFunction(() => document.getElementById('inboxLink'));
    assert.equal(await dpage.locator('#inboxLink').innerText(), 'https://prueba.trycloudflare.com/enviar?c=ABCD2345');
    await dpage.evaluate(() => window.__app.autoUI.setConfig({ presetId: 'bn', output: 'download', requireApproval: false, autoTone: false }));
    await dpage.click('#btnAutoStart'); await dpage.waitForFunction(() => window.__app.autoUI.state.running === true);
    assert.match(await dpage.locator('.autostate').innerText(), /Recibiendo del teléfono/);

    // el teléfono: llega "por el túnel" (cabecera de reenvío), así que la subida exige el código
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.50' } });
    const ppage = await phone.newPage();
    ppage.on('pageerror', (e) => errors.push('pageerror: ' + e));
    await ppage.goto(`${base}/enviar`);
    const photo = Buffer.from(await png(dpage, 1200, 800, '#c05030'), 'base64');
    // sin código: error claro y la foto no llega
    await ppage.locator('#gal').setInputFiles({ name: 'sin-codigo.png', mimeType: 'image/png', buffer: photo });
    await ppage.waitForFunction(() => /código/i.test(document.getElementById('msg').innerText));
    assert.equal(readdirSync(inbox).filter((f) => /sin-codigo/.test(f)).length, 0);
    // código equivocado
    await ppage.fill('#code', 'ZZZZ9999');
    await ppage.locator('#gal').setInputFiles({ name: 'mal.png', mimeType: 'image/png', buffer: photo });
    await ppage.waitForFunction(() => /incorrecto/i.test(document.getElementById('list').innerText));
    // código bueno (con la foto "tomada" con la cámara)
    await ppage.fill('#code', 'abcd2345');
    assert.equal(await ppage.inputValue('#code'), 'ABCD-2345', 'se da formato al código');
    await ppage.locator('#cam').setInputFiles({ name: 'IMG_0100.png', mimeType: 'image/png', buffer: photo });
    await ppage.waitForFunction(() => /Enviada/.test(document.getElementById('list').innerText), null, { timeout: 30000 });
    shotsDir && await ppage.screenshot({ path: `${shotsDir}/34-enviar-telefono.png` });
    // y el código se recuerda en el teléfono
    await ppage.reload(); assert.equal(await ppage.inputValue('#code'), 'ABCD-2345');

    // la computadora recibe, aplica el preset y deja la hoja lista
    await dpage.waitForFunction(() => window.__app.autoUI.queue.counts().done >= 1, null, { timeout: 120000 });
    const q = await dpage.evaluate(() => window.__app.autoUI.queue.items.map((i) => `${i.name}:${i.status}`));
    assert.deepEqual(q, ['IMG_0100.png:done'], 'solo la foto buena; las rechazadas no llegaron');
    const sat = await dpage.evaluate(async () => { const s = await import('/src/storage.js'); return (await s.listPhotos())[0].edits.color.saturation; });
    assert.equal(sat, -100, 'preset blanco y negro aplicado en la computadora');
    assert.equal(await dpage.locator('[data-act="dl-jpg"]').count(), 1);
    // ver la foto enviada desde la computadora no es posible para el teléfono (el buzón no se lee desde fuera)
    const peek = await ppage.evaluate(async () => (await fetch('/api/inbox')).status);
    assert.equal(peek, 403);
    await shot(dpage, '35-automatico-buzon');
    await desk.close(); await phone.close();
  } finally { srv.server.close(); }
});

t('teléfono: sin carpetas, "Tomar foto y procesar" pasa por el flujo y deja Descargar JPEG / PDF', async () => {
  // un teléfono: pantalla angosta, táctil y SIN showDirectoryPicker (como Safari o Chrome en Android)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  await ctx.addInitScript(() => { try { delete window.showDirectoryPicker; } catch { window.showDirectoryPicker = undefined; } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  await page.goto(`http://127.0.0.1:${port}/index.html?nosw`);
  await page.waitForFunction(() => window.__appReady === true);
  await page.evaluate(() => window.__app.setMode('auto'));
  assert.equal(await page.evaluate(() => window.__app.autoUI.state.cfg.output), 'download', 'sin carpetas, la salida por defecto es descargar');
  assert.match(await page.locator('#autoBody .warn').innerText(), /Tomar foto y procesar/);
  assert.equal(await page.locator('input[name="autoSrc"][value="folder"]').isDisabled(), true, 'no se puede elegir carpeta aquí');
  assert.match(await page.locator('#inboxOff').innerText(), /No disponible/, 'sin servidor local no hay buzón');
  await config(page, { presetId: 'vivido', autoTone: true, requireApproval: false });
  // "toma" la foto con la cámara del teléfono
  await page.locator('#fileAutoCapture').setInputFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: Buffer.from(await png(page, 1200, 900, '#c05030'), 'base64') });
  await waitDone(page, 1);
  await page.locator('#autoList .autorow').first().scrollIntoViewIfNeeded();
  await shot(page, '33-automatico-telefono-listo');
  assert.equal(await page.locator('[data-act="dl-jpg"]').count(), 1); assert.equal(await page.locator('[data-act="dl-pdf"]').count(), 1);
  const [dj] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('[data-act="dl-jpg"]').tap()]);
  assert.match(dj.suggestedFilename(), /_IMG_0001\.jpg$/);
  const { readFileSync } = await import('node:fs');
  const jpg = readFileSync(await dj.path());
  assert.equal(readIccHeader(extractIccFromJpeg(jpg)).description, 'sRGB (Editor de fotos)');
  const [dp] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('[data-act="dl-pdf"]').tap()]);
  assert.equal(readFileSync(await dp.path()).slice(0, 5).toString(), '%PDF-');
  // el panel y la lista caben en la pantalla del teléfono
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await ctx.close();
});

t('teléfono y pantalla angosta: el panel automático cabe y los botones se ven', async () => {
  const { page, ctx } = await newPage({ width: 390, height: 800 });
  await page.evaluate(() => window.__app.setMode('auto'));
  await page.locator('#btnAutoStart').scrollIntoViewIfNeeded();
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(over, false, 'sin desplazamiento horizontal');
  assert.equal(await page.locator('#btnAutoStart').isVisible(), true);
  await shot(page, '32-automatico-telefono');
  await ctx.close();
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FALLA ${name}\n        ${String(e.message).split('\n').slice(0, 5).join('\n        ')}`); process.exitCode = 1; }
}
const real = [...new Set(errors)].filter((e) => !/favicon|No se pudo|no es una foto|Failed to load resource|decode/i.test(e));
if (real.length) { console.log('\nErrores en la consola del navegador:\n' + real.join('\n')); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pruebas del modo automático correctas`);
await browser.close(); server.close();
