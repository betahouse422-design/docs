// Prueba de extremo a extremo con la interfaz real (Chromium sin pantalla).
// Uso: node tests/ui.test.mjs [carpeta-para-capturas]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';

const shotsDir = process.argv[2];
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find(existsSync);
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});

const errors = [];
async function newPage(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: !!opts.touch, isMobile: !!opts.touch, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html?nosw`);
  await page.waitForFunction(() => window.__appReady === true);
  return { page, ctx };
}

const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: `${shotsDir}/${name}.png` }); };
let passed = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// lee el color central del canvas de la vista (promedio de un parche)
const centerColor = (page) => page.evaluate(() => {
  const { engine } = window.__app; const { width, height, data } = engine.readPixels();
  const x = Math.floor(width * 0.72); const y = Math.floor(height * 0.30); const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
});
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const setSlider = async (page, label, value, scope = '#tabBody') => {
  const row = page.locator(`${scope} .srow`, { has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) }).first();
  const input = row.locator('input[type=range]');
  await input.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
  await frame(page);
};

t('arranca vacío y con los botones de edición desactivados', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  assert.equal(await page.locator('#empty').isVisible(), true);
  assert.equal(await page.locator('#btnExport').isDisabled(), true);
  assert.equal(await page.locator('#btnUndo').isDisabled(), true);
  await shot(page, '01-vacio');
  await ctx.close();
});

t('abre la imagen de ejemplo y muestra la foto y el histograma', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample');
  await page.waitForFunction(() => window.__app.engine.hasSource());
  await frame(page);
  assert.equal(await page.locator('#canvasWrap').isVisible(), true);
  assert.equal(await page.locator('#btnExport').isDisabled(), false);
  const w = await page.evaluate(() => document.getElementById('view').clientWidth);
  assert.ok(w > 300, `canvas muy pequeño: ${w}`);
  await page.waitForTimeout(200);
  const histDrawn = await page.evaluate(() => { const c = document.getElementById('hist'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; return d.some((v, i) => i % 4 === 3 && v > 0); });
  assert.equal(histDrawn, true, 'histograma vacío');
  const tabs = await page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(); const l = document.querySelector('#tabs button:last-child').getBoundingClientRect(); return { p: p.right, l: l.right }; });
  assert.ok(tabs.l <= tabs.p + 1, `la pestaña Presets se corta: ${tabs.l} > ${tabs.p}`);
  await shot(page, '02-ejemplo');
  await ctx.close();
});

t('mover un deslizador cambia la imagen; deshacer y rehacer la restauran', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  const before = await centerColor(page);
  await setSlider(page, 'Exposición', -1.5);
  const dark = await centerColor(page);
  assert.ok(dark[0] < before[0] - 20, `no oscureció: ${before} -> ${dark}`);
  assert.equal(await page.locator('#btnUndo').isDisabled(), false);
  await page.click('#btnUndo'); await frame(page);
  const back = await centerColor(page);
  assert.ok(Math.abs(back[0] - before[0]) <= 2, `deshacer no restauró: ${before} -> ${back}`);
  await page.click('#btnRedo'); await frame(page);
  const again = await centerColor(page);
  assert.ok(Math.abs(again[0] - dark[0]) <= 2, 'rehacer no reaplicó');
  await ctx.close();
});

t('doble clic en la etiqueta restablece el deslizador', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await setSlider(page, 'Contraste', 60);
  assert.equal(await page.evaluate(() => window.__app.store.get().light.contrast), 60);
  await page.locator('#tabBody label', { hasText: /^Contraste$/ }).first().dblclick();
  assert.equal(await page.evaluate(() => window.__app.store.get().light.contrast), 0);
  await ctx.close();
});

t('Antes/Después muestra el original mientras se mantiene pulsado', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  const orig = await centerColor(page);
  await setSlider(page, 'Exposición', -2);
  const edited = await centerColor(page);
  assert.ok(edited[0] < orig[0] - 30);
  const box = await page.locator('#btnCompare').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await frame(page);
  const shown = await centerColor(page);
  assert.ok(Math.abs(shown[0] - orig[0]) <= 2, 'no mostró el original');
  assert.equal(await page.locator('#compareTag').isVisible(), true);
  await page.mouse.up(); await frame(page);
  const after = await centerColor(page);
  assert.ok(Math.abs(after[0] - edited[0]) <= 2, 'no volvió a la edición');
  await ctx.close();
});

t('color por rangos: elegir un rango y mover sus deslizadores', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.locator('#tabAdjust summary', { hasText: 'Color por rangos' }).click();
  await page.locator('.chip[data-range="blue"]').click();
  await setSlider(page, 'Saturación', -100, '#tabAdjust details:nth-of-type(3)');
  const v = await page.evaluate(() => window.__app.store.get().color.hsl.blue.s);
  assert.equal(v, -100);
  assert.equal(await page.evaluate(() => window.__app.store.get().color.hsl.red.s), 0, 'no debe tocar otros rangos');
  await ctx.close();
});

t('curvas: arrastrar crea un punto, se refleja en las ediciones y oscurece', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  const before = await centerColor(page);
  await page.click('#tabs button[data-tab="curves"]');
  const box = await page.locator('#curveCanvas').boundingBox();
  const at = (x, y) => [box.x + box.width * x, box.y + box.height * (1 - y)];
  await page.mouse.move(...at(0.5, 0.5)); await page.mouse.down();
  await page.mouse.move(...at(0.5, 0.3), { steps: 4 }); await page.mouse.up(); await frame(page);
  const pts = await page.evaluate(() => window.__app.store.get().curves.master);
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[1][1] - 0.3) < 0.05, JSON.stringify(pts));
  const after = await centerColor(page);
  assert.ok(after[0] < before[0] - 10, `${before} -> ${after}`);
  await shot(page, '03-curvas');
  // doble clic en el punto lo borra
  await page.mouse.dblclick(...at(0.5, 0.3)); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().curves.master.length), 2);
  await ctx.close();
});

t('recorte: proporción 1:1 y aplicar cambia el tamaño de la salida', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  const [w0, h0] = await page.evaluate(() => window.__app.engine.lastSize);
  await page.click('#tabs button[data-tab="geometry"]');
  await page.locator('#aspectChips .chip[data-a="1:1"]').click(); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.ui.cropMode), true);
  await shot(page, '04-recorte');
  await page.locator('#cropButtons button', { hasText: 'Aplicar recorte' }).click(); await frame(page);
  const [w1, h1] = await page.evaluate(() => window.__app.engine.lastSize);
  assert.ok(Math.abs(w1 - h1) <= 1, `no es cuadrado: ${w1}x${h1}`);
  assert.ok(w1 < w0 && h1 === h0 || w1 <= w0, `${w0}x${h0} -> ${w1}x${h1}`);
  await page.locator('#cropButtons button', { hasText: 'Quitar recorte' }).click(); await frame(page);
  const [w2, h2] = await page.evaluate(() => window.__app.engine.lastSize);
  assert.equal(w2 / h2 > 1.3, true);
  await ctx.close();
});

t('recorte: arrastrar una esquina del marco con el ratón', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="geometry"]');
  await page.locator('#cropButtons button', { hasText: 'Recortar' }).click(); await frame(page);
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 }); await page.mouse.up();
  const r = await page.evaluate(() => window.__app.ui.cropDraft);
  assert.ok(r.w < 0.7 && r.w > 0.5 && r.h < 0.7 && r.h > 0.5, JSON.stringify(r));
  await page.locator('#cropButtons button', { hasText: 'Cancelar' }).click();
  assert.deepEqual(await page.evaluate(() => window.__app.store.get().geometry.crop), { x: 0, y: 0, w: 1, h: 1 });
  await ctx.close();
});

t('girar 90° intercambia las dimensiones y es deshacible', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="geometry"]');
  const s0 = await page.evaluate(() => window.__app.engine.lastSize);
  await page.locator('button', { hasText: '⟳ 90°' }).click(); await frame(page);
  const s1 = await page.evaluate(() => window.__app.engine.lastSize);
  assert.ok(s0[0] / s0[1] > 1 && s1[0] / s1[1] < 1, `${s0} -> ${s1}`);
  await page.click('#btnUndo'); await frame(page);
  const s2 = await page.evaluate(() => window.__app.engine.lastSize);
  assert.ok(s2[0] / s2[1] > 1);
  await ctx.close();
});

t('máscaras: añadir un degradado, ajustar y arrastrar su punto', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="masks"]');
  await page.locator('button', { hasText: '+ Degradado' }).click(); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().masks.length), 1);
  await setSlider(page, 'Exposición', -2, '#tabMasks');
  assert.equal(await page.evaluate(() => window.__app.store.get().masks[0].adjust.exposure), -2);
  const box = await page.locator('#overlay').boundingBox();
  await shot(page, '05-mascara');
  // arrastrar el punto p0 (x0=.5, y0=.35)
  const sx = box.x + box.width * 0.5; const sy = box.y + box.height * 0.35;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.15, { steps: 5 }); await page.mouse.up(); await frame(page);
  const m = await page.evaluate(() => window.__app.store.get().masks[0]);
  assert.ok(Math.abs(m.y0 - 0.15) < 0.04, `y0=${m.y0}`);
  // eliminar
  await page.locator('button', { hasText: 'Eliminar máscara' }).click();
  assert.equal(await page.evaluate(() => window.__app.store.get().masks.length), 0);
  await ctx.close();
});

t('máscara radial: mover el centro cambia dónde se aplica', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="masks"]');
  await page.locator('button', { hasText: '+ Radial' }).click(); await frame(page);
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4, { steps: 5 }); await page.mouse.up();
  const m = await page.evaluate(() => window.__app.store.get().masks[0]);
  assert.ok(Math.abs(m.cx - 0.3) < 0.04 && Math.abs(m.cy - 0.4) < 0.04, `${m.cx},${m.cy}`);
  await ctx.close();
});

t('presets: previsualizar con intensidad, cancelar y aplicar', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="presets"]');
  await page.locator('.pitem', { hasText: 'Cálido' }).click(); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().color.temperature), 28);
  await setSlider(page, 'Intensidad', 50, '#tabPresets');
  assert.equal(await page.evaluate(() => window.__app.store.get().color.temperature), 14);
  await page.locator('#tabPresets button', { hasText: 'Cancelar' }).click(); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().color.temperature), 0);
  await page.locator('.pitem', { hasText: 'Vívido' }).click();
  await page.locator('#tabPresets button', { hasText: 'Aplicar' }).click(); await frame(page);
  assert.ok(await page.evaluate(() => window.__app.store.get().color.saturation) > 0);
  assert.equal(await page.evaluate(() => window.__app.store.canUndo()), true);
  await page.click('#btnUndo'); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().color.saturation), 0);
  await ctx.close();
});

t('presets propios: guardar, persistir tras recargar y borrar', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await setSlider(page, 'Contraste', 40);
  await page.click('#tabs button[data-tab="presets"]');
  await page.fill('#tabPresets input[type=text]', 'Mi look');
  await page.locator('#tabPresets button', { hasText: 'Guardar ajustes actuales' }).click();
  await page.waitForSelector('.pitem:has-text("Mi look")');
  await page.reload(); await page.waitForFunction(() => window.__appReady === true);
  await page.waitForTimeout(300);
  await page.click('#tabs button[data-tab="presets"]');
  await page.selectOption('#presetSource', 'mine');
  assert.equal(await page.locator('.pitem', { hasText: 'Mi look' }).count(), 1, 'el preset no sobrevivió a la recarga');
  page.on('dialog', (d) => d.accept());
  await page.locator('.pitem', { hasText: 'Mi look' }).locator('.x').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.pitem')].some((n) => n.textContent.includes('Mi look')));
  await ctx.close();
});

t('las ediciones de una foto se guardan y se recuperan al reabrirla', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 200; c.getContext('2d').fillRect(0, 0, 300, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'prueba.png', { type: 'image/png', lastModified: 12345 });
    await window.__app.openFile(file);
    window.__app.store.set('light.exposure', 1.25); window.__app.store.commit();
    await new Promise((r) => setTimeout(r, 700));
    window.__app.store.load({}); // simular otra sesión
    await window.__app.openFile(file);
    return window.__app.store.get().light.exposure;
  });
  assert.equal(result, 1.25);
  await ctx.close();
});

t('paquete Lightroom abierto: carga, busca, filtra por grupo y aplica con intensidad', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="presets"]');
  await page.selectOption('#presetSource', 'peva3');
  await page.waitForSelector('.pitem');
  const info = await page.evaluate(() => { const p = window.__app.ui.packs.peva3; return { n: p.presets.length, groups: p.groups.length, lic: p.source.license }; });
  assert.ok(info.n >= 400, `pocos presets: ${info.n}`); assert.equal(info.lic, 'MIT'); assert.ok(info.groups >= 10);
  assert.ok(await page.locator('.pitem').count() <= 60, 'la lista debe paginarse');
  assert.ok(await page.locator('button', { hasText: 'Mostrar más' }).count() === 1);
  assert.match(await page.locator('#presetListBox .hint').last().innerText(), /MIT/);
  // búsqueda sin distinguir mayúsculas ni acentos
  await page.fill('#presetSearch', 'portra');
  const n1 = await page.locator('.pitem').count();
  assert.ok(n1 >= 1 && n1 < 60, `búsqueda: ${n1}`);
  assert.ok((await page.locator('.pitem').first().innerText()).toLowerCase().includes('portra'));
  // filtro por grupo
  await page.fill('#presetSearch', '');
  const group = await page.evaluate(() => window.__app.ui.packs.peva3.groups[1]);
  await page.selectOption('#presetGroup', group);
  const names = await page.locator('.pitem').count();
  const expected = await page.evaluate((g) => window.__app.ui.packs.peva3.presets.filter((p) => p.group === g).length, group);
  assert.equal(names, Math.min(60, expected));
  // aplicar uno con intensidad (quitando antes el filtro de grupo)
  await page.selectOption('#presetGroup', '');
  await page.fill('#presetSearch', 'portra');
  await page.locator('.pitem').first().click(); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.dirty()), true, 'el preset debe cambiar las ediciones');
  await setSlider(page, 'Intensidad', 0, '#tabPresets');
  assert.equal(await page.evaluate(() => window.__app.store.dirty()), false, 'al 0 % no debe cambiar nada');
  await page.locator('#tabPresets button', { hasText: 'Cancelar' }).click();
  await shot(page, '08-paquete-presets');
  await ctx.close();
});

t('importar archivos .xmp, .lrtemplate y .pp3 desde el selector', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="presets"]');
  const xmp = '<x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" crs:Name="Look XMP" crs:Contrast2012="+25" crs:Saturation="-10" crs:Dehaze="+20"></rdf:Description></rdf:RDF></x:xmpmeta>';
  const lrt = 's = {\n id = "X",\n title = "Look LRT",\n type = "Develop",\n value = {\n settings = {\n Clarity2012 = 40,\n Vibrance = 15,\n },\n },\n}';
  const pp3 = '[Exposure]\nCompensation=0.7\nContrast=10\n';
  await page.locator('#filePresets').setInputFiles([
    { name: 'a.xmp', mimeType: 'application/octet-stream', buffer: Buffer.from(xmp) },
    { name: 'b.lrtemplate', mimeType: 'application/octet-stream', buffer: Buffer.from(lrt) },
    { name: 'Perfil RT.pp3', mimeType: 'application/octet-stream', buffer: Buffer.from(pp3) },
  ]);
  await page.waitForSelector('.pitem:has-text("Look XMP")');
  assert.equal(await page.evaluate(() => window.__app.ui.presetSource), 'mine');
  for (const n of ['Look XMP', 'Look LRT', 'Perfil RT']) assert.equal(await page.locator('.pitem', { hasText: n }).count(), 1, n);
  const toast = await page.locator('#toast').innerText();
  assert.match(toast, /3 preset/);
  await page.locator('.pitem', { hasText: 'Look XMP' }).click(); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().light.contrast), 25);
  assert.equal(await page.evaluate(() => window.__app.store.get().color.saturation), -10);
  await page.locator('#tabPresets button', { hasText: 'Aplicar' }).click();
  await ctx.close();
});

t('importar un archivo que no es un preset muestra un error y no rompe nada', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="presets"]');
  await page.locator('#filePresets').setInputFiles([{ name: 'basura.xmp', mimeType: 'text/plain', buffer: Buffer.from('hola') }, { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('x') }]);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Problemas'));
  assert.equal(await page.evaluate(() => window.__app.ui.userPresets.length), 0);
  await setSlider(page, 'Brillo', 10, '#tabAdjust'); // la app sigue respondiendo
  await ctx.close();
});

t('exportar descarga un JPEG real a resolución completa', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await setSlider(page, 'Saturación', 30);
  await page.click('#btnExport');
  assert.equal(await page.locator('#exportDlg').evaluate((d) => d.open), true);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#expGo')]);
  assert.match(dl.suggestedFilename(), /-editada\.jpg$/);
  const path = await dl.path();
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(path);
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8); // cabecera JPEG
  assert.ok(buf.length > 20000, `archivo muy pequeño: ${buf.length}`);
  await ctx.close();
});

t('atajos de teclado: Ctrl+Z deshace', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await setSlider(page, 'Brillo', 50);
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => window.__app.store.get().light.brightness), 0);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await page.evaluate(() => window.__app.store.get().light.brightness), 50);
  await ctx.close();
});

t('Restablecer deja todo en neutro y se puede deshacer', async () => {
  const { page, ctx } = await newPage({ width: 1280, height: 800 });
  await page.click('#btnSample'); await frame(page);
  await setSlider(page, 'Contraste', 70); await setSlider(page, 'Saturación', 40);
  page.once('dialog', (d) => d.accept());
  await page.click('#btnReset'); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().light.contrast), 0);
  await page.click('#btnUndo'); await frame(page);
  assert.equal(await page.evaluate(() => window.__app.store.get().light.contrast), 70);
  await ctx.close();
});

t('teléfono (vertical, táctil): la foto y el panel caben sin desbordar', async () => {
  const { page, ctx } = await newPage({ width: 390, height: 844 }, { touch: true });
  await page.click('#btnSample'); await frame(page);
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    view: document.getElementById('view').getBoundingClientRect().toJSON(),
    panel: document.getElementById('panel').getBoundingClientRect().toJSON(),
    bar: document.querySelector('.bar').scrollWidth > document.querySelector('.bar').clientWidth,
  }));
  assert.ok(m.sw <= m.cw + 1, `scroll horizontal: ${m.sw} > ${m.cw}`);
  assert.ok(m.view.width <= 390 && m.view.width > 200, `vista: ${m.view.width}`);
  assert.ok(m.panel.top > m.view.bottom - 2, 'el panel debe quedar debajo de la foto');
  const ex = await page.locator('#btnExport').boundingBox();
  assert.ok(ex.x >= 0 && ex.x + ex.width <= 391, `Exportar queda fuera de la pantalla: ${ex.x}..${ex.x + ex.width}`);
  const last = await page.locator('#tabs button').last().boundingBox();
  assert.ok(last.x + last.width <= 391, 'la última pestaña queda fuera de la pantalla');
  await shot(page, '06-telefono');
  // el panel se desplaza y los deslizadores se pueden mover con el dedo
  await setSlider(page, 'Exposición', 1);
  assert.equal(await page.evaluate(() => window.__app.store.get().light.exposure), 1);
  await ctx.close();
});

t('teléfono: tocar y arrastrar el punto de una curva (táctil)', async () => {
  const { page, ctx } = await newPage({ width: 390, height: 844 }, { touch: true });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="curves"]');
  await page.locator('#curveCanvas').scrollIntoViewIfNeeded();
  const pts = await page.evaluate(async () => {
    const c = document.getElementById('curveCanvas'); const r = c.getBoundingClientRect();
    const fire = (type, fx, fy) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * (1 - fy) }));
    fire('pointerdown', 0.5, 0.5); fire('pointermove', 0.5, 0.35); fire('pointermove', 0.5, 0.3); fire('pointerup', 0.5, 0.3);
    return window.__app.store.get().curves.master;
  });
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[1][1] - 0.3) < 0.05);
  await ctx.close();
});

t('escritorio ancho: captura final con varios ajustes', async () => {
  const { page, ctx } = await newPage({ width: 1440, height: 900 });
  await page.click('#btnSample'); await frame(page);
  await page.click('#tabs button[data-tab="presets"]');
  await page.locator('.pitem', { hasText: 'Dramático' }).click();
  await page.locator('#tabPresets button', { hasText: 'Aplicar' }).click();
  await page.click('#tabs button[data-tab="adjust"]'); await frame(page); await page.waitForTimeout(250);
  await shot(page, '07-escritorio-dramatico');
  await ctx.close();
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FALLA ${name}\n        ${String(e.message).split('\n').slice(0, 3).join('\n        ')}`); process.exitCode = 1; }
}
const real = [...new Set(errors)].filter((e) => !/favicon/.test(e));
if (real.length) { console.log('\nErrores en la consola del navegador:\n' + real.join('\n')); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pruebas de interfaz correctas`);
await browser.close(); server.close();
