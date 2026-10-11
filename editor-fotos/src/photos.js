// Biblioteca de fotos (varias a la vez) y su tira de miniaturas.
//
// Cada foto se guarda en IndexedDB con su archivo original, sus ajustes y su estado
// (pendiente / editada / aprobada). La biblioteca en memoria solo guarda lo ligero
// (nombre, estado, proporción, miniatura): el archivo se lee cuando se necesita.

import * as storage from './storage.js';
import { el } from './ui-kit.js';
import { STATUS_LABELS } from './workflow.js';

const THUMB = 240;

// Decodifica una foto respetando la orientación EXIF.
export async function decodeBlob(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* probar con <img> */ }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.src = url; await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
}

export const sizeOf = (img) => ({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });

// Miniatura JPEG (Blob) de cualquier fuente dibujable.
export function makeThumb(source, w = sizeOf(source).w, h = sizeOf(source).h, quality = 0.8) {
  const k = Math.min(1, THUMB / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}

export class Library {
  constructor() {
    this.items = [];            // [{ id, name, status, aspect, width, height, thumbURL }]
    this.selected = new Set();  // ids marcados con la casilla
    this.currentId = null;
    this.listeners = new Set();
    this.urls = new Map();      // id -> object URL de la miniatura
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  _meta(rec) {
    const old = this.urls.get(rec.id);
    let url = old;
    if (rec.thumb && (!old || old.blob !== rec.thumb)) {
      if (old) URL.revokeObjectURL(old.url);
      url = { blob: rec.thumb, url: URL.createObjectURL(rec.thumb) };
      this.urls.set(rec.id, url);
    }
    return { id: rec.id, name: rec.name, status: rec.status, aspect: rec.aspect || 1.5, width: rec.width, height: rec.height, thumbURL: url ? url.url : '' };
  }

  async load() {
    const recs = await storage.listPhotos();
    this.items = recs.map((r) => this._meta(r));
    this.selected = new Set([...this.selected].filter((id) => this.items.some((p) => p.id === id)));
    this.emit();
  }

  get(id) { return this.items.find((p) => p.id === id) || null; }

  // Guarda el registro completo y actualiza su ficha ligera.
  async put(rec) {
    await storage.putPhoto(rec);
    const m = this._meta(rec);
    const i = this.items.findIndex((p) => p.id === rec.id);
    if (i >= 0) this.items[i] = m; else this.items.push(m);
    this.emit();
    return m;
  }

  setCurrent(id) { this.currentId = id; this.emit(); }

  toggleSelected(id) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); this.emit(); }
  selectAll(on = true) { this.selected = on ? new Set(this.items.map((p) => p.id)) : new Set(); this.emit(); }

  async remove(ids) {
    for (const id of ids) {
      await storage.deletePhoto(id);
      const u = this.urls.get(id); if (u) { URL.revokeObjectURL(u.url); this.urls.delete(id); }
      this.items = this.items.filter((p) => p.id !== id);
      this.selected.delete(id);
    }
    if (ids.includes(this.currentId)) this.currentId = null;
    this.emit();
  }
}

// ---------- tira de miniaturas ----------

// handlers: { onSelect(id), onAction(name) }.  Acciones: approve, copy, paste, selectAll, remove, autoTone
export function createFilmstrip(root, lib, handlers) {
  const bar = el('div', { class: 'fsbar' });
  const list = el('div', { class: 'fslist', role: 'listbox', 'aria-label': 'Fotos' });
  root.replaceChildren(bar, list);

  const btn = (act, label, title) => el('button', { class: 'btn small', type: 'button', 'data-act': act, title, onClick: () => handlers.onAction(act) }, label);
  const info = el('span', { class: 'fsinfo' });
  bar.append(
    info,
    btn('approve', '✓ Aprobar', 'Aprobar o quitar la aprobación (tecla A)'),
    btn('copy', 'Copiar ajustes', 'Copia los ajustes de esta foto'),
    btn('paste', 'Pegar en seleccionadas', 'Pega los ajustes copiados en las fotos marcadas'),
    btn('selectAll', 'Marcar todas', 'Marca o desmarca todas las fotos'),
    btn('remove', 'Quitar', 'Quita de la biblioteca la foto actual o las marcadas'),
  );

  function render() {
    const n = lib.items.length;
    root.hidden = n === 0;
    const ap = lib.items.filter((p) => p.status === 'approved').length;
    info.textContent = `${n} foto${n === 1 ? '' : 's'} · ${ap} aprobada${ap === 1 ? '' : 's'}`;
    const cur = lib.get(lib.currentId);
    const approveBtn = bar.querySelector('[data-act="approve"]');
    approveBtn.classList.toggle('on', !!cur && cur.status === 'approved');
    approveBtn.textContent = cur && cur.status === 'approved' ? '✓ Aprobada' : '✓ Aprobar';
    bar.querySelector('[data-act="paste"]').disabled = !handlers.hasClipboard();
    bar.querySelector('[data-act="selectAll"]').textContent = lib.selected.size === n && n > 0 ? 'Desmarcar todas' : 'Marcar todas';

    list.replaceChildren(...lib.items.map((p) => {
      const cb = el('input', { type: 'checkbox', class: 'sel', 'aria-label': `Marcar ${p.name}`, title: 'Marcar para pegar ajustes, aplicar presets o imprimir' });
      cb.checked = lib.selected.has(p.id);
      cb.addEventListener('click', (e) => { e.stopPropagation(); lib.toggleSelected(p.id); });
      const badge = el('span', { class: `badge ${p.status}`, title: STATUS_LABELS[p.status] }, p.status === 'approved' ? '✓' : p.status === 'edited' ? '✎' : '');
      const img = p.thumbURL ? el('img', { src: p.thumbURL, alt: p.name, draggable: 'false' }) : el('span', { class: 'noimg' }, '…');
      const b = el('button', { class: 'thumb' + (p.id === lib.currentId ? ' on' : ''), type: 'button', role: 'option', 'data-id': p.id, title: `${p.name} — ${STATUS_LABELS[p.status]}`, 'aria-selected': p.id === lib.currentId }, img, badge, cb);
      b.addEventListener('click', () => handlers.onSelect(p.id));
      return b;
    }));
    const on = list.querySelector('.thumb.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  lib.on(render);
  render();
  return { render };
}
