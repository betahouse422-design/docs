// Programa principal: une motor, estado y controles.

import { Engine } from './engine.js';
import { EditStore } from './store.js';
import {
  defaultEdits, SLIDER_GROUPS, HSL_RANGES, HSL_LABELS, getPath, applyPreset, STARTER_PRESETS,
  newMask, MAX_MASKS, isNeutral, clone, CURVE_CHANNELS, HSL_CURVES, flatCurve, migrate, newSpot, MAX_SPOTS,
} from './model.js';
import {
  averagePatchLinear, grayWorldLinear, whiteBalanceFromLinear, autoToneFromHistogram, applyAutoTone, chooseSpotSource,
} from './auto.js';
import { CurveEditor } from './curve-editor.js';
import { Overlay } from './overlay.js';
import { computeHistogram, drawHistogram, clipping } from './histogram.js';
import { ASPECTS, aspectValue, fitAspect } from './geometry.js';
import * as storage from './storage.js';
import { parsePresetText } from './import-presets.js';
import { $, el, toast, sliderRow, download } from './ui-kit.js';
import { Library, createFilmstrip, decodeBlob, makeThumb, sizeOf } from './photos.js';
import {
  statusAfterEdit, toggleApproved, pasteEdits, nextToReview, neighbor, visibleAspect, cropForAspect,
} from './workflow.js';
import { createPrintUI } from './print-ui.js';
import { parseCube, MAX_CUBE_BYTES } from './lut.js';
import { isRawName, decodeRaw, rawToCanvas, canDecodeFull } from './raw.js';
import { newStroke, MAX_STROKES, MAX_STROKE_POINTS } from './brush.js';
import { watermarkBlob, loadImageAsset } from './compose.js';
import { LOGO_POSITIONS } from './layout.js';

// ---------- estado global ----------
const view = $('#view');
const engine = new Engine(view);
const store = new EditStore();
const ui = {
  fileId: null, photoId: null, mode: 'edit', clip: null, loadToken: 0, fileName: 'foto', compare: false, cropMode: false, cropDraft: null, cropAspectId: 'free',
  tab: 'adjust', brush: { r: 0.04, soft: 0.5, erase: false }, looks: [], zoom: { z: 1, cx: 0.5, cy: 0.5 }, hslRange: 'red', selMask: -1, pick: null, spotTool: false, selSpot: -1, presetSession: null, userPresets: [], selPresetId: null,
  presetSource: 'starter', presetQuery: '', presetGroup: '', presetLimit: 60, packs: {}, packLoading: false,
  renderQueued: false, histTimer: 0, saveTimer: 0,
};
const controls = {}; // path -> { setValue(v) }

// ---------- render ----------
function requestRender() {
  if (ui.renderQueued) return;
  ui.renderQueued = true;
  requestAnimationFrame(renderNow);
}

function renderNow() {
  ui.renderQueued = false;
  if (!engine.hasSource() || ui.mode !== 'edit') return;
  const stage = $('#viewport');
  const cs = getComputedStyle(stage);
  const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const lk = store.get().look;
  if (lk.id && engine.lookId !== lk.id) ensureLook(engine, lk.id).then(requestRender); // se ve sin look un instante
  const res = engine.render(store.get(), {
    maxW: Math.max(64, w) * dpr, maxH: Math.max(64, h) * dpr, upscale: true,
    original: ui.compare, geometryEdit: ui.cropMode, view: zoomActive() ? ui.zoom : null,
  });
  if (!res) return;
  ui.lastRes = { w: res.width, h: res.height };
  updateZoomBar();
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


// ---------- zoom de la vista ----------
// ui.zoom = { z, cx, cy }: z veces más cerca, centrado en (cx, cy) de la imagen recortada (0..1, origen arriba-izquierda).
// El recorte y las máscaras se editan siempre con la foto entera, así que ahí el zoom se suspende.
const ZOOM_MAX = 16;
const overlayModeNow = () => overlay.h.getMode();
const zoomActive = () => ui.zoom.z > 1.0001 && !ui.cropMode && !(ui.tab === 'masks' && ui.selMask >= 0 && !!store.get().masks[ui.selMask]);
function zoomMap() { const on = zoomActive(); return { z: on ? ui.zoom.z : 1, cx: on ? ui.zoom.cx : 0.5, cy: on ? ui.zoom.cy : 0.5 }; }
const cropToView = (u, v) => { const m = zoomMap(); return [(u - m.cx) * m.z + 0.5, (v - m.cy) * m.z + 0.5]; };
const viewToCrop = (x, y) => { const m = zoomMap(); return [(x - 0.5) / m.z + m.cx, (y - 0.5) / m.z + m.cy]; };

function clampZoom() {
  const zm = ui.zoom;
  zm.z = Math.min(ZOOM_MAX, Math.max(1, zm.z));
  const half = 0.5 / zm.z;
  zm.cx = Math.min(1 - half, Math.max(half, zm.cx)); zm.cy = Math.min(1 - half, Math.max(half, zm.cy));
  if (zm.z <= 1.0001) { zm.z = 1; zm.cx = 0.5; zm.cy = 0.5; }
}
// Cambia el zoom dejando fijo el punto de la imagen que está bajo (ax, ay) de la vista (0..1).
function setZoom(z, ax = 0.5, ay = 0.5) {
  const zm = ui.zoom; const [px, py] = viewToCrop(ax, ay);
  const old = zm.z;
  zm.z = z;
  if (zm.z > 1.0001) { zm.cx = px - (ax - 0.5) / Math.min(ZOOM_MAX, Math.max(1, zm.z)); zm.cy = py - (ay - 0.5) / Math.min(ZOOM_MAX, Math.max(1, zm.z)); }
  if (old <= 1.0001 && zm.z > 1.0001 && !zoomActive()) { /* en recorte o máscaras no se aplica */ }
  clampZoom(); requestRender();
  if (ui.zoom.z > 1.05) ensureFullRaw();
}
function panBy(dx, dy) { // en fracciones de la vista
  if (!zoomActive()) return;
  ui.zoom.cx -= dx / ui.zoom.z; ui.zoom.cy -= dy / ui.zoom.z;
  clampZoom(); requestRender();
}
function zoom100() { // un píxel de la foto = un píxel de pantalla
  if (!engine.hasSource() || !ui.lastRes) return;
  const g = engine.geometryInfo(store.get(), false);
  return Math.max(1, g.cw / ui.lastRes.w);
}
function updateZoomBar() {
  const bar = $('#zoomBar'); const wrap = $('#canvasWrap');
  const can = engine.hasSource() && !ui.cropMode && !(ui.tab === 'masks' && ui.selMask >= 0);
  bar.hidden = !can;
  wrap.classList.toggle('zoomed', zoomActive());
  const z = ui.zoom.z;
  $('#zoomLabel').textContent = z > 1.0001 ? `×${z < 10 ? z.toFixed(1) : Math.round(z)}` : 'Ajustar';
  $('#zoomOut').disabled = z <= 1.0001;
  $('#zoomIn').disabled = z >= ZOOM_MAX - 0.001;
}
function resetZoom() { ui.zoom = { z: 1, cx: 0.5, cy: 0.5 }; }

function wireZoom() {
  const wrap = $('#canvasWrap');
  const rel = (e) => { const r = $('#view').getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  $('#zoomIn').addEventListener('click', () => setZoom(ui.zoom.z * 1.6));
  $('#zoomOut').addEventListener('click', () => setZoom(ui.zoom.z / 1.6));
  $('#zoomLabel').addEventListener('click', () => { resetZoom(); requestRender(); });
  $('#zoom100').addEventListener('click', () => { const z = zoom100(); if (z) setZoom(Math.abs(ui.zoom.z - z) < 0.02 ? 1 : z); });

  wrap.addEventListener('wheel', (e) => {
    if (!engine.hasSource() || ui.cropMode || (ui.tab === 'masks' && ui.selMask >= 0)) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const [ax, ay] = rel(e);
    setZoom(ui.zoom.z * k, ax, ay);
  }, { passive: false });

  // Gestos con el puntero: pellizcar con dos dedos (zoom + mover), arrastrar para mover la foto
  // (en modo normal, con el botón central o con la barra espaciadora pulsada).
  const ptrs = new Map(); let g = null;
  const pinch = () => { const [a, b] = [...ptrs.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  wrap.addEventListener('pointerdown', (e) => {
    if (!engine.hasSource() || ui.cropMode || (ui.tab === 'masks' && ui.selMask >= 0) || e.target.closest('#zoomBar')) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { g = { kind: 'pinch', ...pinch(), z: ui.zoom.z }; e.stopPropagation(); return; }
    const free = overlayModeNow() === 'none';
    if ((free && e.button === 0 && zoomActive()) || e.button === 1 || ui.space) {
      if (!zoomActive() && !(e.button === 1 || ui.space)) return;
      g = { kind: 'pan', x: e.clientX, y: e.clientY };
      e.stopPropagation(); e.preventDefault(); wrap.classList.add('panning');
      try { wrap.setPointerCapture(e.pointerId); } catch { /* sigue funcionando */ }
    }
  }, true);
  wrap.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!g) return;
    e.stopPropagation();
    const r = $('#view').getBoundingClientRect();
    if (g.kind === 'pinch' && ptrs.size >= 2) {
      const now = pinch(); const ax = (now.x - r.left) / r.width; const ay = (now.y - r.top) / r.height;
      const before = ui.zoom.z; setZoom(g.z * (now.d / g.d), ax, ay);
      if (before > 1.0001 || ui.zoom.z > 1.0001) panBy((now.x - g.x) / r.width, (now.y - g.y) / r.height);
      g.x = now.x; g.y = now.y;
    } else if (g.kind === 'pan') {
      panBy((e.clientX - g.x) / r.width, (e.clientY - g.y) / r.height); g.x = e.clientX; g.y = e.clientY;
    }
  }, true);
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (g && (g.kind === 'pan' || ptrs.size < 2)) { g = null; wrap.classList.remove('panning'); }
  };
  wrap.addEventListener('pointerup', end, true); wrap.addEventListener('pointercancel', end, true);

  wrap.addEventListener('dblclick', (e) => {
    if (overlayModeNow() !== 'none' || !engine.hasSource()) return;
    const [ax, ay] = rel(e);
    if (zoomActive()) { resetZoom(); requestRender(); } else { const z = zoom100(); setZoom(Math.max(2, z || 2), ax, ay); }
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) && ui.mode === 'edit') { ui.space = true; if (zoomActive()) e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') ui.space = false; });
}

// ---------- pestaña Ajustes ----------
function buildAdjustTab() {
  const root = $('#tabAdjust');
  root.replaceChildren();
  for (const g of SLIDER_GROUPS) {
    const d = el('details', { open: g.id === 'light' || g.id === 'color' }, el('summary', {}, g.title));
    if (g.id === 'light') d.append(el('div', { class: 'row tools' }, el('button', { class: 'btn small', type: 'button', id: 'btnAutoTone', title: 'Calcula exposición, luces, sombras y contraste', onClick: autoTone }, '✦ Tono automático')));
    if (g.id === 'color') d.append(el('div', { class: 'row tools' },
      el('button', { class: 'btn small', type: 'button', id: 'btnWbPick', title: 'Toca algo que debería ser gris o blanco', onClick: startWbPicker }, '💧 Gotero'),
      el('button', { class: 'btn small', type: 'button', id: 'btnWbAuto', title: 'Calcula el balance de blancos a partir de toda la foto', onClick: autoWhiteBalance }, '✦ Balance automático')));
    for (const s of g.sliders) d.append(pathSlider(s));
    root.append(d);
    if (g.id === 'color') root.append(buildHslSection());
  }
  root.append(buildGradingSection());
  root.append(buildLookSection());
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


// ---------- looks (LUT 3D .cube) ----------
const lookCache = new Map(); // id -> LUT ya leída

async function getLook(id) {
  if (lookCache.has(id)) return lookCache.get(id);
  const rec = await storage.getAsset(id);
  if (!rec) return null;
  const lut = parseCube(await rec.blob.text());
  lookCache.set(id, lut);
  return lut;
}

// Sube al motor la tabla del look que pide `id` (si todavía no la tiene). No lanza: sin look se ve la foto sin él.
async function ensureLook(eng, id) {
  if (!id || eng.lookId === id) return;
  try { const lut = await getLook(id); if (lut) eng.setLook(id, lut); } catch (err) { console.error(err); }
}

async function importLooks(files) {
  let ok = 0;
  for (const f of files) {
    try {
      if (f.size > MAX_CUBE_BYTES) throw new Error('El archivo es demasiado grande para ser una LUT.');
      const text = await f.text();
      const lut = parseCube(text); // valida antes de guardar
      const rec = { id: storage.newId('look'), kind: 'look', name: (lut.title || f.name.replace(/\.cube$/i, '')).slice(0, 80), file: f.name, blob: new Blob([text], { type: 'text/plain' }), createdAt: Date.now() };
      await storage.putAsset(rec); lookCache.set(rec.id, lut); ok++;
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
  ui.looks = await storage.listAssets('look');
  if (ok) toast(`${ok} look${ok === 1 ? '' : 's'} cargado${ok === 1 ? '' : 's'}`);
  refreshLookSection();
}

function setLook(rec) {
  store.update((e) => { e.look = rec ? { id: rec.id, name: rec.name, intensity: e.look.intensity === 0 ? 100 : (e.look.intensity ?? 100) } : { id: null, name: '', intensity: 100 }; });
  store.commit();
  if (rec) ensureLook(engine, rec.id).then(requestRender);
  refreshLookSection();
}

let lookRefreshing = false;
function refreshLookSection() {
  const old = $('#lookSection');
  if (!old || lookRefreshing) return;
  lookRefreshing = true; // quitar un control con foco dispara "blur", que puede volver a confirmar y llegar aquí
  try {
    const fresh = buildLookSection();
    if (old.open) fresh.open = true;
    old.replaceWith(fresh);
  } finally { lookRefreshing = false; }
}

function buildLookSection() {
  const d = el('details', { id: 'lookSection', open: !!store.get().look.id }, el('summary', {}, 'Look (LUT 3D)'));
  const cur = store.get().look;
  ui.lookShown = cur.id;
  const sel = el('select', { class: 'field', id: 'lookSelect', 'aria-label': 'Look' },
    el('option', { value: '' }, ui.looks.length ? 'Sin look' : 'Aún no hay looks cargados'),
    ...ui.looks.map((r) => el('option', { value: r.id, selected: r.id === cur.id }, r.name)));
  sel.addEventListener('change', () => setLook(ui.looks.find((r) => r.id === sel.value) || null));
  const load = el('button', { class: 'btn small', type: 'button', id: 'btnLoadLook', onClick: () => $('#fileLook').click() }, 'Cargar .cube…');
  d.append(el('div', { class: 'row' }, sel), el('div', { class: 'row tools' }, load));
  if (cur.id) {
    const inten = sliderRow({ label: 'Intensidad del look', min: 0, max: 100, step: 1, neutral: 100,
      get: () => store.get().look.intensity, set: (v) => store.update((e) => { e.look.intensity = v; }), commit: () => store.commit() });
    d.append(inten.row);
    d.append(el('button', { class: 'btn small danger', type: 'button', onClick: async () => {
      if (!confirm(`¿Borrar el look "${cur.name}" de este dispositivo? Las fotos que lo usan se verán sin él.`)) return;
      await storage.deleteAsset(cur.id); lookCache.delete(cur.id); ui.looks = await storage.listAssets('look');
      setLook(null);
    } }, 'Borrar este look'));
  }
  d.append(el('p', { class: 'hint' }, 'Un .cube es una tabla de color que otros fotógrafos comparten. Se aplica al final de tus ajustes. Solo LUT 3D (hasta 65³).'));
  return d;
}

// ---------- pestaña Curvas ----------
let curveEditor = null;
const CURVE_NAMES = { master: 'RGB', r: 'Rojo', g: 'Verde', b: 'Azul', hue: 'Tono→Tono', sat: 'Tono→Sat.', lum: 'Tono→Lum.' };
const isHueCurve = (ch) => HSL_CURVES.includes(ch);
const curvePoints = (ch) => (isHueCurve(ch) ? store.get().hslCurves[ch] : store.get().curves[ch]);
const resetCurve = (ch) => (isHueCurve(ch) ? flatCurve() : [[0, 0], [1, 1]]);

function buildCurvesTab() {
  const root = $('#tabCurves');
  root.replaceChildren();
  const canvas = el('canvas', { id: 'curveCanvas' });
  const bar = el('div', { class: 'chips' });
  [...CURVE_CHANNELS, ...HSL_CURVES].forEach((ch) => {
    const b = el('button', { class: 'chip' + (ch === 'master' ? ' on' : ''), type: 'button', 'data-ch': ch, title: isHueCurve(ch) ? 'Curva por tono: el eje horizontal es el color; el centro es "sin cambio"' : '' }, CURVE_NAMES[ch]);
    b.addEventListener('click', () => {
      bar.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
      curveEditor.setChannel(ch);
      curveEditor.setPoints(curvePoints(ch));
      hint.textContent = isHueCurve(ch) ? HUE_HINT : TONE_HINT;
    });
    bar.append(b);
  });
  const TONE_HINT = 'Toca para añadir un punto, arrástralo para moverlo y haz doble clic (o doble toque) en un punto para quitarlo.';
  const HUE_HINT = 'El eje horizontal es el color (rojo → amarillo → verde → azul → magenta). Sube un punto para aumentar el efecto en ese color y bájalo para reducirlo; la línea central es "sin cambio".';
  const hint = el('p', { class: 'hint' }, TONE_HINT);
  const reset = el('button', { class: 'btn small', type: 'button' }, 'Restablecer esta curva');
  reset.addEventListener('click', () => {
    const ch = curveEditor.channel;
    store.update((e) => { if (isHueCurve(ch)) e.hslCurves[ch] = resetCurve(ch); else e.curves[ch] = resetCurve(ch); });
    store.commit(); curveEditor.setPoints(curvePoints(ch));
  });
  root.append(bar, canvas, hint, reset);
  curveEditor = new CurveEditor(canvas, {
    onChange: (ch, points, final) => {
      store.update((e) => { const pts = points.map((p) => p.slice()); if (isHueCurve(ch)) e.hslCurves[ch] = pts; else e.curves[ch] = pts; });
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
    el('div', { class: 'sub' }, 'Para imprimir'),
    el('div', { class: 'row' }, btn('Ajustar al marco de impresión', () => cropToPrintFrame())),
    el('p', { class: 'hint', id: 'frameAspectHint' }, 'Recorta esta foto a la forma de la ventana del marco elegido en "Imprimir".'),
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

function cropToPrintFrame() {
  if (!engine.hasSource() || !printUI) return;
  const [ow, oh] = orientedSize();
  const aspect = printUI.windowAspectFor(visibleAspect(store.get(), ow, oh));
  const rect = fitAspect(aspect, ow, oh, store.get().geometry.crop);
  store.update((e) => { e.geometry.crop = rect; });
  store.commit();
  toast(`Recorte ajustado a la forma del marco (${aspect.toFixed(2)} : 1)`);
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

// ---------- pincel ----------
function brushControls(m) {
  const size = sliderRow({ label: 'Tamaño del pincel', min: 1, max: 30, step: 0.5, neutral: 4, unit: '%',
    get: () => ui.brush.r * 100, set: (v) => { ui.brush.r = v / 100; overlay.draw(); }, commit: () => {} }).row;
  const soft = sliderRow({ label: 'Suavidad del borde', min: 0, max: 100, step: 1, neutral: 50,
    get: () => ui.brush.soft * 100, set: (v) => { ui.brush.soft = v / 100; }, commit: () => {} }).row;
  const cb = el('input', { type: 'checkbox' }); cb.checked = ui.brush.erase;
  cb.addEventListener('change', () => { ui.brush.erase = cb.checked; overlay.draw(); });
  const clear = el('button', { class: 'btn small', type: 'button', onClick: () => {
    store.update((ed) => { ed.masks[ui.selMask].strokes = []; }); store.commit(); overlay.draw();
  } }, 'Borrar todo el pincelado');
  return [
    el('p', { class: 'hint' }, 'Pinta sobre la foto la zona a ajustar (se ve en rojo). Si cambias el recorte después, repinta.'),
    size, soft, el('label', { class: 'check' }, cb, 'Goma (quitar zona pintada)'), clear,
  ];
}

// ---------- pestaña Máscaras ----------
function buildMasksTab() {
  const root = $('#tabMasks');
  root.replaceChildren();
  const e = store.get();
  const list = el('div', { class: 'list' });
  e.masks.forEach((m, i) => {
    const b = el('button', { class: 'pitem' + (i === ui.selMask ? ' on' : ''), type: 'button' },
      el('span', {}, `${i + 1} · ${m.type === 'linear' ? 'Degradado' : m.type === 'brush' ? 'Pincel' : 'Radial'}${m.enabled === false ? ' (off)' : ''}`));
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
      el('button', { class: 'btn small', type: 'button', onClick: add('radial') }, '+ Radial'),
      el('button', { class: 'btn small', type: 'button', onClick: add('brush') }, '+ Pincel')),
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
    el('div', { class: 'sub' }, m.type === 'brush' ? 'Pincel' : 'Forma'),
    ...(m.type === 'brush' ? brushControls(m) : [field('feather', 'Difuminado', 0, 100, 1, 100)]),
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
const PACKS = [{ id: 'peva3', label: 'Lightroom abiertos (MIT)', url: 'presets/lightroom-peva3-mit.json' }];
const PRESET_PAGE = 60;
const fold = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function findPreset(id) {
  return STARTER_PRESETS.find((x) => x.id === id) || ui.userPresets.find((x) => x.id === id)
    || Object.values(ui.packs).flatMap((p) => p.presets).find((x) => x.id === id);
}

async function loadPack(id) {
  if (ui.packs[id]) return ui.packs[id];
  const meta = PACKS.find((p) => p.id === id);
  if (!meta) return null;
  const res = await fetch(meta.url);
  if (!res.ok) throw new Error('No se pudo cargar el paquete de presets');
  const pack = await res.json();
  if (pack.format !== 'editor-fotos-pack' || !Array.isArray(pack.presets)) throw new Error('El paquete de presets no es válido');
  pack.presets = pack.presets.map((p) => ({ ...p, edits: migrate(p.edits), pack: id }));
  ui.packs[id] = pack;
  return pack;
}

// presets de la fuente elegida, ya filtrados por grupo y búsqueda
function visiblePresets() {
  const src = ui.presetSource;
  let list = src === 'starter' ? STARTER_PRESETS : src === 'mine' ? ui.userPresets : (ui.packs[src] ? ui.packs[src].presets : []);
  if (ui.presetGroup) list = list.filter((p) => p.group === ui.presetGroup);
  const q = fold(ui.presetQuery.trim());
  if (q) list = list.filter((p) => fold(p.name).includes(q) || fold(p.group || '').includes(q));
  return list;
}

function renderPresetList() {
  const box = $('#presetListBox');
  if (!box) return;
  box.replaceChildren();
  const src = ui.presetSource;
  if (src !== 'starter' && src !== 'mine' && !ui.packs[src]) {
    box.append(el('p', { class: 'hint' }, ui.packLoading ? 'Cargando paquete…' : 'No se pudo cargar el paquete.'));
    return;
  }
  const all = visiblePresets();
  const list = el('div', { class: 'list' });
  for (const p of all.slice(0, ui.presetLimit)) {
    const b = el('button', { class: 'pitem' + (p.id === ui.selPresetId ? ' on' : ''), type: 'button', title: p.group || '' }, el('span', {}, p.name));
    b.addEventListener('click', () => selectPreset(p.id));
    if (!p.builtin && !p.pack) {
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
  box.append(list);
  if (!all.length) box.append(el('p', { class: 'hint' }, src === 'mine' ? 'Aún no tienes presets propios. Guarda uno o importa archivos.' : 'Ningún preset coincide con la búsqueda.'));
  if (all.length > ui.presetLimit) {
    box.append(el('button', { class: 'btn small', type: 'button', onClick: () => { ui.presetLimit += PRESET_PAGE; renderPresetList(); } }, `Mostrar más (${all.length - ui.presetLimit})`));
  }
  const pack = ui.packs[src];
  if (pack) {
    box.append(el('p', { class: 'hint' }, `${all.length} de ${pack.presets.length} presets. Fuente: `,
      el('a', { href: pack.source.repo, target: '_blank', rel: 'noopener', style: 'color:inherit' }, pack.source.author + '/' + pack.source.repo.split('/').pop()),
      ` · Licencia ${pack.source.license}. Conversión aproximada: se parecen al original, no son idénticos.`));
  }
}

function buildPresetsTab() {
  const root = $('#tabPresets');
  root.replaceChildren();

  // fuente, búsqueda y grupo
  const sources = [{ id: 'starter', label: 'Arranque' }, { id: 'mine', label: `Mis presets (${ui.userPresets.length})` }, ...PACKS.map((p) => ({ id: p.id, label: p.label }))];
  const sel = el('select', { class: 'field', id: 'presetSource', 'aria-label': 'Fuente de presets' }, sources.map((o) => el('option', { value: o.id, selected: o.id === ui.presetSource }, o.label)));
  sel.addEventListener('change', async () => {
    ui.presetSource = sel.value; ui.presetGroup = ''; ui.presetQuery = ''; ui.presetLimit = PRESET_PAGE;
    if (PACKS.some((p) => p.id === sel.value) && !ui.packs[sel.value]) {
      ui.packLoading = true; buildPresetsTab();
      try { await loadPack(sel.value); } catch (err) { toast(err.message, true); }
      ui.packLoading = false;
    }
    buildPresetsTab();
  });
  root.append(sel);

  const pack = ui.packs[ui.presetSource];
  const search = el('input', { class: 'field', type: 'search', id: 'presetSearch', placeholder: 'Buscar preset…', value: ui.presetQuery, style: 'margin-top:8px' });
  search.addEventListener('input', () => { ui.presetQuery = search.value; ui.presetLimit = PRESET_PAGE; renderPresetList(); });
  root.append(search);
  if (pack && pack.groups && pack.groups.length) {
    const g = el('select', { class: 'field', id: 'presetGroup', 'aria-label': 'Grupo', style: 'margin-top:8px' },
      el('option', { value: '' }, `Todos los grupos (${pack.groups.length})`),
      pack.groups.map((n) => el('option', { value: n, selected: n === ui.presetGroup }, n)));
    g.addEventListener('change', () => { ui.presetGroup = g.value; ui.presetLimit = PRESET_PAGE; renderPresetList(); });
    root.append(g);
  }
  root.append(el('div', { id: 'presetListBox', style: 'margin-top:8px' }));
  renderPresetList();

  if (ui.presetSession) {
    const s = ui.presetSession;
    const inten = sliderRow({
      label: 'Intensidad', min: 0, max: 100, step: 1, neutral: 100,
      get: () => Math.round(s.intensity * 100),
      set: (v) => { s.intensity = v / 100; previewPreset(); },
      commit: () => {},
    });
    root.append(el('div', { class: 'card' }, el('div', { class: 'hint' }, s.preset.name), inten.row,
      el('div', { class: 'row' },
        el('button', { class: 'btn small primary', type: 'button', onClick: applyPresetSession }, 'Aplicar'),
        el('button', { class: 'btn small', type: 'button', onClick: cancelPreset }, 'Cancelar')),
      lib.items.length > 1 ? el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', { class: 'btn small', type: 'button', id: 'btnPresetAll', onClick: () => applySessionToMany('all') }, 'Aplicar a todas las fotos'),
        el('button', { class: 'btn small', type: 'button', id: 'btnPresetMarked', onClick: () => applySessionToMany('marked') }, 'A las marcadas')) : null));
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
    ui.userPresets.push(p); name.value = ''; ui.presetSource = 'mine'; ui.presetQuery = ''; ui.presetGroup = '';
    buildPresetsTab(); toast('Preset guardado');
  });
  const exp = el('button', { class: 'btn small', type: 'button' }, 'Exportar mis presets');
  exp.addEventListener('click', () => {
    if (!ui.userPresets.length) { toast('Aún no tienes presets propios', true); return; }
    download(new Blob([storage.presetsToJson(ui.userPresets)], { type: 'application/json' }), 'mis-presets.json');
  });
  const imp = el('button', { class: 'btn small', type: 'button', id: 'btnImportPresets', onClick: () => $('#filePresets').click() }, 'Importar archivos…');
  root.append(el('div', { class: 'sub' }, 'Mis presets'), name, el('div', { class: 'row', style: 'margin-top:8px' }, save), el('div', { class: 'row', style: 'margin-top:8px' }, exp, imp),
    el('p', { class: 'hint' }, 'Importa presets de Lightroom (.xmp, .lrtemplate), RawTherapee (.pp3, .arp) o de esta app (.json). Un preset suma sus ajustes a los que ya tienes; la intensidad lo mezcla de 0 a 100 %.'));
}

async function importPresetFiles(files) {
  let ok = 0; const notes = []; const errs = [];
  for (const f of files) {
    try {
      const ext = (f.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
      const text = await f.text();
      if (ext === 'json') {
        const list = storage.presetsFromJson(text);
        for (const p of list) { await storage.savePreset(p); ui.userPresets.push(p); }
        ok += list.length; continue;
      }
      const r = parsePresetText(f.name, text);
      r.edits.geometry = defaultEdits().geometry; r.edits.masks = [];
      const p = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: r.name, edits: r.edits };
      await storage.savePreset(p); ui.userPresets.push(p); ok++;
      if (r.report.ignored.length) notes.push(`${r.name}: sin equivalente (${r.report.ignored.slice(0, 3).join(', ')}${r.report.ignored.length > 3 ? '…' : ''})`);
      if (!r.report.mapped.length) errs.push(`${r.name}: no tenía ningún ajuste que esta app entienda`);
    } catch (err) { errs.push(`${f.name}: ${err.message}`); }
  }
  ui.presetSource = 'mine'; ui.presetQuery = ''; ui.presetGroup = '';
  buildPresetsTab();
  const msg = `${ok} preset(s) importado(s)` + (notes.length ? `. ${notes.length === 1 ? notes[0] : `${notes.length} tenían ajustes sin equivalente`}` : '') + (errs.length ? `. Problemas: ${errs.slice(0, 2).join(' · ')}` : '');
  toast(msg, errs.length > 0 && ok === 0);
}

function selectPreset(id) {
  if (!engine.hasSource()) { toast('Abre una foto primero', true); return; }
  const p = findPreset(id);
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

async function applySessionToMany(which) {
  const s = ui.presetSession;
  if (!s) return;
  const ids = which === 'all' ? lib.items.map((p) => p.id) : [...lib.selected];
  if (!ids.length) { toast('No hay fotos marcadas (casilla de cada miniatura)', true); return; }
  const { preset, intensity } = s;
  ui.presetSession = null; ui.selPresetId = null;
  store.replace(s.base, false); // quita la previsualización antes de aplicar de verdad
  toast(`Aplicando "${preset.name}" a ${ids.length} foto${ids.length === 1 ? '' : 's'}…`);
  const n = await batchUpdate(ids, (e) => applyPreset(e, preset.edits, intensity));
  buildPresetsTab();
  toast(`Preset "${preset.name}" aplicado a ${n} foto${n === 1 ? '' : 's'}`);
}

function cancelPreset() {
  const s = ui.presetSession;
  ui.presetSession = null; ui.selPresetId = null;
  if (s) store.replace(s.base, false);
  buildPresetsTab();
}

// ---------- herramientas automáticas y de retoque ----------

// Pixeles de la vista SIN ajustes (conserva recorte y giro): para medir colores y tonos de la foto original.
function neutralPixels(maxSide = 600) {
  engine.render(store.get(), { maxW: maxSide, maxH: maxSide, original: true, upscale: false });
  const px = engine.readPixels();
  requestRender();
  return px;
}

function lumaHistogram(data) {
  const h = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) h[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  return h;
}

function setWb(wb, label) {
  store.update((e) => { e.color.temperature = wb.temperature; e.color.tint = wb.tint; });
  store.commit();
  toast(`${label}: temperatura ${wb.temperature > 0 ? '+' : ''}${wb.temperature}, tinte ${wb.tint > 0 ? '+' : ''}${wb.tint}`);
}

function startWbPicker() {
  if (!engine.hasSource()) return;
  ui.pick = ui.pick === 'wb' ? null : 'wb';
  if (ui.pick) toast('Toca en la foto algo que debería ser gris o blanco');
  updateOverlayMode(); overlay.draw();
  $('#overlay').style.cursor = ui.pick ? 'crosshair' : 'default';
}

function pickWhiteBalance(vx, vy) {
  const [u, v] = viewToCrop(vx, vy);
  const px = neutralPixels(700);
  const avg = averagePatchLinear(px.data, px.width, px.height, u * px.width, v * px.height, Math.max(2, Math.round(px.width / 180)));
  ui.pick = null; updateOverlayMode(); overlay.draw();
  if (!(avg.r > 0.002 && avg.g > 0.002 && avg.b > 0.002)) { toast('Ese punto es casi negro: prueba con una zona más clara', true); return; }
  setWb(whiteBalanceFromLinear(avg.r, avg.g, avg.b), 'Balance de blancos');
}

function autoWhiteBalance() {
  if (!engine.hasSource()) return;
  const px = neutralPixels(500);
  const gw = grayWorldLinear(px.data, px.width, px.height);
  if (!gw) { toast('No encontré tonos neutros para calcularlo. Usa el gotero.', true); return; }
  setWb(whiteBalanceFromLinear(gw.r, gw.g, gw.b), 'Balance automático');
}

function autoTone() {
  if (!engine.hasSource()) return;
  const px = neutralPixels(500);
  const tone = autoToneFromHistogram(lumaHistogram(px.data));
  store.update((e) => { Object.assign(e.light, tone); });
  store.commit();
  toast('Tono automático aplicado. Afínalo con los deslizadores.');
}

// Auto (tono + balance) en varias fotos, con el motor de trabajo.
async function autoMany() {
  const ids = lib.selected.size ? [...lib.selected] : (ui.photoId ? [ui.photoId] : []);
  if (!ids.length) return;
  toast(`Calculando el automático de ${ids.length} foto${ids.length === 1 ? '' : 's'}…`);
  const plan = new Map();
  for (const id of ids) {
    const rec = await storage.getPhoto(id);
    if (!rec) continue;
    const we = await loadWork(rec);
    we.render(rec.edits, { maxW: 500, maxH: 500, original: true, upscale: false });
    const px = we.readPixels();
    const gw = grayWorldLinear(px.data, px.width, px.height);
    plan.set(id, { wb: gw ? whiteBalanceFromLinear(gw.r, gw.g, gw.b) : null, tone: autoToneFromHistogram(lumaHistogram(px.data)) });
  }
  const n = await batchUpdate([...plan.keys()], (e, rec) => {
    const p = plan.get(rec.id); const out = applyAutoTone(e, p.tone);
    if (p.wb) { out.color.temperature = p.wb.temperature; out.color.tint = p.wb.tint; }
    return out;
  });
  toast(`Automático aplicado en ${n} foto${n === 1 ? '' : 's'}`);
}

// ----- quitar manchas -----
function cropGeo() {
  const g = store.get().geometry; const [ow, oh] = orientedSize();
  return { crop: g.crop, ow, oh };
}
function spotToCrop(sp) {
  const { crop, ow, oh } = cropGeo();
  return {
    cx: (sp.x - crop.x) / crop.w, cy: (sp.y - crop.y) / crop.h, rw: sp.r / crop.w, rh: (sp.r * ow) / (crop.h * oh),
    sx: (sp.x + sp.dx - crop.x) / crop.w, sy: (sp.y + sp.dy - crop.y) / crop.h, mode: sp.mode,
  };
}
// Lo mismo, pero en coordenadas de la vista (con el zoom aplicado)
function spotToView(sp) {
  const c = spotToCrop(sp); const { z } = zoomMap();
  const [cx, cy] = cropToView(c.cx, c.cy); const [sx, sy] = cropToView(c.sx, c.sy);
  return { cx, cy, sx, sy, rw: c.rw * z, rh: c.rh * z, mode: c.mode };
}
function spotsView() { return store.get().spots.map(spotToView); }

function updateSpotView(i, patch, final) {
  const sp = store.get().spots[i];
  if (!sp) return;
  const pv = { ...spotToView(sp), ...patch };
  const { z } = zoomMap();
  const [vcx, vcy] = viewToCrop(pv.cx, pv.cy); const [vsx, vsy] = viewToCrop(pv.sx, pv.sy);
  const v = { cx: vcx, cy: vcy, sx: vsx, sy: vsy, rw: pv.rw / z };
  const { crop } = cropGeo();
  const c01 = (x) => Math.min(1, Math.max(0, x));
  store.update((e) => {
    const t = e.spots[i];
    t.x = c01(crop.x + v.cx * crop.w); t.y = c01(crop.y + v.cy * crop.h);
    t.r = Math.min(0.3, Math.max(0.003, v.rw * crop.w));
    t.dx = Math.min(1, Math.max(-1, (v.sx - v.cx) * crop.w)); t.dy = Math.min(1, Math.max(-1, (v.sy - v.cy) * crop.h));
  });
  if (final) { store.commit(); buildRetouchTab(); }
}

function autoSpotSource(i) {
  const sp = store.get().spots[i];
  if (!sp) return;
  const px = neutralPixels(700);
  const v = spotToCrop(sp);
  const rpx = Math.max(3, v.rw * px.width);
  const s = chooseSpotSource(px.data, px.width, px.height, v.cx * px.width, v.cy * px.height, rpx);
  const { crop } = cropGeo();
  store.update((e) => { e.spots[i].dx = (s.dx / px.width) * crop.w; e.spots[i].dy = (s.dy / px.height) * crop.h; });
}

function addSpotView(vx, vy) {
  const [u, v] = viewToCrop(vx, vy);
  const st = store.get();
  if (st.geometry.straighten !== 0) { toast('Pon el enderezado en 0° para usar el retoque', true); return; }
  if (st.spots.length >= MAX_SPOTS) { toast(`Máximo ${MAX_SPOTS} retoques por foto`, true); return; }
  const { crop } = cropGeo();
  const sp = newSpot(Math.min(1, Math.max(0, crop.x + u * crop.w)), Math.min(1, Math.max(0, crop.y + v * crop.h)), 0.02);
  store.update((e) => { e.spots.push(sp); });
  ui.selSpot = store.get().spots.length - 1;
  autoSpotSource(ui.selSpot);
  store.commit();
  buildRetouchTab();
}

function buildRetouchTab() {
  const root = $('#tabRetouch');
  if (!root) return;
  root.replaceChildren();
  const spots = store.get().spots;
  const blocked = store.get().geometry.straighten !== 0;
  const toggle = el('button', { class: 'btn' + (ui.spotTool ? ' on' : ''), type: 'button', id: 'btnSpotTool', disabled: blocked,
    onClick: () => { ui.spotTool = !ui.spotTool; ui.pick = null; updateOverlayMode(); overlay.draw(); buildRetouchTab(); } }, ui.spotTool ? 'Quitar manchas: activado' : 'Quitar manchas');
  root.append(el('div', { class: 'row' }, toggle),
    el('p', { class: 'hint' }, blocked ? 'Pon el enderezado en 0° (pestaña Recorte) para usar el retoque.'
      : 'Toca una mancha o una migaja para quitarla. Arrastra el círculo punteado para elegir de dónde se copia la textura. El punto naranja cambia el tamaño.'));
  if (!spots.length) { root.append(el('p', { class: 'hint' }, 'Aún no hay retoques en esta foto.')); return; }
  const chips = el('div', { class: 'chips' }, spots.map((_, i) => {
    const c = el('button', { class: 'chip' + (i === ui.selSpot ? ' on' : ''), type: 'button' }, `Retoque ${i + 1}`);
    c.addEventListener('click', () => { ui.selSpot = i; buildRetouchTab(); overlay.draw(); });
    return c;
  }));
  root.append(chips);
  const sp = spots[ui.selSpot];
  if (!sp) return;
  const sl = (label, key, min, max, step, scale, unit) => sliderRow({
    label, min, max, step, unit, neutral: key === 'r' ? 2 : 100,
    get: () => (store.get().spots[ui.selSpot] ? store.get().spots[ui.selSpot][key] * scale : 0),
    set: (v) => store.update((e) => { if (e.spots[ui.selSpot]) e.spots[ui.selSpot][key] = v / scale; }),
    commit: () => store.commit(),
  }).row;
  const mode = el('select', { class: 'field', id: 'spotMode' }, el('option', { value: 'heal' }, 'Reparar (iguala la luz del entorno)'), el('option', { value: 'clone' }, 'Clonar (copia tal cual)'));
  mode.value = sp.mode;
  mode.addEventListener('change', () => { store.update((e) => { e.spots[ui.selSpot].mode = mode.value; }); store.commit(); });
  root.append(
    sl('Tamaño', 'r', 0.3, 15, 0.1, 100, '%'), sl('Difuminado', 'feather', 0, 100, 1, 100, ''), sl('Opacidad', 'opacity', 0, 100, 1, 100, ''),
    el('label', { class: 'pfield' }, el('span', {}, 'Modo'), mode),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', id: 'btnSpotAuto', onClick: () => { autoSpotSource(ui.selSpot); store.commit(); } }, 'Elegir origen automático'),
      el('button', { class: 'btn small danger', type: 'button', id: 'btnSpotDel', onClick: () => { store.update((e) => { e.spots.splice(ui.selSpot, 1); }); store.commit(); ui.selSpot = Math.min(ui.selSpot, store.get().spots.length - 1); buildRetouchTab(); } }, 'Eliminar'),
      el('button', { class: 'btn small danger', type: 'button', onClick: () => { store.update((e) => { e.spots = []; }); store.commit(); ui.selSpot = -1; buildRetouchTab(); } }, 'Quitar todos')));
}

// ---------- pestañas ----------
function setTab(name) {
  ui.tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('#tabBody section').forEach((s) => { s.hidden = s.dataset.tab !== name; });
  if (name === 'curves' && curveEditor) { curveEditor.setPoints(curvePoints(curveEditor.channel)); curveEditor.draw(); }
  if (name === 'masks') { buildMasksTab(); }
  if (name !== 'geometry' && ui.cropMode) endCrop(false);
  if (name !== 'retouch') ui.spotTool = false;
  if (name === 'retouch') buildRetouchTab();
  updateOverlayMode(); overlay.draw();
}

// ---------- capa interactiva ----------
const overlay = new Overlay($('#overlay'), {
  getMode: () => {
    if (ui.compare || !engine.hasSource()) return 'none';
    if (ui.cropMode) return 'crop';
    if (ui.pick === 'wb') return 'pick';
    if (ui.spotTool && ui.tab === 'retouch') return 'spot';
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
  brushInfo: () => ({ r: ui.brush.r, erase: ui.brush.erase }),
  brushStart: (x, y) => {
    store.update((ed) => { const m = ed.masks[ui.selMask]; if (m.strokes.length < MAX_STROKES) m.strokes.push(newStroke(x, y, ui.brush.r, ui.brush.soft, ui.brush.erase)); });
  },
  brushMove: (x, y) => {
    store.update((ed) => {
      const st = ed.masks[ui.selMask].strokes; const s = st[st.length - 1];
      if (!s) return;
      const q = s.pts[s.pts.length - 1];
      if (Math.hypot(x - q[0], y - q[1]) < s.r * 0.18) return; // puntos muy juntos no aportan
      if (s.pts.length >= MAX_STROKE_POINTS) { // trazo lleno: sigue en uno nuevo con el mismo estilo
        if (st.length < MAX_STROKES) st.push({ r: s.r, soft: s.soft, erase: s.erase, pts: [q, [x, y]] });
        return;
      }
      s.pts.push([x, y]);
    });
  },
  brushEnd: () => { store.commit(); },
  onPick: (u, v) => pickWhiteBalance(u, v),
  getSpotsView: () => spotsView(),
  selectedSpot: () => ui.selSpot,
  selectSpot: (i) => { ui.selSpot = i; buildRetouchTab(); },
  addSpotView: (u, v) => addSpotView(u, v),
  updateSpotView: (i, patch, final) => updateSpotView(i, patch, final),
  updateMask: (patch, final) => {
    if (Object.keys(patch).length) store.update((e) => { Object.assign(e.masks[ui.selMask], patch); });
    if (final) { store.commit(); buildMasksTab(); }
  },
});

function updateOverlayMode() {
  $('#overlay').style.pointerEvents = overlay.active() ? 'auto' : 'none';
  requestRender(); // el zoom se suspende en recorte y máscaras
}

// ---------- sincronizar la interfaz con el estado ----------
function syncControls() {
  for (const c of Object.values(controls)) c.refresh();
  if (curveEditor) curveEditor.setPoints(curvePoints(curveEditor.channel));
  if (ui.tab === 'masks') buildMasksTab();
  if (ui.tab === 'retouch') buildRetouchTab();
  if (store.get().look.id !== ui.lookShown) refreshLookSection();
}

function updateButtons() {
  const has = engine.hasSource();
  const printing = ui.mode === 'print';
  $('#btnUndo').disabled = printing || !store.canUndo();
  $('#btnRedo').disabled = printing || !store.canRedo();
  $('#btnReset').disabled = printing || !has || isNeutral(store.get());
  $('#btnCompare').disabled = printing || !has;
  $('#btnExport').disabled = printing ? lib.items.length === 0 : !has;
  $('#btnExport').textContent = printing ? 'Descargar PDF' : 'Exportar';
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
  ui.saveTimer = setTimeout(() => { saveCurrent(); }, 300);
}

// ---------- biblioteca de fotos ----------
const lib = new Library();
let workEngine = null; let workId = null;

// ---------- origen de la foto (JPEG/PNG… o RAW) ----------
// Un RAW se revela a RGB lineal de 16 bits (LibRaw). Para editar basta media resolución (rápido: ~1 s); el tamaño
// completo se revela al acercar el zoom o al exportar. Devuelve algo que `applySource` sabe subir a un motor.
async function decodeSource(rec, { full = false } = {}) {
  if (!rec.isRaw) return { kind: 'bitmap', bmp: await decodeBlob(rec.blob), full: true };
  const wantFull = full && canDecodeFull(rec.width, rec.height);
  return { kind: 'raw', raw: await decodeRaw(rec.blob, { half: !wantFull }), full: wantFull };
}
function applySource(eng, src) {
  if (src.kind === 'bitmap') { eng.setSource(src.bmp); if (src.bmp.close) src.bmp.close(); }
  else if (!eng.setSourceLinear(src.raw)) eng.setSource(rawToCanvas(src.raw)); // GPU sin texturas half-float: 8 bits
  eng.srcFull = src.full;
}

// Revela el RAW de la foto actual a tamaño completo (una sola vez) y lo cambia en la vista sin perder la edición.
async function ensureFullRaw() {
  if (ui.fullRawBusy) return ui.fullRawBusy;
  const id = ui.photoId;
  if (!id || !engine.hasSource() || engine.srcFull !== false) return;
  ui.fullRawBusy = (async () => {
    try {
      const rec = await storage.getPhoto(id);
      if (!rec || !rec.isRaw || !canDecodeFull(rec.width, rec.height)) { engine.srcFull = true; return; }
      toast('Revelando todo el detalle del RAW…');
      const src = await decodeSource(rec, { full: true });
      if (ui.photoId !== id) return; // cambió de foto mientras tanto
      applySource(engine, src);
      requestRender();
    } catch (err) { console.error(err); engine.srcFull = true; toast(err.message, true); }
    finally { ui.fullRawBusy = null; }
  })();
  return ui.fullRawBusy;
}

const getWorkEngine = () => { if (!workEngine) workEngine = new Engine(document.createElement('canvas')); return workEngine; };

// Motor de trabajo (miniaturas, impresión) con la foto de `rec` cargada.
async function loadWork(rec, edits = rec.edits, { full = false } = {}) {
  const we = getWorkEngine();
  if (edits && edits.look && edits.look.id) await ensureLook(we, edits.look.id);
  if (workId === rec.id && we.hasSource() && (!full || we.srcFull !== false)) return we;
  const src = await decodeSource(rec, { full });
  applySource(we, src);
  workId = rec.id;
  return we;
}

async function regenThumb(rec, edits) {
  const we = await loadWork(rec, edits);
  we.render(edits, { maxW: 240, maxH: 240, upscale: false });
  rec.thumb = await makeThumb(we.canvas, we.canvas.width, we.canvas.height);
}

// Guarda en disco los ajustes de la foto actual y actualiza su estado y miniatura.
async function saveCurrent() {
  if (!ui.photoId) return;
  const rec = await storage.getPhoto(ui.photoId);
  if (!rec) return;
  const edits = clone(store.get());
  const changed = JSON.stringify(rec.edits) !== JSON.stringify(edits);
  if (!changed && rec.thumb) return;
  rec.edits = edits;
  rec.aspect = visibleAspect(edits, rec.width, rec.height);
  if (changed) rec.status = statusAfterEdit(edits); // al editar, deja de estar aprobada
  if (changed && engine.hasSource() && ui.mode === 'edit' && !ui.compare && !ui.cropMode) {
    renderNow();
    rec.thumb = await makeThumb(view, view.width, view.height);
  }
  await lib.put(rec);
}

const isImageFile = (f) => isRawName(f.name) || /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp)$/i.test(f.name);

// Importa un RAW: revela a media resolución, calcula un revelado base (tono automático) y la miniatura.
async function importRaw(file, id, order) {
  const raw = await decodeRaw(file, { half: true });
  const we = getWorkEngine();
  if (!we.setSourceLinear(raw)) we.setSource(rawToCanvas(raw));
  we.srcFull = false; workId = id; // el motor de trabajo ya tiene esta foto a media resolución
  we.render(defaultEdits(), { maxW: 500, maxH: 500, upscale: false });
  const edits = applyAutoTone(defaultEdits(), autoToneFromHistogram(lumaHistogram(we.readPixels().data)));
  we.render(edits, { maxW: 240, maxH: 240, upscale: false });
  const thumb = await makeThumb(we.canvas, we.canvas.width, we.canvas.height);
  const w = raw.width * 2; const h = raw.height * 2; // tamaño completo (media resolución = la mitad en cada lado)
  return {
    id, name: file.name.replace(/\.[^.]+$/, ''), blob: file, edits, status: 'pending', thumb, isRaw: true, rawMeta: raw.meta,
    addedAt: Date.now(), order, width: w, height: h, aspect: raw.width / raw.height,
  };
}

async function openFiles(list) {
  const files = [...list].filter(isImageFile);
  if (!files.length) { toast('Ese archivo no es una imagen compatible', true); return; }
  if (files.length > 1) toast(`Abriendo ${files.length} fotos…`);
  let firstId = null; let failed = 0; let lastError = '';
  for (const [i, file] of files.entries()) {
    try {
      const id = storage.fileKey(file);
      if (!(await storage.getPhoto(id))) {
        if (isRawName(file.name)) {
          if (files.length > 1) toast(`Revelando RAW ${i + 1} de ${files.length}…`);
          await lib.put(await importRaw(file, id, Date.now() + i));
        } else {
          const bmp = await decodeBlob(file);
          const { w, h } = sizeOf(bmp);
          const thumb = await makeThumb(bmp, w, h);
          if (bmp.close) bmp.close();
          await lib.put({
            id, name: file.name.replace(/\.[^.]+$/, ''), blob: file, edits: defaultEdits(), status: 'pending', thumb,
            addedAt: Date.now(), order: Date.now() + i, width: w, height: h, aspect: w / h,
          });
        }
      }
      firstId = firstId || id;
    } catch (err) { failed++; lastError = err.message || ''; console.error(err); }
  }
  if (failed) toast(isRawName(files[0].name) && lastError ? lastError : `${failed} archivo(s) no se pudieron abrir. Si son HEIC, tu navegador puede no soportarlos.`, true);
  if (firstId) await selectPhoto(firstId);
}
const openFile = (file) => (file ? openFiles([file]) : undefined);

async function selectPhoto(id) {
  const token = ++ui.loadToken;
  if (ui.photoId && ui.photoId !== id) await saveCurrent();
  const rec = await storage.getPhoto(id);
  if (!rec) return;
  if (rec.isRaw) toast('Revelando RAW…');
  let src;
  try { src = await decodeSource(rec); } catch (err) { console.error(err); toast(err.message, true); return; }
  if (token !== ui.loadToken) { if (src.bmp && src.bmp.close) src.bmp.close(); return; } // el usuario ya eligió otra
  applySource(engine, src);
  ui.photoId = id; ui.fileId = id; ui.fileName = rec.name;
  resetZoom(); ui.cropMode = false; ui.cropDraft = null; ui.selMask = -1; ui.presetSession = null; ui.selPresetId = null; ui.pick = null; ui.spotTool = false; ui.selSpot = -1;
  $('#empty').hidden = true; document.body.classList.add('has-photos');
  store.load(rec.edits);
  lib.setCurrent(id); storage.kvSet('lastPhoto', id);
  renderCropButtons(); updateOverlayMode(); setTab(ui.tab); updateButtons();
  if (ui.mode === 'print') printUI.schedulePreview(); else requestRender();
}

function showEmpty() {
  ui.photoId = null; engine.clearSource();
  $('#empty').hidden = false; document.body.classList.remove('has-photos');
  updateButtons();
}

// Aplica una transformación de ajustes a varias fotos (la actual y/o otras guardadas).
async function batchUpdate(ids, fn) {
  let n = 0;
  for (const id of ids) {
    if (id === ui.photoId) { store.replace(fn(clone(store.get()), lib.get(id)), true); await saveCurrent(); n++; continue; }
    const rec = await storage.getPhoto(id);
    if (!rec) continue;
    const next = fn(clone(rec.edits), rec);
    if (JSON.stringify(next) === JSON.stringify(rec.edits)) continue;
    rec.edits = next; rec.aspect = visibleAspect(next, rec.width, rec.height); rec.status = statusAfterEdit(next);
    try { await regenThumb(rec, next); } catch { /* sin miniatura nueva */ }
    await lib.put(rec); n++;
  }
  return n;
}

async function toggleApprove() {
  if (!ui.photoId) return;
  await saveCurrent();
  const rec = await storage.getPhoto(ui.photoId);
  rec.status = toggleApproved(rec.status);
  await lib.put(rec);
  if (rec.status === 'approved') {
    const next = nextToReview(lib.items, ui.photoId);
    if (next) selectPhoto(next); else toast('Todas las fotos están aprobadas. Pasa a Imprimir.');
  }
}

async function filmstripAction(act) {
  if (act === 'approve') return toggleApprove();
  if (act === 'copy') { ui.clip = clone(store.get()); toast('Ajustes copiados'); lib.emit(); return undefined; }
  if (act === 'paste') {
    if (!ui.clip) return undefined;
    const ids = [...lib.selected];
    if (!ids.length) { toast('Marca primero las fotos donde quieres pegar (casilla de cada miniatura)', true); return undefined; }
    const n = await batchUpdate(ids, (e) => pasteEdits(e, ui.clip));
    toast(`Ajustes pegados en ${n} foto${n === 1 ? '' : 's'}`); return undefined;
  }
  if (act === 'selectAll') { lib.selectAll(lib.selected.size !== lib.items.length); return undefined; }
  if (act === 'remove') return removePhotos();
  if (act === 'auto') return autoMany();
  return undefined;
}

async function removePhotos() {
  const ids = lib.selected.size ? [...lib.selected] : (ui.photoId ? [ui.photoId] : []);
  if (!ids.length) return;
  if (!confirm(`¿Quitar ${ids.length} foto${ids.length === 1 ? '' : 's'} de la biblioteca? Se borran también sus ajustes (tu archivo original no se toca).`)) return;
  const removingCurrent = ids.includes(ui.photoId);
  await lib.remove(ids);
  if (removingCurrent) { const next = lib.items[0]; if (next) await selectPhoto(next.id); else showEmpty(); }
}

async function sampleImage() {
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
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  await openFiles([new File([blob], 'ejemplo.png', { type: 'image/png', lastModified: 1 })]);
}

// ---------- modo Editar / Imprimir ----------
let printUI = null;
function setMode(mode) {
  ui.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'print') {
    if (ui.cropMode) endCrop(false);
    saveCurrent().then(() => { printUI.build(); printUI.schedulePreview(); });
  } else { requestRender(); }
  updateOverlayMode(); updateButtons();
}

// ---------- exportar ----------
function openExportDialog() {
  const dlg = $('#exportDlg');
  const g = engine.geometryInfo(store.get(), false);
  const scale = Math.min(1, engine.maxRender / Math.max(g.cw, g.ch));
  $('#expInfo').textContent = `Tamaño: ${Math.round(g.cw * scale)} × ${Math.round(g.ch * scale)} px`;
  $('#expQualityRow').hidden = $('#expType').value === 'image/png';
  dlg.dataset.ready = '';
  dlg.showModal();
  openWatermarkOptions().catch(() => { /* sin marca de agua si falla el almacenamiento */ }).finally(() => { dlg.dataset.ready = '1'; });
}

// Marca de agua: usa el logo de un restaurante ya configurado en Imprimir.
const WM_DEFAULT = { on: false, brandId: null, pos: 'bottom-right', size: 18, opacity: 85 };
async function openWatermarkOptions() {
  let wm = { ...WM_DEFAULT };
  try { wm = { ...wm, ...((await storage.kvGet('watermark')) || {}) }; } catch { /* sin preferencias */ }
  const brands = (await storage.listBrands()).filter((b) => b.logoId);
  const sel = $('#expWmBrand');
  sel.replaceChildren(...brands.map((b) => el('option', { value: b.id }, b.name)));
  if (brands.some((b) => b.id === wm.brandId)) sel.value = wm.brandId;
  $('#expWm').checked = wm.on && brands.length > 0;
  $('#expWm').disabled = brands.length === 0;
  $('#expWmPos').value = wm.pos; $('#expWmSize').value = wm.size; $('#expWmOp').value = wm.opacity;
  $('#expWmSizeOut').textContent = wm.size; $('#expWmOpOut').textContent = wm.opacity;
  $('#expWmNote').textContent = brands.length ? '' : 'Primero carga el logo de un restaurante en Imprimir.';
  $('#expWmBox').hidden = !($('#expWm').checked) && brands.length > 0;
  if (!brands.length) $('#expWmBox').hidden = false;
}

function readWatermark() {
  return { on: $('#expWm').checked, brandId: $('#expWmBrand').value || null, pos: $('#expWmPos').value,
    size: Number($('#expWmSize').value), opacity: Number($('#expWmOp').value) };
}

async function doExport() {
  const type = $('#expType').value;
  const quality = Number($('#expQuality').value) / 100;
  toast('Exportando…');
  await ensureFullRaw(); // un RAW se exporta con todo su detalle, no con la media resolución de la vista
  await new Promise((r) => setTimeout(r, 30));
  const { blob, width, height } = await engine.exportBlob(store.get(), { type, quality });
  requestRender();
  if (!blob) { toast('No se pudo exportar', true); return; }
  const wm = readWatermark();
  try { await storage.kvSet('watermark', wm); } catch { /* preferencia opcional */ }
  let out = blob;
  if (wm.on && wm.brandId) {
    try {
      const brand = (await storage.listBrands()).find((b) => b.id === wm.brandId);
      const rec = brand && brand.logoId ? await storage.getAsset(brand.logoId) : null;
      if (!rec) throw new Error('sin logo');
      const logoAsset = await loadImageAsset(rec.blob);
      const [px, py] = LOGO_POSITIONS[wm.pos] || LOGO_POSITIONS['bottom-right'];
      out = (await watermarkBlob(blob, logoAsset, { x: px, y: py, widthPct: wm.size, opacity: wm.opacity / 100, plate: false, plateColor: '#ffffff' }, { type, quality })) || blob;
    } catch (err) { console.error(err); toast('No se pudo poner el logo; se guarda sin marca', true); }
  }
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const filename = `${ui.fileName}-editada.${ext}`;
  const file = new File([out], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: filename }); toast(`Compartido (${width}×${height})`); return; } catch { /* cancelado: descargar */ }
  }
  download(out, filename);
  toast(`Guardado ${filename} (${width}×${height})`);
}

// ---------- eventos ----------
function wire() {
  const fileInput = $('#file');
  $('#btnOpen').addEventListener('click', () => fileInput.click());
  $('#btnOpen2').addEventListener('click', () => fileInput.click());
  $('#btnSample').addEventListener('click', sampleImage);
  fileInput.addEventListener('change', () => { openFiles(fileInput.files); fileInput.value = ''; });

  $('#fileLook').addEventListener('change', async (ev) => {
    const files = [...ev.target.files]; ev.target.value = '';
    if (files.length) await importLooks(files);
  });
  $('#filePresets').addEventListener('change', async (ev) => {
    const files = [...ev.target.files]; ev.target.value = '';
    if (files.length) await importPresetFiles(files);
  });

  $('#btnUndo').addEventListener('click', () => store.undo());
  $('#btnRedo').addEventListener('click', () => store.redo());
  $('#btnReset').addEventListener('click', () => { if (confirm('¿Restablecer todos los ajustes de esta foto? Podrás deshacerlo.')) store.reset(); });
  $('#btnExport').addEventListener('click', () => (ui.mode === 'print' ? printUI.exportPdf() : openExportDialog()));
  $('#modeSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#expType').addEventListener('change', () => { $('#expQualityRow').hidden = $('#expType').value === 'image/png'; });
  $('#expWm').addEventListener('change', () => { $('#expWmBox').hidden = !$('#expWm').checked; });
  $('#expWmSize').addEventListener('input', () => { $('#expWmSizeOut').textContent = $('#expWmSize').value; });
  $('#expWmOp').addEventListener('input', () => { $('#expWmOpOut').textContent = $('#expWmOp').value; });
  $('#expQuality').addEventListener('input', () => { $('#expQualityOut').textContent = $('#expQuality').value; });
  $('#exportDlg').addEventListener('close', () => { if ($('#exportDlg').returnValue === 'go') doExport(); });

  const cmp = $('#btnCompare');
  const setCompare = (on) => { if (!engine.hasSource() || ui.compare === on) return; ui.compare = on; updateOverlayMode(); requestRender(); };
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); setCompare(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => setCompare(false));

  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && ((t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'search' || t.type === 'number')) || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); }
    else if (e.key === 'Escape' && (ui.pick || ui.spotTool)) { ui.pick = null; ui.spotTool = false; updateOverlayMode(); overlay.draw(); if (ui.tab === 'retouch') buildRetouchTab(); }
    else if (e.key === '\\') setCompare(true);
    else if (!mod && (e.key === '+' || e.key === '=') && engine.hasSource() && ui.mode === 'edit') setZoom(ui.zoom.z * 1.6);
    else if (!mod && (e.key === '-' || e.key === '_') && engine.hasSource() && ui.mode === 'edit') setZoom(ui.zoom.z / 1.6);
    else if (!mod && e.key === '0' && engine.hasSource() && ui.mode === 'edit') { resetZoom(); requestRender(); }
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'a' && t.tagName !== 'INPUT') toggleApprove();
    else if (!mod && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && t.tagName !== 'INPUT' && ui.photoId) { const id = neighbor(lib.items, ui.photoId, e.key === 'ArrowRight' ? 1 : -1); if (id && id !== ui.photoId) selectPhoto(id); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === '\\') setCompare(false); });
  wireZoom();

  window.addEventListener('resize', requestRender);
  new ResizeObserver(() => { requestRender(); if (ui.mode === 'print') printUI.schedulePreview(); }).observe($('#viewport'));

  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dragover'); openFiles(e.dataTransfer.files); });
  window.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/')); if (f.length) openFiles(f); });
}

// ---------- arranque ----------
async function init() {
  buildAdjustTab(); buildCurvesTab(); buildGeometryTab(); buildMasksTab(); buildPresetsTab();
  createFilmstrip($('#filmstrip'), lib, { onSelect: (id) => selectPhoto(id), onAction: filmstripAction, hasClipboard: () => !!ui.clip });
  printUI = createPrintUI({ lib, loadWork, flush: saveCurrent, getCurrentId: () => ui.photoId, toast, sliderRow, download });
  printUI.setCropAllHandler(async (ids, aspectFor) => {
    // cada foto conserva su centro; el recorte pasa a la proporción de SU ventana (según su orientación)
    const n = await batchUpdate(ids, (e, rec) => cropForAspect(e, aspectFor(visibleAspect(e, rec.width, rec.height)), rec.width, rec.height));
    toast(n ? `Recorte ajustado al marco en ${n} foto${n === 1 ? '' : 's'}` : 'Ya estaban recortadas a la forma del marco');
  });
  wire(); updateButtons();
  try { ui.userPresets = await storage.listPresets(); buildPresetsTab(); } catch { /* sin presets propios */ }
  try { ui.looks = await storage.listAssets('look'); refreshLookSection(); } catch { /* sin looks guardados */ }
  try {
    await lib.load();
    await printUI.init();
    if (lib.items.length) {
      const last = await storage.kvGet('lastPhoto');
      await selectPhoto(lib.get(last) ? last : lib.items[0].id);
    }
  } catch (err) { console.error(err); }
  updateButtons();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !location.search.includes('nosw')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { engine, store, ui, lib, sampleImage, openFile, openFiles, selectPhoto, requestRender, renderNow, setMode, printUI, batchUpdate, saveCurrent };
  window.__appReady = true;
}
init();
