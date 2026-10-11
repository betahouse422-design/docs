// Estado de la edición actual con historial (deshacer / rehacer).
// Código puro (sin DOM).
//
// Dos tipos de cambio:
//  - "vivos" (set / update): ocurren mientras arrastras un deslizador; se
//    dibujan al momento pero NO entran al historial.
//  - "confirmados" (commit): al soltar el deslizador; entran al historial.

import { defaultEdits, clone, migrate, getPath, setPath } from './model.js';

export class EditStore {
  constructor(initial = defaultEdits(), limit = 100) {
    this.limit = limit;
    this.listeners = new Set();
    this.load(initial);
  }

  // Carga ediciones nuevas y reinicia el historial (por ejemplo, al abrir otra foto).
  load(edits) {
    this.edits = migrate(edits);
    this.committed = JSON.stringify(this.edits);
    this.past = [];
    this.future = [];
    this._emit('load');
  }

  get() { return this.edits; }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _emit(kind) { for (const fn of this.listeners) fn(this.edits, kind); }

  // cambio vivo de un valor por ruta
  set(path, value) {
    setPath(this.edits, path, value);
    this._emit('live');
  }

  get_(path) { return getPath(this.edits, path); }

  // cambio vivo con una función que modifica las ediciones
  update(fn) {
    fn(this.edits);
    this._emit('live');
  }

  // sustituye todo; con commit=true entra al historial
  replace(edits, commit = true) {
    this.edits = migrate(edits);
    this._emit('live');
    if (commit) this.commit();
  }

  dirty() { return JSON.stringify(this.edits) !== this.committed; }

  // confirma el estado actual en el historial; devuelve true si hubo cambios
  commit() {
    const cur = JSON.stringify(this.edits);
    if (cur === this.committed) return false;
    this.past.push(this.committed);
    if (this.past.length > this.limit) this.past.shift();
    this.committed = cur;
    this.future = [];
    this._emit('commit');
    return true;
  }

  canUndo() { return this.dirty() || this.past.length > 0; }
  canRedo() { return this.future.length > 0 && !this.dirty(); }

  undo() {
    if (this.dirty()) { // descarta los cambios vivos sin confirmar
      this.edits = JSON.parse(this.committed);
      this._emit('undo');
      return true;
    }
    if (!this.past.length) return false;
    this.future.push(this.committed);
    this.committed = this.past.pop();
    this.edits = JSON.parse(this.committed);
    this._emit('undo');
    return true;
  }

  redo() {
    if (!this.canRedo()) return false;
    this.past.push(this.committed);
    this.committed = this.future.pop();
    this.edits = JSON.parse(this.committed);
    this._emit('redo');
    return true;
  }

  reset() { this.replace(defaultEdits(), true); }
}
