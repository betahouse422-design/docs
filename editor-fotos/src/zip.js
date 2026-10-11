// Empaquetador ZIP mínimo (sin compresión: los JPEG ya van comprimidos). Código puro.

const enc = new TextEncoder();
let TABLE = null;

export function crc32(bytes) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// files: [{ name, data: Uint8Array }]. Los nombres se guardan en UTF-8.
export function buildZip(files, when = new Date()) {
  const { time, date } = dosDateTime(when);
  const chunks = []; const central = []; let offset = 0;
  const u16 = (v) => [v & 255, (v >> 8) & 255];
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data); const size = f.data.length;
    const flags = 0x0800; // nombres en UTF-8
    const local = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(flags), ...u16(0), ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
    chunks.push(local, name, f.data);
    central.push({ name, crc, size, offset, flags });
    offset += local.length + name.length + size;
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(c.flags), ...u16(0), ...u16(time), ...u16(date), ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)]);
    chunks.push(h, c.name); offset += h.length + c.name.length;
  }
  const cdSize = offset - cdStart;
  chunks.push(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total); let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}
