// Especificación de una hoja de impresión y de un restaurante (marca). Código puro.
//
// Un "restaurante" guarda su logo y sus preferencias de impresión (papel, marco,
// posición del logo, texto), para que cada pedido salga igual sin reconfigurar.

import { PAPERS, FRAME_KINDS, DPI_OPTIONS, LOGO_POSITIONS } from './layout.js';

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const pick = (v, list, d) => (list.includes(v) ? v : d);
const color = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);

export const FONTS = [
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { id: 'sans', label: 'Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'script', label: 'Manuscrita', css: '"Brush Script MT", "Snell Roundhand", cursive' },
  { id: 'mono', label: 'Monoespaciada', css: 'ui-monospace, Menlo, Consolas, monospace' },
];

export function defaultPrintSpec() {
  return {
    paper: '10x15', orientation: 'auto', custom: { w: 100, h: 150 }, dpi: 300,
    marginMm: 0, background: '#ffffff',
    bleedMm: 0, marks: false, // sangrado (la foto y el fondo se extienden bajo el corte) y marcas de corte
    color: { mode: 'srgb', profileId: null, profileName: '', intent: 'relative', bpc: true }, // 'profile' = convertir al perfil ICC de la imprenta
    cols: 1, rows: 1, gutterMm: 4, copies: 1,
    photoFit: 'cover',
    frame: { kind: 'border', widthMm: 5, color: '#ffffff', innerColor: '#2a2a2a', radiusMm: 4, customId: null, fit: 'contain' },
    logo: { enabled: true, x: 0.5, y: 0.93, widthPct: 22, opacity: 1, plate: false, plateColor: '#ffffff' },
    caption: { enabled: false, text: '', font: 'serif', sizePt: 14, color: '#2a2a2a', bold: false, italic: false, y: 0.965 },
  };
}

// Sanea cualquier objeto (de disco o de un archivo) y completa lo que falte.
export function migratePrintSpec(raw) {
  const d = defaultPrintSpec();
  const r = raw && typeof raw === 'object' ? raw : {};
  const f = r.frame || {}; const l = r.logo || {}; const c = r.caption || {}; const k = r.color || {};
  return {
    paper: pick(r.paper, PAPERS.map((p) => p.id), d.paper),
    orientation: pick(r.orientation, ['auto', 'portrait', 'landscape'], d.orientation),
    custom: { w: clamp(r.custom && r.custom.w, 20, 1000, d.custom.w), h: clamp(r.custom && r.custom.h, 20, 1000, d.custom.h) },
    dpi: pick(Number(r.dpi), DPI_OPTIONS, d.dpi),
    marginMm: clamp(r.marginMm, 0, 50, d.marginMm),
    bleedMm: clamp(r.bleedMm, 0, 10, d.bleedMm), marks: !!r.marks,
    color: {
      mode: k.mode === 'profile' && typeof k.profileId === 'string' && k.profileId ? 'profile' : 'srgb',
      profileId: typeof k.profileId === 'string' && k.profileId ? k.profileId.slice(0, 80) : null,
      profileName: typeof k.profileName === 'string' ? k.profileName.slice(0, 120) : '',
      intent: pick(k.intent, ['perceptual', 'relative', 'saturation', 'absolute'], d.color.intent), bpc: k.bpc !== false,
    },
    background: color(r.background, d.background),
    cols: Math.round(clamp(r.cols, 1, 4, 1)), rows: Math.round(clamp(r.rows, 1, 4, 1)),
    gutterMm: clamp(r.gutterMm, 0, 30, d.gutterMm),
    copies: Math.round(clamp(r.copies, 1, 99, 1)),
    photoFit: pick(r.photoFit, ['cover', 'contain'], d.photoFit),
    frame: {
      kind: pick(f.kind, FRAME_KINDS.map((k) => k.id), d.frame.kind),
      widthMm: clamp(f.widthMm, 0, 60, d.frame.widthMm),
      color: color(f.color, d.frame.color), innerColor: color(f.innerColor, d.frame.innerColor),
      radiusMm: clamp(f.radiusMm, 0, 40, d.frame.radiusMm),
      customId: typeof f.customId === 'string' ? f.customId : null,
      fit: pick(f.fit, ['contain', 'stretch', 'cover'], d.frame.fit),
    },
    logo: {
      enabled: l.enabled !== false, x: clamp(l.x, 0, 1, d.logo.x), y: clamp(l.y, 0, 1, d.logo.y),
      widthPct: clamp(l.widthPct, 2, 100, d.logo.widthPct), opacity: clamp(l.opacity, 0.05, 1, 1),
      plate: !!l.plate, plateColor: color(l.plateColor, d.logo.plateColor),
    },
    caption: {
      enabled: !!c.enabled, text: typeof c.text === 'string' ? c.text.slice(0, 200) : '',
      font: pick(c.font, FONTS.map((x) => x.id), d.caption.font), sizePt: clamp(c.sizePt, 6, 96, d.caption.sizePt),
      color: color(c.color, d.caption.color), bold: !!c.bold, italic: !!c.italic, y: clamp(c.y, 0, 1, d.caption.y),
    },
  };
}

export function newBrand(name, id) {
  return { id: id || `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: String(name || 'Restaurante').slice(0, 60), spec: defaultPrintSpec(), logoId: null, createdAt: Date.now() };
}

export function migrateBrand(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { id: String(r.id || newBrand().id), name: String(r.name || 'Restaurante').slice(0, 60), spec: migratePrintSpec(r.spec), logoId: typeof r.logoId === 'string' ? r.logoId : null, createdAt: Number(r.createdAt) || Date.now() };
}

// Texto del pie con variables: {fecha}, {nombre} (restaurante), {foto}
export function captionText(template, vars = {}) {
  return String(template || '')
    .replace(/\{fecha\}/gi, vars.fecha || '')
    .replace(/\{nombre\}/gi, vars.nombre || '')
    .replace(/\{foto\}/gi, vars.foto || '')
    .trim();
}

export function setLogoPosition(spec, key) {
  const p = LOGO_POSITIONS[key];
  if (!p) return spec;
  return { ...spec, logo: { ...spec.logo, x: p[0], y: p[1] } };
}

// Páginas necesarias para una lista de copias.
export function pagesNeeded(photoCount, spec) {
  const perPage = Math.max(1, spec.cols * spec.rows);
  return Math.ceil((photoCount * Math.max(1, spec.copies)) / perPage);
}

// Expande fotos × copias en el orden de impresión.
export function expandCopies(ids, copies) {
  const out = [];
  for (const id of ids) for (let i = 0; i < Math.max(1, copies); i++) out.push(id);
  return out;
}
