// Curvas de tono. Código puro (sin DOM).
//
// Una curva es una lista de puntos [x, y] en 0..1 ordenados por x.
// Se interpola con una spline cúbica monótona (Fritsch-Carlson): pasa por
// todos los puntos y NUNCA se pasa de largo entre ellos, así que no aparecen
// ondulaciones ni inversiones de tono. De ahí se genera una tabla (LUT) que
// la GPU consulta.

export const LUT_SIZE = 256;
export const MIN_GAP = 0.01; // separación mínima en x entre puntos

export function normalizePoints(points) {
  const pts = points
    .map(([x, y]) => [clamp01(x), clamp01(y)])
    .sort((a, b) => a[0] - b[0]);
  // x duplicadas: quedarse con la última
  const out = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-6) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length < 2) return [[0, 0], [1, 1]];
  return out;
}

// Pendientes monótonas en cada nodo.
function tangents(pts) {
  const n = pts.length;
  const d = new Array(n - 1);
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
}

// Devuelve una función x -> y.
export function makeCurve(points) {
  const pts = normalizePoints(points);
  const n = pts.length;
  const m = tangents(pts);
  return (x) => {
    x = clamp01(x);
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > pts[i + 1][0]) i++;
    const h = pts[i + 1][0] - pts[i][0];
    const t = (x - pts[i][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * pts[i][1] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * pts[i + 1][1] +
      (t3 - t2) * h * m[i + 1];
    return clamp01(y);
  };
}

export function buildLUT(points, size = LUT_SIZE) {
  const f = makeCurve(points);
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i++) lut[i] = f(i / (size - 1));
  return lut;
}

export function isIdentity(points) {
  const f = makeCurve(points);
  for (let i = 0; i <= 16; i++) if (Math.abs(f(i / 16) - i / 16) > 1e-6) return false;
  return true;
}

// ---- Edición de puntos (la UI llama a esto) -------------------------------

export function addPoint(points, x, y) {
  const pts = normalizePoints(points);
  x = clamp01(x); y = clamp01(y);
  for (const p of pts) if (Math.abs(p[0] - x) < MIN_GAP) return { points: pts, index: pts.indexOf(p) };
  pts.push([x, y]);
  pts.sort((a, b) => a[0] - b[0]);
  return { points: pts, index: pts.findIndex((p) => p[0] === x && p[1] === y) };
}

// Mueve el punto i sin pasar a sus vecinos ni sacar los extremos de x=0 / x=1.
export function movePoint(points, i, x, y) {
  const pts = points.map((p) => p.slice());
  if (i < 0 || i >= pts.length) return pts;
  y = clamp01(y);
  if (i === 0) { pts[0] = [0, y]; return pts; }
  if (i === pts.length - 1) { pts[i] = [1, y]; return pts; }
  const lo = pts[i - 1][0] + MIN_GAP;
  const hi = pts[i + 1][0] - MIN_GAP;
  pts[i] = [Math.min(hi, Math.max(lo, clamp01(x))), y];
  return pts;
}

export function removePoint(points, i) {
  if (i <= 0 || i >= points.length - 1) return points.map((p) => p.slice()); // los extremos no se borran
  return points.filter((_, k) => k !== i).map((p) => p.slice());
}

export function nearestPoint(points, x, y, maxDist = 0.04) {
  let best = -1;
  let bd = maxDist;
  points.forEach((p, i) => {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function clamp01(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : (v || 0); }
