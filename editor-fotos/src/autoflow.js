// Flujo automático: vigilar una carpeta donde llegan las fotos de la cámara, y llevar cada una por la cola
// (importar -> preset -> marco -> salida). Este archivo es lógica pura (sin DOM ni almacenamiento): se prueba sola.

// Estados de una foto en la cola, en orden. `final` = ya no se tocará sola.
export const STATES = {
  waiting: { label: 'Esperando', final: false },
  importing: { label: 'Importando', final: false },
  processing: { label: 'Aplicando preset y marco', final: false },
  review: { label: 'Por aprobar', final: false },
  printing: { label: 'Enviando a imprimir', final: false },
  done: { label: 'Lista', final: true },
  discarded: { label: 'Descartada', final: true },
  error: { label: 'Error', final: true },
};

// Nombres que NO son fotos de la cámara: ocultos, temporales de una copia a medias, miniaturas y sidecars.
const IGNORED = /(^\.|~$|\.(tmp|part|partial|crdownload|download|lock|xmp|aae|thm|json|txt|db|ini|log)$|^thumbs\.db$)/i;
export function isIncomingName(name, isPhotoName) {
  const n = String(name || '');
  return n.length > 0 && !IGNORED.test(n) && !!isPhotoName(n);
}

// Vigila una carpeta. `list()` devuelve [{ name, size, mtime }]. Una foto está "lista" cuando su tamaño y fecha
// llevan `settleMs` sin cambiar (así no se abre una foto que la cámara todavía está copiando).
export class FolderWatcher {
  constructor({ list, isPhotoName, settleMs = 1500, now = () => Date.now(), known = [] } = {}) {
    this.list = list; this.isPhotoName = isPhotoName; this.settleMs = settleMs; this.now = now;
    this.known = new Set(known);   // claves ya procesadas
    this.seen = new Map();         // nombre -> { size, mtime, since }
    this.started = false;
  }

  keyOf(e) { return `${e.name}|${e.size}|${e.mtime}`; }

  // includeExisting=false: las fotos que ya estaban en la carpeta al empezar se ignoran (solo cuentan las nuevas).
  async start({ includeExisting = false } = {}) {
    this.seen.clear(); this.started = true;
    if (!includeExisting) for (const e of await this.list()) if (isIncomingName(e.name, this.isPhotoName)) this.known.add(this.keyOf(e));
  }

  // Devuelve las fotos nuevas y estables, de la más antigua a la más nueva (así se imprimen en orden de disparo).
  async poll() {
    const entries = (await this.list()).filter((e) => isIncomingName(e.name, this.isPhotoName));
    const t = this.now(); const present = new Set(); const ready = [];
    for (const e of entries) {
      present.add(e.name);
      const key = this.keyOf(e);
      if (this.known.has(key)) continue;
      const prev = this.seen.get(e.name);
      if (!prev || prev.size !== e.size || prev.mtime !== e.mtime) { this.seen.set(e.name, { size: e.size, mtime: e.mtime, since: t }); continue; }
      if (e.size > 0 && t - prev.since >= this.settleMs) ready.push(e);
    }
    for (const name of [...this.seen.keys()]) if (!present.has(name)) this.seen.delete(name);
    ready.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const e of ready) { this.known.add(this.keyOf(e)); this.seen.delete(e.name); }
    return ready;
  }

  // Si el procesamiento falló y se quiere reintentar.
  forget(entry) { this.known.delete(this.keyOf(entry)); }
  knownKeys() { return [...this.known].slice(-5000); } // para guardar entre sesiones, con tope
}

// Cola de fotos con sus estados. Guarda solo las últimas `max` para no crecer sin fin en un evento largo.
export class AutoQueue {
  constructor(max = 300) { this.items = []; this.max = max; this.seq = 0; this.listeners = new Set(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  add(fields) {
    const item = { id: `q${++this.seq}`, status: 'waiting', addedAt: Date.now(), error: '', ...fields };
    this.items.push(item);
    while (this.items.length > this.max) { const i = this.items.findIndex((x) => STATES[x.status].final); this.items.splice(i < 0 ? 0 : i, 1); }
    this.emit(); return item;
  }
  update(id, patch) { const it = this.items.find((x) => x.id === id); if (it) { Object.assign(it, patch); this.emit(); } return it; }
  get(id) { return this.items.find((x) => x.id === id) || null; }
  counts() {
    const c = { waiting: 0, importing: 0, processing: 0, review: 0, printing: 0, done: 0, discarded: 0, error: 0 };
    for (const it of this.items) c[it.status]++;
    return c;
  }
  // La próxima foto que toca procesar (la más antigua en espera).
  nextWaiting() { return this.items.find((x) => x.status === 'waiting') || null; }
  clearFinished() { this.items = this.items.filter((x) => !STATES[x.status].final); this.emit(); }
}

// Nombre de archivo de salida seguro y ordenado: 20261011-203015_001_plato.jpg
export function outputName(photoName, index, ext, date = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const safe = String(photoName || 'foto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'foto';
  return `${stamp}_${p(index, 3)}_${safe}.${ext}`;
}

// ¿Puede este navegador vigilar una carpeta? (Chrome y Edge en Mac, Windows y Linux; Safari y Firefox no.)
export function folderAccessSupported(win = globalThis) {
  return typeof win.showDirectoryPicker === 'function';
}
