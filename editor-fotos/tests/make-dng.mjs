// Genera un DNG sintético mínimo (mosaico Bayer RGGB de 16 bits sin comprimir) para probar el revelado RAW
// sin depender de archivos de cámara. `color(x, y)` devuelve el RGB LINEAL (0..1) que debe tener cada píxel.
// Se escribe con los primarios sRGB como "cámara", así que LibRaw debe devolver casi los mismos valores.

export function makeDng({ width = 96, height = 64, color, orientation = 1, black = 0, white = 65535 } = {}) {
  const f = color || (() => [0.18, 0.18, 0.18]);
  const data = new Uint16Array(width * height);
  const cfa = [[0, 1], [1, 2]]; // RGGB: 0 = R, 1 = G, 2 = B
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ch = cfa[y & 1][x & 1];
    const v = Math.max(0, Math.min(1, f(x, y)[ch]));
    data[y * width + x] = Math.round(black + v * (white - black));
  }
  const pixels = Buffer.from(data.buffer);

  const entries = []; // { tag, type, count, value: Buffer|number }
  const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SRATIONAL: 10 };
  const add = (tag, type, vals) => entries.push({ tag, type, vals: Array.isArray(vals) ? vals : [vals] });
  const rat = (v) => { const den = 10000; return [Math.round(v * den), den]; };

  add(254, T.LONG, 0);                      // NewSubfileType
  add(256, T.LONG, width); add(257, T.LONG, height);
  add(258, T.SHORT, 16); add(259, T.SHORT, 1);
  add(262, T.SHORT, 32803);                 // CFA
  add(273, T.LONG, 0);                      // StripOffsets (se rellena abajo)
  add(274, T.SHORT, orientation);
  add(277, T.SHORT, 1); add(278, T.LONG, height); add(279, T.LONG, pixels.length); add(284, T.SHORT, 1);
  add(33421, T.SHORT, [2, 2]); add(33422, T.BYTE, [0, 1, 1, 2]);
  add(50706, T.BYTE, [1, 4, 0, 0]); add(50707, T.BYTE, [1, 1, 0, 0]);
  add(50708, T.ASCII, 'Prueba Sintetica');
  add(50714, T.SHORT, black); add(50717, T.SHORT, white);
  // XYZ(D65) -> sRGB lineal: así la "cámara" es sRGB
  const m = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
  add(50721, T.SRATIONAL, m.flatMap(rat));
  add(50728, T.RATIONAL, [1, 1, 1].flatMap((v) => [v * 10000, 10000]));
  add(50778, T.SHORT, 21);                  // iluminante D65
  entries.sort((a, b) => a.tag - b.tag);

  const sizeOf = (e) => ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 }[e.type]);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize; // los datos que no caben en 4 bytes van tras la IFD
  const blobs = [];
  for (const e of entries) {
    const count = e.type === T.ASCII ? e.vals[0].length + 1 : e.type === T.RATIONAL || e.type === T.SRATIONAL ? e.vals.length / 2 : e.vals.length;
    e.count = count; e.bytes = e.type === T.ASCII ? count : count * sizeOf(e);
    if (e.bytes > 4) { e.offset = extra; extra += e.bytes + (e.bytes & 1); blobs.push(e); }
  }
  const stripOffset = extra;
  entries.find((e) => e.tag === 273).vals = [stripOffset];

  const out = Buffer.alloc(stripOffset + pixels.length);
  out.write('II', 0); out.writeUInt16LE(42, 2); out.writeUInt32LE(8, 4);
  let p = 8; out.writeUInt16LE(entries.length, p); p += 2;
  const writeVals = (buf, off, e) => {
    let o = off;
    if (e.type === T.ASCII) { buf.write(e.vals[0], o, 'ascii'); return; }
    for (const v of e.vals) {
      if (e.type === T.BYTE) buf.writeUInt8(v, o++);
      else if (e.type === T.SHORT) { buf.writeUInt16LE(v, o); o += 2; }
      else if (e.type === T.LONG) { buf.writeUInt32LE(v, o); o += 4; }
      else if (e.type === T.RATIONAL) { buf.writeUInt32LE(v, o); o += 4; }
      else if (e.type === T.SRATIONAL) { buf.writeInt32LE(v, o); o += 4; }
    }
  };
  for (const e of entries) {
    out.writeUInt16LE(e.tag, p); out.writeUInt16LE(e.type, p + 2); out.writeUInt32LE(e.count, p + 4);
    if (e.bytes > 4) out.writeUInt32LE(e.offset, p + 8); else writeVals(out, p + 8, e);
    p += 12;
  }
  out.writeUInt32LE(0, p);
  for (const e of blobs) writeVals(out, e.offset, e);
  pixels.copy(out, stripOffset);
  return out;
}

// Cuatro parches grandes (rojo, verde, azul y gris 18 %) con margen para que el desmosaico no los contamine.
export const patchesColor = (w, h) => (x, y) => {
  const col = Math.floor((x / w) * 4);
  return [[0.8, 0.05, 0.05], [0.05, 0.7, 0.05], [0.05, 0.05, 0.8], [0.18, 0.18, 0.18]][Math.min(3, col)];
};
