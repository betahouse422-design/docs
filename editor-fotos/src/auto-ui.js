// Modo automático: la cámara deja las fotos en una carpeta; cada una se importa, recibe el preset elegido, se
// coloca en el marco del restaurante y se envía a la salida (carpeta de impresión, impresora o espera de aprobación).
//
// ctx: {
//   lib, toast, printUI,
//   isPhotoName(name), importFile(file, order) -> id de la foto en la biblioteca,
//   collections() -> [{ id, label, load() -> [{ id, name, edits }] }],      (arranque, mis presets, paquetes)
//   processRec(id, { preset, intensity, autoTone, autoWb, cropToFrame, approve }),
//   setRunning(bool)                                                     (bloquea Editar/Imprimir mientras corre)
// }

import { el, $ } from './ui-kit.js';
import * as storage from './storage.js';
import { FolderWatcher, AutoQueue, STATES, folderAccessSupported, outputName } from './autoflow.js';

const DEFAULT_CFG = {
  collection: 'starter', presetId: 'natural', intensity: 100,
  autoTone: true, autoWb: false, cropToFrame: true,
  output: 'folder',          // 'folder' = carpeta de impresión · 'download' = descargar/compartir (teléfono) · 'print' = imprimir directo · 'hold' = solo preparar
  format: 'jpg',             // 'jpg' | 'pdf' | 'both'
  requireApproval: false, includeExisting: false,
};

const baseName = (n) => String(n).replace(/\.[^.]+$/, ''); // sin la extensión
const pick = (v, list, d) => (list.includes(v) ? v : d);
function sanitizeCfg(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    collection: typeof r.collection === 'string' ? r.collection : DEFAULT_CFG.collection,
    presetId: typeof r.presetId === 'string' ? r.presetId : DEFAULT_CFG.presetId,
    intensity: num(r.intensity, 0, 100, 100),
    autoTone: r.autoTone !== false, autoWb: !!r.autoWb, cropToFrame: r.cropToFrame !== false,
    output: pick(r.output, ['folder', 'download', 'print', 'hold'], 'folder'), format: pick(r.format, ['jpg', 'pdf', 'both'], 'jpg'),
    requireApproval: !!r.requireApproval, includeExisting: !!r.includeExisting,
  };
}

// Lista el contenido de una carpeta (FileSystemDirectoryHandle): [{ name, size, mtime, handle }]
async function listDirectory(dir) {
  const out = [];
  for await (const h of dir.values()) {
    if (h.kind !== 'file') continue;
    try { const f = await h.getFile(); out.push({ name: h.name, size: f.size, mtime: f.lastModified, handle: h }); } catch { /* la cámara aún lo está escribiendo */ }
  }
  return out;
}

async function ensurePermission(handle, mode) {
  if (!handle) return false;
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted'; // pide el permiso al hacer clic en "Empezar"
  } catch { return false; }
}

export function createAutoUI(ctx) {
  const { lib, toast, printUI } = ctx;
  const S = {
    cfg: { ...DEFAULT_CFG }, watchDir: null, outDir: null, running: false, watcher: null, timer: 0, pumping: false,
    queue: new AutoQueue(300), collections: [], presets: [], counter: 0, urls: new Map(), startedAt: 0, lastPoll: 0,
  };
  const root = $('#autoBody');
  const wrap = $('#autoWrap');

  // ------------------------------------------------------------------ configuración guardada
  async function init() {
    S.cfg = sanitizeCfg(await storage.kvGet('autoConfig'));
    if (!folderAccessSupported() && S.cfg.output === 'folder') S.cfg.output = 'download'; // teléfono / navegador sin carpetas
    try { S.watchDir = (await storage.kvGet('autoWatchDir')) || null; S.outDir = (await storage.kvGet('autoOutDir')) || null; } catch { /* sin carpetas guardadas */ }
    S.counter = Number(await storage.kvGet('autoCounter')) || 0;
    S.queue.on(renderQueue);
  }
  const saveCfg = () => { storage.kvSet('autoConfig', { ...S.cfg }); };

  async function chooseFolder(kind) {
    if (!folderAccessSupported()) { toast('Este navegador no puede vigilar carpetas. Usa Google Chrome o Microsoft Edge.', true); return; }
    try {
      const h = await window.showDirectoryPicker({ id: kind === 'watch' ? 'camara' : 'salida', mode: kind === 'watch' ? 'read' : 'readwrite' });
      if (kind === 'watch') { S.watchDir = h; await storage.kvSet('autoWatchDir', h); } else { S.outDir = h; await storage.kvSet('autoOutDir', h); }
      build();
    } catch (err) { if (err && err.name !== 'AbortError') toast('No se pudo abrir esa carpeta', true); }
  }

  // ------------------------------------------------------------------ presets
  async function loadCollections() {
    S.collections = ctx.collections();
    const col = S.collections.find((c) => c.id === S.cfg.collection) || S.collections[0];
    if (col) { S.cfg.collection = col.id; try { S.presets = await col.load(); } catch (err) { S.presets = []; toast(err.message, true); } }
    if (!S.presets.some((p) => p.id === S.cfg.presetId)) S.cfg.presetId = S.presets[0] ? S.presets[0].id : '';
  }
  const currentPreset = () => S.presets.find((p) => p.id === S.cfg.presetId) || null;

  // ------------------------------------------------------------------ panel
  const section = (title, ...kids) => el('div', { class: 'asec' }, el('div', { class: 'sub' }, title), ...kids);
  const radio = (name, value, label, checked, onChange, disabled = false) => {
    const r = el('input', { type: 'radio', name, value }); r.checked = checked; r.disabled = disabled;
    r.addEventListener('change', () => { if (r.checked) onChange(value); });
    return el('label', { class: 'check' }, r, label);
  };
  const check = (key, label, rebuild = false) => {
    const c = el('input', { type: 'checkbox' }); c.checked = !!S.cfg[key]; c.disabled = S.running;
    c.addEventListener('change', () => { S.cfg[key] = c.checked; saveCfg(); if (rebuild) build(); });
    return el('label', { class: 'check' }, c, label);
  };

  async function build() {
    await loadCollections();
    const sp = printUI.getSpec(); const brand = printUI.state.brand;
    const supported = folderAccessSupported();
    const colSel = el('select', { class: 'field', id: 'autoCollection', disabled: S.running }, S.collections.map((c) => el('option', { value: c.id, selected: c.id === S.cfg.collection }, c.label)));
    colSel.addEventListener('change', () => { S.cfg.collection = colSel.value; S.cfg.presetId = ''; saveCfg(); build(); });
    const preSel = el('select', { class: 'field', id: 'autoPreset', disabled: S.running }, S.presets.map((p) => el('option', { value: p.id, selected: p.id === S.cfg.presetId }, p.name)));
    preSel.addEventListener('change', () => { S.cfg.presetId = preSel.value; saveCfg(); });
    const brandSel = el('select', { class: 'field', id: 'autoBrand', disabled: S.running }, printUI.state.brands.map((b) => el('option', { value: b.id, selected: brand && b.id === brand.id }, b.name)));
    brandSel.addEventListener('change', async () => { await printUI.selectBrand(brandSel.value); build(); });
    const inten = el('input', { type: 'range', min: 0, max: 100, step: 1, value: S.cfg.intensity, id: 'autoIntensity', disabled: S.running });
    const intenOut = el('output', {}, `${S.cfg.intensity}%`);
    inten.addEventListener('input', () => { S.cfg.intensity = Number(inten.value); intenOut.textContent = `${S.cfg.intensity}%`; });
    inten.addEventListener('change', saveCfg);

    const frameName = sp.frame.kind === 'custom' ? 'marco cargado' : (sp.frame.kind === 'none' ? 'sin marco' : `marco "${sp.frame.kind}"`);
    const summary = `${sp.paper === 'custom' ? 'Papel personalizado' : sp.paper.replace('x', '×') + ' cm'} · ${frameName} · ${sp.logo.enabled ? 'con logo' : 'sin logo'} · ${sp.bleedMm > 0 ? `sangrado ${sp.bleedMm} mm` : 'sin sangrado'}`;

    const outFolder = S.cfg.output === 'folder';
    const parts = [
      !supported ? el('p', { class: 'warn' }, 'Este navegador (o el teléfono) no puede vigilar una carpeta. Aquí usa "Tomar foto y procesar". Para vigilar la carpeta de la cámara, abre la app en Google Chrome o Edge en la computadora.') : null,
      section('1 · Carpeta donde llegan las fotos',
        el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', id: 'btnAutoWatch', disabled: S.running || !supported, onClick: () => chooseFolder('watch') }, S.watchDir ? 'Cambiar carpeta…' : 'Elegir carpeta…'),
          el('span', { class: 'hint', id: 'autoWatchName' }, S.watchDir ? S.watchDir.name : 'Sin carpeta')),
        check('includeExisting', 'Procesar también las fotos que ya estén en la carpeta')),
      section('2 · Restaurante, marco y logo',
        brandSel, el('p', { class: 'hint', id: 'autoSummary' }, summary),
        el('button', { class: 'btn small', type: 'button', id: 'btnAutoToPrint', disabled: S.running, onClick: () => ctx.goToPrint() }, 'Ajustar papel, marco y logo en Imprimir')),
      section('3 · Estilo de las fotos (preset)',
        colSel, preSel,
        el('label', { class: 'pfield' }, el('span', {}, 'Intensidad'), el('div', { class: 'row' }, inten, intenOut)),
        check('autoTone', 'Tono automático antes del preset'), check('autoWb', 'Balance de blancos automático'), check('cropToFrame', 'Encuadrar cada foto a la ventana del marco')),
      section('4 · Qué hacer con cada foto',
        radio('autoOut', 'folder', 'Guardar en una carpeta de impresión', S.cfg.output === 'folder', (v) => { S.cfg.output = v; saveCfg(); build(); }, S.running),
        outFolder ? el('div', { class: 'row indent' },
          el('button', { class: 'btn small', type: 'button', id: 'btnAutoOut', disabled: S.running || !supported, onClick: () => chooseFolder('out') }, S.outDir ? 'Cambiar carpeta…' : 'Elegir carpeta…'),
          el('span', { class: 'hint', id: 'autoOutName' }, S.outDir ? S.outDir.name : 'Sin carpeta')) : null,
        outFolder ? el('label', { class: 'pfield indent' }, el('span', {}, 'Formato'),
          (() => { const s = el('select', { class: 'field', id: 'autoFormat', disabled: S.running }, [['jpg', 'JPEG'], ['pdf', 'PDF'], ['both', 'JPEG y PDF']].map(([v, l]) => el('option', { value: v, selected: v === S.cfg.format }, l))); s.addEventListener('change', () => { S.cfg.format = s.value; saveCfg(); }); return s; })()) : null,
        radio('autoOut', 'download', 'Descargar o compartir (para probar, o en el teléfono)', S.cfg.output === 'download', (v) => { S.cfg.output = v; saveCfg(); build(); }, S.running),
        radio('autoOut', 'print', 'Mandar a imprimir (abre el diálogo de impresión)', S.cfg.output === 'print', (v) => { S.cfg.output = v; saveCfg(); build(); }, S.running),
        radio('autoOut', 'hold', 'Solo preparar (las dejo en la biblioteca)', S.cfg.output === 'hold', (v) => { S.cfg.output = v; saveCfg(); build(); }, S.running),
        check('requireApproval', 'Pedir mi aprobación antes de imprimir o guardar')),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary big', type: 'button', id: 'btnAutoStart', onClick: () => (S.running ? stop() : start()) }, S.running ? 'Detener' : 'Empezar'),
        el('button', { class: 'btn', type: 'button', id: 'btnAutoCapture', disabled: S.running, onClick: () => $('#fileAutoCapture').click(), title: 'Abre la cámara del teléfono (o elige una foto) y la pasa por el flujo' }, '📷 Tomar foto y procesar'),
        el('button', { class: 'btn', type: 'button', id: 'btnAutoTest', disabled: S.running, onClick: () => $('#fileAutoTest').click(), title: 'Procesa una foto de tu computadora con esta misma configuración, sin cámara' }, 'Probar con una foto…')),
      el('p', { class: 'hint' }, 'Al empezar, solo se procesan las fotos nuevas que lleguen a la carpeta. Deja esta pestaña abierta durante el evento.'),
    ];
    root.replaceChildren(...parts.filter(Boolean)); // (replaceChildren escribiría "null" por cada hueco)
    renderQueue();
  }

  // ------------------------------------------------------------------ cola en pantalla
  function statusChip(it) { return el('span', { class: `chip st-${it.status}` }, STATES[it.status].label); }
  function renderQueue() {
    const c = S.queue.counts();
    const items = [...S.queue.items].reverse().slice(0, 60);
    const header = el('div', { class: 'autohead' },
      el('div', { class: 'autostate' + (S.running ? ' on' : '') }, S.running ? `● Vigilando ${S.watchDir ? S.watchDir.name : ''}` : '○ Detenido'),
      el('div', { class: 'autocounts', id: 'autoCounts' },
        `${c.done} listas · ${c.waiting + c.importing + c.processing + c.printing} en proceso` + (c.review ? ` · ${c.review} por aprobar` : '') + (c.error ? ` · ${c.error} con error` : '')),
      S.queue.items.some((x) => STATES[x.status].final) ? el('button', { class: 'btn small', type: 'button', onClick: () => S.queue.clearFinished() }, 'Limpiar terminadas') : null);
    const reviewAll = c.review > 1 ? el('button', { class: 'btn small primary', type: 'button', id: 'btnAutoApproveAll', onClick: approveAll }, `Aprobar las ${c.review}`) : null;
    const list = el('div', { class: 'autolist', id: 'autoList' }, items.length ? items.map(rowFor) : el('p', { class: 'hint center' }, S.running ? 'Esperando fotos de la cámara…' : 'Aquí aparecerán las fotos que lleguen. Pulsa "Empezar".'));
    wrap.replaceChildren(...[header, reviewAll, list].filter(Boolean));
  }
  function previewUrl(it) {
    if (it.pages && it.pages[0] && !S.urls.has(it.id)) S.urls.set(it.id, URL.createObjectURL(new Blob([it.pages[0].jpeg], { type: 'image/jpeg' })));
    if (S.urls.has(it.id)) return S.urls.get(it.id);
    const m = it.photoId ? lib.get(it.photoId) : null;
    return m ? m.thumbURL : '';
  }
  function rowFor(it) {
    const url = previewUrl(it);
    const actions = [];
    if (it.status === 'review') actions.push(el('button', { class: 'btn small primary', type: 'button', 'data-act': 'approve', onClick: () => approve(it.id) }, 'Aprobar'), el('button', { class: 'btn small', type: 'button', 'data-act': 'discard', onClick: () => discard(it.id) }, 'Descartar'));
    if (it.status === 'error') actions.push(el('button', { class: 'btn small', type: 'button', 'data-act': 'retry', onClick: () => retry(it.id) }, 'Reintentar'));
    if (it.status === 'done' && it.ready && it.pages) {
      actions.push(el('button', { class: 'btn small primary', type: 'button', 'data-act': 'dl-jpg', onClick: () => downloadPage(it, 'jpg') }, 'Descargar JPEG'), el('button', { class: 'btn small', type: 'button', 'data-act': 'dl-pdf', onClick: () => downloadPage(it, 'pdf') }, 'Descargar PDF'));
      if (canShareFiles()) actions.push(el('button', { class: 'btn small', type: 'button', 'data-act': 'share', onClick: () => shareFirst(it) }, 'Compartir'));
    }
    if (it.status === 'done' && S.cfg.output !== 'hold' && !it.ready && it.pages) actions.push(el('button', { class: 'btn small', type: 'button', 'data-act': 'again', title: 'Imprimir o guardar otra vez', onClick: () => again(it.id) }, 'Otra copia'));
    return el('div', { class: 'autorow', 'data-id': it.id, 'data-status': it.status },
      url ? el('img', { src: url, alt: it.name, class: 'autothumb' }) : el('span', { class: 'autothumb noimg' }),
      el('div', { class: 'autoinfo' }, el('div', { class: 'autoname' }, it.name), statusChip(it), it.error ? el('div', { class: 'autoerr' }, it.error) : null, it.note ? el('div', { class: 'hint' }, it.note) : null),
      el('div', { class: 'autoact' }, ...actions));
  }

  // ------------------------------------------------------------------ ejecución
  async function start() {
    const preset = currentPreset();
    if (!preset) { toast('Elige un preset', true); return; }
    if (!S.watchDir) { toast('Primero elige la carpeta donde llegan las fotos de la cámara', true); return; }
    if (S.cfg.output === 'folder' && !S.outDir) { toast('Elige la carpeta donde se guardarán las fotos listas', true); return; }
    if (!(await ensurePermission(S.watchDir, 'read'))) { toast('Sin permiso para leer la carpeta de la cámara', true); return; }
    if (S.cfg.output === 'folder' && !(await ensurePermission(S.outDir, 'readwrite'))) { toast('Sin permiso para escribir en la carpeta de salida', true); return; }
    S.watcher = new FolderWatcher({ list: () => listDirectory(S.watchDir), isPhotoName: ctx.isPhotoName, settleMs: 1500, known: (await storage.kvGet('autoKnown')) || [] });
    try { await S.watcher.start({ includeExisting: S.cfg.includeExisting }); } catch (err) { toast('No se pudo leer la carpeta: ' + (err.message || err), true); return; }
    S.running = true; S.startedAt = Date.now(); ctx.setRunning(true);
    build(); toast('Modo automático en marcha');
    tick();
  }

  function stop() {
    S.running = false; clearTimeout(S.timer); ctx.setRunning(false);
    build(); toast('Modo automático detenido');
  }

  async function tick() {
    if (!S.running) return;
    try {
      const ready = await S.watcher.poll();
      S.lastPoll = Date.now();
      for (const e of ready) S.queue.add({ name: e.name, entry: e, key: S.watcher.keyOf(e) });
      if (ready.length) storage.kvSet('autoKnown', S.watcher.knownKeys());
      pump();
    } catch (err) { console.error(err); }
    if (S.running) S.timer = setTimeout(tick, 1000);
  }

  async function pump() {
    if (S.pumping) return; S.pumping = true;
    try { for (let it = S.queue.nextWaiting(); it; it = S.queue.nextWaiting()) await processItem(it); } finally { S.pumping = false; }
  }

  async function processItem(it) {
    const set = (status, patch = {}) => S.queue.update(it.id, { status, ...patch });
    try {
      set('importing');
      const file = it.file || (await it.entry.handle.getFile());
      const photoId = await ctx.importFile(file, Date.now());
      set('processing', { photoId });
      await ctx.processRec(photoId, { preset: currentPreset(), intensity: S.cfg.intensity / 100, autoTone: S.cfg.autoTone, autoWb: S.cfg.autoWb, cropToFrame: S.cfg.cropToFrame, approve: !S.cfg.requireApproval });
      if (S.cfg.output === 'hold') { set('done', { note: 'Preparada en la biblioteca' }); return; }
      const pages = await printUI.renderPagesFor([photoId], 'Automático');
      if (!pages) throw new Error('No se pudo componer la hoja');
      it.pages = pages; S.queue.update(it.id, { pages });
      if (S.cfg.requireApproval) { set('review'); return; }
      await deliver(it);
    } catch (err) {
      console.error(err);
      set('error', { error: (err && err.message) || String(err) });
      if (it.entry && S.watcher) S.watcher.forget(it.entry); // se puede reintentar
    }
  }

  async function writeFile(name, bytes) {
    const fh = await S.outDir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(bytes); await w.close();
  }

  // Entrega las hojas ya compuestas: carpeta, impresora o nada
  async function deliver(it) {
    const pages = it.pages;
    if (S.cfg.output === 'folder') {
      S.queue.update(it.id, { status: 'printing' });
      S.counter++; storage.kvSet('autoCounter', S.counter);
      const names = [];
      if (S.cfg.format !== 'pdf') for (let i = 0; i < pages.length; i++) { const n = outputName(baseName(it.name), S.counter * 10 + i, 'jpg'); await writeFile(n, pages[i].jpeg); names.push(n); }
      if (S.cfg.format !== 'jpg') { const n = outputName(baseName(it.name), S.counter, 'pdf'); await writeFile(n, printUI.pdfBytes(pages, baseName(it.name))); names.push(n); }
      S.queue.update(it.id, { status: 'done', note: `Guardada: ${names.join(', ')}` });
    } else if (S.cfg.output === 'download') {
      S.queue.update(it.id, { status: 'done', note: 'Lista: toca Descargar o Compartir', ready: true });
    } else if (S.cfg.output === 'print') {
      S.queue.update(it.id, { status: 'printing' });
      await printUI.printPages(pages);
      S.queue.update(it.id, { status: 'done', note: 'Enviada a la impresora' });
    } else S.queue.update(it.id, { status: 'done' });
  }

  async function approve(id) {
    const it = S.queue.get(id); if (!it || it.status !== 'review') return;
    try { await ctx.processRec(it.photoId, { approveOnly: true }); await deliver(it); }
    catch (err) { console.error(err); S.queue.update(id, { status: 'error', error: (err && err.message) || String(err) }); }
  }
  async function approveAll() { for (const it of S.queue.items.filter((x) => x.status === 'review')) await approve(it.id); }
  function discard(id) { S.queue.update(id, { status: 'discarded' }); }
  function retry(id) { S.queue.update(id, { status: 'waiting', error: '' }); if (S.running) pump(); else pump(); }
  async function again(id) {
    const it = S.queue.get(id); if (!it || !it.pages) return;
    try { await deliver(it); } catch (err) { S.queue.update(id, { status: 'error', error: (err && err.message) || String(err) }); }
  }

  // Descargar / compartir desde el teléfono (hay que tocar el botón: el navegador exige un gesto del usuario)
  const fileOf = (it, kind) => {
    const base = baseName(it.name);
    if (kind === 'pdf') return new File([printUI.pdfBytes(it.pages, base)], outputName(base, 1, 'pdf'), { type: 'application/pdf' });
    return new File([it.pages[0].jpeg], outputName(base, 1, 'jpg'), { type: 'image/jpeg' });
  };
  function canShareFiles() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.jpg', { type: 'image/jpeg' })] })); } catch { return false; }
  }
  function downloadPage(it, kind) {
    const f = fileOf(it, kind); const url = URL.createObjectURL(f);
    const a = el('a', { href: url, download: f.name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function shareFirst(it) {
    try { await navigator.share({ files: [fileOf(it, 'jpg')], title: baseName(it.name) }); } catch (err) { if (err && err.name !== 'AbortError') toast('No se pudo compartir; usa Descargar', true); }
  }

  // Probar con un archivo de la computadora (sin cámara): pasa por exactamente el mismo camino
  async function testWith(file) {
    if (!file) return;
    if (S.cfg.output === 'folder' && !S.outDir) { toast('Elige antes la carpeta de salida (o cambia la salida a "Solo preparar")', true); return; }
    if (S.cfg.output === 'folder' && !(await ensurePermission(S.outDir, 'readwrite'))) { toast('Sin permiso para escribir en la carpeta de salida', true); return; }
    S.queue.add({ name: file.name.replace(/\.[^.]+$/, ''), file });
    pump();
  }

  return { init, build, start, stop, testWith, renderQueue, state: S, queue: S.queue, setFolders: (watch, out) => { S.watchDir = watch || S.watchDir; S.outDir = out || S.outDir; }, setConfig: (patch) => { S.cfg = sanitizeCfg({ ...S.cfg, ...patch }); saveCfg(); } };
}
