// Editor de curvas sobre un <canvas>. Toque o ratón.
//  - arrastrar un punto: lo mueve
//  - tocar en vacío: añade un punto y lo arrastra
//  - doble clic / doble toque en un punto: lo borra

import { makeCurve, addPoint, movePoint, removePoint, nearestPoint } from './curves.js';

const COLORS = { master: '#e8e8ee', r: '#ff5a5a', g: '#4cd964', b: '#5a8bff' };

export class CurveEditor {
  // opts.onChange(channel, points, final)  final=true al soltar
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.onChange = opts.onChange;
    this.channel = 'master';
    this.points = [[0, 0], [1, 1]];
    this.active = -1;
    this.dragging = false;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('dblclick', (e) => this._dbl(e));
    this._lastTap = 0;
    this.draw();
  }

  setChannel(ch) { this.channel = ch; this.active = -1; this.draw(); }
  setPoints(points) { this.points = points.map((p) => p.slice()); this.draw(); }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  }

  _down(e) {
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* algunos navegadores lo rechazan; el arrastre sigue funcionando */ }
    const [x, y] = this._pos(e);
    // doble toque (táctil): borrar
    const now = performance.now();
    const hit = nearestPoint(this.points, x, y, 0.06);
    if (hit >= 0 && e.pointerType !== 'mouse' && now - this._lastTap < 320 && hit === this.active) {
      this.points = removePoint(this.points, hit); this.active = -1; this.dragging = false;
      this.onChange(this.channel, this.points, true); this.draw(); return;
    }
    this._lastTap = now;
    if (hit >= 0) { this.active = hit; }
    else {
      const r = addPoint(this.points, x, y);
      this.points = r.points; this.active = r.index;
      this.onChange(this.channel, this.points, false);
    }
    this.dragging = true;
    this.draw();
  }

  _move(e) {
    if (!this.dragging) return;
    const [x, y] = this._pos(e);
    this.points = movePoint(this.points, this.active, x, y);
    this.onChange(this.channel, this.points, false);
    this.draw();
  }

  _up() {
    if (!this.dragging) return;
    this.dragging = false;
    this.onChange(this.channel, this.points, true);
  }

  _dbl(e) {
    const [x, y] = this._pos(e);
    const hit = nearestPoint(this.points, x, y, 0.06);
    if (hit > 0 && hit < this.points.length - 1) {
      this.points = removePoint(this.points, hit); this.active = -1;
      this.onChange(this.channel, this.points, true); this.draw();
    }
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#16171b'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo((i / 4) * w, 0); ctx.lineTo((i / 4) * w, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (i / 4) * h); ctx.lineTo(w, (i / 4) * h); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
    const color = COLORS[this.channel];
    const f = makeCurve(this.points);
    ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      const px = x * w; const py = (1 - f(x)) * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    this.points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p[0] * w, (1 - p[1]) * h, (i === this.active ? 7 : 5) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = i === this.active ? color : '#16171b';
      ctx.fill(); ctx.lineWidth = 2 * dpr; ctx.strokeStyle = color; ctx.stroke();
    });
  }
}
