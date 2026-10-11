// Ajustes automáticos: balance de blancos y tono. Código puro (sin DOM).
//
// El balance de blancos es la INVERSA exacta del modelo del shader (shaders.js, "PASE LINEAL"):
//   R' = R · 2^(0.7·T + 0.1·N)   G' = G · 2^(-0.5·N)   B' = B · 2^(-0.7·T + 0.1·N)
// con T = temperatura/100 y N = tinte/100. Si se cambia el shader hay que cambiar estas constantes.

export const WB_TEMP = 0.7;
export const WB_TINT_G = 0.5;
export const WB_TINT_RB = 0.1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

export function srgbToLinear(v8) {
  const c = v8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// Dado un color LINEAL que debería ser gris (r,g,b > 0), devuelve temperatura y tinte (-100..100)
// que lo dejan neutro. Si el color es casi negro o casi blanco, no hay información: devuelve 0.
export function whiteBalanceFromLinear(r, g, b) {
  if (!(r > 1e-4 && g > 1e-4 && b > 1e-4)) return { temperature: 0, tint: 0 };
  const lr = Math.log2(r); const lg = Math.log2(g); const lb = Math.log2(b);
  const T = (lb - lr) / (2 * WB_TEMP);
  const N = (lg - lr - WB_TEMP * T) / (WB_TINT_G + WB_TINT_RB);
  return { temperature: round1(clamp(T, -1, 1) * 100), tint: round1(clamp(N, -1, 1) * 100) };
}

// Gotero: promedio (en lineal) de un parche de bytes sRGB RGBA (data, ancho w, alto h, centro cx,cy, radio rad px).
export function averagePatchLinear(data, w, h, cx, cy, rad = 3) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++) {
      const i = (y * w + x) * 4;
      r += srgbToLinear(data[i]); g += srgbToLinear(data[i + 1]); b += srgbToLinear(data[i + 2]); n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
}

// Automático: "mundo gris" sobre los píxeles de tono medio y poco saturados (ignora los muy
// oscuros, los quemados y los muy coloridos, que falsearían el promedio).
export function grayWorldLinear(data, w, h) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
      const mx = Math.max(R, G, B); const mn = Math.min(R, G, B);
      if (mx < 40 || mn > 235) continue;           // muy oscuro o casi blanco
      if (mx > 0 && (mx - mn) / mx > 0.55) continue; // demasiado saturado: es el color del objeto, no de la luz
      r += srgbToLinear(R); g += srgbToLinear(G); b += srgbToLinear(B); n++;
    }
  }
  return n > 20 ? { r: r / n, g: g / n, b: b / n, samples: n } : null;
}

// ---------- tono automático ----------

export function percentile(hist, p) {
  let total = 0; for (let i = 0; i < hist.length; i++) total += hist[i];
  if (!total) return 0;
  const target = total * p; let acc = 0;
  for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= target) return i / (hist.length - 1); }
  return 1;
}

// hist: histograma de luminosidad (256) de la imagen SIN ajustes, en espacio de visualización.
// Devuelve ajustes sugeridos (en las unidades de la app). Es prudente a propósito: es un punto de partida.
export function autoToneFromHistogram(hist) {
  const p1 = percentile(hist, 0.01); const p10 = percentile(hist, 0.10); const p50 = percentile(hist, 0.5);
  const p90 = percentile(hist, 0.90); const p99 = percentile(hist, 0.99);
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  // exposición: lleva la mediana hacia un tono medio agradable (sin pasarse)
  const target = 0.46;
  let ev = Math.log2(lin(target) / Math.max(lin(Math.max(p50, 0.02)), 1e-4));
  ev = clamp(ev * 0.8, -2, 2);
  // tras la exposición, dónde quedan las luces: si se queman, se recortan con "luces"
  const afterHi = Math.min(1.2, p99 * 2 ** (ev * 0.45));
  let highlights = 0; let whites = 0; let blacks = 0; let shadows = 0; let contrast = 0;
  if (afterHi > 0.96) highlights = -clamp((afterHi - 0.96) * 260, 0, 60);
  else if (p99 < 0.9) whites = clamp((0.96 - p99) * 120, 0, 35);
  if (p1 > 0.06) blacks = -clamp((p1 - 0.02) * 220, 0, 35);
  if (p10 < 0.14) shadows = clamp((0.16 - p10) * 260, 0, 45);
  // poco contraste (histograma estrecho): un poco de contraste
  const spread = p90 - p10;
  if (spread < 0.45) contrast = clamp((0.45 - spread) * 100, 0, 22);
  const out = { exposure: Math.round(ev * 100) / 100, contrast: Math.round(contrast), highlights: Math.round(highlights), shadows: Math.round(shadows), whites: Math.round(whites), blacks: Math.round(blacks) };
  for (const k of Object.keys(out)) if (Object.is(out[k], -0)) out[k] = 0;
  return out;
}

// Aplica los ajustes automáticos sobre unas ediciones (sin tocar lo demás).
export function applyAutoTone(edits, tone) {
  const e = JSON.parse(JSON.stringify(edits));
  Object.assign(e.light, tone);
  return e;
}

// ---------- origen automático para quitar manchas ----------

// Elige de dónde copiar para tapar una mancha: prueba 16 posiciones alrededor y se queda con
// la zona cuyo ENTORNO se parece más al de la mancha y que es más lisa (sin otros detalles).
// pixels: RGBA de la vista; (cx, cy) y r en píxeles. Devuelve { dx, dy } en píxeles.
export function chooseSpotSource(data, w, h, cx, cy, r) {
  const stat = (x0, y0, rad) => {
    let n = 0; let sr = 0; let sg = 0; let sb = 0; let s2 = 0;
    for (let y = Math.floor(y0 - rad); y <= Math.ceil(y0 + rad); y += 2) {
      for (let x = Math.floor(x0 - rad); x <= Math.ceil(x0 + rad); x += 2) {
        if (x < 0 || y < 0 || x >= w || y >= h) return null; // se sale de la imagen
        const i = (y * w + x) * 4; const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
        sr += R; sg += G; sb += B; s2 += R * R + G * G + B * B; n++;
      }
    }
    if (!n) return null;
    const m = [sr / n, sg / n, sb / n];
    return { m, v: Math.max(0, s2 / n - (m[0] ** 2 + m[1] ** 2 + m[2] ** 2)) };
  };
  const ring = (x0, y0) => {
    // entorno: 8 muestras en un anillo a 1.7 r
    let sr = 0; let sg = 0; let sb = 0; let n = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4; const x = Math.round(x0 + Math.cos(a) * r * 1.7); const y = Math.round(y0 + Math.sin(a) * r * 1.7);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const i = (y * w + x) * 4; sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
    return [sr / n, sg / n, sb / n];
  };
  const target = ring(cx, cy);
  let best = null;
  for (const dist of [2.8, 4.2]) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI * 2) / 16; const dx = Math.cos(a) * r * dist; const dy = Math.sin(a) * r * dist;
      const sx = cx + dx; const sy = cy + dy;
      const here = stat(sx, sy, r); const rg = ring(sx, sy);
      if (!here || !rg || !target) continue;
      const colorDiff = Math.hypot(rg[0] - target[0], rg[1] - target[1], rg[2] - target[2]);
      const score = colorDiff + Math.sqrt(here.v) * 0.8 + dist * 0.5;
      if (!best || score < best.score) best = { score, dx, dy };
    }
  }
  return best ? { dx: best.dx, dy: best.dy } : { dx: r * 3, dy: 0 };
}
