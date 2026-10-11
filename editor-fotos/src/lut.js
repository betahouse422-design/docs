// Looks LUT 3D en formato .cube (Adobe/Resolve). Código puro, sin DOM.
//
// Un .cube es una tabla N×N×N: para cada color de entrada guarda el color de salida.
// Aquí solo se lee y se valida; el motor la sube a la GPU como textura 3D.

export const MAX_LUT_SIZE = 65;      // 65³ × 4 canales × 4 bytes ≈ 4.5 MB: más no hace falta
export const MAX_CUBE_BYTES = 40e6;  // un .cube de 65³ en texto pesa ~ 8 MB

// Devuelve { title, size, data: Float32Array (RGBA, rojo variando más rápido), domainMin, domainMax }.
// Lanza Error con un mensaje en español si el archivo no sirve.
export function parseCube(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('El archivo .cube está vacío.');
  let size = 0; let title = '';
  let dmin = [0, 0, 0]; let dmax = [1, 1, 1];
  let dim1 = false;
  let data = null; let n = 0; let total = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const c = line.charCodeAt(0);
    const isNumeric = (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46; // dígito, -, +, .
    if (!isNumeric) {
      const parts = line.split(/\s+/);
      const key = parts[0].toUpperCase();
      if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
      else if (key === 'LUT_3D_SIZE') {
        size = parseInt(parts[1], 10);
        if (!Number.isInteger(size) || size < 2) throw new Error('Tamaño de LUT no válido.');
        if (size > MAX_LUT_SIZE) throw new Error(`La LUT es demasiado grande (${size}³; el máximo es ${MAX_LUT_SIZE}³).`);
        total = size * size * size;
        data = new Float32Array(total * 4);
      } else if (key === 'LUT_1D_SIZE') dim1 = true;
      else if (key === 'DOMAIN_MIN' && parts.length >= 4) dmin = parts.slice(1, 4).map(Number);
      else if (key === 'DOMAIN_MAX' && parts.length >= 4) dmax = parts.slice(1, 4).map(Number);
      continue;
    }
    if (dim1 && !size) throw new Error('Este .cube es una LUT 1D; solo se admiten LUT 3D.');
    if (!data) throw new Error('Falta LUT_3D_SIZE antes de los datos.');
    const p = line.split(/\s+/);
    if (p.length < 3) throw new Error(`Línea ${li + 1}: se esperaban 3 valores.`);
    const r = Number(p[0]); const g = Number(p[1]); const b = Number(p[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) throw new Error(`Línea ${li + 1}: valor no numérico.`);
    if (n >= total) throw new Error('Hay más filas de datos de las que indica LUT_3D_SIZE.');
    data[n * 4] = r; data[n * 4 + 1] = g; data[n * 4 + 2] = b; data[n * 4 + 3] = 1;
    n++;
  }
  if (!data) throw new Error('No es un archivo .cube con una LUT 3D.');
  if (n !== total) throw new Error(`Faltan datos: se esperaban ${total} filas y hay ${n}.`);
  if (dmin.some((v) => !Number.isFinite(v)) || dmax.some((v) => !Number.isFinite(v)) || dmax.some((v, i) => v <= dmin[i])) {
    throw new Error('DOMAIN_MIN / DOMAIN_MAX no válidos.');
  }
  return { title: title || '', size, data, domainMin: dmin, domainMax: dmax };
}

// Identidad de tamaño N: sirve para pruebas y para comparar.
export function identityLut(size = 17) {
  const data = new Float32Array(size ** 3 * 4);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    data[i++] = r / (size - 1); data[i++] = g / (size - 1); data[i++] = b / (size - 1); data[i++] = 1;
  }
  return { title: 'Identidad', size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

// Texto .cube a partir de una función (r,g,b)->[r,g,b]; para generar looks de prueba.
export function cubeText(size, fn, title = 'prueba') {
  const out = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const v = fn(r / (size - 1), g / (size - 1), b / (size - 1));
    out.push(`${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}`);
  }
  return out.join('\n');
}
