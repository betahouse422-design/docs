// Almacenamiento local (IndexedDB) con respaldo en memoria.
// Guarda: ediciones por foto (para retomar), y presets propios.
// Nada sale del dispositivo.

import { migrate } from './model.js';

const DB_NAME = 'editor-fotos';
const DB_VERSION = 1;

let dbPromise = null;
const memory = { edits: new Map(), presets: new Map() };

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits');
        if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;

export async function saveEdits(key, edits) {
  const db = await openDb();
  const value = JSON.parse(JSON.stringify(edits));
  if (!db) { memory.edits.set(key, value); return; }
  try { await tx(db, 'edits', 'readwrite', (s) => s.put(value, key)); } catch { memory.edits.set(key, value); }
}

export async function loadEdits(key) {
  const db = await openDb();
  if (!db) return memory.edits.has(key) ? migrate(memory.edits.get(key)) : null;
  try {
    const v = await tx(db, 'edits', 'readonly', (s) => s.get(key));
    return v ? migrate(v) : null;
  } catch { return null; }
}

export async function listPresets() {
  const db = await openDb();
  if (!db) return [...memory.presets.values()];
  try {
    const all = await tx(db, 'presets', 'readonly', (s) => s.getAll());
    return (all || []).map((p) => ({ ...p, edits: migrate(p.edits) }));
  } catch { return []; }
}

export async function savePreset(preset) {
  const value = { id: preset.id, name: preset.name, edits: JSON.parse(JSON.stringify(preset.edits)) };
  const db = await openDb();
  if (!db) { memory.presets.set(value.id, value); return; }
  try { await tx(db, 'presets', 'readwrite', (s) => s.put(value)); } catch { memory.presets.set(value.id, value); }
}

export async function deletePreset(id) {
  const db = await openDb();
  memory.presets.delete(id);
  if (!db) return;
  try { await tx(db, 'presets', 'readwrite', (s) => s.delete(id)); } catch { /* sin acción */ }
}

// ---- Exportar / importar presets como archivo ----

export function presetsToJson(presets) {
  return JSON.stringify({
    format: 'editor-fotos-presets', version: 1,
    presets: presets.map((p) => ({ id: p.id, name: p.name, edits: p.edits })),
  }, null, 2);
}

export function presetsFromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('El archivo no es JSON válido.'); }
  if (!data || data.format !== 'editor-fotos-presets' || !Array.isArray(data.presets)) {
    throw new Error('El archivo no es un paquete de presets de esta app.');
  }
  return data.presets
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: p.name.slice(0, 60),
      edits: migrate(p.edits),
    }));
}
