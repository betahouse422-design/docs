// Prueba de extremo a extremo del flujo del restaurante:
// abrir varias fotos -> editar -> aprobar -> marco + logo -> PDF / JPEG / imprimir.
// Uso: node tests/workflow.test.mjs [carpeta-para-capturas]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';
import { makeDng, patchesColor } from './make-dng.mjs';
import { makeMatrixProfile, readIccHeader, extractIccFromJpeg } from '../src/icc.js';

const shotsDir = process.argv[2];
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find(existsSync);
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const errors = [];

async function newPage(viewport = { width: 1440, height: 900 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html?nosw`);
  await page.waitForFunction(() => window.__appReady === true);
  return { page, ctx };
}
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: `${shotsDir}/${name}.png` }); };

// PNG de prueba: fondo de color, con un bloque distinto para ver recortes
async function png(page, w, h, bg, fg = '#ffffff', alpha = false) {
  const b64 = await page.evaluate(({ w, h, bg, fg, alpha }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    if (!alpha) { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, bg); gr.addColorStop(1, '#202020'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
    g.fillStyle = fg; g.fillRect(w * 0.35, h * 0.35, w * 0.3, h * 0.3);
    return c.toDataURL('image/png').split(',')[1];
  }, { w, h, bg, fg, alpha });
  return Buffer.from(b64, 'base64');
}
const file = (name, buffer, type = 'image/png') => ({ name, mimeType: type, buffer });

async function openPhotos(page, specs) {
  const files = [];
  for (const [i, s] of specs.entries()) files.push(file(s.name || `foto-${i + 1}.png`, await png(page, s.w || 1200, s.h || 800, s.bg || '#c05030')));
  await page.locator('#file').setInputFiles(files);
  await page.waitForFunction((n) => window.__app.lib.items.length >= n && window.__app.ui.photoId && window.__app.engine.hasSource(), specs.length);
  await frame(page);
}
const items = (page) => page.evaluate(() => window.__app.lib.items.map((p) => ({ id: p.id, name: p.name, status: p.status })));
const setSlider = async (page, label, value, scope = '#tabBody') => {
  const row = page.locator(`${scope} .srow`, { has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.locator('input[type=range]').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
  await frame(page);
};
const settle = (page) => page.waitForTimeout(1000); // deja terminar el guardado diferido
const waitStatus = (page, i, status) => page.waitForFunction(([i, s]) => window.__app.lib.items[i] && window.__app.lib.items[i].status === s, [i, status], { timeout: 15000 });

let passed = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);

t('abrir varias fotos: aparece la tira con todas, la primera seleccionada y en estado pendiente', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#c05030' }, { bg: '#30a050' }, { bg: '#3050c0', w: 800, h: 1200 }]);
  assert.equal(await page.locator('#filmstrip').isVisible(), true);
  assert.equal(await page.locator('.thumb').count(), 3);
  assert.equal(await page.locator('.thumb.on').count(), 1);
  const st = await items(page);
  assert.deepEqual(st.map((p) => p.status), ['pending', 'pending', 'pending']);
  assert.match(await page.locator('.fsinfo').innerText(), /3 fotos · 0 aprobadas/);
  assert.equal(await page.locator('.thumb img').count(), 3, 'cada miniatura tiene imagen');
  await shot(page, '10-varias-fotos');
  await ctx.close();
});

t('editar cambia el estado a "editada"; volver a neutro la deja "pendiente"', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}, { bg: '#30a050' }]);
  await setSlider(page, 'Exposición', 0.8); await waitStatus(page, 0, 'edited');
  assert.ok(await page.locator('.thumb.on .badge.edited').count() === 1);
  await setSlider(page, 'Exposición', 0); await waitStatus(page, 0, 'pending');
  await ctx.close();
});

t('aprobar marca la foto y pasa a la siguiente por revisar; editar una aprobada la devuelve a "editada"', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'a.png' }, { name: 'b.png', bg: '#30a050' }, { name: 'c.png', bg: '#3050c0' }]);
  await setSlider(page, 'Contraste', 20); await settle(page);
  await page.click('[data-act="approve"]');
  await page.waitForFunction(() => window.__app.ui.fileName === 'b');
  const st = await items(page);
  assert.equal(st[0].status, 'approved');
  assert.match(await page.locator('.fsinfo').innerText(), /1 aprobada/);
  assert.equal(await page.locator('.thumb .badge.approved').count(), 1);
  // volver a la primera y editarla: ya no está aprobada
  await page.locator('.thumb').first().click(); await page.waitForFunction(() => window.__app.ui.fileName === 'a');
  await setSlider(page, 'Brillo', 15); await waitStatus(page, 0, 'edited');
  // atajo de teclado: A aprueba
  await page.keyboard.press('a'); await page.waitForFunction(() => window.__app.lib.items[0].status === 'approved');
  await ctx.close();
});

t('flechas del teclado cambian de foto', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'uno.png' }, { name: 'dos.png', bg: '#30a050' }]);
  await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => window.__app.ui.fileName === 'dos');
  await page.keyboard.press('ArrowLeft'); await page.waitForFunction(() => window.__app.ui.fileName === 'uno');
  await ctx.close();
});

t('los ajustes de cada foto se conservan al cambiar de una a otra', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'uno.png' }, { name: 'dos.png', bg: '#30a050' }]);
  await setSlider(page, 'Saturación', 40); await settle(page);
  await page.locator('.thumb').nth(1).click(); await page.waitForFunction(() => window.__app.ui.fileName === 'dos');
  assert.equal(await page.evaluate(() => window.__app.store.get().color.saturation), 0);
  await setSlider(page, 'Saturación', -30); await settle(page);
  await page.locator('.thumb').first().click(); await page.waitForFunction(() => window.__app.ui.fileName === 'uno');
  assert.equal(await page.evaluate(() => window.__app.store.get().color.saturation), 40);
  await ctx.close();
});

t('copiar ajustes y pegarlos en las fotos marcadas (sin pisar su recorte)', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'uno.png' }, { name: 'dos.png', bg: '#30a050' }, { name: 'tres.png', bg: '#3050c0' }]);
  await setSlider(page, 'Exposición', 0.5); await setSlider(page, 'Temperatura', 25); await settle(page);
  assert.equal(await page.locator('[data-act="paste"]').isDisabled(), true);
  await page.click('[data-act="copy"]');
  assert.equal(await page.locator('[data-act="paste"]').isDisabled(), false);
  await page.locator('.thumb .sel').nth(1).click(); await page.locator('.thumb .sel').nth(2).click();
  await page.click('[data-act="paste"]');
  await page.waitForFunction(() => window.__app.lib.items.filter((p) => p.status === 'edited').length === 3);
  const edits = await page.evaluate(async () => { const out = []; for (const p of window.__app.lib.items) { const r = await (await import('/src/storage.js')).getPhoto(p.id); out.push([r.edits.light.exposure, r.edits.color.temperature]); } return out; });
  assert.deepEqual(edits, [[0.5, 25], [0.5, 25], [0.5, 25]]);
  await ctx.close();
});

t('pegar sin fotos marcadas avisa en vez de hacer algo raro', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}, { bg: '#30a050' }]);
  await setSlider(page, 'Exposición', 0.5); await settle(page);
  await page.click('[data-act="copy"]'); await page.click('[data-act="paste"]');
  assert.match(await page.locator('#toast').innerText(), /Marca primero/);
  assert.equal((await items(page))[1].status, 'pending');
  await ctx.close();
});

t('aplicar un preset a todas las fotos', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}, { bg: '#30a050' }, { bg: '#3050c0' }]);
  await page.click('#tabs button[data-tab="presets"]');
  await page.locator('.pitem', { hasText: 'Cálido' }).click();
  await page.click('#btnPresetAll');
  await page.waitForFunction(() => window.__app.lib.items.every((p) => p.status === 'edited'), null, { timeout: 20000 });
  const temps = await page.evaluate(async () => { const s = await import('/src/storage.js'); const o = []; for (const p of window.__app.lib.items) o.push((await s.getPhoto(p.id)).edits.color.temperature); return o; });
  assert.deepEqual(temps, [28, 28, 28]);
  await ctx.close();
});

t('quitar una foto de la biblioteca', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'uno.png' }, { name: 'dos.png', bg: '#30a050' }]);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-act="remove"]');
  await page.waitForFunction(() => window.__app.lib.items.length === 1);
  await page.waitForFunction(() => window.__app.ui.fileName === 'dos');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-act="remove"]');
  await page.waitForFunction(() => window.__app.lib.items.length === 0);
  assert.equal(await page.locator('#empty').isVisible(), true);
  await ctx.close();
});

t('la biblioteca, los estados y la foto actual sobreviven a recargar la página', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'uno.png' }, { name: 'dos.png', bg: '#30a050' }]);
  await setSlider(page, 'Exposición', 0.7); await settle(page);
  await page.click('[data-act="approve"]');
  await page.waitForFunction(() => window.__app.ui.fileName === 'dos'); await settle(page);
  await page.reload(); await page.waitForFunction(() => window.__appReady === true);
  await page.waitForFunction(() => window.__app.lib.items.length === 2 && window.__app.engine.hasSource());
  assert.deepEqual((await items(page)).map((p) => p.status), ['approved', 'pending']);
  assert.equal(await page.evaluate(() => window.__app.ui.fileName), 'dos');
  await page.locator('.thumb').first().click(); await page.waitForFunction(() => window.__app.ui.fileName === 'uno');
  assert.equal(await page.evaluate(() => window.__app.store.get().light.exposure), 0.7);
  await ctx.close();
});

t('modo Imprimir: muestra la hoja con la foto, el panel cambia y los botones de edición se ocultan', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForFunction(() => { const c = document.getElementById('printCanvas'); return c.width > 100 && document.getElementById('printInfo').textContent.includes('mm'); });
  assert.equal(await page.locator('#printWrap').isVisible(), true);
  assert.equal(await page.locator('#canvasWrap').isVisible(), false);
  assert.equal(await page.locator('#printBody').isVisible(), true);
  assert.equal(await page.locator('#tabs').isVisible(), false);
  assert.equal(await page.locator('#btnUndo').isVisible(), false);
  assert.equal((await page.locator('#btnExport').innerText()).toLowerCase(), 'descargar pdf');
  assert.match(await page.locator('#printInfo').innerText(), /10 × 15 cm|102 × 152|152 × 102/);
  await shot(page, '11-imprimir');
  await page.click('#modeSwitch button[data-mode="edit"]');
  assert.equal(await page.locator('#canvasWrap').isVisible(), true);
  assert.equal((await page.locator('#btnExport').innerText()).toLowerCase(), 'exportar');
  await ctx.close();
});

t('papel y orientación: A4 vertical y automática según la foto', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ w: 1200, h: 800 }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('details[data-sec="hoja"]');
  await page.selectOption('details[data-sec="hoja"] select >> nth=1', 'portrait'); // orientación
  await page.selectOption('details[data-sec="hoja"] select >> nth=0', 'a4');
  await page.waitForFunction(() => document.getElementById('printInfo').textContent.includes('210 × 297'));
  await page.selectOption('details[data-sec="hoja"] select >> nth=1', 'auto');
  await page.waitForFunction(() => document.getElementById('printInfo').textContent.includes('297 × 210'));
  await ctx.close();
});

t('restaurantes: crear, renombrar, cambiar y eliminar; la configuración es de cada uno', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('#brandSelect');
  await page.fill('#brandName', 'La Casona'); await page.locator('#brandName').press('Tab');
  await page.waitForFunction(() => document.querySelector('#brandSelect option').textContent === 'La Casona');
  await page.selectOption('details[data-sec="hoja"] select >> nth=0', 'a4'); // papel del primero
  await page.click('#btnNewBrand');
  await page.waitForFunction(() => document.querySelectorAll('#brandSelect option').length === 2);
  assert.equal(await page.evaluate(() => window.__app.printUI.getSpec().paper), '10x15', 'el restaurante nuevo empieza con la configuración por defecto');
  await page.selectOption('#brandSelect', { index: 0 });
  await page.waitForFunction(() => window.__app.printUI.getSpec().paper === 'a4');
  await page.selectOption('#brandSelect', { index: 1 });
  await page.waitForFunction(() => window.__app.printUI.state.brand.name !== 'La Casona');
  page.once('dialog', (d) => d.accept());
  await page.locator('details[data-sec="restaurante"] button', { hasText: 'Eliminar' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#brandSelect option').length === 1);
  await ctx.close();
});

t('logo: se carga, se ve en la hoja, se mueve arrastrando y queda guardado para el restaurante', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#c05030' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('#fileLogo', { state: 'attached' });
  const logo = await png(page, 400, 160, '#0044ff', '#ffff00');
  await page.locator('#fileLogo').setInputFiles(file('logo.png', logo));
  await page.waitForFunction(() => window.__app.printUI.state.assets.logo);
  await page.waitForTimeout(400);
  const pos0 = await page.evaluate(() => ({ ...window.__app.printUI.getSpec().logo }));
  assert.ok(pos0.enabled && pos0.y > 0.8);
  // el logo aparece en la hoja: hay píxeles azules del logo cerca de la posición inferior
  const hasBlue = () => page.evaluate(() => { const c = document.getElementById('printCanvas'); const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.8), c.width, Math.floor(c.height * 0.2)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 80 && d[i + 1] < 120) n++; return n; });
  assert.ok(await hasBlue() > 50, 'el logo debe verse abajo');
  await shot(page, '12-logo');
  // arrastrar el logo hacia arriba a la izquierda
  const box = await page.locator('#printCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * pos0.x, box.y + box.height * pos0.y); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.12, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const pos1 = await page.evaluate(() => ({ ...window.__app.printUI.getSpec().logo }));
  assert.ok(pos1.x < 0.35 && pos1.y < 0.3, `no se movió: ${pos1.x},${pos1.y}`);
  // botones de posición
  await page.locator('[data-pos="bottom-right"]').click();
  assert.ok(await page.evaluate(() => window.__app.printUI.getSpec().logo.x) > 0.7);
  // sobrevive a recargar
  await page.waitForTimeout(700);
  await page.reload(); await page.waitForFunction(() => window.__appReady === true);
  await page.waitForFunction(() => window.__app.printUI.state.assets.logo, null, { timeout: 15000 });
  assert.ok(await page.evaluate(() => window.__app.printUI.getSpec().logo.x) > 0.7);
  await ctx.close();
});

t('marcos generados: cambiar de tipo y de color se refleja en la hoja', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#c05030' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('#frameKind');
  await page.selectOption('#frameKind', 'polaroid');
  await page.waitForFunction(() => window.__app.printUI.getSpec().frame.kind === 'polaroid');
  await page.waitForTimeout(300);
  const edge = () => page.evaluate(() => { const c = document.getElementById('printCanvas'); const d = c.getContext('2d').getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]]; });
  assert.deepEqual(await edge(), [255, 255, 255]);
  await page.locator('details[data-sec="marco"] input[type=color]').first().evaluate((el) => { el.value = '#112233'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(400);
  assert.deepEqual(await edge(), [17, 34, 51]);
  await shot(page, '13-polaroid');
  await ctx.close();
});

t('marco cargado (PNG): se detecta la ventana, manda la orientación y la foto se ve dentro', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#30a050', w: 900, h: 1200 }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('#fileFrame', { state: 'attached' });
  const frameB64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d');
    g.fillStyle = '#7a4b20'; g.fillRect(0, 0, 1200, 800); g.fillStyle = '#d9b36c'; g.fillRect(30, 30, 1140, 740); g.clearRect(100, 90, 1000, 620);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#fileFrame').setInputFiles(file('marco-madera.png', Buffer.from(frameB64, 'base64')));
  await page.waitForFunction(() => window.__app.printUI.state.assets.frame && window.__app.printUI.state.assets.frame.window);
  await page.waitForTimeout(400);
  const w = await page.evaluate(() => window.__app.printUI.state.assets.frame.window);
  assert.ok(Math.abs(w.x - 100 / 1200) < 0.01 && Math.abs(w.w - 1000 / 1200) < 0.02, JSON.stringify(w));
  const dims = await page.evaluate(() => [document.getElementById('printCanvas').width, document.getElementById('printCanvas').height]);
  assert.ok(dims[0] > dims[1], `el marco horizontal manda sobre la foto vertical: ${dims}`);
  const px = (fx, fy) => page.evaluate(([fx, fy]) => { const c = document.getElementById('printCanvas'); const d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
  const center = await px(0.3, 0.3); const edge = await px(0.01, 0.5);
  assert.ok(center[1] > center[0] && center[1] > 60, `foto verde dentro: ${center}`);
  assert.ok(Math.abs(edge[0] - 0x7a) < 25, `marco de madera: ${edge}`);
  assert.equal(await page.locator('#frameList .pitem').count(), 1);
  assert.match(await page.locator('details[data-sec="marco"] .hint').first().innerText(), /Ventana detectada|Mis marcos|PNG/);
  await shot(page, '14-marco-cargado');
  // el recorte de la foto se puede ajustar a la forma de la ventana desde Editar
  await page.click('#modeSwitch button[data-mode="edit"]');
  await page.click('#tabs button[data-tab="geometry"]');
  await page.locator('button', { hasText: 'Ajustar al marco de impresión' }).click();
  const crop = await page.evaluate(() => window.__app.store.get().geometry.crop);
  const aspect = await page.evaluate(() => window.__app.printUI.getWindowAspect());
  const [ow, oh] = [900, 1200];
  assert.ok(Math.abs((crop.w * ow) / (crop.h * oh) - aspect) < 0.01, `recorte ${JSON.stringify(crop)} vs ${aspect}`);
  await ctx.close();
});

t('texto del pie con variables y varias por hoja', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'Paella' }, { name: 'Tacos', bg: '#30a050' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('details[data-sec="texto"]');
  await page.locator('details[data-sec="texto"] input[type=checkbox]').first().check();
  await page.fill('details[data-sec="texto"] input[type=text]', '{nombre} · {foto}');
  await page.locator('details[data-sec="texto"] input[type=text]').press('Tab');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__app.printUI.getSpec().caption.text), '{nombre} · {foto}');
  await page.selectOption('#gridSelect', '2x1'); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => `${window.__app.printUI.getSpec().cols}x${window.__app.printUI.getSpec().rows}`), '2x1');
  await ctx.close();
});

t('pedido: "solo aprobadas", copias y hojas necesarias', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'a.png' }, { name: 'b.png', bg: '#30a050' }, { name: 'c.png', bg: '#3050c0' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('#jobSummary');
  assert.match(await page.locator('#jobSummary').innerText(), /No hay fotos en este pedido/);
  await page.locator('[data-job="all"] input').check();
  await page.waitForFunction(() => document.getElementById('jobSummary').textContent.includes('3 fotos × 1 copia → 3 hojas'));
  await page.fill('#copies', '2'); await page.locator('#copies').press('Tab');
  await page.waitForFunction(() => document.getElementById('jobSummary').textContent.includes('3 fotos × 2 copias → 6 hojas'));
  await page.selectOption('#gridSelect', '2x2');
  await page.waitForFunction(() => document.getElementById('jobSummary').textContent.includes('→ 2 hojas'));
  await ctx.close();
});

t('avisos: recorte grande (foto vertical en hoja horizontal) y resolución baja', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'vertical.png', w: 600, h: 900 }, { name: 'chica.png', w: 400, h: 267 }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  // con orientación automática la hoja se adapta a cada foto: no debe avisar de recorte
  await page.waitForFunction(() => /2 fotos/.test(document.getElementById('jobSummary').textContent));
  assert.ok(!/se recortará/.test(await page.locator('#jobSummary').innerText()), 'con orientación automática no hay recorte grande');
  // forzando hoja horizontal, la vertical sí pierde mucho
  await page.selectOption('details[data-sec="hoja"] select >> nth=1', 'landscape');
  await page.waitForFunction(() => /se recortará más de un 8 %/.test(document.getElementById('jobSummary').textContent), null, { timeout: 15000 });
  await page.waitForFunction(() => /Resolución baja/.test(document.getElementById('jobSummary').textContent), null, { timeout: 15000 });
  await ctx.close();
});

t('"Recortar todas al marco" ajusta el recorte de cada foto a la forma de la ventana', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'v.png', w: 600, h: 900 }, { name: 'h.png', w: 1200, h: 800 }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  await page.click('#btnCropAll');
  await page.waitForFunction(() => /Recorte ajustado|Ya estaban/.test(document.getElementById('toast').textContent), null, { timeout: 20000 });
  const r = await page.evaluate(async () => {
    const s = await import('/src/storage.js'); const out = [];
    for (const p of window.__app.lib.items) {
      const rec = await s.getPhoto(p.id); const c = rec.edits.geometry.crop;
      const got = (c.w * rec.width) / (c.h * rec.height);
      out.push({ name: rec.name, got, want: window.__app.printUI.windowAspectFor(rec.width / rec.height) });
    }
    return out;
  });
  r.forEach((x) => assert.ok(Math.abs(x.got - x.want) < 0.02, `${x.name}: ${x.got} vs ${x.want}`));
  assert.ok(r[0].want < 1 && r[1].want > 1, 'la vertical usa hoja vertical y la horizontal, hoja horizontal');
  assert.ok((await items(page)).every((p) => p.status === 'edited'));
  await ctx.close();
});

t('exportar PDF: archivo válido, una hoja por foto, al tamaño exacto del papel', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'a.png' }, { name: 'b.png', bg: '#30a050' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  await page.selectOption('details[data-sec="hoja"] select >> nth=0', '13x18');
  await page.selectOption('details[data-sec="hoja"] select >> nth=1', 'landscape');
  await page.selectOption('details[data-sec="hoja"] select >> nth=2', '150');
  await page.waitForTimeout(400);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnPdf')]);
  assert.match(dl.suggestedFilename(), /\.pdf$/);
  const path = await dl.path();
  const buf = readFileSync(path);
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  try {
    const info = execFileSync('pdfinfo', [path]).toString();
    assert.match(info, /Pages:\s+2/); assert.match(info, /Page size:\s+504(\.\d+)? x 360(\.\d+)? pts/); // 178 x 127 mm
    const dir = mkdtempSync(join(tmpdir(), 'pdf-')); execFileSync('pdftoppm', ['-r', '30', '-png', path, join(dir, 'p')]);
    if (shotsDir) writeFileSync(`${shotsDir}/15-hoja-pdf.png`, readFileSync(join(dir, 'p-1.png')));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await ctx.close();
});

t('exportar JPEG: uno solo si es una hoja; ZIP si son varias', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'a.png' }, { name: 'b.png', bg: '#30a050' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.selectOption('details[data-sec="hoja"] select >> nth=2', '150');
  await page.locator('[data-job="selected"] input').check();
  await page.locator('.thumb .sel').first().check();
  await page.waitForTimeout(300);
  let [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnJpegs')]);
  assert.match(dl.suggestedFilename(), /\.jpg$/);
  assert.deepEqual([...readFileSync(await dl.path()).slice(0, 3)], [0xff, 0xd8, 0xff]);
  await page.locator('[data-job="all"] input').check();
  [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnJpegs')]);
  assert.match(dl.suggestedFilename(), /\.zip$/);
  try {
    const list = execFileSync('unzip', ['-Z1', await dl.path()]).toString().trim().split('\n');
    assert.equal(list.length, 2); assert.ok(list.every((n) => /-0[12]\.jpg$/.test(n)), list.join(','));
    execFileSync('unzip', ['-t', await dl.path()]);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await ctx.close();
});

t('imprimir: prepara las hojas con su tamaño de papel y abre el diálogo de impresión', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ name: 'a.png' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  await page.selectOption('details[data-sec="hoja"] select >> nth=2', '150');
  await page.evaluate(() => { window.__printed = null; window.print = () => { const s = document.getElementById('printSheet'); window.__printed = { imgs: s.querySelectorAll('img').length, css: s.querySelector('style').textContent, printing: document.body.classList.contains('printing') }; }; });
  await page.click('#btnPrint');
  await page.waitForFunction(() => window.__printed, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.__printed);
  assert.equal(r.imgs, 1); assert.equal(r.printing, true);
  assert.match(r.css, /@page pg0 \{ size: (101\.6|152\.4)mm (152\.4|101\.6)mm; margin: 0; \}/);
  await ctx.close();
});

// imagen de prueba dibujada por el código que se le pasa
async function drawPng(page, w, h, body) {
  const b64 = await page.evaluate(({ w, h, body }) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); new Function('g', 'w', 'h', body)(g, w, h); return c.toDataURL('image/png').split(',')[1]; }, { w, h, body });
  return Buffer.from(b64, 'base64');
}
const openBuffers = async (page, list) => {
  await page.locator('#file').setInputFiles(list.map(([name, buf]) => file(name, buf)));
  await page.waitForFunction((n) => window.__app.lib.items.length >= n && window.__app.ui.photoId && window.__app.engine.hasSource(), list.length);
  await frame(page);
};
const viewPx = (page, fx, fy) => page.evaluate(([fx, fy]) => { const { width, height, data } = window.__app.engine.readPixels(); const i = (Math.floor(fy * height) * width + Math.floor(fx * width)) * 4; return [data[i], data[i + 1], data[i + 2]]; }, [fx, fy]);

t('gotero de balance de blancos: tocar un gris con dominante cálida lo neutraliza', async () => {
  const { page, ctx } = await newPage();
  const buf = await drawPng(page, 600, 400, "g.fillStyle='rgb(200,205,215)'; g.fillRect(0,0,w,h); g.fillStyle='rgb(190,165,135)'; g.fillRect(w*0.3,h*0.3,w*0.4,h*0.4);");
  await openBuffers(page, [['calida.png', buf]]);
  const before = await viewPx(page, 0.5, 0.5);
  assert.ok(before[0] - before[2] > 50, `la prueba necesita una dominante cálida: ${before}`);
  await page.click('#btnWbPick');
  assert.equal(await page.evaluate(() => window.__app.ui.pick), 'wb');
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForFunction(() => window.__app.ui.pick === null);
  await frame(page);
  const e = await page.evaluate(() => window.__app.store.get().color);
  assert.ok(e.temperature < -20, `debe enfriar: ${e.temperature}`);
  const after = await viewPx(page, 0.5, 0.5);
  assert.ok(Math.max(...after) - Math.min(...after) < 14, `tras el gotero debe quedar neutro: ${after}`);
  assert.equal(await page.evaluate(() => window.__app.store.canUndo()), true);
  await ctx.close();
});

t('balance de blancos automático y tono automático', async () => {
  const { page, ctx } = await newPage();
  const buf = await drawPng(page, 600, 400, "const gr=g.createLinearGradient(0,0,w,0); gr.addColorStop(0,'rgb(60,45,30)'); gr.addColorStop(1,'rgb(110,85,60)'); g.fillStyle=gr; g.fillRect(0,0,w,h);");
  await openBuffers(page, [['oscura.png', buf]]);
  await page.click('#btnWbAuto');
  await page.waitForFunction(() => window.__app.store.get().color.temperature !== 0);
  assert.ok(await page.evaluate(() => window.__app.store.get().color.temperature) < -10, 'foto cálida: debe enfriar');
  await page.click('#btnAutoTone');
  await page.waitForFunction(() => window.__app.store.get().light.exposure !== 0);
  assert.ok(await page.evaluate(() => window.__app.store.get().light.exposure) > 0.5, 'foto oscura: debe subir la exposición');
  await page.click('#btnUndo'); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().light.exposure), 0, 'se puede deshacer');
  await ctx.close();
});

t('quitar manchas: tocar una mancha la elimina, se puede mover el origen y deshacer', async () => {
  const { page, ctx } = await newPage();
  const buf = await drawPng(page, 800, 600, "g.fillStyle='rgb(150,120,90)'; g.fillRect(0,0,w,h); g.fillStyle='rgb(10,10,10)'; g.beginPath(); g.arc(w*0.5,h*0.5,14,0,7); g.fill();");
  await openBuffers(page, [['migaja.png', buf]]);
  const before = await viewPx(page, 0.5, 0.5);
  assert.ok(before[0] < 60, `se debe ver la mancha: ${before}`);
  await page.click('#tabs button[data-tab="retouch"]');
  await page.click('#btnSpotTool');
  assert.equal(await page.evaluate(() => window.__app.ui.spotTool), true);
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForFunction(() => window.__app.store.get().spots.length === 1);
  await frame(page);
  const after = await viewPx(page, 0.5, 0.5);
  assert.ok(Math.abs(after[0] - 150) < 18, `la mancha debe desaparecer: ${before} -> ${after}`);
  await shot(page, '18-retoque');
  // cambiar el origen arrastrando el círculo punteado: la parte editada sigue limpia
  const sp = await page.evaluate(() => window.__app.store.get().spots[0]);
  assert.ok(Math.hypot(sp.dx, sp.dy) > sp.r * 2, 'el origen debe quedar fuera de la mancha');
  // seleccionar y cambiar el modo y el tamaño desde el panel
  await page.selectOption('#spotMode', 'clone');
  assert.equal(await page.evaluate(() => window.__app.store.get().spots[0].mode), 'clone');
  await page.locator('#btnSpotDel').click();
  await page.waitForFunction(() => window.__app.store.get().spots.length === 0);
  await frame(page);
  const back = await viewPx(page, 0.5, 0.5);
  assert.ok(back[0] < 60, 'al eliminar el retoque vuelve la mancha');
  await page.click('#btnUndo'); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().spots.length), 1, 'deshacer recupera el retoque');
  await ctx.close();
});

t('quitar manchas: con la foto enderezada se avisa y no se puede usar', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}]);
  await page.evaluate(() => { window.__app.store.update((e) => { e.geometry.straighten = 5; }); window.__app.store.commit(); });
  await page.click('#tabs button[data-tab="retouch"]');
  assert.equal(await page.locator('#btnSpotTool').isDisabled(), true);
  await ctx.close();
});

t('"Auto" en varias fotos marcadas aplica tono y balance a cada una', async () => {
  const { page, ctx } = await newPage();
  const dark = await drawPng(page, 500, 330, "g.fillStyle='rgb(50,38,26)'; g.fillRect(0,0,w,h); g.fillStyle='rgb(90,70,50)'; g.fillRect(w*.3,h*.3,w*.3,h*.3);");
  const dark2 = await drawPng(page, 500, 330, "g.fillStyle='rgb(40,30,22)'; g.fillRect(0,0,w,h); g.fillStyle='rgb(100,78,55)'; g.fillRect(w*.2,h*.3,w*.4,h*.3);");
  await openBuffers(page, [['a.png', dark], ['b.png', dark2]]);
  await page.locator('.thumb .sel').nth(0).check(); await page.locator('.thumb .sel').nth(1).check();
  await page.click('[data-act="auto"]');
  await page.waitForFunction(() => window.__app.lib.items.every((p) => p.status === 'edited'), null, { timeout: 30000 });
  const ex = await page.evaluate(async () => { const s = await import('/src/storage.js'); const o = []; for (const p of window.__app.lib.items) { const r = await s.getPhoto(p.id); o.push([r.edits.light.exposure, r.edits.color.temperature]); } return o; });
  ex.forEach(([e, t]) => { assert.ok(e > 0.3, `exposición ${e}`); assert.ok(t < 0, `temperatura ${t}`); });
  await ctx.close();
});

t('ruido y neblina: los controles nuevos aparecen y modifican las ediciones', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}]);
  await page.locator('#tabAdjust summary', { hasText: 'Reducción de ruido' }).click();
  await setSlider(page, 'Luminosidad', 40, '#tabAdjust details:has(summary:text("Reducción de ruido"))');
  await setSlider(page, 'Quitar neblina', 25);
  const d = await page.evaluate(() => window.__app.store.get().detail);
  assert.equal(d.denoise, 40); assert.equal(d.dehaze, 25);
  await ctx.close();
});

t('bloom y halation: aparecen en Efectos y modifican las ediciones', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{}]);
  await setSlider(page, 'Bloom \\(brillo\\)', 35);
  await setSlider(page, 'Halation \\(halo cálido\\)', 20);
  const f = await page.evaluate(() => window.__app.store.get().effects);
  assert.equal(f.bloom, 35); assert.equal(f.halation, 20);
  await waitStatus(page, 0, 'edited');
  await ctx.close();
});

t('pincel: pintar con el dedo/ratón, ajustar solo esa zona, goma y deshacer', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#808080' }]);
  await page.click('#tabs button[data-tab="masks"]');
  await page.locator('#tabMasks button', { hasText: '+ Pincel' }).click();
  assert.equal(await page.evaluate(() => window.__app.store.get().masks[0].type), 'brush');
  await setSlider(page, 'Exposición', 1.5, '#tabMasks');
  const box = await page.locator('#overlay').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const px = (fx, fy) => page.evaluate(([fx, fy]) => { const { width, height, data } = window.__app.engine.readPixels(); const i = (Math.floor(fy * height) * width + Math.floor(fx * width)) * 4; return data[i]; }, [fx, fy]);
  await frame(page); await page.evaluate(() => window.__app.renderNow());
  const base = await px(0.22, 0.2); // la foto de prueba es un degradado: se compara con su valor sin pintar
  await page.mouse.move(...at(0.15, 0.2)); await page.mouse.down();
  await page.mouse.move(...at(0.3, 0.2), { steps: 8 }); await page.mouse.up();
  const n = await page.evaluate(() => window.__app.store.get().masks[0].strokes.length);
  assert.equal(n, 1, 'un trazo');
  await frame(page); await frame(page);
  await page.evaluate(() => window.__app.renderNow());
  const painted = await px(0.22, 0.2); const away = await px(0.8, 0.8);
  assert.ok(painted > base + 25, `lo pintado debe verse más claro: ${painted} vs ${base}`);
  await shot(page, '20-pincel');
  // goma
  await page.locator('#tabMasks label', { hasText: 'Goma' }).locator('input').check();
  await page.mouse.move(...at(0.15, 0.2)); await page.mouse.down();
  await page.mouse.move(...at(0.3, 0.2), { steps: 8 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__app.store.get().masks[0].strokes.length), 2);
  await page.evaluate(() => window.__app.renderNow());
  near2(await px(0.22, 0.2), base, 4, 'la goma deja la zona como estaba');
  // deshacer quita el último trazo (la goma) de un golpe
  await page.evaluate(() => window.__app.store.undo());
  assert.equal(await page.evaluate(() => window.__app.store.get().masks[0].strokes.length), 1);
  // "Borrar todo el pincelado"
  await page.locator('#tabMasks button', { hasText: 'Borrar todo el pincelado' }).click();
  assert.equal(await page.evaluate(() => window.__app.store.get().masks[0].strokes.length), 0);
  await ctx.close();
});
const near2 = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

t('marca de agua al exportar una foto suelta: logo del restaurante en la esquina elegida', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#404040' }]);
  // sin logo guardado, la casilla está deshabilitada
  await page.click('#btnExport');
  await page.waitForSelector('#exportDlg[open][data-ready="1"]');
  assert.equal(await page.locator('#expWm').isDisabled(), true);
  await page.keyboard.press('Escape');
  // carga el logo en Imprimir
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForSelector('#fileLogo', { state: 'attached' });
  await page.locator('#fileLogo').setInputFiles(file('logo.png', await png(page, 400, 160, '#202020', '#ffff00')));
  await page.waitForFunction(() => window.__app.printUI.state.assets.logo);
  await page.waitForTimeout(500);
  await page.click('#modeSwitch button[data-mode="edit"]');
  await page.waitForFunction(() => window.__app.engine.hasSource());
  const yellow = (buf, region) => page.evaluate(async ({ b64, region }) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const [x0, y0, x1, y1] = region.map((v, i) => Math.floor(v * (i % 2 ? c.height : c.width)));
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] > 180 && d[i + 2] < 90) n++;
    return n;
  }, { b64: buf.toString('base64'), region });
  const exportFile = async (setup) => {
    await page.click('#btnExport'); await page.waitForSelector('#exportDlg[open][data-ready="1"]');
    await setup();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#expGo')]);
    return readFileSync(await dl.path());
  };
  const without = await exportFile(async () => { if (await page.locator('#expWm').isChecked()) await page.locator('#expWm').uncheck(); });
  assert.equal(await yellow(without, [0, 0, 1, 1]), 0, 'sin marca no hay amarillo');
  const withWm = await exportFile(async () => {
    assert.equal(await page.locator('#expWm').isDisabled(), false);
    await page.locator('#expWm').check();
    assert.equal(await page.locator('#expWmBox').isVisible(), true);
    await page.selectOption('#expWmPos', 'bottom-right');
  });
  const inCorner = await yellow(withWm, [0.6, 0.7, 1, 1]); const elsewhere = await yellow(withWm, [0, 0, 0.5, 0.5]);
  assert.ok(inCorner > 100, `el logo debe verse abajo a la derecha (${inCorner})`);
  assert.equal(elsewhere, 0, 'y no en otra esquina');
  // la elección se recuerda
  await page.click('#btnExport'); await page.waitForSelector('#exportDlg[open][data-ready="1"]');
  assert.equal(await page.locator('#expWm').isChecked(), true);
  assert.equal(await page.locator('#expWmPos').inputValue(), 'bottom-right');
  await ctx.close();
});

t('looks .cube: cargar, elegir, intensidad, se ve en la foto, sobrevive a recargar; archivos malos avisan', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#808080' }]);
  const cube = (fn) => { const n = 5; const out = ['TITLE "Inversa"', `LUT_3D_SIZE ${n}`]; for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) out.push(fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(5)).join(' ')); return out.join('\n'); };
  const center = () => page.evaluate(() => { const { width, height, data } = window.__app.engine.readPixels(); const i = (Math.floor(height * 0.3) * width + Math.floor(width * 0.3)) * 4; return data[i]; });
  await page.evaluate(() => window.__app.renderNow());
  const before = await center();
  await page.locator('#lookSection summary').click();
  // un archivo que no es una LUT avisa y no se guarda
  await page.locator('#fileLook').setInputFiles({ name: 'malo.cube', mimeType: 'text/plain', buffer: Buffer.from('esto no es una lut') });
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.locator('#lookSelect option').count(), 1, 'solo "Aún no hay looks"');
  // uno bueno
  await page.locator('#fileLook').setInputFiles({ name: 'inversa.cube', mimeType: 'text/plain', buffer: Buffer.from(cube((r, g, b) => [1 - r, 1 - g, 1 - b])) });
  await page.waitForFunction(() => document.querySelectorAll('#lookSelect option').length === 2);
  await page.selectOption('#lookSelect', { label: 'Inversa' });
  const id = await page.evaluate(() => window.__app.store.get().look.id);
  assert.ok(id, 'el look queda en las ediciones');
  await page.waitForFunction(() => window.__app.engine.lookId === window.__app.store.get().look.id);
  await frame(page); await page.evaluate(() => window.__app.renderNow());
  const after = await center();
  assert.ok(Math.abs(after - (255 - before)) < 12, `con la inversa el gris claro se oscurece: ${before} -> ${after}`);
  // intensidad 0 = foto sin look
  await setSlider(page, 'Intensidad del look', 0, '#lookSection');
  await page.evaluate(() => window.__app.renderNow());
  assert.ok(Math.abs(await center() - before) < 4, 'intensidad 0');
  await setSlider(page, 'Intensidad del look', 100, '#lookSection');
  await shot(page, '22-look');
  await waitStatus(page, 0, 'edited'); await settle(page);
  // recargar: el look sigue elegido y la tabla se vuelve a cargar sola
  await page.reload(); await page.waitForFunction(() => window.__appReady === true);
  await page.waitForFunction(() => window.__app.engine.hasSource() && window.__app.store.get().look.id);
  await page.waitForFunction(() => window.__app.engine.lookId === window.__app.store.get().look.id, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.renderNow());
  assert.ok(Math.abs(await center() - after) < 6, 'tras recargar se ve igual');
  assert.equal(await page.locator('#lookSelect').inputValue(), id);
  // deshacer quita el look de la selección
  await page.evaluate(() => window.__app.store.undo()); await page.evaluate(() => window.__app.store.undo()); await frame(page);
  // quitar "Sin look"
  await page.selectOption('#lookSelect', '');
  assert.equal(await page.evaluate(() => window.__app.store.get().look.id), null);
  await ctx.close();
});

t('zoom: botones, teclado, rueda, arrastrar para mover, 1:1 y se suspende en recorte y máscaras', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ w: 1600, h: 1000 }]);
  const z = () => page.evaluate(() => ({ ...window.__app.ui.zoom }));
  const label = () => page.locator('#zoomLabel').innerText();
  assert.equal(await page.locator('#zoomBar').isVisible(), true);
  assert.equal(await label(), 'Ajustar'); assert.equal(await page.locator('#zoomOut').isDisabled(), true);
  await page.click('#zoomIn'); await frame(page);
  assert.ok(Math.abs((await z()).z - 1.6) < 0.01); assert.equal(await label(), '×1.6');
  await page.keyboard.press('+'); await frame(page);
  assert.ok((await z()).z > 2.5);
  await page.keyboard.press('-'); await page.keyboard.press('-'); await frame(page);
  assert.ok((await z()).z < 1.1, 'vuelve a ajustar');
  await page.keyboard.press('0'); assert.equal((await z()).z, 1);
  // 1:1: un píxel de la foto por píxel de pantalla (la foto es mayor que la vista, así que debe acercar)
  await page.click('#zoom100'); await frame(page);
  const z1 = (await z()).z; assert.ok(z1 > 1.2, `1:1 acerca (${z1})`);
  await page.click('#zoom100'); assert.equal((await z()).z, 1, 'otro clic vuelve a ajustar');
  // rueda con Ctrl (como pellizcar en el trackpad): acerca bajo el cursor
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.2);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control'); await frame(page);
  const zw = await z(); assert.ok(zw.z > 1.2, 'la rueda acerca');
  assert.ok(zw.cx > 0.5 && zw.cy < 0.5, `acerca hacia donde apunta el cursor (${zw.cx}, ${zw.cy})`);
  // arrastrar mueve la foto
  const c0 = await z();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45, { steps: 5 }); await page.mouse.up(); await frame(page);
  const c1 = await z();
  assert.ok(c1.cx > c0.cx && c1.cy > c0.cy, `arrastrar a la izquierda/arriba muestra lo de la derecha/abajo (${c0.cx},${c0.cy}) -> (${c1.cx},${c1.cy})`);
  // no se puede salir de la foto
  for (let i = 0; i < 6; i++) { await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05, { steps: 3 }); await page.mouse.up(); }
  const c2 = await z(); assert.ok(c2.cx <= 1 - 0.5 / c2.z + 1e-6 && c2.cy <= 1 - 0.5 / c2.z + 1e-6, 'se queda dentro de la foto');
  await shot(page, '23-zoom');
  // doble clic: vuelve a ajustar
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5); await frame(page);
  assert.equal((await z()).z, 1);
  // en recorte y en máscaras se ve la foto entera y la barra se oculta
  await page.click('#zoomIn'); await page.click('#tabs button[data-tab="geometry"]');
  await page.locator('#tabGeometry button', { hasText: 'Recortar' }).first().click().catch(() => {});
  await page.click('#tabs button[data-tab="masks"]'); await page.locator('#tabMasks button', { hasText: '+ Radial' }).click(); await frame(page);
  assert.equal(await page.locator('#zoomBar').isHidden(), true, 'sin barra en máscaras');
  assert.equal(await page.evaluate(() => window.__app.engine.lastSize[0] > 0), true);
  await ctx.close();
});

t('zoom: el retoque funciona acercado (el punto tocado cae donde se ve) y cambiar de foto restablece el zoom', async () => {
  const { page, ctx } = await newPage();
  const buf = await drawPng(page, 800, 600, "g.fillStyle='rgb(150,120,90)'; g.fillRect(0,0,w,h); g.fillStyle='rgb(10,10,10)'; g.beginPath(); g.arc(w*0.5625,h*0.5,10,0,7); g.fill();");
  await openBuffers(page, [['migaja.png', buf], ['otra.png', buf]]);
  await page.click('#tabs button[data-tab="retouch"]'); await page.click('#btnSpotTool');
  // acerca ×4 al centro y toca a 3/4 del ancho: en la imagen eso es 0.5 + 0.25/4 = 0.5625
  await page.evaluate(() => { const a = window.__app; a.ui.zoom = { z: 4, cx: 0.5, cy: 0.5 }; a.requestRender(); });
  await frame(page); await frame(page);
  const before = await viewPx(page, 0.75, 0.5); assert.ok(before[0] < 60, `la migaja se ve al acercar: ${before}`);
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5);
  await page.waitForFunction(() => window.__app.store.get().spots.length === 1);
  const sp = await page.evaluate(() => window.__app.store.get().spots[0]);
  assert.ok(Math.abs(sp.x - 0.5625) < 0.004 && Math.abs(sp.y - 0.5) < 0.004, `mancha en (${sp.x}, ${sp.y})`);
  await frame(page); await frame(page);
  const after = await viewPx(page, 0.75, 0.5); assert.ok(Math.abs(after[0] - 150) < 20, `la migaja desaparece: ${before} -> ${after}`);
  // cambiar de foto restablece el zoom
  await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => window.__app.ui.photoId && window.__app.lib.currentId !== window.__app.lib.items[0].id);
  assert.equal(await page.evaluate(() => window.__app.ui.zoom.z), 1);
  await ctx.close();
});

t('RAW: abrir un DNG lo revela, marca RAW, parte de un revelado base, y se acerca/exporta a tamaño completo', async () => {
  const { page, ctx } = await newPage();
  const dng = makeDng({ width: 256, height: 128, color: patchesColor(256, 128), orientation: 6 }); // sensor 256×128 girado: queda vertical 128×256
  await page.locator('#file').setInputFiles({ name: 'plato.dng', mimeType: 'image/x-adobe-dng', buffer: dng });
  await page.waitForFunction(() => window.__app.lib.items.length === 1 && window.__app.ui.photoId && window.__app.engine.hasSource(), null, { timeout: 60000 });
  await frame(page);
  assert.equal(await page.locator('.thumb .rawtag').count(), 1, 'la miniatura lleva la etiqueta RAW');
  const rec = await page.evaluate(async () => { const r = await (await import('/src/storage.js')).getPhoto(window.__app.ui.photoId); return { isRaw: r.isRaw, w: r.width, h: r.height, aspect: r.aspect, status: r.status, make: r.rawMeta && r.rawMeta.make, tone: JSON.stringify(r.edits.light) }; });
  assert.equal(rec.isRaw, true); assert.equal(rec.status, 'pending'); assert.equal(rec.make, 'Prueba');
  assert.ok(rec.aspect < 1, `la orientación EXIF lo deja vertical (aspecto ${rec.aspect})`);
  assert.ok(rec.h > rec.w, 'tamaño completo estimado vertical');
  // al abrir va a media resolución (la mitad de lado)
  const sz = () => page.evaluate(() => ({ size: [...window.__app.engine.srcSize], full: window.__app.engine.srcFull }));
  assert.deepEqual(await sz(), { size: [64, 128], full: false });
  await shot(page, '24-raw');
  // acercar el zoom revela todo el detalle
  await page.click('#zoomIn');
  await page.waitForFunction(() => window.__app.engine.srcFull === true, null, { timeout: 60000 });
  assert.deepEqual((await sz()).size, [128, 256]);
  await frame(page); await frame(page);
  // exportar un JPEG sale a tamaño completo
  await page.click('#btnExport'); await page.waitForSelector('#exportDlg[open][data-ready="1"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#expGo')]);
  const buf = readFileSync(await dl.path());
  const dims = await page.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob()); return [bmp.width, bmp.height]; }, buf.toString('base64'));
  assert.deepEqual(dims, [128, 256]);
  await ctx.close();
});

t('RAW: al exportar sin haber acercado, se revela a tamaño completo antes; y un archivo que no es RAW avisa', async () => {
  const { page, ctx } = await newPage();
  await page.locator('#file').setInputFiles({ name: 'plato.dng', mimeType: 'image/x-adobe-dng', buffer: makeDng({ width: 256, height: 128, color: patchesColor(256, 128) }) });
  await page.waitForFunction(() => window.__app.lib.items.length === 1 && window.__app.engine.hasSource(), null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__app.engine.srcFull), false);
  await page.click('#btnExport'); await page.waitForSelector('#exportDlg[open][data-ready="1"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#expGo')]);
  const dims = await page.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob()); return [bmp.width, bmp.height]; }, readFileSync(await dl.path()).toString('base64'));
  assert.deepEqual(dims, [256, 128], 'salió a tamaño completo, no a la mitad');
  // un archivo con extensión RAW pero contenido inválido: mensaje claro y la biblioteca no se rompe
  await page.locator('#file').setInputFiles({ name: 'roto.nef', mimeType: 'application/octet-stream', buffer: Buffer.from('esto no es un RAW de verdad') });
  await page.waitForFunction(() => /No se pudo revelar el RAW/.test(document.getElementById('toast').innerText), null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__app.lib.items.length), 1, 'no se añadió');
  await ctx.close();
});

t('RAW: imprimir con un RAW usa el tamaño completo en la exportación y la vista previa sigue funcionando', async () => {
  const { page, ctx } = await newPage();
  await page.locator('#file').setInputFiles({ name: 'plato.dng', mimeType: 'image/x-adobe-dng', buffer: makeDng({ width: 256, height: 128, color: patchesColor(256, 128) }) });
  await page.waitForFunction(() => window.__app.lib.items.length === 1 && window.__app.engine.hasSource(), null, { timeout: 60000 });
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  await page.waitForTimeout(1500);
  const hasPhoto = await page.evaluate(() => { const c = document.getElementById('printCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n; });
  assert.ok(hasPhoto > 200, `la vista previa muestra el parche rojo del RAW (${hasPhoto})`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#btnPdf')]);
  assert.equal(readFileSync(await dl.path()).slice(0, 5).toString(), '%PDF-');
  await ctx.close();
});

const REAL_RAW = process.env.RAW_SAMPLE || (existsSync(new URL('./_tmp_sony.ARW', import.meta.url)) ? new URL('./_tmp_sony.ARW', import.meta.url).pathname : '');
if (REAL_RAW) t('RAW real de cámara (RAW_SAMPLE): abre, se ve razonable y exporta a tamaño completo', async () => {
  const { page, ctx } = await newPage();
  await page.locator('#file').setInputFiles(REAL_RAW);
  await page.waitForFunction(() => window.__app.lib.items.length === 1 && window.__app.engine.hasSource(), null, { timeout: 120000 });
  await frame(page);
  const info = await page.evaluate(async () => {
    const r = await (await import('/src/storage.js')).getPhoto(window.__app.ui.photoId);
    const { width, height, data } = window.__app.engine.readPixels(); let sum = 0; let clip = 0; const n = width * height;
    for (let i = 0; i < data.length; i += 4) { const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; sum += l; if (l > 250) clip++; }
    return { w: r.width, h: r.height, make: r.rawMeta.make, model: r.rawMeta.model, mean: sum / n, clip: clip / n, srcFull: window.__app.engine.srcFull, src: window.__app.engine.srcSize };
  });
  assert.ok(info.make && info.model, 'metadatos de cámara');
  assert.ok(info.mean > 70 && info.mean < 200, `brillo medio razonable tras el revelado base (${info.mean.toFixed(0)})`);
  assert.ok(info.clip < 0.15, `pocas luces quemadas (${(info.clip * 100).toFixed(1)}%)`);
  assert.equal(info.srcFull, false);
  await shot(page, '25-raw-real');
  await page.click('#btnExport'); await page.waitForSelector('#exportDlg[open][data-ready="1"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#expGo')]);
  const dims = await page.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob()); return [bmp.width, bmp.height]; }, readFileSync(await dl.path()).toString('base64'));
  assert.ok(dims[0] >= info.w * 0.97, `exportó a tamaño completo (${dims.join('×')} vs ${info.w}×${info.h})`);
  await ctx.close();
});

t('color e imprenta: cargar un perfil ICC, convertir al exportar, simular en pantalla; el JPEG y el PDF llevan el perfil', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#ff1010' }]); // rojo saturado: queda fuera del gamut del perfil de prueba
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  await page.waitForSelector('#fileIcc', { state: 'attached' });
  const small = makeMatrixProfile({ description: 'Gamut chico', colorants: [[0.3, 0.2, 0.02], [0.3, 0.55, 0.1], [0.13, 0.07, 0.62]], gamma: 2.2 });
  // un archivo que no es un perfil avisa y no cambia nada
  await page.locator('#fileIcc').setInputFiles({ name: 'malo.icc', mimeType: 'application/octet-stream', buffer: Buffer.from('esto no es un perfil de color') });
  await page.waitForFunction(() => /no es un perfil/i.test(document.getElementById('toast').innerText), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__app.printUI.getSpec().color.mode), 'srgb');
  // uno válido
  await page.locator('#fileIcc').setInputFiles({ name: 'gamut-chico.icc', mimeType: 'application/octet-stream', buffer: Buffer.from(small) });
  await page.waitForFunction(() => window.__app.printUI.state.icc, null, { timeout: 15000 });
  assert.match(await page.locator('#iccName').innerText(), /Gamut chico \(RGB\)/);
  assert.equal(await page.evaluate(() => window.__app.printUI.getSpec().color.mode), 'profile', 'al cargar un perfil RGB se activa la conversión');
  await page.waitForTimeout(400);
  const jpegOf = async () => { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#btnJpegs')]); return readFileSync(await dl.path()); };
  const red = (buf) => page.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob(), { colorSpaceConversion: 'none' }); /* sin que el navegador deshaga el perfil incrustado */ const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return [...g.getImageData(Math.floor(bmp.width * 0.1), Math.floor(bmp.height * 0.1), 1, 1).data.slice(0, 3)]; }, buf.toString('base64'));
  const converted = await jpegOf();
  assert.equal(Buffer.from(extractIccFromJpeg(converted)).equals(Buffer.from(small)), true, 'el JPEG lleva el perfil de la imprenta');
  const rgbConv = await red(converted);
  // volver a sRGB: otro perfil incrustado y colores distintos
  await page.selectOption('details[data-sec="color"] select >> nth=0', 'srgb');
  await page.waitForTimeout(400);
  const plain = await jpegOf();
  assert.equal(readIccHeader(extractIccFromJpeg(plain)).description, 'sRGB (Editor de fotos)');
  const rgbPlain = await red(plain);
  assert.ok(Math.abs(rgbConv[0] - rgbPlain[0]) + Math.abs(rgbConv[1] - rgbPlain[1]) + Math.abs(rgbConv[2] - rgbPlain[2]) > 20, `la conversión cambia los colores (${rgbPlain} -> ${rgbConv})`);
  // simular en pantalla cambia la vista previa pero no lo exportado
  const prev = () => page.evaluate(() => { const c = document.getElementById('printCanvas'); return [...c.getContext('2d').getImageData(Math.floor(c.width * 0.1), Math.floor(c.height * 0.1), 1, 1).data.slice(0, 3)]; });
  const before = await prev();
  await page.locator('#proofCheck').check(); await page.waitForTimeout(900);
  const after = await prev();
  assert.ok(Math.abs(before[0] - after[0]) + Math.abs(before[1] - after[1]) + Math.abs(before[2] - after[2]) > 8, `la simulación cambia la vista previa (${before} -> ${after})`);
  await shot(page, '26-color-imprenta');
  await ctx.close();
});

t('sangrado y marcas de corte en el PDF: la página crece y el PDF declara TrimBox y BleedBox', async () => {
  const { page, ctx } = await newPage();
  await openPhotos(page, [{ bg: '#c05030' }]);
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.locator('[data-job="all"] input').check();
  // sangrado 3 mm (deslizador) y marcas
  await page.locator('details[data-sec="color"] .srow', { has: page.locator('label', { hasText: /^Sangrado$/ }) }).locator('input[type=range]').evaluate((el) => { el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('details[data-sec="color"] label.check', { hasText: 'Marcas de corte' }).locator('input').check();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__app.printUI.getSpec().bleedMm), 3);
  assert.equal(await page.evaluate(() => window.__app.printUI.getSpec().marks), true);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#btnPdf')]);
  const path = await dl.path();
  try {
    const sizeMm = (w, h) => `${(w * 25.4 / 72).toFixed(1)} x ${(h * 25.4 / 72).toFixed(1)}`;
    const info = execFileSync('pdfinfo', ['-box', path]).toString();
    const m = info.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
    assert.ok(m, info);
    const [w, h] = [Number(m[1]), Number(m[2])];
    // 10×15 cm de papel (4×6 in = 152,4 × 101,6 mm) + 2 × (3 mm de sangrado + 7 mm de marcas)
    assert.ok(Math.abs(w * 25.4 / 72 - 172.4) < 0.7 && Math.abs(h * 25.4 / 72 - 121.6) < 0.7, `tamaño de página ${sizeMm(w, h)} mm`);
    assert.match(info, /TrimBox:\s+/); assert.match(info, /BleedBox:\s+/);
    const r = execFileSync('python3', ['-c', `
from pypdf import PdfReader
p = PdfReader(${JSON.stringify(path)}).pages[0]
mm = lambda v: round(float(v) * 25.4 / 72, 1)
print([mm(v) for v in p.trimbox], [mm(v) for v in p.bleedbox], p['/Resources']['/XObject']['/Im0']['/ColorSpace'][0])`]).toString();
    assert.match(r, /\[10\.0, 10\.0, 162\.4, 111\.6\] \[7\.0, 7\.0, 165\.4, 114\.6\] \/ICCBased/, r);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await ctx.close();
});

t('teléfono: el modo Imprimir y la tira de fotos caben y se pueden usar con el dedo', async () => {
  const { page, ctx } = await newPage({ width: 390, height: 844 }, { touch: true });
  await openPhotos(page, [{}, { bg: '#30a050' }]);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, fs: document.getElementById('filmstrip').getBoundingClientRect().toJSON(), v: document.getElementById('view').getBoundingClientRect().toJSON() }));
  assert.ok(m.sw <= m.cw + 1, `desborda: ${m.sw} > ${m.cw}`);
  assert.ok(m.v.height > 120, `foto muy pequeña: ${m.v.height}`);
  await shot(page, '16-telefono-editar');
  await page.click('#modeSwitch button[data-mode="print"]');
  await page.waitForFunction(() => document.getElementById('printCanvas').width > 100);
  await page.waitForTimeout(300);
  const p = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, c: document.getElementById('printCanvas').getBoundingClientRect().toJSON() }));
  assert.ok(p.sw <= p.cw + 1, `desborda en Imprimir: ${p.sw} > ${p.cw}`);
  assert.ok(p.c.width > 100 && p.c.width <= 390);
  await shot(page, '17-telefono-imprimir');
  await ctx.close();
});

const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null; // ONLY=RAW node tests/workflow.test.mjs : solo las pruebas cuyo nombre coincida
for (const [name, fn] of tests) {
  if (only && !only.test(name)) continue;
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FALLA ${name}\n        ${String(e.message).split('\n').slice(0, 3).join('\n        ')}`); process.exitCode = 1; }
}
const real = [...new Set(errors)].filter((e) => !/favicon/.test(e) && !/No se pudo revelar el RAW \(vac/.test(e)); // el segundo es el error esperado de la prueba del RAW roto
if (real.length) { console.log('\nErrores en la consola del navegador:\n' + real.join('\n')); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pruebas de flujo correctas`);
await browser.close(); server.close();
