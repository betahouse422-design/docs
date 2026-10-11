// Compositor de hojas de impresión (Canvas 2D).
//
// Dibuja, para cada celda de la hoja: marco + foto editada + logo + texto.
// No sabe nada del motor de edición: recibe, por cada foto, una función
// render(w, h) que devuelve una imagen que CUBRE al menos w×h píxeles.

import {
  pageMm, pagePx, mmToPx, insetRect, gridCells, coverCrop, containRect, logoRect, cellWindow, effectiveOrientation,
  findFrameWindow,
} from './layout.js';
import { FONTS } from './printspec.js';

const MAX_PIXELS = 120e6; // límite sano de un canvas

// Tamaño de la hoja en píxeles; baja los ppp si el canvas sería demasiado grande.
export function pageGeometry(spec, dpi, photoAspect, frameAsset) {
  const mm = pageMm(spec.paper, effectiveOrientation(spec, frameAsset), spec.custom, photoAspect);
  let use = dpi; let px = pagePx(mm, use);
  while (px.w * px.h > MAX_PIXELS && use > 50) { use = Math.round(use * 0.8); px = pagePx(mm, use); }
  return { mm, px, dpi: use };
}

function roundRectPath(ctx, r, rad) {
  const x = r.x; const y = r.y; const w = r.w; const h = r.h; const k = Math.min(rad, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function drawPhoto(ctx, item, win, fit, bleed = 0) {
  const w = Math.max(1, Math.round(win.w)); const h = Math.max(1, Math.round(win.h));
  const src = item.render(w, h);
  if (!src) return;
  if (fit === 'contain') {
    const r = containRect(src.width, src.height, win);
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
  } else {
    const c = coverCrop(src.width, src.height, w, h);
    ctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, win.x - bleed, win.y - bleed, win.w + 2 * bleed, win.h + 2 * bleed);
  }
}

function drawBuiltinFrame(ctx, spec, cell, g, item, dpi) {
  const f = spec.frame;
  const line = Math.max(1, Math.round(dpi / 150));
  if (f.kind !== 'none') { ctx.fillStyle = f.color; ctx.fillRect(cell.x, cell.y, cell.w, cell.h); }
  if (f.kind === 'rounded') {
    ctx.save(); roundRectPath(ctx, g.window, g.radius); ctx.clip();
    drawPhoto(ctx, item, g.window, spec.photoFit); ctx.restore();
    return;
  }
  ctx.save(); ctx.beginPath(); ctx.rect(g.window.x, g.window.y, g.window.w, g.window.h); ctx.clip();
  drawPhoto(ctx, item, g.window, spec.photoFit);
  ctx.restore();
  const w = g.window;
  if (f.kind === 'double' && g.border > 4) {
    ctx.strokeStyle = f.innerColor; ctx.lineWidth = line;
    const o = g.border * 0.42;
    ctx.strokeRect(cell.x + o, cell.y + o, cell.w - 2 * o, cell.h - 2 * o);
    ctx.strokeRect(w.x - line * 2, w.y - line * 2, w.w + line * 4, w.h + line * 4);
  } else if (f.kind === 'polaroid') {
    ctx.strokeStyle = 'rgba(0,0,0,.14)'; ctx.lineWidth = line;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
  } else if (f.kind === 'mat') {
    const b = Math.max(2, g.border * 0.07);
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.fillRect(w.x - b, w.y - b, w.w + 2 * b, b); ctx.fillRect(w.x - b, w.y - b, b, w.h + 2 * b);
    ctx.fillStyle = 'rgba(255,255,255,.65)';
    ctx.fillRect(w.x - b, w.y + w.h, w.w + 2 * b, b); ctx.fillRect(w.x + w.w, w.y - b, b, w.h + 2 * b);
    ctx.strokeStyle = f.innerColor; ctx.lineWidth = line; ctx.globalAlpha = 0.5;
    ctx.strokeRect(w.x - b, w.y - b, w.w + 2 * b, w.h + 2 * b); ctx.globalAlpha = 1;
  }
}

function drawLogo(ctx, spec, cell, assets, dpi) {
  const L = spec.logo;
  if (!L.enabled || !assets.logo) return;
  const r0 = logoRect(L, assets.logo.w / assets.logo.h, { w: cell.w, h: cell.h });
  const r = { x: cell.x + r0.x, y: cell.y + r0.y, w: r0.w, h: r0.h };
  ctx.save();
  ctx.globalAlpha = L.opacity;
  if (L.plate) {
    const pad = Math.max(4, r.h * 0.14);
    ctx.fillStyle = L.plateColor;
    roundRectPath(ctx, { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }, pad);
    ctx.fill();
  }
  ctx.drawImage(assets.logo.img, r.x, r.y, r.w, r.h);
  ctx.restore();
}

function drawCaption(ctx, spec, cell, text, dpi) {
  const C = spec.caption;
  if (!C.enabled || !text) return;
  const fam = (FONTS.find((f) => f.id === C.font) || FONTS[0]).css;
  let px = (C.sizePt / 72) * dpi;
  const font = (size) => `${C.italic ? 'italic ' : ''}${C.bold ? 'bold ' : ''}${size}px ${fam}`;
  ctx.font = font(px);
  const maxW = cell.w * 0.92;
  const m = ctx.measureText(text).width;
  if (m > maxW) { px *= maxW / m; ctx.font = font(px); }
  ctx.fillStyle = C.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cell.x + cell.w / 2, cell.y + C.y * cell.h);
}

// Tamaño (px) de la ventana de cada celda a unos ppp dados: sirve para renderizar cada foto
// al tamaño justo ANTES de componer la hoja.
export function cellWindowSizes(spec, assets, photoAspect, dpi) {
  const frameAsset = spec.frame.kind === 'custom' ? assets.frame : null;
  const g = pageGeometry(spec, dpi, photoAspect, frameAsset);
  const inner = insetRect({ x: 0, y: 0, w: g.px.w, h: g.px.h }, mmToPx(spec.marginMm, g.dpi));
  const cells = gridCells(inner, spec.cols, spec.rows, mmToPx(spec.gutterMm, g.dpi));
  return { geometry: g, cells, windows: cells.map((c) => { const w = cellWindow(spec.frame, c, g.dpi, frameAsset).window; return { w: Math.max(1, Math.round(w.w)), h: Math.max(1, Math.round(w.h)) }; }) };
}

// spec: hoja ya migrada. items: fotos de ESTA hoja (máximo cols×rows).
// item: { render(w,h) -> imagen, aspect, caption }   assets: { logo:{img,w,h}|null, frame:{img,w,h,window}|null }
// opts: { dpi, guides }
export function composePage(spec, items, assets = {}, opts = {}) {
  const frameAsset = spec.frame.kind === 'custom' ? assets.frame : null;
  const g = pageGeometry(spec, opts.dpi || spec.dpi, (items[0] && items[0].aspect) || 1.5, frameAsset);
  const canvas = document.createElement('canvas');
  canvas.width = g.px.w; canvas.height = g.px.h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = spec.background; ctx.fillRect(0, 0, g.px.w, g.px.h);
  ctx.imageSmoothingQuality = 'high';

  const inner = insetRect({ x: 0, y: 0, w: g.px.w, h: g.px.h }, mmToPx(spec.marginMm, g.dpi));
  const cells = gridCells(inner, spec.cols, spec.rows, mmToPx(spec.gutterMm, g.dpi));
  items.slice(0, cells.length).forEach((item, i) => {
    const cell = cells[i];
    const cw = cellWindow(spec.frame, cell, g.dpi, frameAsset);
    if (cw.custom) {
      const bleed = Math.max(1, g.dpi / 100); // la foto asoma bajo el marco: no queda rendija
      ctx.save(); ctx.beginPath(); ctx.rect(cell.x, cell.y, cell.w, cell.h); ctx.clip();
      drawPhoto(ctx, item, cw.window, spec.photoFit, bleed);
      ctx.drawImage(frameAsset.img, cw.dest.x, cw.dest.y, cw.dest.w, cw.dest.h);
      ctx.restore();
    } else {
      drawBuiltinFrame(ctx, spec, cell, cw, item, g.dpi);
    }
    drawLogo(ctx, spec, cell, assets, g.dpi);
    drawCaption(ctx, spec, cell, item.caption, g.dpi);
  });

  if (opts.guides && cells.length > 1) { // marcas de corte entre fotos
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
    for (const c of cells) ctx.strokeRect(c.x, c.y, c.w, c.h);
  }
  return { canvas, geometry: g, cells };
}

// ---------- carga de recursos ----------

// Logo o marco desde un Blob. SVG se carga como <img> (createImageBitmap no lo admite en todos los navegadores).
export async function loadImageAsset(blob) {
  const isSvg = blob.type === 'image/svg+xml' || /\.svg$/i.test(blob.name || '');
  if (!isSvg) {
    try { const bmp = await createImageBitmap(blob); return { img: bmp, w: bmp.width, h: bmp.height }; } catch { /* probar con <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url; await img.decode();
    const w = img.naturalWidth || 300; const h = img.naturalHeight || 150;
    return { img, w, h };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
}

// Detecta la ventana transparente de un marco PNG (normalizada 0..1) o null.
export function detectWindow(asset) {
  const k = Math.min(1, 1600 / Math.max(asset.w, asset.h));
  const w = Math.max(1, Math.round(asset.w * k)); const h = Math.max(1, Math.round(asset.h * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(asset.img, 0, 0, w, h);
  return findFrameWindow(ctx.getImageData(0, 0, w, h).data, w, h);
}

export function canvasToJpegBytes(canvas, quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (b) => {
      if (!b) return reject(new Error('No se pudo generar la imagen de la hoja.'));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, 'image/jpeg', quality);
  });
}
