// Pruebas del compositor de hojas: dibuja en un navegador real y comprueba píxeles.
// Uso: node tests/compose.test.mjs
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';

const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find(existsSync);
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
await page.waitForFunction(() => window.__ready === true);

await page.evaluate(() => {
  const { compose, printspec } = window.__t;
  const H = {};
  H.solid = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; };
  H.split = (w, h, a, b) => { const c = H.solid(w, h, a); const g = c.getContext('2d'); g.fillStyle = b; g.fillRect(w / 2, 0, w / 2, h); return c; };
  H.item = (color, aspect = 1.5, caption = '') => ({ aspect, caption, render: (w, hh) => { const k = Math.max(w, hh * aspect); return H.solid(Math.ceil(k), Math.ceil(k / aspect), color); } });
  H.spec = (over = {}) => { const s = printspec.defaultPrintSpec(); return printspec.migratePrintSpec({ ...s, dpi: 150, orientation: 'landscape', paper: '10x15', ...over, frame: { ...s.frame, ...(over.frame || {}) }, logo: { ...s.logo, enabled: false, ...(over.logo || {}) }, caption: { ...s.caption, ...(over.caption || {}) } }); };
  H.run = (spec, items, assets = {}, opts = {}) => { H.last = compose.composePage(spec, items, assets, { dpi: 100, ...opts }); return H.last; };
  H.px = (xf, yf) => { const c = H.last.canvas; const d = c.getContext('2d').getImageData(Math.min(c.width - 1, Math.floor(xf * c.width)), Math.min(c.height - 1, Math.floor(yf * c.height)), 1, 1).data; return [d[0], d[1], d[2]]; };
  H.rows = (xf, pred) => { const c = H.last.canvas; const x = Math.floor(xf * c.width); const d = c.getContext('2d').getImageData(x, 0, 1, c.height).data; const out = []; for (let y = 0; y < c.height; y++) if (pred([d[y * 4], d[y * 4 + 1], d[y * 4 + 2]])) out.push(y); return out; };
  window.__c = H;
});

const run = (fn, ...a) => page.evaluate(fn, ...a);
const isColor = (p, c, tol = 12) => p.every((v, i) => Math.abs(v - c[i]) <= tol);
let passed = 0; const tests = []; const t = (n, f) => tests.push([n, f]);

t('hoja 10×15 cm a 100 ppp mide 600×400 px y el marco blanco rodea la foto', async () => {
  const r = await run(() => { const { canvas } = __c.run(__c.spec({ frame: { kind: 'border', widthMm: 6, color: '#ffffff' } }), [__c.item('#ff0000')]); return { w: canvas.width, h: canvas.height, edge: __c.px(0.01, 0.01), center: __c.px(0.5, 0.5) }; });
  assert.deepEqual([r.w, r.h], [600, 400]);
  assert.ok(isColor(r.edge, [255, 255, 255]), `borde: ${r.edge}`); assert.ok(isColor(r.center, [255, 0, 0]), `centro: ${r.center}`);
});

t('sin marco, la foto ocupa toda la hoja', async () => {
  const r = await run(() => { __c.run(__c.spec({ frame: { kind: 'none' } }), [__c.item('#00aa00')]); return [__c.px(0.01, 0.01), __c.px(0.99, 0.99)]; });
  assert.ok(isColor(r[0], [0, 170, 0]) && isColor(r[1], [0, 170, 0]), JSON.stringify(r));
});

t('el color de marco y del fondo se respetan', async () => {
  const r = await run(() => { __c.run(__c.spec({ frame: { kind: 'border', widthMm: 8, color: '#102030' }, background: '#ffee00', marginMm: 4 }), [__c.item('#ff0000')]); return { page: __c.px(0.005, 0.005), frame: __c.px(0.06, 0.5) }; });
  assert.ok(isColor(r.page, [255, 238, 0]), `fondo: ${r.page}`); assert.ok(isColor(r.frame, [16, 32, 48]), `marco: ${r.frame}`);
});

t('polaroid: el borde de abajo es bastante mayor que el de arriba', async () => {
  const r = await run(() => {
    __c.run(__c.spec({ frame: { kind: 'polaroid', widthMm: 5, color: '#ffffff' }, orientation: 'portrait' }), [__c.item('#ff0000', 0.75)]);
    const red = __c.rows(0.5, (p) => p[0] > 200 && p[1] < 60); const H = __c.last.canvas.height;
    return { top: red[0], bottom: H - 1 - red[red.length - 1] };
  });
  assert.ok(r.bottom > r.top * 2.5, `arriba=${r.top} abajo=${r.bottom}`);
});

t('esquinas redondeadas: la esquina de la ventana queda con el color del marco', async () => {
  const r = await run(() => {
    const s = __c.spec({ frame: { kind: 'rounded', widthMm: 8, radiusMm: 8, color: '#ffffff' } }); const { canvas } = __c.run(s, [__c.item('#ff0000')]);
    const mm = 100 / 25.4; const bw = Math.round(8 * mm); const g = canvas.getContext('2d').getImageData(bw + 1, bw + 1, 1, 1).data; // esquina exacta de la ventana
    return { corner: [g[0], g[1], g[2]], center: __c.px(0.5, 0.5) };
  });
  assert.ok(isColor(r.corner, [255, 255, 255], 30), `esquina: ${r.corner}`); assert.ok(isColor(r.center, [255, 0, 0]));
});

t('logo: aparece donde se indica y no aparece si está desactivado', async () => {
  const [on, off] = await run(() => {
    const logo = { img: __c.solid(100, 50, '#0000ff'), w: 100, h: 50 };
    const sp = (en) => __c.spec({ frame: { kind: 'border', widthMm: 12, color: '#ffffff' }, logo: { enabled: en, x: 0.5, y: 0.9, widthPct: 20 } });
    __c.run(sp(true), [__c.item('#ff0000')], { logo }); const on = __c.px(0.5, 0.9);
    __c.run(sp(false), [__c.item('#ff0000')], { logo }); return [on, __c.px(0.5, 0.9)];
  });
  assert.ok(isColor(on, [0, 0, 255]), `logo: ${on}`); assert.ok(!isColor(off, [0, 0, 255]), `desactivado: ${off}`);
});

t('logo: la opacidad lo mezcla con el fondo y la placa lo rodea', async () => {
  const r = await run(() => {
    const logo = { img: __c.solid(100, 50, '#000000'), w: 100, h: 50 };
    const base = { frame: { kind: 'none' } };
    __c.run(__c.spec({ ...base, logo: { enabled: true, x: 0.5, y: 0.5, widthPct: 30, opacity: 0.5 } }), [__c.item('#ffffff')], { logo }); const half = __c.px(0.5, 0.5);
    __c.run(__c.spec({ ...base, logo: { enabled: true, x: 0.5, y: 0.5, widthPct: 30, plate: true, plateColor: '#ffff00' } }), [__c.item('#ff0000')], { logo });
    const lr = __c.last.canvas.width * 0.3; const px = Math.floor(__c.last.canvas.width * 0.5 - lr / 2 - 4); const py = Math.floor(__c.last.canvas.height * 0.5);
    const d = __c.last.canvas.getContext('2d').getImageData(px, py, 1, 1).data;
    return { half, plate: [d[0], d[1], d[2]] };
  });
  assert.ok(r.half[0] > 100 && r.half[0] < 160, `opacidad 50%: ${r.half}`); assert.ok(isColor(r.plate, [255, 255, 0], 20), `placa: ${r.plate}`);
});

t('texto del pie: se dibuja en la banda indicada y no si está desactivado', async () => {
  const [on, off] = await run(() => {
    const count = () => { const c = __c.last.canvas; const y0 = Math.floor(c.height * 0.94); const d = c.getContext('2d').getImageData(0, y0, c.width, Math.floor(c.height * 0.05)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 120) n++; return n; };
    const s = (en) => __c.spec({ frame: { kind: 'border', widthMm: 14, color: '#ffffff' }, caption: { enabled: en, text: 'LA CASONA', sizePt: 14, color: '#000000', y: 0.965 } });
    __c.run(s(true), [__c.item('#ff0000', 1.5, 'LA CASONA')]); const on = count();
    __c.run(s(false), [__c.item('#ff0000', 1.5, 'LA CASONA')]); return [on, count()];
  });
  assert.ok(on > 50, `texto no dibujado: ${on}`); assert.equal(off, 0);
});

t('varias por hoja: 2×2 reparte cuatro fotos distintas en su celda', async () => {
  const r = await run(() => {
    __c.run(__c.spec({ paper: 'a5', orientation: 'portrait', cols: 2, rows: 2, gutterMm: 3, frame: { kind: 'none' } }), [__c.item('#ff0000', 0.7), __c.item('#00ff00', 0.7), __c.item('#0000ff', 0.7), __c.item('#ffff00', 0.7)]);
    return [__c.px(0.25, 0.25), __c.px(0.75, 0.25), __c.px(0.25, 0.75), __c.px(0.75, 0.75)];
  });
  assert.ok(isColor(r[0], [255, 0, 0]) && isColor(r[1], [0, 255, 0]) && isColor(r[2], [0, 0, 255]) && isColor(r[3], [255, 255, 0]), JSON.stringify(r));
});

t('cubrir recorta la foto y contener deja franjas del fondo', async () => {
  const r = await run(() => {
    const wide = { aspect: 3, render: (w, h) => { const k = Math.max(w, h * 3); return __c.split(Math.ceil(k), Math.ceil(k / 3), '#ff0000', '#0000ff'); } };
    const base = { paper: 'sq20', frame: { kind: 'none' }, background: '#00ff00' };
    __c.run(__c.spec({ ...base, photoFit: 'cover' }), [wide]); const cov = [__c.px(0.5, 0.02), __c.px(0.25, 0.5), __c.px(0.75, 0.5)];
    __c.run(__c.spec({ ...base, photoFit: 'contain' }), [wide]); const con = [__c.px(0.5, 0.02), __c.px(0.25, 0.5), __c.px(0.75, 0.5)];
    return { cov, con };
  });
  assert.ok(!isColor(r.cov[0], [0, 255, 0]) && isColor(r.cov[1], [255, 0, 0]) && isColor(r.cov[2], [0, 0, 255]), `cubrir: ${JSON.stringify(r.cov)}`);
  assert.ok(isColor(r.con[0], [0, 255, 0]), `contener: franja ${r.con[0]}`); assert.ok(isColor(r.con[1], [255, 0, 0]));
});

t('marco cargado: se detecta su ventana y la foto se ve dentro, el marco fuera', async () => {
  const r = await run(async () => {
    const f = document.createElement('canvas'); f.width = 600; f.height = 400; const g = f.getContext('2d');
    g.fillStyle = '#663300'; g.fillRect(0, 0, 600, 400); g.clearRect(60, 50, 480, 300);
    const blob = await new Promise((res) => f.toBlob(res, 'image/png'));
    const asset = await __t.compose.loadImageAsset(blob); const win = __t.compose.detectWindow(asset);
    const full = { ...asset, window: win };
    __c.run(__c.spec({ paper: '10x15', orientation: 'portrait', frame: { kind: 'custom', fit: 'contain' } }), [__c.item('#00ff00')], { frame: full });
    return { win, size: [__c.last.canvas.width, __c.last.canvas.height], center: __c.px(0.5, 0.5), edge: __c.px(0.02, 0.5) };
  });
  assert.ok(r.win && Math.abs(r.win.x - 0.1) < 0.02 && Math.abs(r.win.w - 0.8) < 0.03, JSON.stringify(r.win));
  assert.ok(r.size[0] > r.size[1], `el marco manda la orientación: ${r.size}`);
  assert.ok(isColor(r.center, [0, 255, 0]), `foto: ${r.center}`); assert.ok(isColor(r.edge, [102, 51, 0], 20), `marco: ${r.edge}`);
});

t('logo SVG se carga y se dibuja', async () => {
  const r = await run(async () => {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#ff00ff"/></svg>'], { type: 'image/svg+xml' });
    const logo = await __t.compose.loadImageAsset(svg);
    __c.run(__c.spec({ frame: { kind: 'none' }, logo: { enabled: true, x: 0.5, y: 0.5, widthPct: 30 } }), [__c.item('#ffffff')], { logo });
    return { dims: [logo.w, logo.h], px: __c.px(0.5, 0.5) };
  });
  assert.deepEqual(r.dims, [200, 100]); assert.ok(isColor(r.px, [255, 0, 255]), String(r.px));
});

t('ppp altos bajan solos si la hoja sería gigante', async () => {
  const r = await run(() => { const s = __c.spec({ paper: 'custom', custom: { w: 1000, h: 1000 } }); return __t.compose.pageGeometry(s, 600, 1.5, null); });
  assert.ok(r.px.w * r.px.h <= 120e6 + 1 && r.dpi < 600, JSON.stringify(r));
  const ok = await run(() => __t.compose.pageGeometry(__c.spec({ paper: 'a4', orientation: 'portrait' }), 300, 1.5, null));
  assert.deepEqual([ok.px.w, ok.px.h, ok.dpi], [2480, 3508, 300]);
});

t('la hoja se convierte en JPEG y en un PDF que se puede abrir', async () => {
  const r = await run(async () => {
    const { canvas, geometry } = __c.run(__c.spec({ frame: { kind: 'border', widthMm: 5 } }), [__c.item('#cc3300')], {}, { dpi: 150 });
    const jpeg = await __t.compose.canvasToJpegBytes(canvas, 0.9);
    const bytes = __t.pdf.buildPdf([{ jpeg, imgW: canvas.width, imgH: canvas.height, widthMm: geometry.mm.w, heightMm: geometry.mm.h }], { title: 'Prueba' });
    return { head: [...jpeg.slice(0, 3)], pdf: Array.from(bytes), pageMm: geometry.mm };
  });
  assert.deepEqual(r.head, [0xff, 0xd8, 0xff]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/claude-0/hoja-prueba.pdf', Buffer.from(r.pdf));
  const { execFileSync } = await import('node:child_process');
  try {
    const info = execFileSync('pdfinfo', ['/tmp/claude-0/hoja-prueba.pdf']).toString();
    assert.match(info, /Pages:\s+1/); assert.match(info, /Page size:\s+432 x 288 pts/);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FALLA ${name}\n        ${String(e.message).split('\n')[0]}`); process.exitCode = 1; }
}
const real = [...new Set(errors)].filter((e) => !/favicon/.test(e));
if (real.length) { console.log('\nErrores en la consola:\n' + real.join('\n')); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pruebas de composición correctas`);
await browser.close(); server.close();
