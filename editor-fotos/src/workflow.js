// Lógica del flujo de trabajo con varias fotos. Código puro (sin DOM).
//
// Estados de una foto:  pending (sin tocar) -> edited (con ajustes) -> approved (lista para imprimir).
// Si se edita una foto aprobada, vuelve a "edited": hay que aprobarla de nuevo.

import { clone, defaultEdits, isNeutral, migrate } from './model.js';
import { fitAspect } from './geometry.js';

export const STATUSES = ['pending', 'edited', 'approved'];
export const STATUS_LABELS = { pending: 'Pendiente', edited: 'Editada', approved: 'Aprobada' };

// Estado tras cambiar los ajustes (nunca devuelve "approved").
export function statusAfterEdit(edits) { return isNeutral(edits) ? 'pending' : 'edited'; }

// ¿Se puede aprobar? (una foto sin ajustes también se puede aprobar: a veces sale bien tal cual)
export function toggleApproved(status) { return status === 'approved' ? 'edited' : 'approved'; }

// Copia ajustes de una foto a otra. Por defecto NO copia recorte/giro ni máscaras (son de cada foto).
export function pasteEdits(target, source, { geometry = false, masks = false } = {}) {
  const out = clone(migrate(source));
  if (!geometry) out.geometry = clone(migrate(target)).geometry;
  if (!masks) out.masks = clone(migrate(target)).masks;
  return out;
}

export function orientedDims(w, h, rotate90 = 0) { return rotate90 % 2 === 1 ? { w: h, h: w } : { w, h }; }

// Pone el recorte de una foto a la proporción dada (ancho/alto), centrado sobre su recorte actual.
export function cropForAspect(edits, aspect, srcW, srcH) {
  const e = clone(migrate(edits));
  const { w: ow, h: oh } = orientedDims(srcW, srcH, e.geometry.rotate90);
  e.geometry.crop = fitAspect(aspect, ow, oh, e.geometry.crop);
  return e;
}

// Proporción (ancho/alto) de lo que se ve de la foto con sus ajustes de recorte y giro.
export function visibleAspect(edits, srcW, srcH) {
  const g = migrate(edits).geometry;
  const { w: ow, h: oh } = orientedDims(srcW, srcH, g.rotate90);
  return (g.crop.w * ow) / (g.crop.h * oh);
}

// Qué fotos van en el pedido: 'approved' | 'all' | 'selected'
export function selectJobIds(photos, mode, selected = new Set()) {
  if (mode === 'all') return photos.map((p) => p.id);
  if (mode === 'selected') return photos.filter((p) => selected.has(p.id)).map((p) => p.id);
  return photos.filter((p) => p.status === 'approved').map((p) => p.id);
}

export function summarize(photos) {
  const s = { pending: 0, edited: 0, approved: 0, total: photos.length };
  for (const p of photos) s[p.status] = (s[p.status] || 0) + 1;
  return s;
}

// Siguiente foto por revisar después de la actual (primero las no aprobadas, dando la vuelta). null si todas están aprobadas.
export function nextToReview(photos, currentId) {
  if (!photos.length) return null;
  const start = Math.max(0, photos.findIndex((p) => p.id === currentId));
  for (let i = 1; i <= photos.length; i++) {
    const p = photos[(start + i) % photos.length];
    if (p.status !== 'approved' && p.id !== currentId) return p.id;
  }
  return null;
}

export function neighbor(photos, currentId, delta) {
  if (!photos.length) return null;
  const i = photos.findIndex((p) => p.id === currentId);
  const j = Math.min(photos.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
  return photos[j].id;
}

// Avisos de recorte: fotos que perderían más de `limit` de su superficie al cubrir la ventana.
// windowAspect: número (igual para todas) o función (foto) => proporción de su ventana.
export function cropWarnings(photos, windowAspect, limit = 0.08) {
  const out = [];
  for (const p of photos) {
    const a = p.aspect; const w = typeof windowAspect === 'function' ? windowAspect(p) : windowAspect;
    if (!a || !w) continue;
    const loss = a > w ? 1 - w / a : 1 - a / w;
    if (loss > limit) out.push({ id: p.id, name: p.name, loss });
  }
  return out;
}

// Resolución efectiva (puntos por pulgada) de una foto dentro de una ventana de impresión.
// rec: { width, height, edits }. windowPxW/H: tamaño de la ventana en píxeles a `dpi` ppp.
// Con "cubrir", la foto se escala hasta llenar la ventana: manda la dimensión más justa.
export function effectivePpi(rec, windowPxW, windowPxH, dpi, fit = 'cover') {
  const e = migrate(rec.edits);
  const { w: ow, h: oh } = orientedDims(rec.width, rec.height, e.geometry.rotate90);
  const cropW = e.geometry.crop.w * ow; const cropH = e.geometry.crop.h * oh;
  const a = cropW / windowPxW; const b = cropH / windowPxH; // píxeles de foto por píxel de papel
  return Math.round(dpi * (fit === 'contain' ? Math.max(a, b) : Math.min(a, b)));
}

export { defaultEdits };
