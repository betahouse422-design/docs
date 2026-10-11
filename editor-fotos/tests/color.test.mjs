// Pruebas de color para impresión: perfiles ICC (generación, incrustado en JPEG/PDF), conversión con Little CMS,
// simulación de impresión, sangrado y marcas de corte.
// Uso: node tests/color.test.mjs
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';
import { makeMatrixProfile, makeSrgbProfile, readIccHeader, embedIccInJpeg, extractIccFromJpeg, SRGB_COLORANTS } from '../src/icc.js';
import { buildPdf } from '../src/pdf.js';

const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find(existsSync);
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
await page.waitForFunction(() => window.__ready === true);

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ±${tol}`);
let passed = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);
const b64 = (u8) => Buffer.from(u8).toString('base64');

// Perfiles de prueba hechos aquí mismo: uno de gamut chico y otro igual a sRGB pero con gamma 1.8
const SMALL = makeMatrixProfile({ description: 'Gamut chico', colorants: [[0.3, 0.2, 0.02], [0.3, 0.55, 0.1], [0.13, 0.07, 0.62]], gamma: 2.2 });
const G18 = makeMatrixProfile({ description: 'Gamma 1.8', colorants: SRGB_COLORANTS, gamma: 1.8 });
const COLORS = [[200, 100, 50], [255, 0, 0], [30, 200, 60], [128, 128, 128], [10, 10, 10]];

t('perfil sRGB generado: cabecera válida y Little CMS (Pillow) lo abre y lo trata como sRGB', async () => {
  const p = makeSrgbProfile();
  const h = readIccHeader(p);
  assert.deepEqual([h.version, h.cls, h.space, h.pcs, h.description], ['2.1', 'mntr', 'RGB', 'XYZ', 'sRGB (Editor de fotos)']);
  assert.equal(p.length, h.size);
  assert.equal(readIccHeader(new Uint8Array(200)), null, 'basura no es un perfil');
  assert.equal(makeSrgbProfile().join(), p.join(), 'es reproducible');
  const dir = mkdtempSync(join(tmpdir(), 'icc-')); const f = join(dir, 's.icc'); writeFileSync(f, p);
  try {
    const out = execFileSync('python3', ['-c', `
from PIL import ImageCms, Image
p = ImageCms.getOpenProfile(${JSON.stringify(f)})
t = ImageCms.buildTransform(p, ImageCms.createProfile('sRGB'), 'RGB', 'RGB')
im = Image.new('RGB', (4, 1)); cols = [(200,100,50),(255,0,0),(30,200,60),(10,10,10)]
for i, c in enumerate(cols): im.putpixel((i, 0), c)
o = ImageCms.applyTransform(im, t)
print([o.getpixel((i, 0)) for i in range(4)] == cols, ImageCms.getProfileDescription(p).strip())`]).toString();
    assert.match(out, /^True sRGB \(Editor de fotos\)/, out);
  } catch (e) { if (e.code !== 'ENOENT') throw e; } // sin Python/Pillow se omite
});

t('incrustar un perfil en un JPEG: se lee igual y respeta el JFIF; los perfiles grandes se parten en trozos', async () => {
  const jfif = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const body = [0xff, 0xdb, 0x00, 0x04, 1, 2, 0xff, 0xda, 0x00, 0x04, 9, 9, 0x11, 0x22, 0xff, 0xd9];
  const jpeg = new Uint8Array([...jfif, ...body]);
  const p = makeSrgbProfile();
  const out = embedIccInJpeg(jpeg, p);
  assert.deepEqual([...out.slice(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(out[20], 0xff); assert.equal(out[21], 0xe2, 'el APP2 va justo después del JFIF');
  assert.equal(extractIccFromJpeg(out).join(), p.join());
  assert.equal(out.length, jpeg.length + p.length + 18);
  assert.deepEqual([...out.slice(out.length - body.length)], body, 'los datos de imagen quedan intactos');
  const big = new Uint8Array(150000).map((_, i) => (i * 31) & 255);
  const out2 = embedIccInJpeg(jpeg, big);
  assert.equal(extractIccFromJpeg(out2).join() === big.join(), true, 'ida y vuelta con 3 trozos');
  assert.equal(extractIccFromJpeg(jpeg), null);
  assert.throws(() => embedIccInJpeg(new Uint8Array([1, 2, 3]), p), /JPEG/);
});

t('JPEG con perfil: un navegador y Pillow lo abren y reportan el perfil', async () => {
  const jpgB64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32; const x = c.getContext('2d'); x.fillStyle = '#c86432'; x.fillRect(0, 0, 32, 32);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  const jpeg = Uint8Array.from(Buffer.from(jpgB64, 'base64'));
  const out = embedIccInJpeg(jpeg, makeSrgbProfile());
  const ok = await page.evaluate(async (b) => { const blob = new Blob([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }); const bmp = await createImageBitmap(blob); return [bmp.width, bmp.height]; }, b64(out));
  assert.deepEqual(ok, [32, 32]);
  const dir = mkdtempSync(join(tmpdir(), 'icc-')); const f = join(dir, 'a.jpg'); writeFileSync(f, out);
  try {
    const r = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(f)}); print(len(im.info.get('icc_profile', b'')), im.size)`]).toString();
    assert.match(r, new RegExp(`^${makeSrgbProfile().length} \\(32, 32\\)`));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
});

t('PDF con perfil ICC y cajas de corte: Pillow/pypdf/pdfinfo lo abren y ven ICCBased, TrimBox y BleedBox', async () => {
  const jpgB64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 60; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#3366cc'; x.fillRect(0, 0, 60, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  const jpeg = Uint8Array.from(Buffer.from(jpgB64, 'base64'));
  const icc = makeSrgbProfile();
  const pdf = buildPdf([{ jpeg, imgW: 60, imgH: 40, widthMm: 160, heightMm: 110, trimMm: { x: 10, y: 5, w: 150, h: 100 }, bleedMm: { x: 7, y: 2, w: 156, h: 106 } }, { jpeg, imgW: 60, imgH: 40, widthMm: 160, heightMm: 110 }], { title: 'T', icc });
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-')); const f = join(dir, 'a.pdf'); writeFileSync(f, pdf);
  try {
    const info = execFileSync('pdfinfo', [f]).toString();
    assert.match(info, /Pages:\s+2/); assert.match(info, /Page size:\s+453\.5\d* x 311\.8\d* pts/); // 160 x 110 mm
    const r = execFileSync('python3', ['-c', `
from pypdf import PdfReader
r = PdfReader(${JSON.stringify(f)}); p = r.pages[0]
img = p['/Resources']['/XObject']['/Im0'].get_object()
cs = img['/ColorSpace']; prof = cs[1].get_object()
tb = [round(float(v) * 25.4 / 72, 1) for v in p.trimbox]; bb = [round(float(v) * 25.4 / 72, 1) for v in p.bleedbox]
print(cs[0], prof['/N'], len(prof.get_data()), tb, bb, [round(float(v), 1) for v in r.pages[1].trimbox] == [round(float(v), 1) for v in r.pages[1].mediabox])`]).toString();
    assert.ok(r.includes('/ICCBased 3 ' + icc.length), r);
    assert.ok(r.includes('[10.0, 5.0, 160.0, 105.0]'), 'TrimBox (mm, desde abajo-izquierda): ' + r);
    assert.ok(r.includes('[7.0, 2.0, 163.0, 108.0]'), 'BleedBox: ' + r);
    assert.ok(r.trim().endsWith('True'), 'sin cajas, TrimBox = MediaBox');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // sin perfil sigue siendo DeviceRGB
  const plain = buildPdf([{ jpeg, imgW: 60, imgH: 40, widthMm: 100, heightMm: 70 }]);
  assert.ok(Buffer.from(plain).toString('latin1').includes('/DeviceRGB'));
});

t('Little CMS en la página: perfil de la imprenta (conversión) y simulación coinciden con los valores de referencia', async () => {
  const r = await page.evaluate(async ([small, g18, cols]) => {
    const cm = await import('/src/colorman.js');
    const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const mk = () => { const c = document.createElement('canvas'); c.width = cols.length; c.height = 1; const x = c.getContext('2d', { willReadFrequently: true }); cols.forEach((col, i) => { x.fillStyle = `rgb(${col.join(',')})`; x.fillRect(i, 0, 1, 1); }); return c; };
    const read = (c) => [...c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, 1).data].filter((_, i) => i % 4 !== 3);
    const out = { info: await cm.profileInfo(dec(small)) };
    let c = mk(); await cm.convertCanvas(c, dec(small), { intent: 'relative', bpc: false }); out.conv = read(c);
    c = mk(); await cm.convertCanvas(c, dec(g18), { intent: 'relative', bpc: false }); out.g18 = read(c);
    c = mk(); await cm.softProofCanvas(c, dec(small), { intent: 'relative', bpc: false }); out.proof = read(c);
    c = mk(); await cm.softProofCanvas(c, dec(small), { intent: 'relative', bpc: false, gamutCheck: true }); out.gamut = read(c);
    try { await cm.convertCanvas(mk(), new Uint8Array(500), {}); out.bad = 'sin error'; } catch (e) { out.bad = e.message; }
    return out;
  }, [b64(SMALL), b64(G18), COLORS]);
  assert.deepEqual([r.info.space, r.info.description], ['RGB', 'Gamut chico']);
  // referencia: Pillow (Little CMS 2), mismo perfil, intención relativa sin compensación de negro
  const want = {
    conv: [249, 67, 52, 255, 1, 10, 43, 224, 44, 160, 131, 133, 23, 19, 19],
    g18: [188, 81, 38, 255, 0, 0, 23, 188, 46, 109, 109, 109, 10, 10, 10],
    proof: [200, 98, 50, 204, 85, 14, 30, 200, 60, 128, 128, 128, 10, 10, 10],
  };
  for (const k of Object.keys(want)) want[k].forEach((v, i) => near(r[k][i], v, 1, `${k}[${i}]`));
  assert.match(r.bad, /No se pudo leer el perfil/);
  // la simulación: lo que cabe en el papel no cambia; lo que no cabe pierde saturación (rojo puro: 255,0,0 -> ~204,85,14)
  assert.ok(r.proof[3] < 255 && r.proof[3] > 150, 'el rojo puro se limita');
  assert.ok(r.gamut.some((v, i) => v !== r.proof[i]), 'la marca de fuera de gamut cambia los colores que no caben');
  near(r.proof[9], 128, 1, 'un gris medio cabe en el papel: no cambia');
});

t('sangrado y marcas: el lienzo crece, el fondo y la foto llegan al borde del sangrado y las marcas quedan fuera', async () => {
  const r = await page.evaluate(async () => {
    const { compose, printspec } = window.__t;
    const mkItem = (color) => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 300, 200); return { aspect: 1.5, caption: '', render: () => c }; };
    const base = printspec.defaultPrintSpec();
    base.paper = '10x15'; base.orientation = 'landscape'; base.marginMm = 0; base.frame.kind = 'none'; base.logo.enabled = false; base.background = '#00aa00'; base.dpi = 100;
    const px = (ctx, x, y) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3)];
    const run = (over) => { const s = { ...base, ...over }; const res = compose.composePage(s, [mkItem('#cc0000')], {}, { dpi: 100 }); const ctx = res.canvas.getContext('2d', { willReadFrequently: true }); return { w: res.canvas.width, h: res.canvas.height, g: res.geometry, ctx }; };
    const none = run({ bleedMm: 0, marks: false });
    const bleed = run({ bleedMm: 3, marks: false });
    const marks = run({ bleedMm: 3, marks: true });
    const withMargin = run({ bleedMm: 3, marks: false, marginMm: 5 });
    const mm = (v) => (v / 25.4) * 100;
    return {
      none: [none.w, none.h], bleed: [bleed.w, bleed.h], marks: [marks.w, marks.h],
      mediaBleed: [bleed.g.mediaMm.w, bleed.g.mediaMm.h], trim: marks.g.trimMm, bleedBox: marks.g.bleedBoxMm,
      // sin margen la foto roja llega hasta el borde del sangrado (a sangre)
      bleedEdge: px(bleed.ctx, 1, bleed.h / 2), bleedCenter: px(bleed.ctx, bleed.w / 2, bleed.h / 2),
      // con margen, el sangrado se rellena con el color de fondo
      marginEdge: px(withMargin.ctx, 1, withMargin.h / 2), marginPhoto: px(withMargin.ctx, withMargin.w / 2, withMargin.h / 2),
      // en el slug (fuera del sangrado) todo es blanco salvo las marcas; el corte arriba-izquierda está en (ext, ext)
      slug: px(marks.ctx, 3, 3), ext: Math.round(mm(10)),
      markH: px(marks.ctx, 10, Math.round(mm(10))), markV: px(marks.ctx, Math.round(mm(10)), 10),
      farFromMarks: px(marks.ctx, 10, Math.round(mm(10)) - 8),
      insideBleed: px(marks.ctx, mm(10) + 10, mm(10) + 10),
    };
  });
  const mm = (v) => (v / 25.4) * 100;
  const sameSize = (got, wantMm, msg) => got.forEach((v, i) => near(v, mm(wantMm[i]), 2, `${msg}: ${got} vs ${wantMm.map(mm)}`));
  sameSize(r.none, [152.4, 101.6], 'sin sangrado: la hoja final');
  sameSize(r.bleed, [158.4, 107.6], 'con 3 mm de sangrado por lado');
  sameSize(r.marks, [172.4, 121.6], 'con marcas: 3 mm de sangrado + 2 de hueco + 5 de marca por lado');
  near(r.mediaBleed[0], 158.4, 0.6, 'tamaño de página en mm'); near(r.mediaBleed[1], 107.6, 0.6, 'tamaño de página en mm');
  near(r.trim.x, 10, 0.3, 'corte x'); near(r.trim.w, 152.4, 0.3, 'corte ancho'); near(r.bleedBox.x, 7, 0.3, 'sangrado x'); near(r.bleedBox.w, 158.4, 0.3, 'sangrado ancho');
  assert.ok(r.bleedEdge[0] > 150 && r.bleedEdge[1] < 60, `a sangre: la foto roja llega al borde (${r.bleedEdge})`);
  assert.ok(r.marginEdge[1] > 120 && r.marginEdge[0] < 60, `con margen el borde es el fondo verde (${r.marginEdge})`);
  assert.ok(r.marginPhoto[0] > 150, 'y la foto sigue en el centro');
  assert.deepEqual(r.slug, [255, 255, 255], 'el slug es blanco');
  assert.ok(r.markH.every((v) => v < 40), `marca de corte negra (${r.markH})`);
  assert.deepEqual(r.farFromMarks, [255, 255, 255], 'y solo la marca, no todo el slug');
  assert.ok(r.insideBleed[0] > 150, 'dentro del sangrado hay foto');
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FALLA ${name}\n        ${String(e.message).split('\n').slice(0, 4).join('\n        ')}`); process.exitCode = 1; }
}
const real = [...new Set(errors)].filter((e) => !/favicon/.test(e));
if (real.length) { console.log('\nErrores en la consola del navegador:\n' + real.join('\n')); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pruebas de color correctas`);
await browser.close(); server.close();
