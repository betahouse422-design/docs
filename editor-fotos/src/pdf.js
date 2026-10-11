// Generador mínimo de PDF: una imagen JPEG por página, a tamaño de papel.
// Sin dependencias. Código puro (Uint8Array).

const enc = new TextEncoder();

function utf16hex(s) {
  let out = 'FEFF';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${out}>`;
}

// pages: [{ jpeg: Uint8Array, imgW, imgH, widthMm, heightMm }]
export function buildPdf(pages, { title = 'Impresión' } = {}) {
  if (!pages.length) throw new Error('No hay páginas para el PDF.');
  const chunks = []; const offsets = {};
  let length = 0;
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n${body}\nendobj\n`); };
  const streamObj = (n, dict, bytes) => {
    offsets[n] = length;
    push(`${n} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    push(bytes); push('\nendstream\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // comentario binario

  const pageObj = (i) => 4 + i * 3; const contentObj = (i) => 5 + i * 3; const imageObj = (i) => 6 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Title ${utf16hex(title)} /Producer (Editor de fotos) >>`);

  pages.forEach((p, i) => {
    const wpt = ((p.widthMm * 72) / 25.4).toFixed(3); const hpt = ((p.heightMm * 72) / 25.4).toFixed(3);
    obj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
    streamObj(contentObj(i), '', enc.encode(`q ${wpt} 0 0 ${hpt} 0 0 cm /Im0 Do Q`));
    streamObj(imageObj(i), `/Type /XObject /Subtype /Image /Width ${p.imgW} /Height ${p.imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
  });

  const count = 3 + pages.length * 3 + 1; // objetos + el 0
  const xrefPos = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(length); let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}
