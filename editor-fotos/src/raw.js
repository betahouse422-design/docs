// Fotos RAW (ARW, CR2, CR3, NEF, DNG, RAF, ORF, RW2…) con LibRaw compilado a WebAssembly.
//
// Se revelan a RGB LINEAL de 16 bits con el balance de blancos de la cámara y primarios sRGB, sin ajuste
// automático de brillo ni curva: así el motor recibe la luz de la escena tal cual y los ajustes de exposición
// y de luces recuperan detalle que un JPEG ya habría perdido.
//
// El decodificador (LibRaw, vendor/libraw-wasm) se carga solo cuando hace falta.

export const RAW_EXTENSIONS = [
  'arw', 'sr2', 'srf', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'dng', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'srw',
  '3fr', 'fff', 'erf', 'kdc', 'dcr', 'mrw', 'iiq', 'mef', 'mos', 'x3f', 'raw',
];
const RAW_RE = new RegExp(`\\.(${RAW_EXTENSIONS.join('|')})$`, 'i');

export const isRawName = (name) => RAW_RE.test(String(name || ''));
// Para <input accept="..."> : imágenes normales + extensiones RAW
export const RAW_ACCEPT = RAW_EXTENSIONS.map((e) => `.${e}`).join(',');

// Lado largo máximo que se desarrolla a tamaño completo (más grande = media resolución, para no agotar la memoria)
export const MAX_FULL_SIDE = 8192;

let libPromise = null;
const loadLib = () => (libPromise ||= import('../vendor/libraw-wasm/index.js').then((m) => m.default));

// Metadatos legibles de la toma
function pickMeta(m) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    make: String(m.camera_make || '').trim(), model: String(m.camera_model || '').trim(),
    iso: num(m.iso_speed), shutter: num(m.shutter), aperture: num(m.aperture), focal: num(m.focal_len),
    time: m.timestamp instanceof Date && !Number.isNaN(+m.timestamp) ? +m.timestamp : null,
  };
}

// Revela `blob` (File/Blob RAW). opts.half = media resolución (4 veces menos píxeles, mucho más rápido).
// Devuelve { width, height, data: Uint16Array RGB entrelazado y lineal (0..65535), meta, half }.
export async function decodeRaw(blob, { half = false } = {}) {
  const LibRaw = await loadLib();
  const raw = new LibRaw();
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await raw.open(bytes, {
      useCameraWb: true, useCameraMatrix: 1, outputColor: 1, outputBps: 16,
      gamm: [1, 1, 0, 0, 0, 0],   // curva lineal (el envoltorio exige las 6 posiciones)
      noAutoBright: true,         // sin "autobrillo": la exposición la decide la persona
      adjustMaximumThr: 0,        // respeta el nivel de blanco de la cámara (no reescala por el parche más claro)
      userQual: 3, highlight: 0, halfSize: !!half,
    });
    const meta = await raw.metadata();
    const img = await raw.imageData();
    if (!img || !img.data || !img.width || !img.height) throw new Error('vacío');
    if (img.bits !== 16 || img.colors !== 3) throw new Error('formato de salida inesperado');
    return { width: img.width, height: img.height, data: img.data, meta: pickMeta(meta), half: !!half };
  } catch (err) {
    throw new Error(`No se pudo revelar el RAW (${(err && err.message) || err}). Puede ser un formato o una compresión que aún no se admite.`);
  } finally {
    if (raw.dispose) raw.dispose();
  }
}

// ¿Conviene revelar a tamaño completo? Solo en pantallas con memoria de sobra y si la foto cabe en una textura.
export function canDecodeFull(width, height) { return Math.max(width, height) <= MAX_FULL_SIDE; }

// ---- conversión a half-float (para la textura RGBA16F) ----

const HALF_LUT = (() => {
  const t = new Uint16Array(65536);
  const f32 = new Float32Array(1); const u32 = new Uint32Array(f32.buffer);
  for (let v = 0; v < 65536; v++) {
    f32[0] = v / 65535; const x = u32[0];
    const sign = (x >>> 16) & 0x8000; let exp = ((x >>> 23) & 0xff) - 127 + 15; let man = x & 0x7fffff;
    let h;
    if (v === 0) h = 0;
    else if (exp <= 0) { man |= 0x800000; const shift = 14 - exp; h = shift > 24 ? 0 : (man >> shift) + ((man >> (shift - 1)) & 1); }
    else if (exp >= 31) h = 0x7bff;
    else { h = (exp << 10) | (man >> 13); h += (man >> 12) & 1; } // redondeo al más cercano
    t[v] = sign | h;
  }
  return t;
})();
export const HALF_ONE = 0x3c00;

// Rellena `out` (Uint16Array RGBA half-float) con las filas [y0, y1) de `raw`, volteadas en vertical (la textura
// tiene el origen abajo). `out` debe medir width * (y1 - y0) * 4.
export function packRowsHalf(raw, y0, y1, out) {
  const { width, data } = raw;
  let o = 0;
  for (let y = y1 - 1; y >= y0; y--) {
    let i = y * width * 3;
    for (let x = 0; x < width; x++, i += 3) { out[o++] = HALF_LUT[data[i]]; out[o++] = HALF_LUT[data[i + 1]]; out[o++] = HALF_LUT[data[i + 2]]; out[o++] = HALF_ONE; }
  }
  return out;
}

// Plan B si la tarjeta gráfica no admite texturas float: canvas de 8 bits en sRGB.
const SRGB8 = (() => {
  const t = new Uint8ClampedArray(65536);
  for (let v = 0; v < 65536; v++) { const l = v / 65535; t[v] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055)); }
  return t;
})();
export function rawToCanvas(raw) {
  const { width, height, data } = raw;
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(width, height); const d = img.data;
  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) { d[o] = SRGB8[data[i]]; d[o + 1] = SRGB8[data[i + 1]]; d[o + 2] = SRGB8[data[i + 2]]; d[o + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}
