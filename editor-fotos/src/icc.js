// Perfiles de color ICC para impresión. Código puro (sin DOM).
//
// - makeSrgbProfile(): un perfil sRGB ICC v2 de matriz/curva generado aquí mismo (sin copiar ningún archivo de terceros).
// - embedIccInJpeg(): inserta un perfil en un JPEG (marcadores APP2 "ICC_PROFILE").
// - readIccHeader(): lee lo básico de un perfil que carga la persona (espacio de color, versión, descripción).
//
// El canvas del navegador exporta JPEG sin perfil: los lectores lo toman como sRGB, pero una imprenta o un RIP sin
// instrucciones puede interpretarlo distinto. Con el perfil incrustado, el color queda definido.

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const s15 = (v) => be32(Math.round(v * 65536) >>> 0); // s15Fixed16
const ascii = (str) => [...String(str).normalize('NFD').replace(/[^\x20-\x7e]/g, '')].map((c) => c.charCodeAt(0)); // ICC v2 usa ASCII: sin acentos
const pad4 = (arr) => { while (arr.length % 4) arr.push(0); return arr; };

// sRGB -> lineal (EOTF) para la tabla de curva
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// Perfil de matriz/curva v2.1 (clase "mntr", RGB -> XYZ D50): tres colorantes, una curva de gamma o la de sRGB.
// colorants = [[X,Y,Z] rojo, verde, azul] ya adaptados a D50. gamma = número, o 'srgb'.
export function makeMatrixProfile({ description = 'Perfil RGB', colorants, gamma = 'srgb' } = {}) {
  const xyzTag = (x, y, z) => [...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const text = (str) => pad4([...ascii('text'), 0, 0, 0, 0, ...ascii(str), 0]);
  const desc = (str) => { // textDescriptionType (v2): ASCII + Unicode vacío + ScriptCode vacío
    const a = [...ascii(str), 0];
    return pad4([...ascii('desc'), 0, 0, 0, 0, ...be32(a.length), ...a, ...be32(0), ...be32(0), ...be16(0), 0, ...new Array(67).fill(0)]);
  };
  const N = 1024; // puntos de la curva (compartida por R, G y B)
  const curve = [...ascii('curv'), 0, 0, 0, 0, ...be32(N)];
  for (let i = 0; i < N; i++) {
    const v = i / (N - 1);
    curve.push(...be16(Math.round((gamma === 'srgb' ? srgbToLinear(v) : v ** gamma) * 65535)));
  }
  pad4(curve);

  const tags = [
    ['desc', desc(description)],
    ['cprt', text('Sin copyright: perfil generado por Editor de fotos')],
    ['wtpt', xyzTag(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyzTag(...colorants[0])],
    ['gXYZ', xyzTag(...colorants[1])],
    ['bXYZ', xyzTag(...colorants[2])],
    ['rTRC', curve], ['gTRC', 'rTRC'], ['bTRC', 'rTRC'], // las tres curvas comparten los mismos datos
  ];
  const tableLen = 4 + tags.length * 12;
  let offset = 128 + tableLen; const placed = {}; const table = []; const body = [];
  for (const [sig, data] of tags) {
    if (typeof data === 'string') { table.push(...ascii(sig), ...be32(placed[data].offset), ...be32(placed[data].size)); continue; }
    placed[sig] = { offset, size: data.length };
    table.push(...ascii(sig), ...be32(offset), ...be32(data.length));
    body.push(...data); offset += data.length;
  }
  const size = 128 + tableLen + body.length;
  const header = [
    ...be32(size), 0, 0, 0, 0, 2, 0x10, 0, 0,        // tamaño, CMM, versión 2.1.0
    ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '),
    ...be16(2024), ...be16(1), ...be16(1), ...be16(0), ...be16(0), ...be16(0), // fecha fija: el perfil es reproducible
    ...ascii('acsp'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // plataforma, flags, fabricante, modelo, atributos
    ...be32(0),                                       // intención: perceptual
    ...s15(0.9642), ...s15(1.0), ...s15(0.8249),      // iluminante D50
    0, 0, 0, 0, ...new Array(44).fill(0),             // creador, id, reservado
  ];
  const out = new Uint8Array(size);
  out.set(header.slice(0, 128), 0);
  out.set(be32(tags.length), 128); out.set(table, 132); out.set(body, 128 + tableLen);
  return out;
}

// sRGB: colorantes de IEC 61966-2-1 adaptados a D50 (Bradford) y su curva.
export const SRGB_COLORANTS = [[0.43607, 0.22249, 0.01392], [0.38515, 0.71687, 0.09708], [0.14307, 0.06061, 0.71410]];
export const makeSrgbProfile = (description = 'sRGB (Editor de fotos)') => makeMatrixProfile({ description, colorants: SRGB_COLORANTS, gamma: 'srgb' });

// Lee la cabecera de un perfil ICC. Devuelve null si no parece un perfil.
export function readIccHeader(bytes) {
  if (!bytes || bytes.length < 132) return null;
  const s = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
  if (s(36, 4) !== 'acsp') return null;
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (size > bytes.length || size < 132) return null;
  const info = { size, version: `${bytes[8]}.${bytes[9] >> 4}`, cls: s(12, 4), space: s(16, 4).trim(), pcs: s(20, 4).trim(), intent: bytes[67], description: '' };
  // descripción: etiqueta 'desc' (v2) o 'mluc' (v4)
  const count = ((bytes[128] << 24) | (bytes[129] << 16) | (bytes[130] << 8) | bytes[131]) >>> 0;
  for (let i = 0; i < Math.min(count, 200); i++) {
    const o = 132 + i * 12;
    if (o + 12 > bytes.length) break;
    if (s(o, 4) === 'desc') {
      const off = ((bytes[o + 4] << 24) | (bytes[o + 5] << 16) | (bytes[o + 6] << 8) | bytes[o + 7]) >>> 0;
      const type = s(off, 4);
      if (type === 'desc') { const n = ((bytes[off + 8] << 24) | (bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11]) >>> 0; info.description = s(off + 12, Math.max(0, n - 1)); }
      else if (type === 'mluc') { const len = ((bytes[off + 20] << 24) | (bytes[off + 21] << 16) | (bytes[off + 22] << 8) | bytes[off + 23]) >>> 0; const so = ((bytes[off + 24] << 24) | (bytes[off + 25] << 16) | (bytes[off + 26] << 8) | bytes[off + 27]) >>> 0; let t = ''; for (let k = 0; k + 1 < len; k += 2) t += String.fromCharCode((bytes[off + so + k] << 8) | bytes[off + so + k + 1]); info.description = t; }
    }
  }
  return info;
}

// Quita de un JPEG los segmentos de perfil ICC que ya traiga (Chrome, por ejemplo, incrusta el suyo al exportar un canvas):
// dos juegos de perfil en el mismo archivo se interpretan mal.
function stripIcc(jpeg) {
  const keep = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const m = jpeg[i + 1]; const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (m === 0xda) break; // empiezan los datos de imagen
    const isIcc = m === 0xe2 && len >= 14 && String.fromCharCode(...jpeg.subarray(i + 4, i + 15)) === 'ICC_PROFILE';
    if (!isIcc) keep.push(jpeg.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  keep.push(jpeg.subarray(i));
  const out = new Uint8Array(keep.reduce((n, k) => n + k.length, 0));
  let p = 0; for (const k of keep) { out.set(k, p); p += k.length; }
  return out;
}

// Inserta `profile` en un JPEG (tras SOI y, si existe, tras JFIF), sustituyendo cualquier perfil anterior.
// Cada marcador APP2 admite 65519 bytes de perfil.
export function embedIccInJpeg(jpegIn, profile) {
  if (!(jpegIn[0] === 0xff && jpegIn[1] === 0xd8)) throw new Error('No es un JPEG.');
  const jpeg = stripIcc(jpegIn);
  const CHUNK = 65519; const total = Math.max(1, Math.ceil(profile.length / CHUNK));
  const marker = ascii('ICC_PROFILE').concat([0]);
  const parts = [];
  for (let i = 0; i < total; i++) {
    const data = profile.subarray(i * CHUNK, (i + 1) * CHUNK);
    const len = 2 + marker.length + 2 + data.length;
    parts.push(new Uint8Array([0xff, 0xe2, len >> 8, len & 255, ...marker, i + 1, total]), data);
  }
  let at = 2; // después de SOI
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]); // tras el APP0 (JFIF)
  const extra = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(jpeg.length + extra);
  out.set(jpeg.subarray(0, at), 0);
  let p = at; for (const part of parts) { out.set(part, p); p += part.length; }
  out.set(jpeg.subarray(at), p);
  return out;
}

// Extrae el perfil incrustado en un JPEG (o null). Para pruebas y para respetar perfiles de fotos que ya lo traen.
export function extractIccFromJpeg(jpeg) {
  const chunks = [];
  let i = 2;
  while (i + 4 < jpeg.length && jpeg[i] === 0xff) {
    const m = jpeg[i + 1]; const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (m === 0xda) break; // empiezan los datos de imagen
    if (m === 0xe2 && String.fromCharCode(...jpeg.slice(i + 4, i + 15)) === 'ICC_PROFILE') chunks.push({ n: jpeg[i + 16], data: jpeg.subarray(i + 18, i + 2 + len) });
    i += 2 + len;
  }
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.n - b.n);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.data.length, 0));
  let p = 0; for (const c of chunks) { out.set(c.data, p); p += c.data.length; }
  return out;
}
