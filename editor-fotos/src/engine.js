// Motor de render WebGL2.
//
// Responsabilidades:
//  - subir la foto original como textura (nunca se modifica),
//  - preparar un desenfoque del original (para "claridad"),
//  - convertir las ediciones en uniformes y tablas de curvas,
//  - dibujar el resultado con la geometría (recorte, giro, enderezado).
// Todo el procesado de color ocurre en un solo shader (ver shaders.js).

import { VERT, VERT_VIEW, DOWN_FRAG, BLUR_FRAG, MAIN_FRAG } from './shaders.js';
import { buildLUT, LUT_SIZE } from './curves.js';
import { packRowsHalf } from './raw.js';
import { strokesToAlpha } from './brush.js';
import {
  HSL_RANGES, CURVE_CHANNELS, HSL_CURVES, lookActive, defaultEdits, curvesActive, hslCurvesActive, hslActive, gradingActive,
} from './model.js';

const BLUR_LONG_SIDE = 512;
const MAX_SOURCE_SIDE = 8192;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false,
    });
    if (!gl) throw new Error('Este navegador no soporta WebGL2.');
    this.gl = gl;
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), MAX_SOURCE_SIDE);
    this.maxRender = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 16384);

    this.progMain = this._program(VERT_VIEW, MAIN_FRAG);
    this.progDown = this._program(VERT, DOWN_FRAG);
    this.progBlur = this._program(VERT, BLUR_FRAG);

    // triángulo que cubre toda la pantalla
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of [this.progMain, this.progDown, this.progBlur]) {
      const loc = gl.getAttribLocation(p.program, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    this.srcTex = null;
    this.srcSize = [1, 1];
    this.blur = null; // { fboA, texA, fboB, texB, w, h }
    this.lutTex = this._makeLutTexture();
    this.brushTex = this._makeBrushTexture();
    this.brushKey = '';
    this.lookTex = this._makeLookTexture();
    this.lookId = null; this.lookInfo = null;
    this.lutKey = '';
    this.edits = defaultEdits();
    this.lastSize = [1, 1];
  }

  // ---------- carga de la foto ----------

  // source: ImageBitmap | HTMLImageElement | HTMLCanvasElement
  setSource(source) {
    const gl = this.gl;
    let w = source.width;
    let h = source.height;
    const scale = Math.min(1, this.maxTex / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    // pasar por un canvas 2D: limita el tamaño y deja subir con flipY
    const c2 = document.createElement('canvas');
    c2.width = cw; c2.height = ch;
    const ctx = c2.getContext('2d');
    ctx.drawImage(source, 0, 0, cw, ch);

    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, c2);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.srcSize = [cw, ch];
    this.maxLod = Math.floor(Math.log2(Math.max(cw, ch)));
    this._buildBlur();
  }

  // RAW revelado: RGB lineal de 16 bits (resultado de decodeRaw). Se sube como textura half-float (RGBA16F),
  // sin pasar por 8 bits, para conservar los detalles de luces y sombras. Devuelve false si la GPU no admite
  // texturas half-float con mipmaps (entonces el llamador usa setSource con un canvas de 8 bits).
  setSourceLinear(raw) {
    const gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) return false;
    const w = raw.width; const h = raw.height;
    if (Math.max(w, h) > this.maxTex) return false;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    // por franjas: la conversión a half-float no necesita una copia completa en memoria
    const band = Math.max(16, Math.min(512, Math.floor(4e6 / w)));
    const buf = new Uint16Array(w * band * 4);
    for (let y1 = h; y1 > 0; y1 -= band) {
      const y0 = Math.max(0, y1 - band); const rows = y1 - y0;
      packRowsHalf(raw, y0, y1, buf); // filas de arriba hacia abajo -> textura (origen abajo): la franja más alta de la imagen queda arriba
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, h - y1, w, rows, gl.RGBA, gl.HALF_FLOAT, buf.subarray(0, w * rows * 4));
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.srcSize = [w, h];
    this.maxLod = Math.floor(Math.log2(Math.max(w, h)));
    this._buildBlur();
    return true;
  }

  hasSource() { return !!this.srcTex; }

  // Libera la foto cargada (por ejemplo, al quitar la última de la biblioteca).
  clearSource() {
    const gl = this.gl;
    if (this.srcTex) { gl.deleteTexture(this.srcTex); this.srcTex = null; }
  }

  _buildBlur() {
    const gl = this.gl;
    const [sw, sh] = this.srcSize;
    const k = BLUR_LONG_SIDE / Math.max(sw, sh);
    const w = Math.max(8, Math.round(sw * Math.min(1, k)));
    const h = Math.max(8, Math.round(sh * Math.min(1, k)));
    if (this.blur) {
      gl.deleteFramebuffer(this.blur.fboA); gl.deleteTexture(this.blur.texA);
      gl.deleteFramebuffer(this.blur.fboB); gl.deleteTexture(this.blur.texB);
    }
    const mk = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    const A = mk();
    const B = mk();
    this.blur = { fboA: A.fbo, texA: A.tex, fboB: B.fbo, texB: B.tex, w, h };

    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, w, h);
    // 1) reducir el origen a A
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
    gl.useProgram(this.progDown.program);
    this._bindTex(0, this.srcTex);
    gl.uniform1i(this.progDown.u('u_tex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 2) horizontal A -> B
    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo);
    gl.useProgram(this.progBlur.program);
    this._bindTex(0, A.tex);
    gl.uniform1i(this.progBlur.u('u_tex'), 0);
    gl.uniform2f(this.progBlur.u('u_step'), 1 / w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 3) vertical B -> A
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
    this._bindTex(0, B.tex);
    gl.uniform2f(this.progBlur.u('u_step'), 0, 1 / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------- tablas de curvas ----------

  _makeLutTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 8, 0, gl.RGBA, gl.FLOAT, new Float32Array(LUT_SIZE * 8 * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // LUT 3D del look: RGBA16F N³ (se filtra en lineal entre nodos).
  _makeLookTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 2, 2, 2, 0, gl.RGBA, gl.FLOAT, new Float32Array(2 * 2 * 2 * 4));
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    return tex;
  }

  // lut = resultado de parseCube() o null para quitar el look. `id` identifica cuál está cargada.
  setLook(id, lut) {
    const gl = this.gl;
    if (!lut) { this.lookId = null; this.lookInfo = null; return; }
    gl.bindTexture(gl.TEXTURE_3D, this.lookTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, lut.data);
    this.lookId = id; this.lookInfo = { size: lut.size, min: lut.domainMin, max: lut.domainMax };
  }

  // Un solo RGBA8: el canal i guarda el pincel de la máscara activa número i.
  _makeBrushTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Rasteriza los pinceles solo cuando cambian (o cambia la proporción de la salida).
  _updateBrush(masks, geo) {
    const brushes = masks.map((m) => (m.type === 'brush' ? m.strokes || [] : null));
    if (!brushes.some((b) => b && b.length)) { this.brushKey = ''; return; }
    const aspect = geo.cw / geo.ch;
    const long = 1024;
    const W = Math.max(8, Math.round(aspect >= 1 ? long : long * aspect));
    const H = Math.max(8, Math.round(aspect >= 1 ? long / aspect : long));
    const key = `${W}x${H}|${JSON.stringify(brushes)}`;
    if (key === this.brushKey) return;
    this.brushKey = key;
    const data = new Uint8Array(W * H * 4);
    brushes.forEach((b, i) => {
      if (!b || !b.length || i > 3) return;
      const a = strokesToAlpha(b, W, H);
      for (let p = 0; p < a.length; p++) data[p * 4 + i] = a[p];
    });
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.brushTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  _updateLut(edits) {
    const key = JSON.stringify([edits.curves, edits.hslCurves]);
    if (key === this.lutKey) return;
    this.lutKey = key;
    const data = new Float32Array(LUT_SIZE * 8 * 4);
    CURVE_CHANNELS.forEach((ch, row) => {
      const lut = buildLUT(edits.curves[ch]);
      for (let i = 0; i < LUT_SIZE; i++) data[(row * LUT_SIZE + i) * 4] = lut[i];
    });
    HSL_CURVES.forEach((ch, k) => { // filas 4..6: tono, saturación, luminosidad por tono
      const lut = buildLUT(edits.hslCurves[ch]);
      for (let i = 0; i < LUT_SIZE; i++) data[((4 + k) * LUT_SIZE + i) * 4] = lut[i];
    });
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 8, gl.RGBA, gl.FLOAT, data);
  }

  // ---------- geometría ----------

  // Tamaño (px) del recorte en el espacio orientado, para las ediciones dadas.
  geometryInfo(edits, geometryEdit = false) {
    const g = edits.geometry;
    const [sw, sh] = this.srcSize;
    const odd = g.rotate90 % 2 === 1;
    const ow = odd ? sh : sw;
    const oh = odd ? sw : sh;
    const crop = geometryEdit ? { x: 0, y: 0, w: 1, h: 1 } : g.crop;
    const angle = geometryEdit ? 0 : (g.straighten * Math.PI) / 180;
    const cw = Math.max(1, crop.w * ow);
    const ch = Math.max(1, crop.h * oh);
    const ca = Math.abs(Math.cos(angle));
    const sa = Math.abs(Math.sin(angle));
    const fit = Math.min(cw / (cw * ca + ch * sa), ch / (cw * sa + ch * ca));
    return { ow, oh, crop, angle, cw, ch, fit };
  }

  // ---------- dibujo ----------

  // opts: { maxW, maxH, upscale, full, original, geometryEdit, view: { z, cx, cy } }
  //   view = zoom: z veces más cerca, centrado en (cx, cy) de la imagen recortada (0..1, origen arriba-izquierda)
  render(edits, opts = {}) {
    if (!this.srcTex) return null;
    const gl = this.gl;
    const e = opts.original ? { ...defaultEdits(), geometry: edits.geometry } : edits;
    const geo = this.geometryInfo(e, !!opts.geometryEdit);

    let scale;
    if (opts.full) {
      scale = Math.min(1, this.maxRender / Math.max(geo.cw, geo.ch));
    } else {
      const mw = opts.maxW || 1024;
      const mh = opts.maxH || 1024;
      scale = Math.min(opts.upscale ? 8 : 1, mw / geo.cw, mh / geo.ch);
    }
    const outW = Math.max(1, Math.round(geo.cw * scale));
    const outH = Math.max(1, Math.round(geo.ch * scale));
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW;
      this.canvas.height = outH;
    }
    this.lastSize = [outW, outH];

    this._updateLut(e);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.bindVertexArray(this.vao);
    const P = this.progMain;
    gl.useProgram(P.program);
    this._bindTex(0, this.srcTex);
    this._bindTex(1, this.blur.texA);
    this._bindTex(2, this.lutTex);
    this._bindTex(3, this.brushTex);
    gl.uniform1i(P.u('u_brush'), 3);
    gl.activeTexture(gl.TEXTURE0 + 4); gl.bindTexture(gl.TEXTURE_3D, this.lookTex);
    gl.uniform1i(P.u('u_look'), 4);
    // el look solo se aplica si su tabla ya está cargada en este motor
    const lookOn = lookActive(e) && this.lookInfo && this.lookId === e.look.id;
    gl.uniform1f(P.u('u_lookAmt'), lookOn ? e.look.intensity / 100 : 0);
    if (lookOn) {
      gl.uniform3fv(P.u('u_lookMin'), this.lookInfo.min); gl.uniform3fv(P.u('u_lookMax'), this.lookInfo.max);
      gl.uniform1f(P.u('u_lookSize'), this.lookInfo.size);
    }
    gl.uniform1i(P.u('u_src'), 0);
    gl.uniform1i(P.u('u_blur'), 1);
    gl.uniform1i(P.u('u_lut'), 2);

    // geometría
    gl.uniform2f(P.u('u_orientedSize'), geo.ow, geo.oh);
    // el modelo usa origen arriba-izquierda (como la pantalla); el shader, abajo-izquierda
    gl.uniform4f(P.u('u_crop'), geo.crop.x, 1 - geo.crop.y - geo.crop.h, geo.crop.w, geo.crop.h);
    gl.uniform2f(P.u('u_cropPx'), geo.cw, geo.ch);
    gl.uniform1f(P.u('u_angle'), geo.angle);
    gl.uniform1f(P.u('u_fit'), geo.fit);
    gl.uniform1i(P.u('u_rot'), ((e.geometry.rotate90 % 4) + 4) % 4);
    gl.uniform2f(P.u('u_flip'), e.geometry.flipH ? 1 : 0, e.geometry.flipV ? 1 : 0);
    const z = Math.max(1, Math.min(32, (opts.view && opts.view.z) || 1));
    const vc = opts.view && z > 1 ? [opts.view.cx, opts.view.cy] : [0.5, 0.5];
    gl.uniform3f(P.u('u_view'), z, vc[0], 1 - vc[1]);
    const lod = Math.min(this.maxLod, Math.max(0, Math.log2(Math.max(1, geo.cw / (outW * z)))));
    gl.uniform1f(P.u('u_lod0'), lod);
    gl.uniform1f(P.u('u_outLong'), Math.max(outW, outH) * z); // el grano se mide respecto a la imagen, no a la pantalla
    gl.uniform2f(P.u('u_outSize'), outW, outH);

    // ajustes globales
    const L = e.light;
    gl.uniform1f(P.u('u_exposure'), L.exposure);
    gl.uniform1f(P.u('u_brightness'), L.brightness);
    gl.uniform1f(P.u('u_contrast'), L.contrast);
    gl.uniform1f(P.u('u_highlights'), L.highlights);
    gl.uniform1f(P.u('u_shadows'), L.shadows);
    gl.uniform1f(P.u('u_whites'), L.whites);
    gl.uniform1f(P.u('u_blacks'), L.blacks);
    gl.uniform1f(P.u('u_temp'), e.color.temperature);
    gl.uniform1f(P.u('u_tint'), e.color.tint);
    gl.uniform1f(P.u('u_sat'), e.color.saturation);
    gl.uniform1f(P.u('u_vib'), e.color.vibrance);
    gl.uniform1f(P.u('u_clarity'), e.detail.clarity);
    gl.uniform1f(P.u('u_sharp'), e.detail.sharpness);
    gl.uniform1f(P.u('u_texture'), e.detail.texture || 0);
    gl.uniform1f(P.u('u_dehaze'), e.detail.dehaze || 0);
    gl.uniform1f(P.u('u_denoise'), e.detail.denoise || 0);
    gl.uniform1f(P.u('u_cdenoise'), e.detail.colorDenoise || 0);
    gl.uniform2f(P.u('u_srcTexel'), 1 / this.srcSize[0], 1 / this.srcSize[1]);
    gl.uniform1f(P.u('u_maxLod'), this.maxLod);

    // retoque de manchas (modelo: origen arriba; shader: origen abajo)
    const spots = (e.spots || []).slice(0, 16);
    gl.uniform1i(P.u('u_spotCount'), spots.length);
    const SA = new Float32Array(64); const SB = new Float32Array(64);
    spots.forEach((sp, i) => {
      SA.set([sp.x, 1 - sp.y, sp.r, sp.feather], i * 4);
      SB.set([sp.dx, -sp.dy, sp.opacity, sp.mode === 'clone' ? 1 : 0], i * 4);
    });
    gl.uniform4fv(P.u('u_spotA[0]'), SA);
    gl.uniform4fv(P.u('u_spotB[0]'), SB);
    gl.uniform1f(P.u('u_fade'), e.effects.fade);
    gl.uniform1f(P.u('u_vignette'), e.effects.vignette);
    gl.uniform1f(P.u('u_grain'), e.effects.grain);
    gl.uniform1f(P.u('u_grainSize'), e.effects.grainSize);
    gl.uniform1f(P.u('u_bloom'), e.effects.bloom);
    gl.uniform1f(P.u('u_halation'), e.effects.halation);

    gl.uniform1i(P.u('u_hslOn'), hslActive(e) ? 1 : 0);
    const hsl = new Float32Array(24);
    HSL_RANGES.forEach((r, i) => {
      hsl[i * 3] = e.color.hsl[r].h; hsl[i * 3 + 1] = e.color.hsl[r].s; hsl[i * 3 + 2] = e.color.hsl[r].l;
    });
    gl.uniform3fv(P.u('u_hsl[0]'), hsl);
    gl.uniform1i(P.u('u_curvesOn'), curvesActive(e) ? 1 : 0);
    gl.uniform1i(P.u('u_hslCurvesOn'), hslCurvesActive(e) ? 1 : 0);

    gl.uniform1i(P.u('u_gradOn'), gradingActive(e) ? 1 : 0);
    const G = e.grading;
    gl.uniform4f(P.u('u_gradS'), G.shadows.hue, G.shadows.sat / 100, 0, 0);
    gl.uniform4f(P.u('u_gradM'), G.mids.hue, G.mids.sat / 100, 0, 0);
    gl.uniform4f(P.u('u_gradH'), G.highlights.hue, G.highlights.sat / 100, 0, 0);
    gl.uniform1f(P.u('u_balance'), G.balance);

    // máscaras
    const masks = e.masks.filter((m) => m.enabled !== false).slice(0, 4);
    this._updateBrush(masks, geo);
    this._bindTex(3, this.brushTex);
    gl.uniform1i(P.u('u_maskCount'), masks.length);
    const A = new Float32Array(16); const B = new Float32Array(16);
    const C = new Float32Array(16); const D = new Float32Array(16);
    masks.forEach((m, i) => {
      A.set([m.type === 'linear' ? 0 : m.type === 'brush' ? 2 : 1, m.feather, m.invert ? 1 : 0, 0], i * 4);
      // mismas coordenadas con origen arriba -> origen abajo (el ángulo cambia de signo)
      if (m.type === 'linear') B.set([m.x0, 1 - m.y0, m.x1, 1 - m.y1], i * 4);
      else if (m.type === 'brush') B.set([0, 0, 0, 0], i * 4);
      else B.set([m.cx, 1 - m.cy, m.rx, m.ry], i * 4);
      C.set([(-(m.angle || 0) * Math.PI) / 180, m.adjust.exposure, m.adjust.contrast, m.adjust.saturation], i * 4);
      D.set([m.adjust.temperature, m.adjust.highlights, m.adjust.shadows, 0], i * 4);
    });
    gl.uniform4fv(P.u('u_mA[0]'), A);
    gl.uniform4fv(P.u('u_mB[0]'), B);
    gl.uniform4fv(P.u('u_mC[0]'), C);
    gl.uniform4fv(P.u('u_mD[0]'), D);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { width: outW, height: outH };
  }

  // ---------- salida ----------

  // Lee píxeles RGBA del canvas actual (fila 0 = arriba).
  readPixels() {
    const gl = this.gl;
    const [w, h] = this.lastSize;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }

  // Exporta a máxima resolución disponible y restaura la vista previa.
  async exportBlob(edits, { type = 'image/jpeg', quality = 0.92, restore } = {}) {
    this.render(edits, { full: true });
    // El tamaño se guarda ANTES de esperar: mientras se codifica la imagen, la
    // pantalla puede volver a dibujar la vista previa y cambiar lastSize.
    const [w, h] = this.lastSize;
    const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, type, quality));
    if (restore) restore();
    return { blob, width: w, height: h };
  }

  // ---------- internos ----------

  _bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  _program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('Error de shader: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Error al enlazar: ' + gl.getProgramInfoLog(program));
    }
    const cache = new Map();
    return {
      program,
      u: (name) => {
        if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
        return cache.get(name);
      },
    };
  }
}
