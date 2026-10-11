// Capa interactiva encima de la foto: recorte y manejo de máscaras.
// Trabaja con coordenadas normalizadas (0..1, origen arriba-izquierda).

import { hitHandle, resizeRect, moveRect } from './geometry.js';

const ACCENT = '#ffb347';

export class Overlay {
  // hooks: getMode() -> 'none'|'crop'|'mask'|'pick'|'spot'
  //        crop: getCrop(), setCrop(rect, final), getAspect(), getOrientedSize()
  //        mask: getMask(), updateMask(patch, final)
  //        pick: onPick(x, y)                        (gotero; coordenadas 0..1 de la vista)
  //        spot: getSpotsView() -> [{cx,cy,rw,rh,sx,sy,sel,mode}] (0..1 de la vista), selectedSpot(),
  //              addSpotView(x, y), updateSpotView(i, patch, final), selectSpot(i)
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.h = hooks;
    this.drag = null;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
  }

  sync(cssW, cssH) {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = `${cssW}px`; c.style.height = `${cssH}px`;
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    this.dpr = dpr;
  }

  active() { return this.h.getMode() !== 'none'; }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  }

  // ---------- eventos ----------

  _down(e) {
    const mode = this.h.getMode();
    if (mode === 'none') return;
    const p = this._pt(e);
    const touch = e.pointerType !== 'mouse';
    if (mode === 'pick') { e.preventDefault(); this.h.onPick(p.x, p.y); return; }
    if (mode === 'spot') {
      e.preventDefault();
      const hit = this._spotHit(p, touch ? 26 : 16);
      if (!hit) { this.h.addSpotView(p.x, p.y); return; }
      this.h.selectSpot(hit.i);
      this.drag = { kind: 'spot', i: hit.i, part: hit.part, start: p, spot: { ...this.h.getSpotsView()[hit.i] } };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* algunos navegadores lo rechazan */ }
      this.draw();
      return;
    }
    if (mode === 'crop') {
      const rect = this.h.getCrop();
      const handle = hitHandle(rect, p.x, p.y, touch ? 0.06 : 0.035);
      if (!handle) return;
      this.drag = { kind: 'crop', handle, start: p, rect: { ...rect } };
    } else if (mode === 'mask') {
      const m = this.h.getMask();
      if (!m) return;
      const handle = this._maskHandle(m, p, touch ? 26 : 16);
      if (!handle) return;
      this.drag = { kind: 'mask', handle, start: p, mask: JSON.parse(JSON.stringify(m)) };
    }
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* algunos navegadores lo rechazan; el arrastre sigue funcionando */ }
  }

  _move(e) {
    if (!this.drag) {
      // cursor orientativo en escritorio
      if (this.h.getMode() === 'crop' && e.pointerType === 'mouse') {
        const p = this._pt(e);
        const hd = hitHandle(this.h.getCrop(), p.x, p.y);
        this.canvas.style.cursor = !hd ? 'default' : hd === 'move' ? 'move'
          : (hd === 'tl' || hd === 'br') ? 'nwse-resize' : (hd === 'tr' || hd === 'bl') ? 'nesw-resize'
            : (hd === 'l' || hd === 'r') ? 'ew-resize' : 'ns-resize';
      }
      return;
    }
    const p = this._pt(e);
    if (this.drag.kind === 'spot') {
      const d = this.drag; const sp = d.spot;
      const clamp = (v) => Math.min(1, Math.max(0, v));
      if (d.part === 'center') {
        const dxn = p.x - d.start.x; const dyn = p.y - d.start.y;
        // el centro se mueve y el origen lo acompaña (conserva su desplazamiento)
        this.h.updateSpotView(d.i, { cx: clamp(sp.cx + dxn), cy: clamp(sp.cy + dyn), sx: sp.sx + dxn, sy: sp.sy + dyn }, false);
      } else if (d.part === 'source') {
        this.h.updateSpotView(d.i, { sx: clamp(p.x), sy: clamp(p.y) }, false);
      } else if (d.part === 'radius') {
        this.h.updateSpotView(d.i, { rw: Math.max(0.004, Math.abs(p.x - sp.cx)) }, false);
      }
      this.draw();
      return;
    }
    if (this.drag.kind === 'crop') {
      const d = this.drag;
      const [ow, oh] = this.h.getOrientedSize();
      const aspect = this.h.getAspect();
      const next = d.handle === 'move'
        ? moveRect(d.rect, p.x - d.start.x, p.y - d.start.y)
        : resizeRect(d.rect, d.handle, p, aspect, ow, oh);
      this.h.setCrop(next, false);
    } else {
      this._dragMask(p);
    }
    this.draw();
  }

  _up() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.kind === 'spot') { this.h.updateSpotView(d.i, {}, true); this.draw(); return; }
    if (d.kind === 'crop') this.h.setCrop(this.h.getCrop(), true);
    else this.h.updateMask({}, true);
    this.draw();
  }

  // ---------- máscaras ----------

  _maskHandles(m, W, H) {
    if (m.type === 'linear') {
      return { p0: [m.x0 * W, m.y0 * H], p1: [m.x1 * W, m.y1 * H] };
    }
    const a = ((m.angle || 0) * Math.PI) / 180;
    const c = [m.cx * W, m.cy * H];
    const rxp = m.rx * W; const ryp = m.ry * H;
    return {
      c,
      rx: [c[0] + rxp * Math.cos(a), c[1] + rxp * Math.sin(a)],
      ry: [c[0] - ryp * Math.sin(a), c[1] + ryp * Math.cos(a)],
    };
  }

  _maskHandle(m, p, tolPx) {
    const hs = this._maskHandles(m, p.w, p.h);
    const px = [p.x * p.w, p.y * p.h];
    let best = null; let bd = tolPx;
    for (const [k, v] of Object.entries(hs)) {
      const d = Math.hypot(v[0] - px[0], v[1] - px[1]);
      if (d < bd) { bd = d; best = k; }
    }
    if (!best && m.type === 'radial') {
      // dentro de la elipse: mover
      const a = ((m.angle || 0) * Math.PI) / 180;
      const dx = px[0] - hs.c[0]; const dy = px[1] - hs.c[1];
      const lx = dx * Math.cos(a) + dy * Math.sin(a);
      const ly = -dx * Math.sin(a) + dy * Math.cos(a);
      if ((lx / (m.rx * p.w)) ** 2 + (ly / (m.ry * p.h)) ** 2 <= 1) best = 'c';
    }
    return best;
  }

  _dragMask(p) {
    const d = this.drag;
    const m = d.mask;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const x = clamp(p.x); const y = clamp(p.y);
    let patch = {};
    if (m.type === 'linear') {
      patch = d.handle === 'p0' ? { x0: x, y0: y } : { x1: x, y1: y };
    } else if (d.handle === 'c') {
      patch = { cx: clamp(m.cx + (p.x - d.start.x)), cy: clamp(m.cy + (p.y - d.start.y)) };
    } else {
      const a = ((m.angle || 0) * Math.PI) / 180;
      const dx = (p.x - m.cx) * p.w; const dy = (p.y - m.cy) * p.h;
      if (d.handle === 'rx') patch = { rx: Math.min(1.5, Math.max(0.03, (dx * Math.cos(a) + dy * Math.sin(a)) / p.w)) };
      if (d.handle === 'ry') patch = { ry: Math.min(1.5, Math.max(0.03, (-dx * Math.sin(a) + dy * Math.cos(a)) / p.h)) };
    }
    this.h.updateMask(patch, false);
  }

  // ---------- retoque de manchas ----------

  _spotHit(p, tolPx) {
    const spots = this.h.getSpotsView();
    const px = [p.x * p.w, p.y * p.h];
    // primero las asas del seleccionado, luego el interior de cualquiera
    const sel = this.h.selectedSpot();
    const order = [...spots.keys()].sort((a, b) => (b === sel) - (a === sel));
    for (const i of order) {
      const sp = spots[i];
      const c = [sp.cx * p.w, sp.cy * p.h]; const s = [sp.sx * p.w, sp.sy * p.h]; const rad = [sp.cx * p.w + sp.rw * p.w, sp.cy * p.h];
      if (Math.hypot(px[0] - s[0], px[1] - s[1]) <= tolPx) return { i, part: 'source' };
      if (Math.hypot(px[0] - rad[0], px[1] - rad[1]) <= tolPx * 0.8 && i === sel) return { i, part: 'radius' };
      if (((px[0] - c[0]) / (sp.rw * p.w)) ** 2 + ((px[1] - c[1]) / (sp.rh * p.h)) ** 2 <= 1.2) return { i, part: 'center' };
    }
    return null;
  }

  _drawSpots(ctx, W, H) {
    const d = this.dpr || 1;
    const spots = this.h.getSpotsView();
    spots.forEach((sp, i) => {
      const sel = i === this.h.selectedSpot();
      const cx = sp.cx * W; const cy = sp.cy * H; const sx = sp.sx * W; const sy = sp.sy * H;
      ctx.lineWidth = (sel ? 2.5 : 1.5) * d; ctx.strokeStyle = sel ? ACCENT : 'rgba(255,255,255,.85)';
      ctx.beginPath(); ctx.ellipse(cx, cy, sp.rw * W, sp.rh * H, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([6 * d, 5 * d]);
      ctx.beginPath(); ctx.ellipse(sx, sy, sp.rw * W, sp.rh * H, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sx, sy); ctx.stroke();
      ctx.setLineDash([]);
      if (sel) { ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(cx + sp.rw * W, cy, 5 * d, 0, Math.PI * 2); ctx.fill(); }
    });
  }

  // ---------- dibujo ----------

  draw() {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const W = c.width; const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const mode = this.h.getMode();
    if (mode === 'crop') this._drawCrop(ctx, W, H);
    else if (mode === 'mask') this._drawMask(ctx, W, H);
    else if (mode === 'spot') this._drawSpots(ctx, W, H);
  }

  _drawCrop(ctx, W, H) {
    const r = this.h.getCrop();
    const x = r.x * W; const y = r.y * H; const w = r.w * W; const h = r.h * H;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, W, y); ctx.fillRect(0, y + h, W, H - y - h);
    ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, W - x - w, h);
    const d = this.dpr || 1;
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5 * d;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = d;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3); ctx.stroke();
    }
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 3 * d;
    const L = 18 * d;
    for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(cx, cy + sy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * L, cy); ctx.stroke();
    }
  }

  _drawMask(ctx, W, H) {
    const m = this.h.getMask();
    if (!m) return;
    const d = this.dpr || 1;
    const hs = this._maskHandles(m, W, H);
    ctx.lineWidth = 2 * d; ctx.strokeStyle = ACCENT; ctx.fillStyle = ACCENT;
    const dot = (p, r = 7) => { ctx.beginPath(); ctx.arc(p[0], p[1], r * d, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = d; ctx.stroke(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 2 * d; };
    if (m.type === 'linear') {
      ctx.beginPath(); ctx.moveTo(...hs.p0); ctx.lineTo(...hs.p1); ctx.stroke();
      // líneas perpendiculares que marcan el principio y el final de la transición
      const dx = hs.p1[0] - hs.p0[0]; const dy = hs.p1[1] - hs.p0[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * W; const ny = (dx / len) * W;
      ctx.setLineDash([8 * d, 6 * d]);
      for (const p of [hs.p0, hs.p1]) { ctx.beginPath(); ctx.moveTo(p[0] - nx, p[1] - ny); ctx.lineTo(p[0] + nx, p[1] + ny); ctx.stroke(); }
      ctx.setLineDash([]);
      dot(hs.p0); dot(hs.p1);
    } else {
      const a = ((m.angle || 0) * Math.PI) / 180;
      ctx.beginPath();
      ctx.ellipse(hs.c[0], hs.c[1], m.rx * W, m.ry * H, a, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([6 * d, 6 * d]);
      ctx.beginPath();
      ctx.ellipse(hs.c[0], hs.c[1], m.rx * W * Math.max(0.05, 1 - m.feather), m.ry * H * Math.max(0.05, 1 - m.feather), a, 0, Math.PI * 2);
      ctx.stroke(); ctx.setLineDash([]);
      dot(hs.c); dot(hs.rx, 6); dot(hs.ry, 6);
    }
  }
}
