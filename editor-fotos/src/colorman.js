// Gestión de color para impresión con Little CMS (lcms-wasm). Se carga solo cuando se usa.
//
//  - convertCanvas: convierte los píxeles de un canvas de sRGB al perfil RGB de la imprenta (y devuelve el perfil
//    para incrustarlo). Así los colores quedan en el espacio que su equipo espera.
//  - softProofCanvas: simula en pantalla cómo se vería la impresión con cualquier perfil (RGB o CMYK):
//    sRGB -> perfil de la imprenta -> sRGB. No cambia lo que se exporta.
//
// Los perfiles los aporta la persona (los da la imprenta o el fabricante del papel); aquí no se incluye ninguno de terceros.

let lcmsPromise = null;
const getLcms = () => (lcmsPromise ||= import('../vendor/lcms-wasm/lcms.min.js').then(async (m) => ({
  m,
  lcms: await m.instantiate({ locateFile: () => new URL('../vendor/lcms-wasm/lcms.wasm', import.meta.url).href }),
})));

export const INTENTS = [
  { id: 'perceptual', label: 'Perceptual', value: 0 },
  { id: 'relative', label: 'Colorimétrico relativo', value: 1 },
  { id: 'saturation', label: 'Saturación', value: 2 },
  { id: 'absolute', label: 'Colorimétrico absoluto', value: 3 },
];
const intentValue = (id) => (INTENTS.find((i) => i.id === id) || INTENTS[1]).value;

// Abre un perfil y devuelve { handle, space ('RGB' | 'CMYK' | 'GRAY' | …), description } o lanza un Error claro.
function openProfile(lcms, bytes) {
  const h = lcms.cmsOpenProfileFromMem(bytes, bytes.length);
  if (!h) throw new Error('No se pudo leer el perfil de color. ¿Es un archivo .icc o .icm válido?');
  let space = '?'; let description = '';
  try { space = String(lcms.cmsGetColorSpaceASCII(h)).replace(/[^A-Za-z]/g, '') || '?'; } catch { /* sin espacio */ }
  try { description = lcms.cmsGetProfileInfoASCII(h, 0, 'en', 'US') || ''; } catch { /* sin descripción */ }
  return { handle: h, space, description };
}

// Información de un perfil (para mostrarla y validar la selección).
export async function profileInfo(bytes) {
  const { lcms } = await getLcms();
  const p = openProfile(lcms, bytes);
  try { return { space: p.space, description: p.description }; } finally { lcms.cmsCloseProfile(p.handle); }
}

// Aplica `transform` a un canvas por franjas (para no duplicar toda la imagen en la memoria de WebAssembly).
function runBands(lcms, transform, canvas, replaceWith) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const rows = Math.max(16, Math.floor(1.5e6 / width));
  for (let y = 0; y < height; y += rows) {
    const h = Math.min(rows, height - y);
    const img = ctx.getImageData(0, y, width, h);
    const out = lcms.cmsDoTransform(transform, img.data, width * h);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = out[i]; img.data[i + 1] = out[i + 1]; img.data[i + 2] = out[i + 2]; } // el alfa no se toca
    ctx.putImageData(img, 0, y);
  }
  return replaceWith;
}

// Convierte el canvas de sRGB al perfil RGB `profileBytes`. Devuelve true. Lanza si el perfil no es RGB.
export async function convertCanvas(canvas, profileBytes, { intent = 'relative', bpc = true } = {}) {
  const { m, lcms } = await getLcms();
  const out = openProfile(lcms, profileBytes);
  const srgb = lcms.cmsCreate_sRGBProfile();
  try {
    if (out.space !== 'RGB') throw new Error(`Este perfil es ${out.space}, no RGB: sirve para simular la impresión en pantalla, pero la exportación se hace en RGB.`);
    const flags = bpc ? m.cmsFLAGS_BLACKPOINTCOMPENSATION : 0;
    const t = lcms.cmsCreateTransform(srgb, m.TYPE_RGBA_8, out.handle, m.TYPE_RGBA_8, intentValue(intent), flags);
    if (!t) throw new Error('No se pudo crear la conversión de color con ese perfil.');
    try { runBands(lcms, t, canvas); } finally { lcms.cmsDeleteTransform(t); }
    return true;
  } finally { lcms.cmsCloseProfile(out.handle); lcms.cmsCloseProfile(srgb); }
}

// Simula en pantalla la impresión con el perfil dado (RGB o CMYK). gamutCheck pinta de gris lo que el papel no alcanza.
export async function softProofCanvas(canvas, profileBytes, { intent = 'relative', bpc = true, gamutCheck = false } = {}) {
  const { m, lcms } = await getLcms();
  const proof = openProfile(lcms, profileBytes);
  const srgb = lcms.cmsCreate_sRGBProfile();
  try {
    let flags = m.cmsFLAGS_SOFTPROOFING | (bpc ? m.cmsFLAGS_BLACKPOINTCOMPENSATION : 0);
    if (gamutCheck) flags |= m.cmsFLAGS_GAMUTCHECK;
    const t = lcms.cmsCreateProofingTransform(srgb, m.TYPE_RGBA_8, srgb, m.TYPE_RGBA_8, proof.handle, intentValue(intent), 1, flags);
    if (!t) throw new Error('No se pudo crear la simulación con ese perfil.');
    try { runBands(lcms, t, canvas); } finally { lcms.cmsDeleteTransform(t); }
    return true;
  } finally { lcms.cmsCloseProfile(proof.handle); lcms.cmsCloseProfile(srgb); }
}
