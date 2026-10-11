// Modo "Imprimir": restaurantes, hoja, marco, logo, texto, vista previa y exportación.

import { el, $ } from './ui-kit.js';
import { getPath, setPath } from './model.js';
import {
  PAPERS, DPI_OPTIONS, FRAME_KINDS, LOGO_POSITIONS, logoRect, windowAspect, effectiveOrientation, pageMm,
} from './layout.js';
import {
  defaultPrintSpec, migrateBrand, newBrand, captionText, FONTS, expandCopies, pagesNeeded, migratePrintSpec,
} from './printspec.js';
import {
  composePage, cellWindowSizes, loadImageAsset, detectWindow, canvasToJpegBytes,
} from './compose.js';
import { buildPdf } from './pdf.js';
import { makeSrgbProfile, embedIccInJpeg, readIccHeader } from './icc.js';
import { INTENTS, convertCanvas, softProofCanvas, profileInfo } from './colorman.js';
import { buildZip } from './zip.js';
import { selectJobIds, cropWarnings, effectivePpi, visibleAspect } from './workflow.js';
import * as storage from './storage.js';

const GRIDS = [
  { id: '1x1', label: '1 por hoja', cols: 1, rows: 1 },
  { id: '2x1', label: '2 por hoja (lado a lado)', cols: 2, rows: 1 },
  { id: '1x2', label: '2 por hoja (una sobre otra)', cols: 1, rows: 2 },
  { id: '2x2', label: '4 por hoja (2 × 2)', cols: 2, rows: 2 },
  { id: '3x2', label: '6 por hoja (3 × 2)', cols: 3, rows: 2 },
  { id: '2x3', label: '6 por hoja (2 × 3)', cols: 2, rows: 3 },
];
const POSITIONS = [
  ['top-left', '↖'], ['top-center', '↑'], ['top-right', '↗'],
  ['center', '●'],
  ['bottom-left', '↙'], ['bottom-center', '↓'], ['bottom-right', '↘'],
];

// ctx: { lib, loadWork(rec, edits, { full }) -> Engine con esa foto cargada, flush(), getCurrentId(), toast, sliderRow, download }
export function createPrintUI(ctx) {
  const { lib, toast, sliderRow, download } = ctx;
  const S = {
    brands: [], brand: null, frames: [], assets: { logo: null, frame: null }, icc: null, proof: false, gamut: false, srgbIcc: makeSrgbProfile(),
    jobMode: 'approved', open: { restaurante: true, hoja: true, marco: true },
    previewToken: 0, previewTimer: 0, saveTimer: 0, last: null, busy: false,
  };
  const root = $('#printBody');
  const canvas = $('#printCanvas');
  const info = $('#printInfo');
  let drag = null;

  const spec = () => S.brand.spec;

  // ------------------------------------------------------------------ datos
  async function init() {
    S.brands = (await storage.listBrands()).map(migrateBrand);
    if (!S.brands.length) { const b = newBrand('Mi restaurante'); await storage.putBrand(b); S.brands = [b]; }
    const last = await storage.kvGet('brandId');
    S.brand = S.brands.find((b) => b.id === last) || S.brands[0];
    S.frames = await storage.listAssets('frame');
    await loadAssets();
    build();
  }

  async function loadAssets() {
    S.assets.logo = null; S.assets.frame = null; S.icc = null;
    if (S.brand.logoId) {
      const rec = await storage.getAsset(S.brand.logoId);
      if (rec) { try { S.assets.logo = { ...(await loadImageAsset(rec.blob)), id: rec.id, blob: rec.blob }; } catch { /* logo ilegible */ } }
    }
    const pid = spec().color.profileId;
    if (pid) {
      const rec = await storage.getAsset(pid);
      if (rec) {
        try { const bytes = new Uint8Array(await rec.blob.arrayBuffer()); const h = readIccHeader(bytes); if (h) S.icc = { id: rec.id, name: rec.name, bytes, space: h.space, description: h.description }; } catch { /* perfil ilegible */ }
      }
    }
    const fid = spec().frame.customId;
    if (fid) {
      const rec = S.frames.find((f) => f.id === fid) || await storage.getAsset(fid);
      if (rec) {
        try {
          const a = await loadImageAsset(rec.blob);
          S.assets.frame = { ...a, id: rec.id, window: rec.window || detectWindow(a) };
        } catch { /* marco ilegible */ }
      }
    }
  }

  function saveBrand() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => storage.putBrand(S.brand), 300);
  }

  // un cambio en la especificación: guardar y redibujar (y reconstruir el panel si cambia su estructura)
  // Se sanea EN EL SITIO: los controles ya construidos guardan referencias a los objetos anidados
  // (spec.frame, spec.logo...) y deben seguir apuntando a los vigentes.
  function deepAssign(target, src) {
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && target[k] && typeof target[k] === 'object') deepAssign(target[k], src[k]);
      else target[k] = src[k];
    }
  }
  function changed(rebuild = false) {
    deepAssign(S.brand.spec, migratePrintSpec(S.brand.spec));
    saveBrand();
    if (rebuild) build();
    schedulePreview();
  }

  // ------------------------------------------------------------------ fotos del pedido
  function jobIds() {
    const ids = selectJobIds(lib.items, S.jobMode, lib.selected);
    return ids;
  }

  function currentFrameAsset() { return spec().frame.kind === 'custom' ? S.assets.frame : null; }

  // proporción de la ventana de la foto con la configuración actual
  const windowAspectFor = (photoAspect) => windowAspect(spec(), currentFrameAsset(), photoAspect || 1.5);
  function getWindowAspect() { return windowAspectFor(1.5); }

  // ------------------------------------------------------------------ render de fotos
  // En la exportación final (≥ 200 ppp) los RAW se revelan a tamaño completo; en la vista previa basta media resolución.
  const loadInto = (rec, dpi) => ctx.loadWork(rec, rec.edits, { full: dpi >= 200 });

  function renderCover(we, edits, ww, wh) {
    const g = we.geometryInfo(edits, false);
    const aspect = g.cw / g.ch; const boxA = ww / wh;
    const w = aspect >= boxA ? wh * aspect : ww; const h = aspect >= boxA ? wh : ww / aspect;
    we.render(edits, { maxW: Math.ceil(w), maxH: Math.ceil(h), upscale: true });
    const c = document.createElement('canvas'); c.width = we.canvas.width; c.height = we.canvas.height;
    c.getContext('2d').drawImage(we.canvas, 0, 0);
    return c;
  }

  // Compone UNA hoja con las fotos dadas (ids). Devuelve { canvas, geometry, cells }.
  async function buildPage(ids, dpi) {
    const recs = [];
    for (const id of ids) { const r = await storage.getPhoto(id); if (r) recs.push(r); }
    const sp = spec();
    const aspect = recs.length ? visibleAspect(recs[0].edits, recs[0].width, recs[0].height) : 1.5;
    const assets = { logo: S.assets.logo, frame: S.assets.frame };
    const { windows } = cellWindowSizes(sp, assets, aspect, dpi);
    const items = [];
    for (let i = 0; i < recs.length && i < windows.length; i++) {
      const rec = recs[i];
      const we = await loadInto(rec, dpi);
      const canvasPhoto = renderCover(we, rec.edits, windows[i].w, windows[i].h);
      items.push({
        aspect: canvasPhoto.width / canvasPhoto.height,
        caption: captionText(sp.caption.text, { nombre: S.brand.name, fecha: new Date().toLocaleDateString('es'), foto: rec.name }),
        render: () => canvasPhoto,
      });
    }
    return composePage(sp, items, assets, { dpi, guides: false });
  }

  // ------------------------------------------------------------------ vista previa
  function schedulePreview() {
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(renderPreview, 60);
  }

  async function renderPreview() {
    const token = ++S.previewToken;
    if (!canvas || canvas.closest('[hidden]')) return;
    await ctx.flush();
    let ids = jobIds();
    let usingCurrent = false;
    if (!ids.length) { const cur = ctx.getCurrentId(); if (cur) { ids = [cur]; usingCurrent = true; } }
    if (!ids.length) { info.textContent = 'Abre o aprueba alguna foto para ver la vista previa.'; const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height); return; }
    const sp = spec();
    const perPage = sp.cols * sp.rows;
    const pageIds = expandCopies(ids, sp.copies).slice(0, perPage);
    const viewport = $('#viewport');
    const maxSide = Math.max(300, Math.min(1400, Math.max(viewport.clientWidth, viewport.clientHeight) * (window.devicePixelRatio || 1)));
    const aspect = 1.5;
    const probe = pageMm(sp.paper, effectiveOrientation(sp, currentFrameAsset()), sp.custom, aspect);
    const dpi = Math.max(40, Math.min(sp.dpi, Math.round(maxSide / (Math.max(probe.w, probe.h) / 25.4))));
    let result;
    try { result = await buildPage(pageIds, dpi); } catch (err) { console.error(err); info.textContent = 'No se pudo generar la vista previa.'; return; }
    if (token !== S.previewToken) return; // llegó una petición más nueva
    canvas.width = result.canvas.width; canvas.height = result.canvas.height;
    canvas.getContext('2d').drawImage(result.canvas, 0, 0);
    if (S.proof && S.icc) { // simulación en pantalla de cómo se vería impreso con el perfil de la imprenta
      try { const k = sp.color; await softProofCanvas(canvas, S.icc.bytes, { intent: k.intent, bpc: k.bpc, gamutCheck: S.gamut }); } catch (err) { console.error(err); }
    }
    // ajustar al espacio disponible
    const cs = getComputedStyle(viewport);
    const aw = viewport.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 30; // 30 px para la línea de información
    const k = Math.min(aw / canvas.width, ah / canvas.height);
    canvas.style.width = `${Math.floor(canvas.width * k)}px`; canvas.style.height = `${Math.floor(canvas.height * k)}px`;
    S.last = { cells: result.cells, geometry: result.geometry, w: canvas.width, h: canvas.height };
    const mm = result.geometry.mm;
    info.textContent = `${PAPERS.find((p) => p.id === sp.paper)?.label.split(' (')[0] || ''} · ${mm.w.toFixed(0)} × ${mm.h.toFixed(0)} mm · ${sp.dpi} ppp`
      + (sp.bleedMm > 0 ? ` · sangrado ${sp.bleedMm} mm` : '') + (S.proof && S.icc ? ' · simulando el perfil de la imprenta' : '') + (usingCurrent ? ' · vista previa de la foto actual' : '');
    updateSummary();
  }

  // ------------------------------------------------------------------ mover el logo con el dedo o el ratón
  function logoHit(px, py) {
    if (!S.last || !S.assets.logo || !spec().logo.enabled) return null;
    for (let i = 0; i < S.last.cells.length; i++) {
      const c = S.last.cells[i];
      const r0 = logoRect(spec().logo, S.assets.logo.w / S.assets.logo.h, { w: c.w, h: c.h });
      const r = { x: c.x + r0.x, y: c.y + r0.y, w: r0.w, h: r0.h };
      const pad = 12;
      if (px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad) return { cell: c };
    }
    return null;
  }
  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  }
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    const p = canvasPoint(e); const hit = logoHit(p.x, p.y);
    if (!hit) return;
    drag = { cell: hit.cell };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* algunos navegadores lo rechazan */ }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = canvasPoint(e);
    if (!drag) { canvas.style.cursor = logoHit(p.x, p.y) ? 'grab' : 'default'; return; }
    const c = drag.cell;
    let x = (p.x - c.x) / c.w; let y = (p.y - c.y) / c.h;
    if (Math.abs(x - 0.5) < 0.02) x = 0.5; // imán al centro
    spec().logo.x = Math.min(1, Math.max(0, x)); spec().logo.y = Math.min(1, Math.max(0, y));
    schedulePreview();
  });
  const endDrag = () => { if (drag) { drag = null; changed(true); } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------------ panel
  function section(id, title, ...kids) {
    const d = el('details', { 'data-sec': id }, el('summary', {}, title), ...kids);
    d.open = S.open[id] !== false;
    d.addEventListener('toggle', () => { S.open[id] = d.open; });
    return d;
  }

  const field = (label, control) => el('label', { class: 'pfield' }, el('span', {}, label), control);

  function select(path, options, onChange) {
    const sel = el('select', { class: 'field' }, options.map(([v, l]) => el('option', { value: String(v) }, l)));
    sel.value = String(getPath(spec(), path));
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const cur = getPath(spec(), path);
      setPath(spec(), path, typeof cur === 'number' ? Number(raw) : raw);
      if (onChange) onChange(); else changed();
    });
    return sel;
  }
  function color(path) {
    const inp = el('input', { type: 'color', class: 'colorpick', value: getPath(spec(), path) });
    inp.addEventListener('input', () => { setPath(spec(), path, inp.value); schedulePreview(); });
    inp.addEventListener('change', () => changed());
    return inp;
  }
  function check(path, label, rebuild = false) {
    const cb = el('input', { type: 'checkbox' }); cb.checked = !!getPath(spec(), path);
    cb.addEventListener('change', () => { setPath(spec(), path, cb.checked); changed(rebuild); });
    return el('label', { class: 'check' }, cb, label);
  }
  function specSlider(label, path, min, max, step, unit, neutral = min) {
    return sliderRow({
      label, min, max, step, unit, neutral,
      get: () => getPath(spec(), path),
      set: (v) => { setPath(spec(), path, v); schedulePreview(); },
      commit: () => changed(),
    }).row;
  }
  function text(path, placeholder, rebuild = false) {
    const inp = el('input', { type: 'text', class: 'field', placeholder, maxlength: 200, value: getPath(spec(), path) || '' });
    inp.addEventListener('input', () => { setPath(spec(), path, inp.value); schedulePreview(); });
    inp.addEventListener('change', () => changed(rebuild));
    return inp;
  }

  function fileButton(label, accept, onFile, extra = {}) {
    const input = el('input', { type: 'file', accept, hidden: true, ...extra });
    input.addEventListener('change', async () => { const f = input.files[0]; input.value = ''; if (f) await onFile(f); });
    const btn = el('button', { class: 'btn small', type: 'button', onClick: () => input.click() }, label);
    return el('span', {}, btn, input);
  }

  // ---- Restaurante
  async function newBrandAction(copy) {
    const base = copy ? { ...S.brand, spec: JSON.parse(JSON.stringify(S.brand.spec)), logoId: S.brand.logoId } : null;
    const b = newBrand(copy ? `${S.brand.name} (copia)` : `Restaurante ${S.brands.length + 1}`);
    if (base) { b.spec = base.spec; b.logoId = base.logoId; }
    await storage.putBrand(b); S.brands.push(b); await selectBrand(b.id);
  }
  async function selectBrand(id) {
    S.brand = S.brands.find((b) => b.id === id) || S.brand;
    await storage.kvSet('brandId', S.brand.id);
    await loadAssets(); build(); schedulePreview();
  }
  async function deleteBrand() {
    if (S.brands.length <= 1) { toast('Debe quedar al menos un restaurante', true); return; }
    if (!confirm(`¿Eliminar el restaurante "${S.brand.name}" y su configuración?`)) return;
    const id = S.brand.id;
    await storage.deleteBrand(id); S.brands = S.brands.filter((b) => b.id !== id);
    await selectBrand(S.brands[0].id);
  }
  async function setLogo(file) {
    if (!/^image\//.test(file.type) && !/\.(svg|png|jpe?g|webp)$/i.test(file.name)) { toast('El logo debe ser una imagen (PNG, SVG, JPG…)', true); return; }
    try {
      const rec = { id: storage.newId('logo'), kind: 'logo', name: file.name, blob: file, createdAt: Date.now() };
      await loadImageAsset(file); // comprueba que se puede leer
      await storage.putAsset(rec);
      S.brand.logoId = rec.id; await storage.putBrand(S.brand);
      await loadAssets(); build(); schedulePreview(); toast('Logo cargado');
    } catch { toast('No se pudo leer ese logo', true); }
  }

  function brandSection() {
    const sel = el('select', { class: 'field', id: 'brandSelect', 'aria-label': 'Restaurante' }, S.brands.map((b) => el('option', { value: b.id }, b.name)));
    sel.value = S.brand.id;
    sel.addEventListener('change', () => selectBrand(sel.value));
    const name = el('input', { type: 'text', class: 'field', id: 'brandName', value: S.brand.name, maxlength: 60, placeholder: 'Nombre del restaurante' });
    name.addEventListener('change', () => { S.brand.name = name.value.trim() || 'Restaurante'; saveBrand(); build(); schedulePreview(); });
    const logoBox = el('div', { class: 'logobox' });
    if (S.assets.logo) {
      const url = URL.createObjectURL(S.assets.logo.blob);
      logoBox.append(el('img', { src: url, alt: 'Logo', class: 'logoimg', onLoad: () => setTimeout(() => URL.revokeObjectURL(url), 2000) }));
    } else logoBox.append(el('span', { class: 'hint' }, 'Sin logo'));
    return section('restaurante', 'Restaurante y logo',
      sel, el('div', { style: 'margin-top:8px' }, name),
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', { class: 'btn small', type: 'button', id: 'btnNewBrand', onClick: () => newBrandAction(false) }, 'Nuevo'),
        el('button', { class: 'btn small', type: 'button', onClick: () => newBrandAction(true) }, 'Duplicar'),
        el('button', { class: 'btn small danger', type: 'button', onClick: deleteBrand }, 'Eliminar')),
      el('div', { class: 'sub' }, 'Logo'),
      el('div', { class: 'row' }, logoBox, fileButton('Cargar logo…', 'image/*,.svg', setLogo, { id: 'fileLogo' }),
        S.assets.logo ? el('button', { class: 'btn small', type: 'button', onClick: async () => { S.brand.logoId = null; await storage.putBrand(S.brand); await loadAssets(); build(); schedulePreview(); } }, 'Quitar') : null),
      el('p', { class: 'hint' }, 'La configuración de este restaurante (papel, marco, logo, texto) se guarda sola.'));
  }

  // ---- Hoja
  function sheetSection() {
    const sp = spec();
    const gridId = `${sp.cols}x${sp.rows}`;
    const gridSel = el('select', { class: 'field', id: 'gridSelect' }, GRIDS.map((g) => el('option', { value: g.id }, g.label)));
    gridSel.value = GRIDS.some((g) => g.id === gridId) ? gridId : '1x1';
    gridSel.addEventListener('change', () => { const g = GRIDS.find((x) => x.id === gridSel.value); sp.cols = g.cols; sp.rows = g.rows; changed(true); });
    const custom = sp.paper === 'custom' ? el('div', { class: 'row' },
      field('Ancho (mm)', el('input', { type: 'number', class: 'field', min: 20, max: 1000, value: sp.custom.w, onChange: (e) => { sp.custom.w = Number(e.target.value); changed(); } })),
      field('Alto (mm)', el('input', { type: 'number', class: 'field', min: 20, max: 1000, value: sp.custom.h, onChange: (e) => { sp.custom.h = Number(e.target.value); changed(); } }))) : null;
    return section('hoja', 'Papel y hoja',
      field('Papel', select('paper', PAPERS.map((p) => [p.id, p.label]), () => changed(true))), custom,
      field('Orientación', select('orientation', [['auto', 'Automática (según la foto)'], ['portrait', 'Vertical'], ['landscape', 'Horizontal']])),
      field('Calidad', select('dpi', DPI_OPTIONS.map((d) => [d, `${d} ppp${d === 300 ? ' (recomendado)' : ''}`]))),
      field('Fotos por hoja', gridSel),
      sp.cols * sp.rows > 1 ? specSlider('Separación', 'gutterMm', 0, 20, 0.5, 'mm') : null,
      field('Copias de cada foto', el('input', { type: 'number', class: 'field', id: 'copies', min: 1, max: 99, value: sp.copies, onChange: (e) => { sp.copies = Number(e.target.value); changed(true); } })),
      specSlider('Margen de la hoja', 'marginMm', 0, 30, 0.5, 'mm'),
      field('Fondo de la hoja', color('background')),
      field('Foto en la ventana', select('photoFit', [['cover', 'Llenar (recorta lo que sobre)'], ['contain', 'Entera (deja franjas)']])));
  }


  // ---- Color y corte
  async function setProfile(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!readIccHeader(bytes)) throw new Error('Ese archivo no es un perfil de color ICC (.icc / .icm).');
      const info = await profileInfo(bytes); // lo valida Little CMS
      const rec = { id: storage.newId('icc'), kind: 'icc', name: file.name.replace(/\.[^.]+$/, ''), blob: file, space: info.space, createdAt: Date.now() };
      await storage.putAsset(rec);
      const k = spec().color; k.profileId = rec.id; k.profileName = info.description || rec.name; k.mode = info.space === 'RGB' ? 'profile' : 'srgb';
      await loadAssets(); changed(true);
      toast(info.space === 'RGB' ? 'Perfil cargado: las fotos se convertirán a ese perfil al exportar.' : `Perfil ${info.space} cargado: sirve para simular la impresión; se exporta en sRGB.`, info.space !== 'RGB');
    } catch (err) { toast(err.message || 'No se pudo leer ese perfil', true); }
  }
  async function removeProfile() {
    const k = spec().color;
    if (k.profileId) { try { await storage.deleteAsset(k.profileId); } catch { /* ya no estaba */ } }
    k.profileId = null; k.profileName = ''; k.mode = 'srgb'; S.proof = false; S.gamut = false;
    await loadAssets(); changed(true);
  }
  const profileActive = () => !!(S.icc && S.icc.space === 'RGB' && spec().color.mode === 'profile');

  function colorSection() {
    const sp = spec(); const k = sp.color;
    const proofCb = el('input', { type: 'checkbox', id: 'proofCheck' }); proofCb.checked = S.proof; proofCb.disabled = !S.icc;
    proofCb.addEventListener('change', () => { S.proof = proofCb.checked; if (!S.proof) S.gamut = false; build(); schedulePreview(); });
    const gamutCb = el('input', { type: 'checkbox', id: 'gamutCheck' }); gamutCb.checked = S.gamut; gamutCb.disabled = !S.icc || !S.proof;
    gamutCb.addEventListener('change', () => { S.gamut = gamutCb.checked; schedulePreview(); });
    const profileBox = S.icc
      ? el('div', { class: 'row' }, el('span', { class: 'hint', id: 'iccName' }, `${S.icc.description || S.icc.name} (${S.icc.space})`), el('button', { class: 'btn small', type: 'button', onClick: removeProfile }, 'Quitar'))
      : el('span', { class: 'hint' }, 'Sin perfil: se exporta en sRGB.');
    const mode = select('color.mode', [['srgb', 'sRGB (lo normal en laboratorios)'], ['profile', 'Convertir al perfil de la imprenta']], () => changed(true));
    mode.disabled = !(S.icc && S.icc.space === 'RGB');
    return section('color', 'Color y corte',
      field('Color de salida', mode), profileBox,
      fileButton('Cargar perfil .icc…', '.icc,.icm,application/vnd.iccprofile', setProfile, { id: 'fileIcc' }),
      profileActive() ? field('Intención de conversión', select('color.intent', INTENTS.map((i) => [i.id, i.label]))) : null,
      profileActive() ? check('color.bpc', 'Compensación del punto negro') : null,
      el('label', { class: 'check' }, proofCb, 'Simular la impresión en pantalla'),
      S.proof ? el('label', { class: 'check' }, gamutCb, 'Marcar los colores que el papel no alcanza') : null,
      el('p', { class: 'hint' }, 'El perfil lo da tu imprenta (o el fabricante del papel). Si no tienes uno, deja sRGB: el archivo lleva un perfil sRGB incrustado.'),
      el('div', { class: 'sub' }, 'Sangrado y marcas'),
      specSlider('Sangrado', 'bleedMm', 0, 10, 0.5, 'mm'),
      check('marks', 'Marcas de corte', true),
      el('p', { class: 'hint' }, 'El sangrado extiende el fondo (y las fotos, si el margen es 0) por fuera del corte, para que no queden bordes blancos si el corte se corre. Pregunta a tu imprenta cuánto necesita (suele ser 3 mm).'));
  }

  // ---- Marco
  async function addFrame(file) {
    if (!/^image\//.test(file.type)) { toast('El marco debe ser una imagen PNG con la ventana transparente', true); return; }
    try {
      const asset = await loadImageAsset(file);
      const win = detectWindow(asset);
      const rec = { id: storage.newId('frame'), kind: 'frame', name: file.name.replace(/\.[^.]+$/, ''), blob: file, window: win, createdAt: Date.now() };
      await storage.putAsset(rec); S.frames.push(rec);
      spec().frame.kind = 'custom'; spec().frame.customId = rec.id;
      await loadAssets(); changed(true);
      toast(win ? 'Marco cargado. Se detectó la ventana de la foto.' : 'Marco cargado, pero no se encontró una ventana transparente. Ajústala a mano.', !win);
    } catch { toast('No se pudo leer ese marco', true); }
  }
  async function removeFrame(id) {
    if (!confirm('¿Quitar este marco de la lista?')) return;
    await storage.deleteAsset(id); S.frames = S.frames.filter((f) => f.id !== id);
    for (const b of S.brands) if (b.spec.frame.customId === id) { b.spec.frame.customId = null; if (b.spec.frame.kind === 'custom') b.spec.frame.kind = 'border'; await storage.putBrand(b); }
    await loadAssets(); build(); schedulePreview();
  }

  function frameSection() {
    const f = spec().frame;
    const kindSel = el('select', { class: 'field', id: 'frameKind' }, FRAME_KINDS.map((k) => el('option', { value: k.id }, k.label)));
    kindSel.value = f.kind;
    kindSel.addEventListener('change', () => {
      f.kind = kindSel.value;
      if (f.kind === 'custom' && !f.customId && S.frames[0]) f.customId = S.frames[0].id;
      loadAssets().then(() => changed(true));
    });
    const list = el('div', { class: 'list', id: 'frameList' }, S.frames.map((fr) => {
      const b = el('button', { class: 'pitem' + (f.kind === 'custom' && f.customId === fr.id ? ' on' : ''), type: 'button' }, el('span', {}, fr.name));
      b.addEventListener('click', async () => { f.kind = 'custom'; f.customId = fr.id; await loadAssets(); changed(true); });
      const x = el('span', { class: 'x', role: 'button', title: 'Quitar marco' }, '✕');
      x.addEventListener('click', (ev) => { ev.stopPropagation(); removeFrame(fr.id); });
      b.append(x); return b;
    }));
    const builtin = ['border', 'double', 'polaroid', 'rounded', 'mat'].includes(f.kind);
    const custom = f.kind === 'custom';
    const win = S.assets.frame && S.assets.frame.window;
    return section('marco', 'Marco',
      kindSel,
      builtin ? specSlider('Grosor', 'frame.widthMm', 0, 40, 0.5, 'mm') : null,
      builtin ? field('Color del marco', color('frame.color')) : null,
      (f.kind === 'double' || f.kind === 'mat') ? field('Color de las líneas', color('frame.innerColor')) : null,
      f.kind === 'rounded' ? specSlider('Radio de las esquinas', 'frame.radiusMm', 0, 30, 0.5, 'mm') : null,
      custom ? field('Cómo se ajusta el marco', select('frame.fit', [['contain', 'Entero (conserva su forma)'], ['cover', 'Llenar la hoja'], ['stretch', 'Estirar a la hoja']])) : null,
      custom && !win ? el('p', { class: 'hint warn' }, 'No se encontró la ventana transparente de este marco. Usa un PNG con la zona de la foto transparente.') : null,
      custom && win ? el('p', { class: 'hint' }, `Ventana detectada: ${(win.w * 100).toFixed(0)} % × ${(win.h * 100).toFixed(0)} % del marco.`) : null,
      el('div', { class: 'sub' }, 'Mis marcos (PNG con ventana transparente)'),
      S.frames.length ? list : el('p', { class: 'hint' }, 'Aún no has cargado marcos.'),
      fileButton('Cargar marco…', 'image/png,image/*', addFrame, { id: 'fileFrame' }));
  }

  // ---- Logo
  function logoSection() {
    const L = spec().logo;
    const posRow = el('div', { class: 'posgrid' }, POSITIONS.map(([k, sym]) => {
      const b = el('button', { class: 'btn small', type: 'button', title: k.replace('-', ' '), 'data-pos': k, onClick: () => { L.x = LOGO_POSITIONS[k][0]; L.y = LOGO_POSITIONS[k][1]; changed(); } }, sym);
      return b;
    }));
    return section('logo', 'Posición del logo',
      check('logo.enabled', 'Mostrar el logo', true),
      L.enabled ? el('div', {},
        !S.assets.logo ? el('p', { class: 'hint warn' }, 'Carga el logo del restaurante arriba.') : null,
        el('p', { class: 'hint' }, 'Arrastra el logo sobre la vista previa, o elige una posición:'), posRow,
        specSlider('Tamaño', 'logo.widthPct', 4, 60, 1, '%'),
        specSlider('Opacidad', 'logo.opacity', 0.1, 1, 0.05, '', 1),
        check('logo.plate', 'Fondo detrás del logo (para que se lea)', true),
        L.plate ? field('Color del fondo', color('logo.plateColor')) : null) : null);
  }

  // ---- Texto
  function textSection() {
    const C = spec().caption;
    return section('texto', 'Texto en la hoja',
      check('caption.enabled', 'Añadir texto', true),
      C.enabled ? el('div', {},
        field('Texto', text('caption.text', 'Ej.: {nombre} · {fecha}', false)),
        el('p', { class: 'hint' }, 'Variables: {nombre} (restaurante), {fecha}, {foto} (nombre de la foto).'),
        field('Letra', select('caption.font', FONTS.map((f) => [f.id, f.label]))),
        specSlider('Tamaño', 'caption.sizePt', 6, 48, 1, 'pt'),
        specSlider('Altura en la hoja', 'caption.y', 0, 1, 0.005, ''),
        field('Color', color('caption.color')),
        el('div', { class: 'row' }, check('caption.bold', 'Negrita'), check('caption.italic', 'Cursiva'))) : null);
  }

  // ---- Pedido
  function jobSection() {
    const radio = (mode, label) => {
      const r = el('input', { type: 'radio', name: 'jobmode', value: mode }); r.checked = S.jobMode === mode;
      r.addEventListener('change', () => { S.jobMode = mode; updateSummary(); schedulePreview(); });
      return el('label', { class: 'check', 'data-job': mode }, r, label);
    };
    return section('pedido', 'Fotos a imprimir',
      radio('approved', 'Solo las aprobadas'), radio('all', 'Todas las de la biblioteca'), radio('selected', 'Solo las marcadas'),
      el('div', { id: 'jobSummary', class: 'card' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', type: 'button', id: 'btnCropAll', onClick: cropAll }, 'Recortar todas al marco')),
      el('p', { class: 'hint' }, 'Ajusta de una vez el recorte de todas las fotos del pedido a la forma de la ventana del marco.'));
  }

  function actionsSection() {
    return section('acciones', 'Exportar e imprimir',
      el('div', { class: 'stack' },
        el('button', { class: 'btn primary', type: 'button', id: 'btnPdf', onClick: exportPdf }, 'Descargar PDF'),
        el('button', { class: 'btn', type: 'button', id: 'btnJpegs', onClick: exportJpegs }, 'Descargar JPEG (uno por hoja)'),
        el('button', { class: 'btn', type: 'button', id: 'btnPrint', onClick: printNow }, 'Imprimir…')),
      el('div', { id: 'printProgress', class: 'hint' }),
      el('p', { class: 'hint' }, 'El PDF sale al tamaño exacto del papel y es lo más fiable para mandar a una imprenta. "Imprimir…" abre el diálogo del navegador.'));
  }

  function build() {
    if (!S.brand) return;
    root.replaceChildren(brandSection(), sheetSection(), frameSection(), logoSection(), textSection(), colorSection(), jobSection(), actionsSection());
    updateSummary();
  }

  // ------------------------------------------------------------------ resumen y avisos
  function updateSummary() {
    const box = $('#jobSummary');
    if (!box || !S.brand) return;
    const sp = spec(); const ids = jobIds();
    const pages = pagesNeeded(ids.length, sp);
    const parts = [el('div', {}, ids.length ? `${ids.length} foto${ids.length === 1 ? '' : 's'} × ${sp.copies} copia${sp.copies === 1 ? '' : 's'} → ${pages} hoja${pages === 1 ? '' : 's'}` : 'No hay fotos en este pedido todavía. Aprueba alguna en el modo Editar.')];
    const photos = ids.map((id) => lib.get(id)).filter(Boolean);
    const warn = cropWarnings(photos, (p) => windowAspectFor(p.aspect), 0.08);
    if (warn.length) parts.push(el('div', { class: 'hint warn' }, `${warn.length} foto${warn.length === 1 ? '' : 's'} se recortará${warn.length === 1 ? '' : 'n'} más de un 8 % para llenar el marco (${warn.slice(0, 3).map((w) => `${w.name} ${(w.loss * 100).toFixed(0)} %`).join(', ')}${warn.length > 3 ? '…' : ''}). Usa "Recortar todas al marco" para elegir tú el encuadre.`));
    box.replaceChildren(...parts);
    lowResCheck(photos).then((low) => {
      if (low.length && $('#jobSummary') === box) box.append(el('div', { class: 'hint warn' }, `Resolución baja para este tamaño: ${low.slice(0, 3).map((l) => `${l.name} ${l.ppi} ppp`).join(', ')}${low.length > 3 ? '…' : ''}. Se verá menos nítida.`));
    });
  }

  async function lowResCheck(photos) {
    const sp = spec(); const out = [];
    if (!photos.length) return out;
    const a = S.assets;
    for (const p of photos.slice(0, 60)) {
      const rec = await storage.getPhoto(p.id); if (!rec) continue;
      const { windows } = cellWindowSizes(sp, a, p.aspect, 100);
      const w = windows[0];
      const ppi = effectivePpi(rec, w.w, w.h, 100, sp.photoFit);
      if (ppi < 150) out.push({ name: p.name, ppi });
    }
    return out;
  }

  // ------------------------------------------------------------------ exportar
  let onCropAll = null;
  async function cropAll() { if (onCropAll) { await onCropAll(jobIds(), windowAspectFor); updateSummary(); schedulePreview(); } }

  function progress(msg) { const p = $('#printProgress'); if (p) p.textContent = msg; }

  async function renderJob(label) {
    await ctx.flush();
    const ids = jobIds();
    if (!ids.length) { toast('No hay fotos en el pedido. Aprueba alguna (o elige "Todas").', true); return null; }
    const sp = spec(); const perPage = sp.cols * sp.rows;
    const all = expandCopies(ids, sp.copies);
    const pages = []; for (let i = 0; i < all.length; i += perPage) pages.push(all.slice(i, i + perPage));
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      progress(`${label}: hoja ${i + 1} de ${pages.length}…`);
      await new Promise((r) => setTimeout(r, 15)); // deja respirar a la pantalla
      const { canvas: c, geometry } = await buildPage(pages[i], sp.dpi);
      let icc = S.srgbIcc;
      if (profileActive()) { await convertCanvas(c, S.icc.bytes, { intent: sp.color.intent, bpc: sp.color.bpc }); icc = S.icc.bytes; }
      const jpeg = embedIccInJpeg(await canvasToJpegBytes(c, 0.95), icc); // el perfil va dentro del archivo
      out.push({
        jpeg, imgW: c.width, imgH: c.height, widthMm: geometry.mediaMm.w, heightMm: geometry.mediaMm.h, icc,
        trimMm: geometry.extra ? geometry.trimMm : null, bleedMm: geometry.extra && sp.bleedMm > 0 ? geometry.bleedBoxMm : null,
      });
    }
    progress('');
    return out;
  }

  const fileBase = () => `${S.brand.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'impresion'}`;

  async function exportPdf() {
    if (S.busy) return; S.busy = true;
    try {
      const pages = await renderJob('PDF');
      if (!pages) return;
      const bytes = buildPdf(pages, { title: `${S.brand.name} — impresión`, icc: pages[0].icc });
      download(new Blob([bytes], { type: 'application/pdf' }), `${fileBase()}.pdf`);
      toast(`PDF listo: ${pages.length} hoja${pages.length === 1 ? '' : 's'}`);
    } catch (err) { console.error(err); toast('No se pudo crear el PDF', true); progress(''); } finally { S.busy = false; }
  }

  async function exportJpegs() {
    if (S.busy) return; S.busy = true;
    try {
      const pages = await renderJob('JPEG');
      if (!pages) return;
      if (pages.length === 1) { download(new Blob([pages[0].jpeg], { type: 'image/jpeg' }), `${fileBase()}.jpg`); toast('JPEG listo'); return; }
      const zip = buildZip(pages.map((p, i) => ({ name: `${fileBase()}-${String(i + 1).padStart(2, '0')}.jpg`, data: p.jpeg })));
      download(new Blob([zip], { type: 'application/zip' }), `${fileBase()}.zip`);
      toast(`ZIP listo con ${pages.length} hojas`);
    } catch (err) { console.error(err); toast('No se pudieron crear los JPEG', true); progress(''); } finally { S.busy = false; }
  }

  async function printNow() {
    if (S.busy) return; S.busy = true;
    try {
      const pages = await renderJob('Imprimir');
      if (!pages) return;
      const urls = pages.map((p) => URL.createObjectURL(new Blob([p.jpeg], { type: 'image/jpeg' })));
      const sheet = $('#printSheet'); sheet.replaceChildren();
      const style = el('style', {});
      const sizes = new Map();
      pages.forEach((p, i) => {
        const key = `${p.widthMm.toFixed(1)}x${p.heightMm.toFixed(1)}`;
        if (!sizes.has(key)) sizes.set(key, `pg${sizes.size}`);
        const img = el('img', { src: urls[i], class: `pgimg ${sizes.get(key)}`, alt: `Hoja ${i + 1}` });
        sheet.append(img);
      });
      let css = '@page { margin: 0; }\n';
      for (const [key, cls] of sizes) { const [w, h] = key.split('x'); css += `@page ${cls} { size: ${w}mm ${h}mm; margin: 0; }\n.${cls} { page: ${cls}; width: ${w}mm; height: ${h}mm; }\n`; }
      style.textContent = css; sheet.append(style);
      await Promise.all([...sheet.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
      const cleanup = () => { urls.forEach((u) => URL.revokeObjectURL(u)); sheet.replaceChildren(); window.removeEventListener('afterprint', cleanup); };
      window.addEventListener('afterprint', cleanup);
      document.body.classList.add('printing');
      window.print();
      document.body.classList.remove('printing');
      if (sizes.size > 1) toast('Hay hojas de distinto tamaño: si sale mal, usa el PDF.', true);
    } catch (err) { console.error(err); toast('No se pudo preparar la impresión', true); progress(''); } finally { S.busy = false; }
  }

  return {
    init, build, schedulePreview, getWindowAspect, windowAspectFor, getSpec: () => (S.brand ? spec() : defaultPrintSpec()),
    getFrameAsset: currentFrameAsset, exportPdf, exportJpegs, printNow, updateSummary,
    setCropAllHandler: (fn) => { onCropAll = fn; },
    state: S,
  };
}
