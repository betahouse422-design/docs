// Programa principal: une motor, estado y controles.

import { Engine } from './engine.js';
import { EditStore } from './store.js';
import {
  defaultEdits, SLIDER_GROUPS, HSL_RANGES, HSL_LABELS, getPath, applyPreset, STARTER_PRESETS,
  newMask, MAX_MASKS, isNeutral, clone, CURVE_CHANNELS,
} from './model.js';
import { CurveEditor } from './curve-editor.js';
import { Overlay } from './overlay.js';
import { computeHistogram, drawHistogram, clipping } from './histogram.js';
import { ASPECTS, aspectValue, fitAspect } from './geometry.js';
import * as storage from './storage.js';

const $ = (s, r = document) => r.querySelector(s);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

// ---------- estado global ----------
const view = $('#view');
const engine = new Engine(view);
const store = new EditStore();
const ui = {
  fileId: null, fileName: 'foto', compare: false, cropMode: false, cropDraft: null, cropAspectId: 'free',
  tab: 'adjust', hslRange: 'red', selMask: -1, presetSession: null, userPresets: [], selPresetId: null,
  renderQueued: false, histTimer: 0, saveTimer: 0,
};
const controls = {}; // path -> { setValue(v) }

// ---------- avisos ----------
let toastTimer = 0;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2200);
}

// ---------- render ----------
function requestRender() {
  if (ui.renderQueued) return;
  ui.renderQueued = true;
  requestAnimationFrame(renderNow);
}

function renderNow() {
  ui.renderQueued = false;
  if (!engine.hasSource()) return;
  const stage = $('#stage');
  const cs = getComputedStyle(stage);
  const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const res = engine.render(store.get(), {
    maxW: Math.max(64, w) * dpr, maxH: Math.max(64, h) * dpr, upscale: true,
    original: ui.compare, geometryEdit: ui.cropMode,
  });
  if (!res) return;
  view.style.width = `${res.width / dpr}px`;
  view.style.height = `${res.height / dpr}px`;
  overlay.sync(res.width / dpr, res.height / dpr);
  overlay.draw();
  $('#compareTag').hidden = !ui.compare;
  clearTimeout(ui.histTimer);
  ui.histTimer = setTimeout(updateHistogram, 90);
}

const scratch = document.createElement('canvas');
function updateHistogram() {
  if (!engine.hasSource()) return;
  const hist = computeHistogram(view, scratch);
  drawHistogram($('#hist'), hist);
  const c = clipping(hist);
  const parts = [];
  if (c.shadows > 0.005) parts.push(`Negros recortados ${(c.shadows * 100).toFixed(1)}%`);
  if (c.highlights > 0.005) parts.push(`Blancos recortados ${(c.highlights * 100).toFixed(1)}%`);
  $('#clipInfo').textContent = parts.join(' · ');
}

// ---------- controles reutilizables ----------
function fmt(spec, v) {
  if (spec.unit === 'EV') return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
  if (spec.unit === '°') return `${v.toFixed(1)}°`;
  return String(Math.round(v));
}

// Crea una fila con deslizador. opts: { label, min, max, step, neutral, unit, track,
//   get(), set(v) (vivo), commit() }
function sliderRow(opts) {
  const id = 's' + Math.random().toString(36).slice(2, 8);
  const input = el('input', { type: 'range', id, min: opts.min, max: opts.max, step: opts.step });
  if (opts.track) input.classList.add('track-' + opts.track);
  const out = el('output', { for: id });
  const label = el('label', { for: id, title: 'Doble clic para restablecer' }, opts.label);
  const row = el('div', { class: 'srow' }, label, out, input);
  const neutral = opts.neutral ?? 0;
  const setValue = (v) => {
    input.value = v; out.textContent = fmt(opts, Number(v));
    row.classList.toggle('changed', Math.abs(Number(v) - neutral) > 1e-9);
  };
  input.addEventListener('input', () => { const v = Number(input.value); opts.set(v); out.textContent = fmt(opts, v); row.classList.toggle('changed', Math.abs(v - neutral) > 1e-9); });
  input.addEventListener('change', () => opts.commit());
  label.addEventListener('dblclick', () => { opts.set(neutral); setValue(neutral); opts.commit(); });
  setValue(opts.get());
  return { row, setValue, refresh: () => setValue(opts.get()) };
}

function pathSlider(spec) {
  const c = sliderRow({
    ...spec,
    neutral: spec.neutral ?? 0,
    get: () => getPath(store.get(), spec.path),
    set: (v) => store.set(spec.path, v),
    commit: () => store.commit(),
  });
  controls[spec.path] = c;
  return c.row;
}

// ---------- pestaña Ajustes ----------
function buildAdjustTab() {
  const root = $('#tabAdjust');
  root.replaceChildren();
  for (const g of SLIDER_GROUPS) {
    const d = el('details', { open: g.id === 'light' || g.id === 'color' }, el('summary', {}, g.title));
    for (const s of g.sliders) d.append(pathSlider(s));
    root.append(d);
    if (g.id === 'color') root.append(buildHslSection());
  }
  root.append(buildGradingSection());
}

function buildHslSection() {
  const d = el('details', {}, el('summary', {}, 'Color por rangos (HSL)'));
  const chips = el('div', { class: 'chips' });
  const colors = { red: '#e0463c', orange: '#f08a2c', yellow: '#e8d23a', green: '#48b85c', aqua: '#33c3c3', blue: '#4a78ff', purple: '#8a5cf0', magenta: '#d44fb8' };
  const body = el('div');
  const rows = {};
  const refresh = () => { for (const k of ['h', 's', 'l']) rows[k].refresh(); };
  const mk = (key, label) => {
    const r = sliderRow({
      label, min: -100, max: 100, step: 1, neutral: 0,
      get: () => store.get().color.hsl[ui.hslRange][key],
      set: (v) => store.update((e) => { e.color.hsl[ui.hslRange][key] = v; }),
      commit: () => store.commit(),
    });
    rows[key] = r; body.append(r.row);
  };
  mk('h', 'Matiz'); mk('s', 'Saturación'); mk('l', 'Luminosidad');
  for (const r of HSL_RANGES) {
    const chip = el('button', { class: 'chip' + (r === ui.hslRange ? ' on' : ''), type: 'button', 'data-range': r },
      el('span', { class: 'swatch', style: `background:${colors[r]}` }), HSL_LABELS[r]);
    chip.addEventListener('click', () => {
      ui.hslRange = r;
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.range === r));
      refresh();
    });
    chips.append(chip);
  }
  controls.__hsl = { refresh };
  d.append(chips, body);
  return d;
}

function buildGradingSection() {
  const d = el('details', {}, el('summary', {}, 'Gradación de color'));
  const zones = [['shadows', 'Sombras'], ['mids', 'Medios'], ['highlights', 'Luces']];
  const refreshers = [];
  for (const [z, name] of zones) {
    d.append(el('div', { class: 'sub' }, name));
    const hue = sliderRow({ label: 'Matiz', min: 0, max: 360, step: 1, track: 'hue', neutral: -1,
      get: () => store.get().grading[z].hue, set: (v) => store.update((e) => { e.grading[z].hue = v; }), commit: () => store.commit() });
    const sat = sliderRow({ label: 'Intensidad', min: 0, max: 100, step: 1, neutral: 0,
      get: () => store.get().grading[z].sat, set: (v) => store.update((e) => { e.grading[z].sat = v; }), commit: () => store.commit() });
    d.append(hue.row, sat.row);
    refreshers.push(hue.refresh, sat.refresh);
  }
  const bal = sliderRow({ label: 'Balance', min: -100, max: 100, step: 1, neutral: 0,
    get: () => store.get().grading.balance, set: (v) => store.update((e) => { e.grading.balance = v; }), commit: () => store.commit() });
  d.append(bal.row); refreshers.push(bal.refresh);
  controls.__grading = { refresh: () => refreshers.forEach((f) => f()) };
  return d;
}

// ---------- pestaña Curvas ----------
let curveEditor = null;
function buildCurvesTab() {
  const root = $('#tabCurves');
  root.replaceChildren();
  const canvas = el('canvas', { id: 'curveCanvas' });
  const names = { master: 'RGB', r: 'Rojo', g: 'Verde', b: 'Azul' };
  const bar = el('div', { class: 'chips' });
  CURVE_CHANNELS.forEach((ch) => {
    const b = el('button', { class: 'chip' + (ch === 'master' ? ' on' : ''), type: 'button', 'data-ch': ch }, names[ch]);
    b.addEventListener('click', () => {
      bar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
      curveEditor.setChannel(ch);
      curveEditor.setPoints(store.get().curves[ch]);
    });
    bar.append(b);
  });
  const reset = el('button', { class: 'btn small', type: 'button' }, 'Restablecer este canal');
  reset.addEventListener('click', () => {
    store.update((e) => { e.curves[curveEditor.channel] = [[0, 0], [1, 1]]; });
    store.commit(); curveEditor.setPoints(store.get().curves[curveEditor.channel]);
  });
  root.append(bar, canvas, el('p', { class: 'hint' }, 'Toca para añadir un punto, arrástralo para moverlo y haz doble clic (o doble toque) en un punto para quitarlo.'), reset);
  curveEditor = new CurveEditor(canvas, {
    onChange: (ch, points, final) => {
      store.update((e) => { e.curves[ch] = points.map((p) => p.slice()); });
      if (final) store.commit();
    },
  });
}

// ---------- pestaña Recorte ----------
function buildGeometryTab() {
  const root = $('#tabGeometry');
  root.replaceChildren();
  const act = (fn) => () => { fn(store.get().geometry); store.commit(); syncControls(); };
  const btn = (label, handler) => el('button', { class: 'btn small', type: 'button', onClick: handler }, label);
  root.append(
    el('div', { class: 'sub' }, 'Girar y voltear'),
    el('div', { class: 'row' },
      btn('⟲ 90°', () => { store.update((e) => { e.geometry.rotate90 = (e.geometry.rotate90 + 3) % 4; e.geometry.crop = { x: 0, y: 0, w: 1, h: 1 }; }); store.commit(); syncControls(); }),
      btn('⟳ 90°', () => { store.update((e) => { e.geometry.rotate90 = (e.geometry.rotate90 + 1) % 4; e.geometry.crop = { x: 0, y: 0, w: 1, h: 1 }; }); store.commit(); syncControls(); }),
      btn('↔ Espejo', () => { store.update((e) => { e.geometry.flipH = !e.geometry.flipH; }); store.commit(); }),
      btn('↕ Espejo', () => { store.update((e) => { e.geometry.flipV = !e.geometry.flipV; }); store.commit(); }),
    ),
    (() => {
      const c = sliderRow({ label: 'Enderezar', min: -45, max: 45, step: 0.1, unit: '°', neutral: 0,
        get: () => store.get().geometry.straighten, set: (v) => store.update((e) => { e.geometry.straighten = v; }), commit: () => store.commit() });
      controls['geometry.straighten'] = c; return c.row;
    })(),
    el('div', { class: 'sub' }, 'Recorte'),
    (() => {
      const chips = el('div', { class: 'chips', id: 'aspectChips' });
      for (const a of ASPECTS) {
        const ch = el('button', { class: 'chip' + (a.id === ui.cropAspectId ? ' on' : ''), type: 'button', 'data-a': a.id }, a.label);
        ch.addEventListener('click', () => chooseAspect(a.id));
        chips.append(ch);
      }
      return chips;
    })(),
    el('div', { class: 'row', id: 'cropButtons' }),
    el('p', { class: 'hint', id: 'cropHint' }, 'Elige una proporción o pulsa "Recortar" para ajustar el marco con el dedo o el ratón.'),
  );
  renderCropButtons();
}

function renderCropButtons() {
  const box = $('#cropButtons');
  if (!box) return;
  box.replaceChildren();
  if (ui.cropMode) {
    box.append(
      el('button', { class: 'btn small primary', type: 'button', onClick: () => endCrop(true) }, 'Aplicar recorte'),
      el('button', { class: 'btn small', type: 'button', onClick: () => endCrop(false) }, 'Cancelar'),
    );
  } else {
    box.append(
      el('button', { class: 'btn small', type: 'button', onClick: () => startCrop() }, 'Recortar'),
      el('button', { class: 'btn small danger', type: 'button', onClick: () => { store.update((e) => { e.geometry.crop = { x: 0, y: 0, w: 1, h: 1 }; }); store.commit(); } }, 'Quitar recorte'),
    );
  }
}

function orientedSize() {
  const g = engine.geometryInfo(store.get(), true);
  return [g.ow, g.oh];
}

function startCrop() {
  if (!engine.hasSource()) return;
  ui.cropMode = true;
  ui.cropDraft = { ...store.get().geometry.crop };
  renderCropButtons(); updateOverlayMode(); requestRender();
}

function endCrop(apply) {
  if (apply && ui.cropDraft) {
    const c = ui.cropDraft;
    store.update((e) => { e.geometry.crop = { x: c.x, y: c.y, w: c.w, h: c.h }; });
    store.commit();
  }
  ui.cropMode = false; ui.cropDraft = null;
  renderCropButtons(); updateOverlayMode(); requestRender();
}

function chooseAspect(id) {
  ui.cropAspectId = id;
  document.querySelectorAll('#aspectChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.a === id));
  if (!engine.hasSource()) return;
  if (!ui.cropMode) startCrop();
  const a = ASPECTS.find((x) => x.id === id);
  const [ow, oh] = orientedSize();
  const v = aspectValue(a.value, ow, oh);
  if (v != null) ui.cropDraft = fitAspect(v, ow, oh, ui.cropDraft);
  overlay.draw(); requestRender();
}

// ---------- pestaña Máscaras ----------
function buildMasksTab() {
  const root = $('#tabMasks');
  root.replaceChildren();
  const e = store.get();
  const list = el('div', { class: 'list' });
  e.masks.forEach((m, i) => {
    const b = el('button', { class: 'pitem' + (i === ui.selMask ? ' on' : ''), type: 'button' },
      el('span', {}, `${i + 1} · ${m.type === 'linear' ? 'Degradado' : 'Radial'}${m.enabled === false ? ' (off)' : ''}`));
    b.addEventListener('click', () => { ui.selMask = i; buildMasksTab(); updateOverlayMode(); overlay.draw(); });
    list.append(b);
  });
  const add = (type) => () => {
    if (store.get().masks.length >= MAX_MASKS) { toast(`Máximo ${MAX_MASKS} máscaras`, true); return; }
    store.update((ed) => { ed.masks.push(newMask(type)); });
    store.commit(); ui.selMask = store.get().masks.length - 1; buildMasksTab(); updateOverlayMode();
  };
  root.append(
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onClick: add('linear') }, '+ Degradado'),
      el('button', { class: 'btn small', type: 'button', onClick: add('radial') }, '+ Radial')),
    list,
  );
  const m = e.masks[ui.selMask];
  if (!m) { root.append(el('p', { class: 'hint' }, 'Una máscara aplica ajustes solo a una zona. Añade una y arrastra sus puntos sobre la foto.')); return; }

  const upd = (patch) => store.update((ed) => { Object.assign(ed.masks[ui.selMask], patch); });
  const adj = (key, label, min, max, step, unit) => sliderRow({
    label, min, max, step, unit, neutral: 0,
    get: () => store.get().masks[ui.selMask].adjust[key],
    set: (v) => store.update((ed) => { ed.masks[ui.selMask].adjust[key] = v; }),
    commit: () => store.commit(),
  }).row;
  const field = (key, label, min, max, step, scale = 1) => sliderRow({
    label, min, max, step, neutral: key === 'feather' ? 0.5 * scale : 0,
    get: () => (store.get().masks[ui.selMask][key] || 0) * scale,
    set: (v) => upd({ [key]: v / scale }),
    commit: () => store.commit(),
  }).row;

  root.append(
    el('div', { class: 'sub' }, 'Ajustes dentro de la máscara'),
    adj('exposure', 'Exposición', -3, 3, 0.01, 'EV'), adj('contrast', 'Contraste', -100, 100, 1),
    adj('highlights', 'Luces', -100, 100, 1), adj('shadows', 'Sombras', -100, 100, 1),
    adj('saturation', 'Saturación', -100, 100, 1), adj('temperature', 'Temperatura', -100, 100, 1),
    el('div', { class: 'sub' }, 'Forma'),
    field('feather', 'Difuminado', 0, 100, 1, 100),
    ...(m.type === 'radial' ? [field('angle', 'Ángulo', -90, 90, 1, 1)] : []),
    (() => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = !!m.invert;
      cb.addEventListener('change', () => { upd({ invert: cb.checked }); store.commit(); });
      return el('label', { class: 'check' }, cb, 'Invertir (aplicar fuera de la zona)');
    })(),
    (() => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = m.enabled !== false;
      cb.addEventListener('change', () => { upd({ enabled: cb.checked }); store.commit(); buildMasksTab(); });
      return el('label', { class: 'check' }, cb, 'Activa');
    })(),
    el('button', { class: 'btn small danger', type: 'button', onClick: () => {
      store.update((ed) => { ed.masks.splice(ui.selMask, 1); });
      store.commit(); ui.selMask = store.get().masks.length ? 0 : -1; buildMasksTab(); updateOverlayMode();
    } }, 'Eliminar máscara'),
  );
}

// ---------- pestaña Presets ----------
function allPresets() { return [...STARTER_PRESETS, ...ui.userPresets]; }

function buildPresetsTab() {
  const root = $('#tabPresets');
  root.replaceChildren();
  const list = el('div', { class: 'list' });
  for (const p of allPresets()) {
    const b = el('button', { class: 'pitem' + (p.id === ui.selPresetId ? ' on' : ''), type: 'button' }, el('span', {}, p.name));
    b.addEventListener('click', () => selectPreset(p.id));
    if (!p.builtin) {
      const x = el('span', { class: 'x', title: 'Eliminar preset', role: 'button' }, '✕');
      x.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(`¿Eliminar el preset "${p.name}"?`)) return;
        await storage.deletePreset(p.id);
        ui.userPresets = ui.userPresets.filter((u) => u.id !== p.id);
        if (ui.selPresetId === p.id) cancelPreset();
        buildPresetsTab();
      });
      b.append(x);
    }
    list.append(b);
  }
  root.append(list);

  if (ui.presetSession) {
    const s = ui.presetSession;
    const inten = sliderRow({
      label: 'Intensidad', min: 0, max: 100, step: 1, neutral: 100,
      get: () => Math.round(s.intensity * 100),
      set: (v) => { s.intensity = v / 100; previewPreset(); },
      commit: () => {},
    });
    root.append(el('div', { class: 'card' }, inten.row,
      el('div', { class: 'row' },
        el('button', { class: 'btn small primary', type: 'button', onClick: applyPresetSession }, 'Aplicar'),
        el('button', { class: 'btn small', type: 'button', onClick: cancelPreset }, 'Cancelar'))));
  }

  const name = el('input', { class: 'field', type: 'text', placeholder: 'Nombre del preset nuevo', maxlength: 60 });
  const save = el('button', { class: 'btn small', type: 'button' }, 'Guardar ajustes actuales como preset');
  save.addEventListener('click', async () => {
    const n = name.value.trim();
    if (!n) { toast('Escribe un nombre para el preset', true); return; }
    if (isNeutral(store.get())) { toast('No hay ajustes que guardar', true); return; }
    const edits = clone(store.get());
    edits.geometry = defaultEdits().geometry; // la geometría es de cada foto, no del preset
    edits.masks = [];
    const p = { id: 'u' + Date.now().toString(36), name: n, edits };
    await storage.savePreset(p);
    ui.userPresets.push(p); name.value = ''; buildPresetsTab(); toast('Preset guardado');
  });
  const exp = el('button', { class: 'btn small', type: 'button' }, 'Exportar mis presets');
  exp.addEventListener('click', () => {
    if (!ui.userPresets.length) { toast('Aún no tienes presets propios', true); return; }
    download(new Blob([storage.presetsToJson(ui.userPresets)], { type: 'application/json' }), 'mis-presets.json');
  });
  const imp = el('button', { class: 'btn small', type: 'button', onClick: () => $('#fileJson').click() }, 'Importar presets');
  root.append(el('div', { class: 'sub' }, 'Mis presets'), name, el('div', { class: 'row', style: 'margin-top:8px' }, save), el('div', { class: 'row', style: 'margin-top:8px' }, exp, imp),
    el('p', { class: 'hint' }, 'Un preset suma sus ajustes a los que ya tienes. La intensidad lo mezcla de 0 a 100 %.'));
}

function selectPreset(id) {
  if (!engine.hasSource()) { toast('Abre una foto primero', true); return; }
  const p = allPresets().find((x) => x.id === id);
  if (!p) return;
  if (!ui.presetSession) ui.presetSession = { base: clone(store.get()), intensity: 1, preset: p };
  ui.presetSession.preset = p; ui.selPresetId = id;
  previewPreset(); buildPresetsTab();
}

function previewPreset() {
  const s = ui.presetSession;
  if (!s) return;
  store.replace(applyPreset(s.base, s.preset.edits, s.intensity), false);
}

function applyPresetSession() {
  const s = ui.presetSession;
  if (!s) return;
  ui.presetSession = null; ui.selPresetId = null;
  store.commit(); buildPresetsTab(); toast(`Preset "${s.preset.name}" aplicado`);
}

function cancelPreset() {
  const s = ui.presetSession;
  ui.presetSession = null; ui.selPresetId = null;
  if (s) store.replace(s.base, false);
  buildPresetsTab();
}

// ---------- pestañas ----------
function setTab(name) {
  ui.tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('#tabBody section').forEach((s) => { s.hidden = s.dataset.tab !== name; });
  if (name === 'curves' && curveEditor) { curveEditor.setPoints(store.get().curves[curveEditor.channel]); curveEditor.draw(); }
  if (name === 'masks') { buildMasksTab(); }
  if (name !== 'geometry' && ui.cropMode) endCrop(false);
  updateOverlayMode(); overlay.draw();
}

// ---------- capa interactiva ----------
const overlay = new Overlay($('#overlay'), {
  getMode: () => {
    if (ui.compare || !engine.hasSource()) return 'none';
    if (ui.cropMode) return 'crop';
    if (ui.tab === 'masks' && ui.selMask >= 0 && store.get().masks[ui.selMask]) return 'mask';
    return 'none';
  },
  getCrop: () => ui.cropDraft || { x: 0, y: 0, w: 1, h: 1 },
  setCrop: (r) => { ui.cropDraft = r; overlay.draw(); },
  getAspect: () => {
    const a = ASPECTS.find((x) => x.id === ui.cropAspectId);
    const [ow, oh] = orientedSize();
    return aspectValue(a ? a.value : null, ow, oh);
  },
  getOrientedSize: () => orientedSize(),
  getMask: () => store.get().masks[ui.selMask],
  updateMask: (patch, final) => {
    if (Object.keys(patch).length) store.update((e) => { Object.assign(e.masks[ui.selMask], patch); });
    if (final) { store.commit(); buildMasksTab(); }
  },
});

function updateOverlayMode() {
  $('#overlay').style.pointerEvents = overlay.active() ? 'auto' : 'none';
}

// ---------- sincronizar la interfaz con el estado ----------
function syncControls() {
  for (const c of Object.values(controls)) c.refresh();
  if (curveEditor) curveEditor.setPoints(store.get().curves[curveEditor.channel]);
  if (ui.tab === 'masks') buildMasksTab();
}

function updateButtons() {
  const has = engine.hasSource();
  $('#btnUndo').disabled = !store.canUndo();
  $('#btnRedo').disabled = !store.canRedo();
  $('#btnReset').disabled = !has || isNeutral(store.get());
  $('#btnCompare').disabled = !has;
  $('#btnExport').disabled = !has;
}

store.subscribe((edits, kind) => {
  requestRender();
  if (kind !== 'live') syncControls();
  // cualquier confirmación ajena al botón "Aplicar" cierra la previsualización del preset
  if (kind === 'undo' || kind === 'redo' || kind === 'load' || (kind === 'commit' && ui.presetSession)) {
    ui.presetSession = null; ui.selPresetId = null;
    if (ui.tab === 'presets') buildPresetsTab();
  }
  updateButtons();
  if (kind === 'commit' || kind === 'undo' || kind === 'redo') scheduleSave();
});

function scheduleSave() {
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(() => { if (ui.fileId) storage.saveEdits(ui.fileId, store.get()); }, 350);
}

// ---------- abrir fotos ----------
async function openFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif|avif|gif|bmp)$/i.test(file.name)) {
    toast('Ese archivo no es una imagen compatible', true); return;
  }
  try {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      const url = URL.createObjectURL(file);
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('decode')); im.src = url; });
    }
    await showImage(bmp, file.name.replace(/\.[^.]+$/, ''), storage.fileKey(file));
  } catch (err) {
    toast('No se pudo abrir esa imagen. Si es HEIC o RAW, tu navegador puede no soportarlo.', true);
    console.error(err);
  }
}

async function showImage(source, name, fileId) {
  engine.setSource(source);
  if (source.close) source.close();
  ui.fileId = fileId; ui.fileName = name || 'foto';
  ui.cropMode = false; ui.cropDraft = null; ui.selMask = -1; ui.presetSession = null; ui.selPresetId = null;
  const saved = fileId ? await storage.loadEdits(fileId) : null;
  $('#empty').hidden = true; $('#canvasWrap').hidden = false;
  store.load(saved || defaultEdits());
  renderCropButtons(); updateOverlayMode(); setTab(ui.tab);
  if (saved && !isNeutral(saved)) toast('Se recuperaron tus ajustes de esta foto');
  requestRender();
}

function sampleImage() {
  const w = 1600; const h = 1067;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#3b6fb6'); sky.addColorStop(0.55, '#9cc3e6'); sky.addColorStop(1, '#f6d9a8');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  const sun = g.createRadialGradient(w * 0.72, h * 0.42, 4, w * 0.72, h * 0.42, 150);
  sun.addColorStop(0, 'rgba(255,250,225,1)'); sun.addColorStop(0.3, 'rgba(255,224,150,.8)'); sun.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = sun; g.fillRect(0, 0, w, h);
  const hill = (y0, amp, color, seed) => {
    g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) g.lineTo(x, y0 + Math.sin(x / 190 + seed) * amp + Math.sin(x / 61 + seed * 2) * amp * 0.25);
    g.lineTo(w, h); g.closePath(); g.fill();
  };
  hill(h * 0.60, 36, '#6b8f9a', 1); hill(h * 0.68, 46, '#487a4f', 2.4); hill(h * 0.80, 52, '#2f5a38', 4);
  const colors = ['#d8453b', '#f0a431', '#3a7bd5', '#e8e0d0'];
  colors.forEach((col, i) => { g.fillStyle = col; g.fillRect(60 + i * 62, h - 90, 48, 48); });
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = '600 28px system-ui, sans-serif'; g.fillText('Imagen de ejemplo', 60, h - 110);
  showImage(c, 'ejemplo', null);
}

// ---------- exportar ----------
function download(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function openExportDialog() {
  const dlg = $('#exportDlg');
  const g = engine.geometryInfo(store.get(), false);
  const scale = Math.min(1, engine.maxRender / Math.max(g.cw, g.ch));
  $('#expInfo').textContent = `Tamaño: ${Math.round(g.cw * scale)} × ${Math.round(g.ch * scale)} px`;
  $('#expQualityRow').hidden = $('#expType').value === 'image/png';
  dlg.showModal();
}

async function doExport() {
  const type = $('#expType').value;
  const quality = Number($('#expQuality').value) / 100;
  toast('Exportando…');
  await new Promise((r) => setTimeout(r, 30));
  const { blob, width, height } = await engine.exportBlob(store.get(), { type, quality });
  requestRender();
  if (!blob) { toast('No se pudo exportar', true); return; }
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const filename = `${ui.fileName}-editada.${ext}`;
  const file = new File([blob], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: filename }); toast(`Compartido (${width}×${height})`); return; } catch { /* cancelado: descargar */ }
  }
  download(blob, filename);
  toast(`Guardado ${filename} (${width}×${height})`);
}

// ---------- eventos ----------
function wire() {
  const fileInput = $('#file');
  $('#btnOpen').addEventListener('click', () => fileInput.click());
  $('#btnOpen2').addEventListener('click', () => fileInput.click());
  $('#btnSample').addEventListener('click', sampleImage);
  fileInput.addEventListener('change', () => { openFile(fileInput.files[0]); fileInput.value = ''; });

  $('#fileJson').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    try {
      const imported = storage.presetsFromJson(await f.text());
      for (const p of imported) { await storage.savePreset(p); ui.userPresets.push(p); }
      buildPresetsTab(); toast(`${imported.length} preset(s) importados`);
    } catch (err) { toast(err.message, true); }
  });

  $('#btnUndo').addEventListener('click', () => store.undo());
  $('#btnRedo').addEventListener('click', () => store.redo());
  $('#btnReset').addEventListener('click', () => { if (confirm('¿Restablecer todos los ajustes de esta foto? Podrás deshacerlo.')) store.reset(); });
  $('#btnExport').addEventListener('click', openExportDialog);
  $('#expType').addEventListener('change', () => { $('#expQualityRow').hidden = $('#expType').value === 'image/png'; });
  $('#expQuality').addEventListener('input', () => { $('#expQualityOut').textContent = $('#expQuality').value; });
  $('#exportDlg').addEventListener('close', () => { if ($('#exportDlg').returnValue === 'go') doExport(); });

  const cmp = $('#btnCompare');
  const setCompare = (on) => { if (!engine.hasSource() || ui.compare === on) return; ui.compare = on; updateOverlayMode(); requestRender(); };
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); setCompare(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => setCompare(false));

  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' && t.type === 'text' || t.tagName === 'SELECT')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); }
    else if (e.key === '\\') setCompare(true);
  });
  window.addEventListener('keyup', (e) => { if (e.key === '\\') setCompare(false); });

  window.addEventListener('resize', requestRender);
  new ResizeObserver(requestRender).observe($('#stage'));

  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dragover'); openFile(e.dataTransfer.files[0]); });
  window.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) openFile(f); });
}

// ---------- arranque ----------
async function init() {
  buildAdjustTab(); buildCurvesTab(); buildGeometryTab(); buildMasksTab(); buildPresetsTab();
  wire(); updateButtons();
  try { ui.userPresets = await storage.listPresets(); buildPresetsTab(); } catch { /* sin presets propios */ }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !location.search.includes('nosw')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { engine, store, ui, showImage, sampleImage, openFile, requestRender, renderNow };
  window.__appReady = true;
}
init();
