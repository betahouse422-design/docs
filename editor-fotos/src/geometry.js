// Matemática del recorte. Código puro (sin DOM).
// Los rectángulos son { x, y, w, h } normalizados (0..1) con origen arriba-izquierda,
// sobre la imagen ya girada. ow/oh son las dimensiones en píxeles de esa imagen,
// necesarias para conservar proporciones reales.

export const MIN_CROP = 0.04;

export const ASPECTS = [
  { id: 'free', label: 'Libre', value: null },
  { id: 'orig', label: 'Original', value: 'orig' },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:5', label: '4:5', value: 4 / 5 },
  { id: '3:2', label: '3:2', value: 3 / 2 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '16:9', label: '16:9', value: 16 / 9 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function aspectValue(spec, ow, oh) {
  if (spec == null) return null;
  return spec === 'orig' ? ow / oh : spec;
}

export function pixelAspect(rect, ow, oh) { return (rect.w * ow) / (rect.h * oh); }

// Mayor rectángulo con la proporción dada, centrado en `around`, dentro de la imagen.
export function fitAspect(aspect, ow, oh, around = { x: 0, y: 0, w: 1, h: 1 }) {
  let w = 1;
  let h = (w * ow) / (aspect * oh);
  if (h > 1) { h = 1; w = (h * aspect * oh) / ow; }
  const cx = around.x + around.w / 2;
  const cy = around.y + around.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

export function moveRect(rect, dx, dy) {
  return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.w), y: clamp(rect.y + dy, 0, 1 - rect.h) };
}

// Qué asa hay bajo el punto (en unidades normalizadas); tol = radio de toque.
export function hitHandle(rect, px, py, tol = 0.035) {
  const L = rect.x; const R = rect.x + rect.w; const T = rect.y; const B = rect.y + rect.h;
  const nearX = (v) => Math.abs(px - v) <= tol;
  const nearY = (v) => Math.abs(py - v) <= tol;
  const inX = px >= L - tol && px <= R + tol;
  const inY = py >= T - tol && py <= B + tol;
  if (nearX(L) && nearY(T)) return 'tl';
  if (nearX(R) && nearY(T)) return 'tr';
  if (nearX(L) && nearY(B)) return 'bl';
  if (nearX(R) && nearY(B)) return 'br';
  if (nearY(T) && inX) return 't';
  if (nearY(B) && inX) return 'b';
  if (nearX(L) && inY) return 'l';
  if (nearX(R) && inY) return 'r';
  if (px > L && px < R && py > T && py < B) return 'move';
  return null;
}

// Redimensiona arrastrando un asa hasta el punto p (normalizado).
export function resizeRect(rect, handle, p, aspect, ow, oh) {
  const px = clamp(p.x, 0, 1);
  const py = clamp(p.y, 0, 1);
  let L = rect.x; let R = rect.x + rect.w; let T = rect.y; let B = rect.y + rect.h;

  if (aspect == null) {
    if (handle.includes('l')) L = Math.min(px, R - MIN_CROP);
    if (handle.includes('r')) R = Math.max(px, L + MIN_CROP);
    if (handle.includes('t')) T = Math.min(py, B - MIN_CROP);
    if (handle.includes('b')) B = Math.max(py, T + MIN_CROP);
    return { x: L, y: T, w: R - L, h: B - T };
  }

  const wFromH = (h) => (h * aspect * oh) / ow;
  const hFromW = (w) => (w * ow) / (aspect * oh);

  if (handle.length === 2) { // esquina: ancla en la esquina opuesta
    const ax = handle.includes('l') ? R : L;
    const ay = handle.includes('t') ? B : T;
    const goRight = handle.includes('r');
    const goDown = handle.includes('b');
    let w = Math.max(Math.abs(px - ax), wFromH(Math.abs(py - ay)));
    w = Math.max(w, MIN_CROP);
    let h = hFromW(w);
    const availW = goRight ? 1 - ax : ax;
    const availH = goDown ? 1 - ay : ay;
    const k = Math.min(1, availW / w, availH / h);
    w *= k; h *= k;
    return { x: goRight ? ax : ax - w, y: goDown ? ay : ay - h, w, h };
  }

  // borde: cambia esa dimensión y la otra se ajusta desde el centro
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w; let h;
  if (handle === 'l' || handle === 'r') {
    w = handle === 'l' ? R - px : px - L;
    w = Math.max(w, MIN_CROP);
    h = hFromW(w);
  } else {
    h = handle === 't' ? B - py : py - T;
    h = Math.max(h, MIN_CROP);
    w = wFromH(h);
  }
  const k = Math.min(1, 1 / w, 1 / h);
  w *= k; h *= k;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}
