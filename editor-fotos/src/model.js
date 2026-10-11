// Modelo de ediciones. Código puro (sin DOM) para poder probarlo en Node.
//
// Una edición es un objeto JSON versionado. El original nunca se modifica:
// el motor vuelve a aplicar estas ediciones sobre la foto original.
// Convención: casi todos los deslizadores van de -100 a 100 y 0 es neutro.
// Excepciones: exposición (EV, -5..5), grano/nitidez/fade (0..100).

import { normalizePoints } from './curves.js';

export const EDITS_VERSION = 1;

export const HSL_RANGES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];

export const HSL_LABELS = {
  red: 'Rojo', orange: 'Naranja', yellow: 'Amarillo', green: 'Verde',
  aqua: 'Aguamarina', blue: 'Azul', purple: 'Morado', magenta: 'Magenta',
};

export const CURVE_CHANNELS = ['master', 'r', 'g', 'b'];

export const MAX_MASKS = 4;

const identityCurve = () => [[0, 0], [1, 1]];

export function defaultEdits() {
  const hsl = {};
  for (const r of HSL_RANGES) hsl[r] = { h: 0, s: 0, l: 0 };
  return {
    v: EDITS_VERSION,
    light: { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    color: { temperature: 0, tint: 0, saturation: 0, vibrance: 0, hsl },
    curves: { master: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    grading: {
      shadows: { hue: 220, sat: 0 },
      mids: { hue: 40, sat: 0 },
      highlights: { hue: 45, sat: 0 },
      balance: 0,
    },
    detail: { clarity: 0, sharpness: 0 },
    effects: { vignette: 0, grain: 0, grainSize: 30, fade: 0 },
    geometry: { crop: { x: 0, y: 0, w: 1, h: 1 }, rotate90: 0, straighten: 0, flipH: false, flipV: false },
    masks: [],
  };
}

export function clone(edits) {
  return JSON.parse(JSON.stringify(edits));
}

// ---- Especificación de deslizadores (la UI se genera desde aquí) ----------

export const SLIDER_GROUPS = [
  {
    id: 'light', title: 'Luz', sliders: [
      { path: 'light.exposure', label: 'Exposición', min: -5, max: 5, step: 0.01, unit: 'EV' },
      { path: 'light.brightness', label: 'Brillo', min: -100, max: 100, step: 1 },
      { path: 'light.contrast', label: 'Contraste', min: -100, max: 100, step: 1 },
      { path: 'light.highlights', label: 'Luces', min: -100, max: 100, step: 1 },
      { path: 'light.shadows', label: 'Sombras', min: -100, max: 100, step: 1 },
      { path: 'light.whites', label: 'Blancos', min: -100, max: 100, step: 1 },
      { path: 'light.blacks', label: 'Negros', min: -100, max: 100, step: 1 },
    ],
  },
  {
    id: 'color', title: 'Color', sliders: [
      { path: 'color.temperature', label: 'Temperatura', min: -100, max: 100, step: 1, track: 'temp' },
      { path: 'color.tint', label: 'Tinte', min: -100, max: 100, step: 1, track: 'tint' },
      { path: 'color.saturation', label: 'Saturación', min: -100, max: 100, step: 1 },
      { path: 'color.vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
    ],
  },
  {
    id: 'detail', title: 'Detalle', sliders: [
      { path: 'detail.clarity', label: 'Claridad', min: -100, max: 100, step: 1 },
      { path: 'detail.sharpness', label: 'Nitidez', min: 0, max: 100, step: 1 },
    ],
  },
  {
    id: 'effects', title: 'Efectos', sliders: [
      { path: 'effects.fade', label: 'Desvanecer', min: 0, max: 100, step: 1 },
      { path: 'effects.vignette', label: 'Viñeta', min: -100, max: 100, step: 1 },
      { path: 'effects.grain', label: 'Grano', min: 0, max: 100, step: 1 },
      { path: 'effects.grainSize', label: 'Tamaño del grano', min: 1, max: 100, step: 1, neutral: 30 },
    ],
  },
];

// ---- Acceso por ruta ("light.exposure") -----------------------------------

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
  return obj;
}

// ---- Neutralidad ----------------------------------------------------------

function curveIsIdentity(pts) {
  if (pts.length !== 2) return false;
  return pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
}

export function curvesActive(edits) {
  return CURVE_CHANNELS.some((c) => !curveIsIdentity(edits.curves[c]));
}

export function hslActive(edits) {
  return HSL_RANGES.some((r) => {
    const v = edits.color.hsl[r];
    return v.h !== 0 || v.s !== 0 || v.l !== 0;
  });
}

export function gradingActive(edits) {
  const g = edits.grading;
  return g.shadows.sat !== 0 || g.mids.sat !== 0 || g.highlights.sat !== 0;
}

export function geometryActive(edits) {
  const g = edits.geometry;
  return g.rotate90 !== 0 || g.straighten !== 0 || g.flipH || g.flipV ||
    g.crop.x !== 0 || g.crop.y !== 0 || g.crop.w !== 1 || g.crop.h !== 1;
}

// "Neutra" = no cambia ni un píxel. Se usa para saltarse todo el render.
export function isNeutral(edits) {
  const d = defaultEdits();
  for (const group of SLIDER_GROUPS) {
    for (const s of group.sliders) {
      if (s.path === 'effects.grainSize') continue; // sin grano, su valor no importa
      if (getPath(edits, s.path) !== getPath(d, s.path)) return false;
    }
  }
  return !curvesActive(edits) && !hslActive(edits) && !gradingActive(edits) &&
    !geometryActive(edits) && edits.masks.length === 0;
}

// ---- Versionado -----------------------------------------------------------
// Todo cambio de formato incrementa EDITS_VERSION y añade un paso aquí.
// Lo no reconocido se completa con valores por defecto, así que se pueden
// añadir ajustes nuevos sin romper fotos guardadas.

export function migrate(raw) {
  const base = defaultEdits();
  if (!raw || typeof raw !== 'object') return base;
  const out = mergeInto(base, raw);
  out.v = EDITS_VERSION;
  out.masks = Array.isArray(raw.masks) ? raw.masks.slice(0, MAX_MASKS).map(normalizeMask) : [];
  for (const c of CURVE_CHANNELS) {
    const pts = raw.curves && raw.curves[c];
    out.curves[c] = Array.isArray(pts) && pts.length >= 2 ? sanitizeCurve(pts) : identityCurve();
  }
  return out;
}

function mergeInto(base, src) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return src === undefined ? base : src;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(base)) {
    if (k === 'masks' || k === 'curves') continue;
    if (src && src[k] !== undefined) {
      out[k] = typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
        ? mergeInto(base[k], src[k])
        : (typeof base[k] === typeof src[k] ? src[k] : base[k]);
    }
  }
  return out;
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

// Ordena, limpia duplicados y fija los extremos en x=0 y x=1.
function sanitizeCurve(pts) {
  const out = normalizePoints(pts.map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]));
  out[0][0] = 0;
  out[out.length - 1][0] = 1;
  return out;
}

// ---- Máscaras locales -----------------------------------------------------

export function defaultMaskAdjust() {
  return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0 };
}

export function newMask(type, id = String(Date.now() + Math.floor(Math.random() * 1000))) {
  const base = { id, type, invert: false, feather: 0.5, enabled: true, adjust: defaultMaskAdjust() };
  if (type === 'linear') return { ...base, x0: 0.5, y0: 0.35, x1: 0.5, y1: 0.75 };
  return { ...base, type: 'radial', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, angle: 0 };
}

function normalizeMask(m) {
  const t = m && m.type === 'linear' ? 'linear' : 'radial';
  const d = newMask(t, m && m.id ? String(m.id) : undefined);
  const out = { ...d, ...m, adjust: { ...d.adjust, ...(m && m.adjust) } };
  out.type = t;
  return out;
}

// ---- Presets --------------------------------------------------------------
// Un preset es un conjunto de ediciones. Aplicarlo con intensidad k (0..1)
// SUMA al estado actual la diferencia (preset - neutro) * k. Así un preset no
// borra lo que ya hiciste con otros ajustes.
// Curvas: se mezclan hacia la identidad con k; si ya tenías una curva propia
// en ese canal, se conserva la tuya.

export function applyPreset(current, preset, intensity = 1) {
  const k = Math.min(1, Math.max(0, intensity));
  if (k === 0) return clone(current); // al 0 % no se toca nada (ni curvas ni matices)
  const neutral = defaultEdits();
  const p = migrate(preset);
  const out = clone(current);

  for (const group of SLIDER_GROUPS) {
    for (const s of group.sliders) {
      const delta = getPath(p, s.path) - getPath(neutral, s.path);
      if (delta === 0) continue;
      const v = getPath(out, s.path) + delta * k;
      setPath(out, s.path, Math.min(s.max, Math.max(s.min, round(v, 4))));
    }
  }
  for (const r of HSL_RANGES) {
    for (const ch of ['h', 's', 'l']) {
      const delta = p.color.hsl[r][ch];
      if (delta === 0) continue;
      out.color.hsl[r][ch] = Math.min(100, Math.max(-100, round(out.color.hsl[r][ch] + delta * k, 4)));
    }
  }
  for (const zone of ['shadows', 'mids', 'highlights']) {
    const pz = p.grading[zone];
    if (pz.sat !== 0) {
      out.grading[zone].hue = pz.hue;
      out.grading[zone].sat = Math.min(100, Math.max(0, round(out.grading[zone].sat + pz.sat * k, 4)));
    }
  }
  if (p.grading.balance !== 0) {
    out.grading.balance = Math.min(100, Math.max(-100, round(out.grading.balance + p.grading.balance * k, 4)));
  }
  for (const c of CURVE_CHANNELS) {
    if (curveIsIdentity(p.curves[c]) || !curveIsIdentity(out.curves[c])) continue;
    out.curves[c] = p.curves[c].map(([x, y]) => [x, round(x + (y - x) * k, 5)]);
  }
  return out;
}

const round = (v, n) => { const f = 10 ** n; return Math.round(v * f) / f; };

// Presets de arranque (valores simples definidos para esta app).
export const STARTER_PRESETS = [
  { id: 'natural', name: 'Natural', edits: { light: { contrast: 12, shadows: 14, highlights: -12 }, color: { vibrance: 18 }, detail: { clarity: 8 } } },
  { id: 'calido', name: 'Cálido', edits: { color: { temperature: 28, tint: 4, vibrance: 10 }, light: { contrast: 6 } } },
  { id: 'frio', name: 'Frío', edits: { color: { temperature: -26, tint: -3 }, light: { contrast: 8, highlights: -8 } } },
  { id: 'vivido', name: 'Vívido', edits: { color: { saturation: 22, vibrance: 28 }, light: { contrast: 18 }, detail: { clarity: 14 } } },
  { id: 'mate', name: 'Mate', edits: { effects: { fade: 38 }, light: { contrast: -10, blacks: 20 }, color: { saturation: -12 } } },
  { id: 'pelicula', name: 'Película', edits: { effects: { fade: 22, grain: 32, grainSize: 36 }, color: { temperature: 10, saturation: -8 }, light: { contrast: 10, highlights: -14 } } },
  { id: 'bn', name: 'Blanco y negro', edits: { color: { saturation: -100 }, light: { contrast: 22 }, detail: { clarity: 14 } } },
  { id: 'dramatico', name: 'Dramático', edits: { light: { contrast: 30, highlights: -35, shadows: 25, blacks: -12 }, detail: { clarity: 30 }, effects: { vignette: -28 }, color: { saturation: -8 } } },
].map((p) => ({ id: p.id, name: p.name, builtin: true, edits: migrate(p.edits) }));
