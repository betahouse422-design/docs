// Modelo de ediciones. Código puro (sin DOM) para poder probarlo en Node.
//
// Una edición es un objeto JSON versionado. El original nunca se modifica:
// el motor vuelve a aplicar estas ediciones sobre la foto original.
// Convención: casi todos los deslizadores van de -100 a 100 y 0 es neutro.
// Excepciones: exposición (EV, -5..5), grano/nitidez/fade (0..100).

import { normalizePoints } from './curves.js';
import { normalizeStrokes } from './brush.js';

export const EDITS_VERSION = 1;

export const HSL_RANGES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];

export const HSL_LABELS = {
  red: 'Rojo', orange: 'Naranja', yellow: 'Amarillo', green: 'Verde',
  aqua: 'Aguamarina', blue: 'Azul', purple: 'Morado', magenta: 'Magenta',
};

export const CURVE_CHANNELS = ['master', 'r', 'g', 'b'];
// Curvas por tono: x = tono (0..1 = 0..360°), y = 0.5 es "sin cambio".
export const HSL_CURVES = ['hue', 'sat', 'lum'];
export const flatCurve = () => [[0, 0.5], [1, 0.5]];

export const MAX_MASKS = 4;
export const MAX_SPOTS = 16;

const identityCurve = () => [[0, 0], [1, 1]];

export function defaultEdits() {
  const hsl = {};
  for (const r of HSL_RANGES) hsl[r] = { h: 0, s: 0, l: 0 };
  return {
    v: EDITS_VERSION,
    light: { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    color: { temperature: 0, tint: 0, saturation: 0, vibrance: 0, hsl },
    curves: { master: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    hslCurves: { hue: flatCurve(), sat: flatCurve(), lum: flatCurve() },
    grading: {
      shadows: { hue: 220, sat: 0 },
      mids: { hue: 40, sat: 0 },
      highlights: { hue: 45, sat: 0 },
      balance: 0,
    },
    detail: { clarity: 0, sharpness: 0, texture: 0, dehaze: 0, denoise: 0, colorDenoise: 0 },
    effects: { vignette: 0, grain: 0, grainSize: 30, fade: 0, bloom: 0, halation: 0 },
    geometry: { crop: { x: 0, y: 0, w: 1, h: 1 }, rotate90: 0, straighten: 0, flipH: false, flipV: false },
    look: { id: null, name: '', intensity: 100 }, // LUT 3D (.cube): el archivo se guarda aparte, aquí solo su id
    masks: [],
    spots: [],
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
      { path: 'detail.texture', label: 'Textura', min: -100, max: 100, step: 1 },
      { path: 'detail.dehaze', label: 'Quitar neblina', min: -100, max: 100, step: 1 },
      { path: 'detail.sharpness', label: 'Nitidez', min: 0, max: 100, step: 1 },
    ],
  },
  {
    id: 'noise', title: 'Reducción de ruido', sliders: [
      { path: 'detail.denoise', label: 'Luminosidad', min: 0, max: 100, step: 1 },
      { path: 'detail.colorDenoise', label: 'Color', min: 0, max: 100, step: 1 },
    ],
  },
  {
    id: 'effects', title: 'Efectos', sliders: [
      { path: 'effects.fade', label: 'Desvanecer', min: 0, max: 100, step: 1 },
      { path: 'effects.bloom', label: 'Bloom (brillo)', min: 0, max: 100, step: 1 },
      { path: 'effects.halation', label: 'Halation (halo cálido)', min: 0, max: 100, step: 1 },
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

function curveIsFlat(pts) {
  return pts.every((p) => Math.abs(p[1] - 0.5) < 1e-6);
}

export function hslCurvesActive(edits) {
  return HSL_CURVES.some((c) => !curveIsFlat(edits.hslCurves[c]));
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

export function lookActive(edits) {
  return !!(edits.look && edits.look.id) && edits.look.intensity !== 0;
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
  return !curvesActive(edits) && !hslCurvesActive(edits) && !hslActive(edits) && !gradingActive(edits) && !lookActive(edits) &&
    !geometryActive(edits) && edits.masks.length === 0 && (edits.spots || []).length === 0;
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
  out.spots = Array.isArray(raw.spots) ? raw.spots.map(normalizeSpot).filter(Boolean).slice(0, MAX_SPOTS) : []; // primero limpiar, luego limitar
  for (const c of CURVE_CHANNELS) {
    const pts = raw.curves && raw.curves[c];
    out.curves[c] = Array.isArray(pts) && pts.length >= 2 ? sanitizeCurve(pts) : identityCurve();
  }
  out.look = normalizeLook(raw.look);
  for (const c of HSL_CURVES) {
    const pts = raw.hslCurves && raw.hslCurves[c];
    out.hslCurves[c] = Array.isArray(pts) && pts.length >= 2 ? wrapCurve(sanitizeCurve(pts)) : flatCurve();
  }
  return out;
}

function mergeInto(base, src) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return src === undefined ? base : src;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(base)) {
    if (k === 'masks' || k === 'curves' || k === 'hslCurves' || k === 'spots' || k === 'look') continue;
    if (src && src[k] !== undefined) {
      out[k] = typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
        ? mergeInto(base[k], src[k])
        : (typeof base[k] === typeof src[k] ? src[k] : base[k]);
    }
  }
  return out;
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

// El tono es circular: 0° y 360° son el mismo color, así que los dos extremos valen lo mismo.
function wrapCurve(pts) { pts[pts.length - 1][1] = pts[0][1]; return pts; }

// Ordena, limpia duplicados y fija los extremos en x=0 y x=1.
function sanitizeCurve(pts) {
  const out = normalizePoints(pts.map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]));
  out[0][0] = 0;
  out[out.length - 1][0] = 1;
  return out;
}

function normalizeLook(l) {
  const id = l && typeof l.id === 'string' && l.id ? l.id.slice(0, 80) : null;
  const i = Number(l && l.intensity);
  return { id, name: id ? String((l && l.name) || '').slice(0, 80) : '', intensity: Number.isFinite(i) ? Math.min(100, Math.max(0, i)) : 100 };
}

// ---- Máscaras locales -----------------------------------------------------

export function defaultMaskAdjust() {
  return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0 };
}

export function newMask(type, id = String(Date.now() + Math.floor(Math.random() * 1000))) {
  const base = { id, type, invert: false, feather: 0.5, enabled: true, adjust: defaultMaskAdjust() };
  if (type === 'brush') return { ...base, type: 'brush', strokes: [] };
  if (type === 'linear') return { ...base, x0: 0.5, y0: 0.35, x1: 0.5, y1: 0.75 };
  return { ...base, type: 'radial', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, angle: 0 };
}

function normalizeMask(m) {
  const t = m && (m.type === 'linear' || m.type === 'brush') ? m.type : 'radial';
  const d = newMask(t, m && m.id ? String(m.id) : undefined);
  const out = { ...d, ...m, adjust: { ...d.adjust, ...(m && m.adjust) } };
  out.type = t;
  if (t === 'brush') out.strokes = normalizeStrokes(m && m.strokes);
  return out;
}

// ---- Puntos de retoque (quitar manchas) ------------------------------------
// Coordenadas en la imagen ya girada (0..1, origen arriba-izquierda), ANTES del recorte:
// así siguen en su sitio si cambias el recorte. r = radio como fracción del ancho.
// (dx, dy) = desplazamiento hasta la zona de la que se toma la textura.

export function newSpot(x, y, r = 0.02, dx = 0.06, dy = 0, mode = 'heal') {
  return { id: String(Date.now() + Math.floor(Math.random() * 1000)), x, y, r, dx, dy, feather: 0.5, opacity: 1, mode };
}

function normalizeSpot(sp) {
  if (!sp || typeof sp !== 'object') return null;
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return {
    id: String(sp.id || Date.now()), x: n(sp.x, 0, 1, 0.5), y: n(sp.y, 0, 1, 0.5), r: n(sp.r, 0.003, 0.3, 0.02),
    dx: n(sp.dx, -1, 1, 0.06), dy: n(sp.dy, -1, 1, 0), feather: n(sp.feather, 0, 1, 0.5), opacity: n(sp.opacity, 0, 1, 1),
    mode: sp.mode === 'clone' ? 'clone' : 'heal',
  };
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
  if (p.look && p.look.id) out.look = { ...p.look, intensity: Math.round(p.look.intensity * k) };
  for (const c of HSL_CURVES) {
    if (curveIsFlat(p.hslCurves[c]) || !curveIsFlat(out.hslCurves[c])) continue;
    out.hslCurves[c] = p.hslCurves[c].map(([x, y]) => [x, round(0.5 + (y - 0.5) * k, 5)]);
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
  { id: 'resplandor', name: 'Resplandor (velas)', edits: { effects: { bloom: 38, halation: 28, fade: 8 }, color: { temperature: 8, saturation: 6 }, light: { highlights: -12, contrast: 6 } } },
].map((p) => ({ id: p.id, name: p.name, builtin: true, edits: migrate(p.edits) }));
