// Matemática del diseño de impresión. Código puro (sin DOM), probado en Node.
//
// Unidades: milímetros para el papel; píxeles para lo que se dibuja (a un ppp dado).
// Los rectángulos son { x, y, w, h }.

export const PAPERS = [
  { id: '10x15', label: '10 × 15 cm (4 × 6 in)', w: 101.6, h: 152.4 },
  { id: '13x18', label: '13 × 18 cm (5 × 7 in)', w: 127, h: 178 },
  { id: '15x20', label: '15 × 20 cm (6 × 8 in)', w: 152.4, h: 203.2 },
  { id: '20x25', label: '20 × 25 cm (8 × 10 in)', w: 203.2, h: 254 },
  { id: '20x30', label: '20 × 30 cm (8 × 12 in)', w: 203.2, h: 304.8 },
  { id: 'a5', label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  { id: 'a4', label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  { id: 'a3', label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  { id: 'letter', label: 'Carta (8.5 × 11 in)', w: 215.9, h: 279.4 },
  { id: 'sq20', label: 'Cuadrado 20 × 20 cm', w: 200, h: 200 },
  { id: 'custom', label: 'Personalizado…', w: 100, h: 150 },
];

export const DPI_OPTIONS = [150, 200, 300, 600];
export const MM_PER_INCH = 25.4;

export const mmToPx = (mm, dpi) => Math.round((mm * dpi) / MM_PER_INCH);
export const ptFromMm = (mm) => (mm * 72) / MM_PER_INCH;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- papel ----------

// orientation: 'portrait' | 'landscape' | 'auto' (según la proporción de la foto: ancho/alto)
export function pageMm(paperId, orientation = 'portrait', custom = null, photoAspect = 1) {
  const p = PAPERS.find((x) => x.id === paperId) || PAPERS[0];
  let w = p.w; let h = p.h;
  if (paperId === 'custom' && custom) { w = clamp(Number(custom.w) || 100, 20, 1000); h = clamp(Number(custom.h) || 150, 20, 1000); }
  const short = Math.min(w, h); const long = Math.max(w, h);
  let landscape = orientation === 'landscape';
  if (orientation === 'auto') landscape = photoAspect > 1.02;
  if (short === long) return { w: short, h: long };
  return landscape ? { w: long, h: short } : { w: short, h: long };
}

export function pagePx(page, dpi) { return { w: mmToPx(page.w, dpi), h: mmToPx(page.h, dpi) }; }

// ---------- rectángulos ----------

export function insetRect(r, left, top = left, right = left, bottom = top) {
  return { x: r.x + left, y: r.y + top, w: Math.max(1, r.w - left - right), h: Math.max(1, r.h - top - bottom) };
}

// Varias fotos por hoja: celdas en orden de lectura.
export function gridCells(rect, cols, rows, gutter = 0) {
  cols = Math.max(1, Math.floor(cols)); rows = Math.max(1, Math.floor(rows));
  const cw = (rect.w - gutter * (cols - 1)) / cols;
  const ch = (rect.h - gutter * (rows - 1)) / rows;
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: rect.x + c * (cw + gutter), y: rect.y + r * (ch + gutter), w: cw, h: ch });
  return out;
}

// Recorte (en la foto) que la hace cubrir una caja sin deformarse.
export function coverCrop(srcW, srcH, boxW, boxH) {
  const sa = srcW / srcH; const ba = boxW / boxH;
  if (sa > ba) { const sw = srcH * ba; return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }; }
  const sh = srcW / ba; return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

// Rectángulo que contiene una imagen dentro de una caja sin deformarla (centrado).
export function containRect(srcW, srcH, box) {
  const sa = srcW / srcH; const ba = box.w / box.h;
  if (sa > ba) { const h = box.w / sa; return { x: box.x, y: box.y + (box.h - h) / 2, w: box.w, h }; }
  const w = box.h * sa; return { x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h };
}

// Qué parte de la foto se pierde al cubrir una caja (0..1), para avisar al usuario.
export function cropLoss(srcW, srcH, boxW, boxH) {
  const c = coverCrop(srcW, srcH, boxW, boxH);
  return 1 - (c.sw * c.sh) / (srcW * srcH);
}

// ---------- logo ----------

export const LOGO_POSITIONS = {
  'top-left': [0.16, 0.07], 'top-center': [0.5, 0.07], 'top-right': [0.84, 0.07],
  'center': [0.5, 0.5],
  'bottom-left': [0.16, 0.93], 'bottom-center': [0.5, 0.93], 'bottom-right': [0.84, 0.93],
};

// logo: { x, y (centro, 0..1 de la página), widthPct (de la página) }  aspect = ancho/alto del logo
export function logoRect(logo, aspect, page) {
  const w = (clamp(logo.widthPct, 2, 100) / 100) * page.w;
  const h = w / (aspect || 1);
  const cx = clamp(logo.x, 0, 1) * page.w; const cy = clamp(logo.y, 0, 1) * page.h;
  return { x: clamp(cx - w / 2, 0, Math.max(0, page.w - w)), y: clamp(cy - h / 2, 0, Math.max(0, page.h - h)), w, h };
}

// ---------- marcos generados ----------

export const FRAME_KINDS = [
  { id: 'none', label: 'Sin marco' },
  { id: 'border', label: 'Borde' },
  { id: 'double', label: 'Doble borde' },
  { id: 'polaroid', label: 'Polaroid' },
  { id: 'rounded', label: 'Esquinas redondeadas' },
  { id: 'mat', label: 'Paspartú' },
  { id: 'custom', label: 'Marco cargado (PNG)' },
];

// Devuelve la ventana donde va la foto y los datos para dibujar el marco.
// frame: { kind, widthMm, radiusMm }, rect: área disponible (px), dpi
export function builtinFrameGeometry(frame, rect, dpi) {
  const bw = mmToPx(clamp(frame.widthMm ?? 6, 0, 60), dpi);
  switch (frame.kind) {
    case 'border': case 'double': case 'rounded': case 'mat':
      return { window: insetRect(rect, bw), border: bw, radius: frame.kind === 'rounded' ? mmToPx(clamp(frame.radiusMm ?? 4, 0, 40), dpi) : 0 };
    case 'polaroid': {
      const bottom = Math.round(bw * 3.4);
      return { window: insetRect(rect, bw, bw, bw, bottom), border: bw, bottom, radius: 0 };
    }
    default: return { window: { ...rect }, border: 0, radius: 0 };
  }
}

// ---------- marcos cargados (PNG con ventana transparente) ----------

// Rectángulo donde se dibuja la imagen del marco dentro de la caja.
export function frameDest(frameW, frameH, box, fit = 'contain') {
  if (fit === 'stretch') return { ...box };
  if (fit === 'cover') { const c = coverCrop(frameW, frameH, box.w, box.h); const k = box.w / c.sw; return { x: box.x - c.sx * k, y: box.y - c.sy * k, w: frameW * k, h: frameH * k }; }
  return containRect(frameW, frameH, box);
}

// Ventana del marco ya colocada: ventana normalizada (0..1 de la imagen) -> px.
export function mapWindow(win, dest) {
  return { x: dest.x + win.x * dest.w, y: dest.y + win.y * dest.h, w: win.w * dest.w, h: win.h * dest.h };
}

// Detecta la ventana transparente de un marco. rgba = Uint8ClampedArray(w*h*4).
// Devuelve { x, y, w, h } normalizado (0..1) o null si no hay ventana clara.
// Elige la mayor región transparente que NO toque el borde (las esquinas
// transparentes de un marco redondeado tocan el borde y se ignoran).
export function findFrameWindow(rgba, w, h, alphaThreshold = 24) {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 480));
  const gw = Math.ceil(w / step); const gh = Math.ceil(h / step);
  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = Math.min(w - 1, gx * step + (step >> 1)); const py = Math.min(h - 1, gy * step + (step >> 1));
      mask[gy * gw + gx] = rgba[(py * w + px) * 4 + 3] < alphaThreshold ? 1 : 0;
    }
  }
  const label = new Int32Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  let best = null; let bestAny = null; let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let head = 0; let tail = 0; queue[tail++] = i; label[i] = next;
    let minX = gw; let minY = gh; let maxX = -1; let maxY = -1; let count = 0; let touches = false;
    while (head < tail) {
      const p = queue[head++]; const x = p % gw; const y = (p / gw) | 0;
      count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) touches = true;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; queue[tail++] = p - 1; }
      if (x < gw - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; queue[tail++] = p + 1; }
      if (y > 0 && mask[p - gw] && !label[p - gw]) { label[p - gw] = next; queue[tail++] = p - gw; }
      if (y < gh - 1 && mask[p + gw] && !label[p + gw]) { label[p + gw] = next; queue[tail++] = p + gw; }
    }
    const comp = { count, minX, minY, maxX, maxY, touches };
    if (!bestAny || count > bestAny.count) bestAny = comp;
    if (!touches && (!best || count > best.count)) best = comp;
  }
  const c = best || bestAny;
  if (!c || c.count < gw * gh * 0.01) return null; // demasiado pequeña para ser una ventana
  if (!best && c.count > gw * gh * 0.97) return null; // todo transparente: no hay marco
  return {
    x: (c.minX * step) / w, y: (c.minY * step) / h,
    w: Math.min(1, ((c.maxX - c.minX + 1) * step) / w), h: Math.min(1, ((c.maxY - c.minY + 1) * step) / h),
  };
}

// ---------- recorte automático al marco ----------

// Proporción (ancho/alto) de la ventana de la foto para una hoja con un marco generado.
export function windowAspectForBuiltin(spec, photoAspect = 1.5) {
  const page = pageMm(spec.paper, spec.orientation, spec.custom, photoAspect);
  const dpi = 100; const pp = pagePx(page, dpi);
  const margin = mmToPx(spec.marginMm ?? 0, dpi);
  let rect = insetRect({ x: 0, y: 0, w: pp.w, h: pp.h }, margin);
  const cells = gridCells(rect, spec.cols || 1, spec.rows || 1, mmToPx(spec.gutterMm ?? 4, dpi));
  const g = builtinFrameGeometry(spec.frame || { kind: 'none' }, cells[0], dpi);
  return g.window.w / g.window.h;
}


// ---------- ventana de una celda (marco generado o cargado) ----------

// frameAsset (solo marco cargado): { w, h, window } con window normalizada (0..1)
export function cellWindow(frame, cell, dpi, frameAsset = null) {
  if (frame.kind === 'custom' && frameAsset && frameAsset.window) {
    const dest = frameDest(frameAsset.w, frameAsset.h, cell, frame.fit || 'contain');
    return { window: mapWindow(frameAsset.window, dest), dest, border: 0, radius: 0, custom: true };
  }
  const g = builtinFrameGeometry(frame.kind === 'custom' ? { kind: 'none' } : frame, cell, dpi);
  return { ...g, custom: false };
}

// Un marco cargado manda sobre la orientación: la hoja se orienta como el marco.
export function effectiveOrientation(spec, frameAsset = null) {
  if (spec.frame && spec.frame.kind === 'custom' && frameAsset) return frameAsset.w >= frameAsset.h ? 'landscape' : 'portrait';
  return spec.orientation;
}

// Proporción (ancho/alto) de la ventana donde irá la foto, para recortar al marco.
export function windowAspect(spec, frameAsset = null, photoAspect = 1.5) {
  const page = pageMm(spec.paper, effectiveOrientation(spec, frameAsset), spec.custom, photoAspect);
  const dpi = 100; const pp = pagePx(page, dpi);
  const rect = insetRect({ x: 0, y: 0, w: pp.w, h: pp.h }, mmToPx(spec.marginMm ?? 0, dpi));
  const cells = gridCells(rect, spec.cols || 1, spec.rows || 1, mmToPx(spec.gutterMm ?? 4, dpi));
  const cw = cellWindow(spec.frame || { kind: 'none' }, cells[0], dpi, frameAsset);
  return cw.window.w / cw.window.h;
}
