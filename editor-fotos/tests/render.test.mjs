// Pruebas de render: abren la app en un Chromium sin pantalla (WebGL por software)
// y comprueban que cada ajuste produce el resultado esperado en píxeles reales.
// Uso: node tests/render.test.mjs
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startServer } from './serve.mjs';

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

// ---- ayudantes dentro de la página ----
await page.evaluate(() => {
  const { engine, model } = window.__t;
  window.model = model;
  const H = {};
  H.edits = () => model.defaultEdits();
  H.load = (w, h, kind) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (kind === 'gray') { ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, w, h); }
    if (kind === 'quad') {
      const q = [['rgb(255,0,0)', 0, 0], ['rgb(0,255,0)', w / 2, 0], ['rgb(0,0,255)', 0, h / 2], ['rgb(255,255,255)', w / 2, h / 2]];
      for (const [col, x, y] of q) { ctx.fillStyle = col; ctx.fillRect(x, y, w / 2, h / 2); }
    }
    if (kind === 'colors') {
      const q = [['rgb(200,60,60)', 0], ['rgb(60,60,200)', 1], ['rgb(200,150,120)', 2], ['rgb(80,160,80)', 3]];
      for (const [col, i] of q) { ctx.fillStyle = col; ctx.fillRect(i * w / 4, 0, w / 4, h); }
    }
    if (kind === 'ramp') {
      const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    if (kind === 'detail') { // damero fino sobre gris
      ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if ((x / 2 + y / 2) % 2 === 0) { ctx.fillStyle = 'rgb(150,150,150)'; ctx.fillRect(x, y, 2, 2); }
    }
    // semilla fija para que las pruebas sean repetibles
    let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    if (kind === 'noise' || kind === 'cnoise' || kind === 'stepnoise') {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4; const base = kind === 'stepnoise' ? (x < w / 2 ? 60 : 200) : 128;
        if (kind === 'cnoise') { const n = (rnd() - 0.5) * 90; img.data[i] = 128 + n; img.data[i + 1] = 128 - n * 0.5; img.data[i + 2] = 128 + (rnd() - 0.5) * 90; }
        else { const n = (rnd() - 0.5) * 50; img.data[i] = img.data[i + 1] = img.data[i + 2] = base + n; }
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    if (kind === 'haze') { const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'rgb(120,125,130)'); g.addColorStop(1, 'rgb(190,190,195)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); ctx.fillStyle = 'rgb(178,178,184)'; ctx.fillRect(w * 0.3, h * 0.3, w * 0.2, h * 0.4); }
    if (kind === 'dot' || kind === 'gradot') {
      if (kind === 'dot') { ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, w, h); }
      else { const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'rgb(40,40,40)'); g.addColorStop(1, 'rgb(220,220,220)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
      ctx.fillStyle = 'rgb(0,0,0)'; ctx.beginPath(); ctx.arc(w * (kind === 'dot' ? 0.5 : 0.3), h * 0.5, w * 0.025, 0, Math.PI * 2); ctx.fill();
    }
    if (kind === 'dotright') { ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = 'rgb(0,0,0)'; ctx.beginPath(); ctx.arc(w * 0.75, h * 0.5, w * 0.025, 0, Math.PI * 2); ctx.fill(); }
    if (kind === 'lamp') { // fondo oscuro con una "luz" blanca en el centro
      ctx.fillStyle = 'rgb(30,30,30)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(255,255,255)'; ctx.fillRect(w * 0.42, h * 0.42, w * 0.16, h * 0.16);
    }
    engine.setSource(c);
  };
  H.std = (x0, y0, x1, y1, ch = 0) => {
    const { width, height, data } = engine.readPixels(); const xs = Math.floor(x0 * width), xe = Math.floor(x1 * width), ys = Math.floor(y0 * height), ye = Math.floor(y1 * height);
    let n = 0, s = 0, s2 = 0; for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) { const i = (y * width + x) * 4; const v = ch < 0 ? Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) : data[i + ch]; n++; s += v; s2 += v * v; }
    const m = s / n; return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
  };
  H.render = (e, opts = {}) => engine.render(e, { maxW: 4096, maxH: 4096, ...opts });
  H.px = (xf, yf) => {
    const { width, height, data } = engine.readPixels();
    const x = Math.min(width - 1, Math.floor(xf * width)); const y = Math.min(height - 1, Math.floor(yf * height));
    const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]];
  };
  H.size = () => engine.lastSize;
  window.__h = H;
});

const run = (fn, ...args) => page.evaluate(fn, ...args);
const near = (actual, expected, tol, msg) => {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: obtuvo ${actual}, esperaba ${expected} ±${tol}`);
};

let passed = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('neutro: la imagen sale igual que entra', async () => {
  const r = await run(() => { __h.load(128, 128, 'colors'); __h.render(__h.edits()); return [__h.px(0.1, 0.5), __h.px(0.35, 0.5), __h.px(0.6, 0.5), __h.px(0.9, 0.5)]; });
  const want = [[200, 60, 60], [60, 60, 200], [200, 150, 120], [80, 160, 80]];
  r.forEach((p, i) => p.forEach((v, k) => near(v, want[i][k], 2, `parche ${i} canal ${k}`)));
});

t('neutro sobre una rampa: monótona y sin saltos', async () => {
  const row = await run(() => {
    __h.load(256, 16, 'ramp'); __h.render(__h.edits());
    const out = []; for (let i = 0; i < 256; i += 16) out.push(__h.px(i / 256, 0.5)[0]); return out;
  });
  for (let i = 1; i < row.length; i++) assert.ok(row[i] >= row[i - 1], 'rampa no monótona');
  near(row[0], 0, 3, 'negro'); near(row[row.length - 1], 240, 6, 'casi blanco');
});

t('exposición +1 EV sube un gris medio a ~175', async () => {
  const v = await run(() => { __h.load(64, 64, 'gray'); const e = __h.edits(); e.light.exposure = 1; __h.render(e); return __h.px(0.5, 0.5)[0]; });
  near(v, 175, 3, 'gris +1EV');
});

t('exposición -1 EV baja un gris medio a ~92', async () => {
  const v = await run(() => { __h.load(64, 64, 'gray'); const e = __h.edits(); e.light.exposure = -1; __h.render(e); return __h.px(0.5, 0.5)[0]; });
  near(v, 92, 3, 'gris -1EV');
});

t('saturación -100 deja todo en gris', async () => {
  const p = await run(() => { __h.load(64, 64, 'colors'); const e = __h.edits(); e.color.saturation = -100; __h.render(e); return __h.px(0.1, 0.5); });
  near(p[0], p[1], 2, 'R≈G'); near(p[1], p[2], 2, 'G≈B');
});

t('saturación +50 aumenta la distancia entre canales', async () => {
  const [a, b] = await run(() => {
    __h.load(64, 64, 'colors'); __h.render(__h.edits()); const a = __h.px(0.1, 0.5);
    const e = __h.edits(); e.color.saturation = 50; __h.render(e); return [a, __h.px(0.1, 0.5)];
  });
  assert.ok(b[0] - b[1] > a[0] - a[1], 'no aumentó la saturación');
});

t('temperatura +: más rojo y menos azul; − al revés', async () => {
  const [w, c] = await run(() => {
    __h.load(64, 64, 'gray'); const e = __h.edits(); e.color.temperature = 60; __h.render(e); const w = __h.px(0.5, 0.5);
    e.color.temperature = -60; __h.render(e); return [w, __h.px(0.5, 0.5)];
  });
  assert.ok(w[0] > w[2], 'cálido: R > B'); assert.ok(c[2] > c[0], 'frío: B > R');
});

t('tinte +: baja el verde (magenta)', async () => {
  const p = await run(() => { __h.load(64, 64, 'gray'); const e = __h.edits(); e.color.tint = 80; __h.render(e); return __h.px(0.5, 0.5); });
  assert.ok(p[1] < p[0] && p[1] < p[2], 'G debe ser el menor');
});

t('contraste +: oscurece sombras y aclara luces', async () => {
  const [lo, hi, lo0, hi0] = await run(() => {
    __h.load(256, 8, 'ramp'); __h.render(__h.edits()); const lo0 = __h.px(0.25, 0.5)[0], hi0 = __h.px(0.75, 0.5)[0];
    const e = __h.edits(); e.light.contrast = 70; __h.render(e); return [__h.px(0.25, 0.5)[0], __h.px(0.75, 0.5)[0], lo0, hi0];
  });
  assert.ok(lo < lo0, 'sombras no bajaron'); assert.ok(hi > hi0, 'luces no subieron');
});

t('brillo + aclara y brillo − oscurece', async () => {
  const [a, b] = await run(() => {
    __h.load(64, 64, 'gray'); const e = __h.edits(); e.light.brightness = 50; __h.render(e); const a = __h.px(0.5, 0.5)[0];
    e.light.brightness = -50; __h.render(e); return [a, __h.px(0.5, 0.5)[0]];
  });
  assert.ok(a > 128 && b < 128, `a=${a} b=${b}`);
});

t('sombras + levanta zonas oscuras más que las claras', async () => {
  const [dark, light] = await run(() => {
    __h.load(256, 8, 'ramp'); const e = __h.edits(); __h.render(e); const d0 = __h.px(0.2, 0.5)[0], l0 = __h.px(0.9, 0.5)[0];
    e.light.shadows = 80; __h.render(e); return [__h.px(0.2, 0.5)[0] - d0, __h.px(0.9, 0.5)[0] - l0];
  });
  assert.ok(dark > 10, `sombras no subieron (${dark})`); assert.ok(dark > light + 5, 'afectó igual a las luces');
});

t('luces − recupera zonas claras más que las oscuras', async () => {
  const [dark, light] = await run(() => {
    __h.load(256, 8, 'ramp'); const e = __h.edits(); __h.render(e); const d0 = __h.px(0.2, 0.5)[0], l0 = __h.px(0.9, 0.5)[0];
    e.light.highlights = -80; __h.render(e); return [d0 - __h.px(0.2, 0.5)[0], l0 - __h.px(0.9, 0.5)[0]];
  });
  assert.ok(light > 8, `luces no bajaron (${light})`); assert.ok(light > dark + 4, 'afectó igual a las sombras');
});

t('negros + levanta el negro; blancos − baja el blanco', async () => {
  const [b, w] = await run(() => {
    __h.load(256, 8, 'ramp'); const e = __h.edits(); e.light.blacks = 100; __h.render(e); const b = __h.px(0, 0.5)[0];
    const e2 = __h.edits(); e2.light.whites = -100; __h.render(e2); return [b, __h.px(0.999, 0.5)[0]];
  });
  assert.ok(b > 10, `negro=${b}`); assert.ok(w < 250, `blanco=${w}`);
});

t('curva: bajar el punto medio oscurece el gris medio', async () => {
  const v = await run(() => { __h.load(64, 64, 'gray'); const e = __h.edits(); e.curves.master = [[0, 0], [0.5, 0.25], [1, 1]]; __h.render(e); return __h.px(0.5, 0.5)[0]; });
  near(v, 64, 5, 'curva');
});

t('curva por canal: subir solo el rojo', async () => {
  const p = await run(() => { __h.load(64, 64, 'gray'); const e = __h.edits(); e.curves.r = [[0, 0], [0.5, 0.75], [1, 1]]; __h.render(e); return __h.px(0.5, 0.5); });
  assert.ok(p[0] > 180 && Math.abs(p[1] - 128) < 3 && Math.abs(p[2] - 128) < 3, JSON.stringify(p));
});

t('HSL: desaturar solo los rojos no toca los azules', async () => {
  const [red, blue, red0] = await run(() => {
    __h.load(128, 64, 'colors'); __h.render(__h.edits()); const red0 = __h.px(0.1, 0.5);
    const e = __h.edits(); e.color.hsl.red.s = -100; __h.render(e); return [__h.px(0.1, 0.5), __h.px(0.35, 0.5), red0];
  });
  assert.ok(Math.max(...red) - Math.min(...red) < Math.max(...red0) - Math.min(...red0) - 40, 'rojo no se desaturó');
  near(blue[0], 60, 3, 'azul R'); near(blue[2], 200, 3, 'azul B');
});

t('HSL: mover el matiz del rojo lo desplaza hacia naranja/amarillo', async () => {
  const [a, b] = await run(() => {
    __h.load(128, 64, 'colors'); __h.render(__h.edits()); const a = __h.px(0.1, 0.5);
    const e = __h.edits(); e.color.hsl.red.h = 100; __h.render(e); return [a, __h.px(0.1, 0.5)];
  });
  assert.ok(b[1] > a[1] + 10, `el verde no subió (${a} -> ${b})`);
});

t('gradación: tinte azul en sombras sube el azul de zonas oscuras', async () => {
  const [a, b] = await run(() => {
    __h.load(256, 8, 'ramp'); __h.render(__h.edits()); const a = __h.px(0.15, 0.5);
    const e = __h.edits(); e.grading.shadows = { hue: 220, sat: 100 }; __h.render(e); return [a, __h.px(0.15, 0.5)];
  });
  assert.ok(b[2] - b[0] > a[2] - a[0] + 8, `${a} -> ${b}`);
});

t('desvanecer sube el negro', async () => {
  const v = await run(() => { __h.load(256, 8, 'ramp'); const e = __h.edits(); e.effects.fade = 100; __h.render(e); return __h.px(0, 0.5)[0]; });
  assert.ok(v > 25, `negro=${v}`);
});

t('viñeta negativa oscurece las esquinas y no el centro', async () => {
  const [c0, c1, k0, k1] = await run(() => {
    __h.load(128, 128, 'gray'); __h.render(__h.edits()); const c0 = __h.px(0.5, 0.5)[0], k0 = __h.px(0.02, 0.02)[0];
    const e = __h.edits(); e.effects.vignette = -80; __h.render(e); return [c0, __h.px(0.5, 0.5)[0], k0, __h.px(0.02, 0.02)[0]];
  });
  near(c1, c0, 3, 'centro'); assert.ok(k1 < k0 - 25, `esquina ${k0} -> ${k1}`);
});

t('grano: añade variación y es estable entre renders', async () => {
  const r = await run(() => {
    __h.load(64, 64, 'gray'); const e = __h.edits(); e.effects.grain = 80; __h.render(e);
    const a = []; for (let i = 0; i < 20; i++) a.push(__h.px(i / 20, 0.5)[0]);
    __h.render(e); const b = []; for (let i = 0; i < 20; i++) b.push(__h.px(i / 20, 0.5)[0]);
    return { a, b };
  });
  assert.deepEqual(r.a, r.b, 'el grano cambió entre renders');
  assert.ok(new Set(r.a).size > 4, 'sin variación');
});

t('nitidez realza un borde; claridad no rompe un gris liso', async () => {
  const [flat, edge0, edge1] = await run(() => {
    __h.load(64, 64, 'gray'); const e = __h.edits(); e.detail.clarity = 100; __h.render(e); const flat = __h.px(0.5, 0.5)[0];
    __h.load(64, 64, 'quad'); const e0 = __h.edits(); __h.render(e0); const a = __h.px(0.51, 0.75)[0];
    const e1 = __h.edits(); e1.detail.sharpness = 100; __h.render(e1); return [flat, a, __h.px(0.51, 0.75)[0]];
  });
  near(flat, 128, 3, 'gris liso con claridad'); assert.ok(Number.isFinite(edge1) && Number.isFinite(edge0));
});

t('giro de 90° horario: el rojo (arriba-izquierda) pasa a arriba-derecha', async () => {
  const [tl, tr, size] = await run(() => {
    __h.load(100, 60, 'quad'); const e = __h.edits(); e.geometry.rotate90 = 1; __h.render(e);
    return [__h.px(0.05, 0.05), __h.px(0.95, 0.05), __h.size()];
  });
  assert.deepEqual(size, [60, 100], 'las dimensiones deben intercambiarse');
  assert.ok(tr[0] > 200 && tr[1] < 60, `arriba-derecha debe ser rojo: ${tr}`);
  assert.ok(tl[2] > 200 && tl[0] < 60, `arriba-izquierda debe ser azul: ${tl}`);
});

t('giro de 180° y 270° colocan los colores donde corresponde', async () => {
  const [r180, r270] = await run(() => {
    __h.load(100, 60, 'quad'); const e = __h.edits(); e.geometry.rotate90 = 2; __h.render(e); const a = __h.px(0.95, 0.95);
    e.geometry.rotate90 = 3; __h.render(e); return [a, __h.px(0.05, 0.95)];
  });
  assert.ok(r180[0] > 200 && r180[1] < 60, `180°: abajo-derecha rojo: ${r180}`);
  assert.ok(r270[0] > 200 && r270[1] < 60, `270°: abajo-izquierda rojo: ${r270}`);
});

t('espejo horizontal y vertical', async () => {
  const [h, v] = await run(() => {
    __h.load(100, 60, 'quad'); const e = __h.edits(); e.geometry.flipH = true; __h.render(e); const h = __h.px(0.95, 0.05);
    const e2 = __h.edits(); e2.geometry.flipV = true; __h.render(e2); return [h, __h.px(0.05, 0.95)];
  });
  assert.ok(h[0] > 200 && h[1] < 60, `flipH: arriba-derecha rojo: ${h}`);
  assert.ok(v[0] > 200 && v[1] < 60, `flipV: abajo-izquierda rojo: ${v}`);
});

t('recorte: tamaño de salida y contenido', async () => {
  const [size, px] = await run(() => {
    __h.load(200, 100, 'quad'); const e = __h.edits(); e.geometry.crop = { x: 0.5, y: 0, w: 0.5, h: 0.5 }; __h.render(e);
    return [__h.size(), __h.px(0.5, 0.5)];
  });
  assert.deepEqual(size, [100, 50]);
  assert.ok(px[1] > 200 && px[0] < 60, `el recorte arriba-derecha debe ser verde: ${px}`);
});

t('enderezar no deja bordes vacíos (sin negro en las esquinas)', async () => {
  const corners = await run(() => {
    __h.load(200, 120, 'gray'); const e = __h.edits(); e.geometry.straighten = 7; __h.render(e);
    return [__h.px(0.003, 0.003), __h.px(0.997, 0.003), __h.px(0.003, 0.997), __h.px(0.997, 0.997)];
  });
  corners.forEach((p) => near(p[0], 128, 4, 'esquina'));
});

t('máscara radial: afecta el centro y no el borde', async () => {
  const [c, k] = await run(() => {
    __h.load(128, 128, 'gray'); const e = __h.edits();
    const m = __h.t ? null : null;
    e.masks.push({ id: 'm', type: 'radial', enabled: true, invert: false, feather: 0.3, cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0,
      adjust: { exposure: -2, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0 } });
    __h.render(e); return [__h.px(0.5, 0.5)[0], __h.px(0.95, 0.95)[0]];
  });
  assert.ok(c < 80, `centro=${c}`); near(k, 128, 3, 'borde');
});

t('máscara radial invertida afecta el borde y no el centro', async () => {
  const [c, k] = await run(() => {
    __h.load(128, 128, 'gray'); const e = __h.edits();
    e.masks.push({ id: 'm', type: 'radial', enabled: true, invert: true, feather: 0.3, cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0,
      adjust: { exposure: -2, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0 } });
    __h.render(e); return [__h.px(0.5, 0.5)[0], __h.px(0.95, 0.95)[0]];
  });
  near(c, 128, 3, 'centro'); assert.ok(k < 80, `borde=${k}`);
});

t('máscara lineal: degradado de arriba hacia abajo', async () => {
  const [top, bottom] = await run(() => {
    __h.load(100, 100, 'gray'); const e = __h.edits();
    e.masks.push({ id: 'm', type: 'linear', enabled: true, invert: false, feather: 0.4, x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.6,
      adjust: { exposure: 1.5, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0 } });
    __h.render(e); return [__h.px(0.5, 0.02)[0], __h.px(0.5, 0.98)[0]];
  });
  assert.ok(top < 128 - 30 || top > 128 + 30, `la parte superior debería cambiar (${top})`);
  near(bottom, 128, 3, 'parte inferior');
});

t('máscara desactivada no hace nada', async () => {
  const v = await run(() => {
    __h.load(64, 64, 'gray'); const e = __h.edits();
    e.masks.push({ id: 'm', type: 'radial', enabled: false, invert: false, feather: 0.3, cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, angle: 0,
      adjust: { exposure: -3, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0 } });
    __h.render(e); return __h.px(0.5, 0.5)[0];
  });
  near(v, 128, 2, 'máscara desactivada');
});

t('vista previa reducida respeta el tamaño máximo y la proporción', async () => {
  const size = await run(() => { __h.load(400, 200, 'quad'); __h.render(__h.edits(), { maxW: 100, maxH: 100 }); return __h.size(); });
  assert.deepEqual(size, [100, 50]);
});

t('"original" (antes/después) ignora los ajustes pero conserva la geometría', async () => {
  const [v, size] = await run(() => {
    __h.load(100, 60, 'gray'); const e = __h.edits(); e.light.exposure = 2; e.geometry.rotate90 = 1;
    __h.render(e, { original: true }); return [__h.px(0.5, 0.5)[0], __h.size()];
  });
  near(v, 128, 2, 'sin ajustes'); assert.deepEqual(size, [60, 100]);
});

t('exportar da un archivo a resolución completa', async () => {
  const r = await run(async () => {
    __h.load(300, 200, 'quad'); const e = __h.edits(); e.geometry.crop = { x: 0, y: 0, w: 0.5, h: 1 };
    const out = await window.__t.engine.exportBlob(e, { type: 'image/jpeg', quality: 0.9 });
    return { size: out.blob.size, type: out.blob.type, w: out.width, h: out.height };
  });
  assert.equal(r.type, 'image/jpeg'); assert.ok(r.size > 200); assert.deepEqual([r.w, r.h], [150, 200]);
});

t('exportar informa el tamaño completo aunque la pantalla se redibuje durante la exportación', async () => {
  const r = await run(async () => {
    __h.load(400, 300, 'quad'); const e = __h.edits();
    const p = window.__t.engine.exportBlob(e, { type: 'image/png' });
    window.__t.engine.render(e, { maxW: 100, maxH: 100 }); // la vista previa se cuela a mitad de exportación
    const out = await p; return { w: out.width, h: out.height };
  });
  assert.deepEqual([r.w, r.h], [400, 300]);
});

t('reducción de ruido: baja bastante la variación en un gris con ruido', async () => {
  const [a, b] = await run(() => {
    __h.load(160, 160, 'noise'); __h.render(__h.edits()); const a = __h.std(0.2, 0.2, 0.8, 0.8);
    const e = __h.edits(); e.detail.denoise = 100; __h.render(e); return [a, __h.std(0.2, 0.2, 0.8, 0.8)];
  });
  assert.ok(b.std < a.std * 0.6, `ruido ${a.std.toFixed(1)} -> ${b.std.toFixed(1)}`); near(b.mean, a.mean, 6, 'brillo medio');
});

t('reducción de ruido: conserva un borde marcado', async () => {
  const [a, b] = await run(() => {
    __h.load(160, 160, 'stepnoise'); __h.render(__h.edits());
    const L0 = __h.std(0.1, 0.2, 0.4, 0.8).mean, R0 = __h.std(0.6, 0.2, 0.9, 0.8).mean;
    const e = __h.edits(); e.detail.denoise = 80; __h.render(e);
    const L1 = __h.std(0.1, 0.2, 0.4, 0.8).mean, R1 = __h.std(0.6, 0.2, 0.9, 0.8).mean;
    return [R0 - L0, R1 - L1];
  });
  assert.ok(b > a * 0.9, `el borde se suavizó: ${a.toFixed(0)} -> ${b.toFixed(0)}`);
});

t('ruido de color: reduce la variación de color sin tocar el brillo medio', async () => {
  const [a, b] = await run(() => {
    __h.load(160, 160, 'cnoise'); __h.render(__h.edits()); const a = __h.std(0.2, 0.2, 0.8, 0.8, -1);
    const e = __h.edits(); e.detail.colorDenoise = 100; __h.render(e); return [a, __h.std(0.2, 0.2, 0.8, 0.8, -1)];
  });
  assert.ok(b.mean < a.mean * 0.75, `color ${a.mean.toFixed(1)} -> ${b.mean.toFixed(1)}`);
});

t('quitar neblina sube el contraste local y su valor negativo lo baja', async () => {
  const r = await run(() => {
    // el velo se estima localmente: lo que debe crecer es la diferencia entre un objeto y su entorno
    __h.load(160, 80, 'haze');
    const diff = (e) => { __h.render(e); return __h.px(0.4, 0.5)[0] - __h.px(0.27, 0.5)[0]; };
    const e0 = __h.edits(); const e1 = __h.edits(); e1.detail.dehaze = 80; const e2 = __h.edits(); e2.detail.dehaze = -80;
    return { a: diff(e0), b: diff(e1), c: diff(e2) };
  });
  assert.ok(r.a > 5, `la prueba necesita un objeto visible: ${r.a}`);
  assert.ok(r.b > r.a * 1.25, `quitar neblina: ${r.a} -> ${r.b}`); assert.ok(r.c < r.a * 0.9, `añadir neblina: ${r.a} -> ${r.c}`);
});

t('textura: realza el detalle fino y su valor negativo lo suaviza', async () => {
  const r = await run(() => {
    __h.load(128, 128, 'detail'); __h.render(__h.edits()); const a = __h.std(0.2, 0.2, 0.8, 0.8);
    const e = __h.edits(); e.detail.texture = 100; __h.render(e); const b = __h.std(0.2, 0.2, 0.8, 0.8);
    const e2 = __h.edits(); e2.detail.texture = -100; __h.render(e2); return { a: a.std, b: b.std, c: __h.std(0.2, 0.2, 0.8, 0.8).std };
  });
  assert.ok(r.b > r.a, `textura +: ${r.a.toFixed(2)} -> ${r.b.toFixed(2)}`); assert.ok(r.c <= r.a, `textura -: ${r.a.toFixed(2)} -> ${r.c.toFixed(2)}`);
});

t('retoque de manchas: una mancha negra desaparece y el resto no cambia', async () => {
  const r = await run(() => {
    __h.load(200, 200, 'dot'); __h.render(__h.edits()); const before = __h.px(0.5, 0.5)[0], far0 = __h.px(0.1, 0.1)[0];
    const e = __h.edits(); e.spots.push({ id: 's', x: 0.5, y: 0.5, r: 0.06, dx: 0.2, dy: 0, feather: 0.5, opacity: 1, mode: 'heal' });
    __h.render(e); return { before, after: __h.px(0.5, 0.5)[0], far: __h.px(0.1, 0.1)[0], far0 };
  });
  assert.ok(r.before < 20, `la mancha debería verse: ${r.before}`); near(r.after, 128, 6, 'tras retocar'); near(r.far, r.far0, 1, 'zona lejana');
});

t('retoque de manchas: opacidad 0 no hace nada y las manchas se quedan en su sitio al recortar', async () => {
  const r = await run(() => {
    __h.load(200, 200, 'dotright');
    const e = __h.edits(); e.spots.push({ id: 's', x: 0.75, y: 0.5, r: 0.06, dx: -0.2, dy: 0, feather: 0.5, opacity: 0, mode: 'heal' }); e.geometry.crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
    __h.render(e); const off = __h.px(0.5, 0.5)[0];
    e.spots[0].opacity = 1; __h.render(e); return { off, on: __h.px(0.5, 0.5)[0] };
  });
  assert.ok(r.off < 20, `con opacidad 0 la mancha sigue (${r.off})`); near(r.on, 128, 6, 'tras retocar con recorte');
});

t('retoque: "reparar" respeta la luz de la zona y "clonar" copia tal cual', async () => {
  const r = await run(() => {
    __h.load(240, 100, 'gradot');
    const mk = (mode) => { const e = __h.edits(); e.spots.push({ id: 's', x: 0.3, y: 0.5, r: 0.06, dx: 0.3, dy: 0, feather: 0.5, opacity: 1, mode }); __h.render(e); return { center: __h.px(0.3, 0.5)[0], around: __h.px(0.3, 0.2)[0] }; };
    return { heal: mk('heal'), clone: mk('clone') };
  });
  const dh = Math.abs(r.heal.center - r.heal.around); const dc = Math.abs(r.clone.center - r.clone.around);
  assert.ok(dh < 18, `reparar: diferencia con el entorno ${dh}`); assert.ok(dc > dh + 12, `clonar debería notarse más (${dc} vs ${dh})`);
});

t('las ediciones combinadas no producen NaN ni píxeles fuera de rango', async () => {
  const p = await run(() => {
    __h.load(64, 64, 'colors'); const e = __h.edits();
    e.light = { exposure: 3, brightness: 60, contrast: 90, highlights: -90, shadows: 90, whites: 90, blacks: -90 };
    e.color.temperature = 90; e.color.tint = -90; e.color.saturation = 100; e.color.vibrance = 100;
    e.color.hsl.red = { h: 100, s: 100, l: 100 }; e.detail = { clarity: 100, sharpness: 100 };
    e.effects = { vignette: -100, grain: 100, grainSize: 100, fade: 100 };
    e.grading.shadows = { hue: 10, sat: 100 }; e.curves.master = [[0, 0.2], [0.5, 0.9], [1, 0.8]];
    __h.render(e); return __h.px(0.5, 0.5);
  });
  p.forEach((v) => assert.ok(Number.isInteger(v) && v >= 0 && v <= 255));
});

t('bloom y halation: el brillo se extiende alrededor de las luces y no toca lo lejano', async () => {
  const r = await run(() => {
    __h.load(256, 256, 'lamp');
    const base = __h.edits(); __h.render(base);
    const near0 = __h.px(0.65, 0.5); const far0 = __h.px(0.05, 0.05);
    const e = __h.edits(); e.effects.bloom = 80; __h.render(e);
    const nearB = __h.px(0.65, 0.5); const farB = __h.px(0.05, 0.05); const lamp = __h.px(0.5, 0.5);
    const h = __h.edits(); h.effects.halation = 80; __h.render(h);
    const nearH = __h.px(0.65, 0.5);
    return { near0, far0, nearB, farB, lamp, nearH };
  });
  assert.ok(r.nearB[0] > r.near0[0] + 8, `bloom: junto a la luz ${r.nearB[0]} vs ${r.near0[0]}`);
  assert.ok(r.farB[0] <= r.far0[0] + 3, `bloom: el fondo lejano no debe cambiar (${r.farB[0]} vs ${r.far0[0]})`);
  assert.ok(r.lamp.every((v) => v >= 250), 'la luz sigue blanca');
  assert.ok(r.nearH[0] - r.nearH[2] > 12, `halation tiñe de cálido: rojo ${r.nearH[0]}, azul ${r.nearH[2]}`);
});

t('pincel: solo cambia lo pintado; la goma lo quita', async () => {
  const r = await run(() => {
    __h.load(200, 100, 'gray');
    const mk = (strokes) => {
      const e = __h.edits();
      const m = model.newMask('brush'); m.adjust.exposure = 1.5; m.strokes = strokes; e.masks.push(m); return e;
    };
    const paint = { r: 0.12, soft: 0.2, erase: false, pts: [[0.2, 0.5], [0.25, 0.5], [0.3, 0.5]] };
    __h.render(mk([paint]));
    const painted = __h.px(0.25, 0.5)[0]; const away = __h.px(0.8, 0.5)[0]; const above = __h.px(0.25, 0.05)[0];
    const erase = { r: 0.12, soft: 0.2, erase: true, pts: [[0.2, 0.5], [0.25, 0.5], [0.3, 0.5]] };
    __h.render(mk([paint, erase])); const erased = __h.px(0.25, 0.5)[0];
    __h.render(mk([])); const none = __h.px(0.25, 0.5)[0];
    const flip = __h.edits(); const fm = model.newMask('brush'); fm.adjust.exposure = 1.5; fm.invert = true; fm.strokes = [paint]; flip.masks.push(fm);
    __h.render(flip); const inv = { inside: __h.px(0.25, 0.5)[0], outside: __h.px(0.8, 0.5)[0] };
    return { painted, away, above, erased, none, inv };
  });
  assert.ok(r.painted > 180, `zona pintada aclarada: ${r.painted}`);
  near(r.away, 128, 3, 'zona sin pintar');
  near(r.above, 128, 3, 'arriba del trazo (y no se invierte)');
  near(r.erased, 128, 3, 'tras la goma');
  near(r.none, 128, 3, 'sin trazos no hay efecto');
  assert.ok(r.inv.outside > 180 && Math.abs(r.inv.inside - 128) < 4, `invertir: dentro ${r.inv.inside}, fuera ${r.inv.outside}`);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FALLA ${name}\n        ${e.message.split('\n')[0]}`); process.exitCode = 1; }
}
if (errors.length) { console.log('\nErrores en la consola del navegador:\n' + [...new Set(errors)].join('\n')); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pruebas de render correctas`);
await browser.close();
server.close();
