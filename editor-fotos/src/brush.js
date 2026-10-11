// Pincel de máscaras: convierte trazos (coordenadas 0..1, origen arriba-izquierda) en una
// imagen de transparencia. Código compartido por el motor (que la sube a la GPU) y por la
// capa interactiva (que la pinta en rojo sobre la foto). No depende del motor.

export const MAX_STROKES = 120;
export const MAX_STROKE_POINTS = 500;

export function newStroke(x, y, r, soft, erase) {
  return { r, soft, erase: !!erase, pts: [[x, y]] };
}

// Limpia trazos guardados: valores en rango y tamaños acotados.
export function normalizeStrokes(list) {
  if (!Array.isArray(list)) return [];
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const out = [];
  for (const s of list.slice(0, MAX_STROKES)) {
    if (!s || !Array.isArray(s.pts)) continue;
    const pts = s.pts.slice(0, MAX_STROKE_POINTS)
      .map((p) => (Array.isArray(p) ? [n(p[0], 0, 1, 0), n(p[1], 0, 1, 0)] : null)).filter(Boolean);
    if (!pts.length) continue;
    out.push({ r: n(s.r, 0.003, 0.4, 0.04), soft: n(s.soft, 0, 1, 0.5), erase: !!s.erase, pts });
  }
  return out;
}

// Dibuja los trazos en `ctx` (canvas W×H). El radio es una fracción del ANCHO.
// Cada "sello" es un círculo con borde suave; borrar quita transparencia.
export function paintStrokes(ctx, strokes, W, H) {
  ctx.clearRect(0, 0, W, H);
  for (const s of strokes) {
    const rad = Math.max(0.6, s.r * W);
    const step = Math.max(0.75, rad * 0.22);
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    const inner = Math.max(0, 1 - s.soft);
    const stamp = (x, y) => {
      const g = ctx.createRadialGradient(x, y, rad * inner * 0.999, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    };
    let prev = null;
    for (const p of s.pts) {
      const x = p[0] * W; const y = p[1] * H;
      if (!prev) stamp(x, y);
      else {
        const dist = Math.hypot(x - prev[0], y - prev[1]);
        const k = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= k; i++) stamp(prev[0] + ((x - prev[0]) * i) / k, prev[1] + ((y - prev[1]) * i) / k);
      }
      prev = [x, y];
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// Alfa (0..255) de cada trazo-conjunto, en un Uint8Array W*H.
export function strokesToAlpha(strokes, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  paintStrokes(ctx, strokes, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}
