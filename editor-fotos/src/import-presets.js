// Importa presets de otros editores y los convierte a las ediciones de esta app.
// Código puro (sin DOM), probado en Node.
//
// Formatos:
//  - Lightroom / Camera Raw: .xmp (preset moderno) y .lrtemplate (Lua, antiguo)
//  - RawTherapee: .pp3 (y .arp de ART, mismo estilo INI: solo se leen las claves conocidas)
//
// La conversión es APROXIMADA: cada programa renderiza distinto, así que un preset
// importado se parecerá, no será idéntico. Lo que no tiene equivalente aquí se
// ignora y se informa en `report.ignored`.

import { defaultEdits, migrate, HSL_RANGES, SLIDER_GROUPS, getPath, setPath } from './model.js';
import { normalizePoints, isIdentity } from './curves.js';

const COLORS = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta' };

// Claves de Lightroom que se conocen pero no tienen equivalente en esta app.
const KNOWN_UNSUPPORTED = new Set([
  'Dehaze', 'Texture', 'LuminanceSmoothing', 'ColorNoiseReduction', 'SharpenRadius', 'SharpnessRadius',
  'SharpnessDetail', 'SharpnessEdgeMasking', 'SharpnessMasking', 'LuminanceNoiseReductionDetail',
  'GrainFrequency', 'GrainRoughness', 'PostCropVignetteMidpoint', 'PostCropVignetteFeather',
  'PostCropVignetteRoundness', 'PostCropVignetteStyle', 'PostCropVignetteHighlightContrast',
  'ColorGradeGlobalHue', 'ColorGradeGlobalSat', 'ColorGradeGlobalLum', 'ColorGradeBlending',
  'ColorGradeShadowLum', 'ColorGradeMidtoneLum', 'ColorGradeHighlightLum',
  'ParametricShadows', 'ParametricDarks', 'ParametricLights', 'ParametricHighlights',
  'ParametricShadowSplit', 'ParametricMidtoneSplit', 'ParametricHighlightSplit',
  'RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation', 'ShadowTint',
  'DefringePurpleAmount', 'DefringeGreenAmount', 'AutoLateralCA', 'LensProfileEnable', 'LensProfileSetup',
]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, n = 3) => { const f = 10 ** n; return Math.round(v * f) / f; };

// "+15" -> 15, "-0.5" -> -0.5, "True" -> true, texto -> texto
function parseScalar(raw) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// ================= conversión desde ajustes de Lightroom =================

// settings: objeto { Clave: valor | [x0, y0, x1, y1, ...] (curvas) }
export function fromLightroomSettings(settings, name = 'Preset') {
  const e = defaultEdits();
  const mapped = [];
  const used = new Set();
  const num = (...keys) => {
    for (const k of keys) {
      const v = settings[k];
      if (v === undefined) continue;
      const n = typeof v === 'number' ? v : Number(parseScalar(String(v)));
      if (Number.isFinite(n)) { used.add(k); return n; }
    }
    return undefined;
  };
  const put = (path, v, label) => {
    if (v === undefined) return;
    const spec = SLIDER_GROUPS.flatMap((g) => g.sliders).find((s) => s.path === path);
    const val = spec ? clamp(v, spec.min, spec.max) : v;
    setPath(e, path, round(val));
    if (val !== getPath(defaultEdits(), path)) mapped.push(label || path);
  };

  // luz
  put('light.exposure', num('Exposure2012', 'Exposure'), 'Exposición');
  put('light.contrast', num('Contrast2012', 'Contrast'), 'Contraste');
  put('light.highlights', num('Highlights2012'), 'Luces');
  put('light.shadows', num('Shadows2012'), 'Sombras');
  put('light.whites', num('Whites2012'), 'Blancos');
  put('light.blacks', num('Blacks2012'), 'Negros');

  // color
  put('color.saturation', num('Saturation'), 'Saturación');
  put('color.vibrance', num('Vibrance'), 'Vibrance');
  put('detail.clarity', num('Clarity2012', 'Clarity'), 'Claridad');
  const sharp = num('Sharpness');
  if (sharp !== undefined) put('detail.sharpness', (sharp * 100) / 150, 'Nitidez');

  // temperatura: con signo (+400) es un desplazamiento; sin signo (6500) es absoluta
  const tRaw = settings.Temperature;
  if (tRaw !== undefined) {
    const n = Number(parseScalar(String(tRaw)));
    if (Number.isFinite(n)) {
      used.add('Temperature');
      const relative = typeof tRaw === 'string' ? /^[+-]/.test(tRaw.trim()) : Math.abs(n) < 2000;
      put('color.temperature', relative ? n / 10 : (n - 5500) / 20, 'Temperatura');
    }
  }
  put('color.tint', num('Tint'), 'Tinte');

  // HSL por color
  for (const r of HSL_RANGES) {
    const C = COLORS[r];
    const h = num(`HueAdjustment${C}`); const s = num(`SaturationAdjustment${C}`); const l = num(`LuminanceAdjustment${C}`);
    if (h !== undefined) e.color.hsl[r].h = clamp(h, -100, 100);
    if (s !== undefined) e.color.hsl[r].s = clamp(s, -100, 100);
    if (l !== undefined) e.color.hsl[r].l = clamp(l, -100, 100);
    if (e.color.hsl[r].h || e.color.hsl[r].s || e.color.hsl[r].l) mapped.push(`HSL ${r}`);
  }

  // gradación (Lightroom moderno) o división de tonos (antiguo)
  const grade = (zone, hueKeys, satKeys) => {
    const hue = num(...hueKeys); const sat = num(...satKeys);
    if (sat !== undefined && sat !== 0) {
      e.grading[zone].sat = clamp(sat, 0, 100);
      if (hue !== undefined) e.grading[zone].hue = clamp(hue, 0, 360);
      mapped.push(`Gradación ${zone}`);
    }
  };
  grade('shadows', ['ColorGradeShadowHue', 'SplitToningShadowHue'], ['ColorGradeShadowSat', 'SplitToningShadowSaturation']);
  grade('mids', ['ColorGradeMidtoneHue'], ['ColorGradeMidtoneSat']);
  grade('highlights', ['ColorGradeHighlightHue', 'SplitToningHighlightHue'], ['ColorGradeHighlightSat', 'SplitToningHighlightSaturation']);
  const bal = num('ColorGradeBalance', 'SplitToningBalance');
  if (bal !== undefined && (e.grading.shadows.sat || e.grading.mids.sat || e.grading.highlights.sat)) e.grading.balance = clamp(bal, -100, 100);

  // efectos
  put('effects.grain', num('GrainAmount'), 'Grano');
  const gs = num('GrainSize');
  if (gs !== undefined && (e.effects.grain > 0)) e.effects.grainSize = clamp(gs, 1, 100);
  put('effects.vignette', num('PostCropVignetteAmount'), 'Viñeta');

  // curvas (0..255 -> 0..1)
  const curve = (key, ch, label) => {
    const arr = settings[key];
    if (!Array.isArray(arr) || arr.length < 4) return;
    const pts = [];
    for (let i = 0; i + 1 < arr.length; i += 2) pts.push([Number(arr[i]) / 255, Number(arr[i + 1]) / 255]);
    if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return;
    const clean = normalizePoints(pts);
    clean[0][0] = 0; clean[clean.length - 1][0] = 1;
    used.add(key);
    if (!isIdentity(clean)) { e.curves[ch] = clean.map(([x, y]) => [round(x, 4), round(y, 4)]); mapped.push(label); }
  };
  curve('ToneCurvePV2012', 'master', 'Curva RGB');
  curve('ToneCurvePV2012Red', 'r', 'Curva roja');
  curve('ToneCurvePV2012Green', 'g', 'Curva verde');
  curve('ToneCurvePV2012Blue', 'b', 'Curva azul');

  // blanco y negro
  const mono = settings.ConvertToGrayscale === true || /^true$/i.test(String(settings.ConvertToGrayscale)) ||
    String(settings.Treatment || '').toLowerCase() === 'monochrome';
  if (mono) {
    e.color.saturation = -100;
    mapped.push('Blanco y negro');
    for (const r of HSL_RANGES) {
      const g = num(`GrayMixer${COLORS[r]}`);
      if (g !== undefined) { e.color.hsl[r].l = clamp(g, -100, 100); e.color.hsl[r].s = 0; e.color.hsl[r].h = 0; }
    }
  }

  const ignored = Object.keys(settings).filter((k) => KNOWN_UNSUPPORTED.has(k) && !isZero(settings[k]));
  return { name, edits: migrate(e), report: { mapped: [...new Set(mapped)], ignored } };
}

function isZero(v) { const n = Number(parseScalar(String(v))); return Number.isFinite(n) && n === 0; }

// ================= .xmp =================

const decodeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseXmp(text, fallbackName = 'Preset') {
  if (!/crs:|camera-raw-settings/.test(text)) throw new Error('El archivo no parece un preset XMP de Lightroom.');
  const settings = {};
  // Los ajustes simples son atributos: crs:Clave="valor". Se descartan los de metadatos.
  const desc = text.match(/<rdf:Description\b[^>]*>/);
  const attrs = desc ? desc[0] : text;
  for (const m of attrs.matchAll(/crs:([A-Za-z0-9]+)="([^"]*)"/g)) settings[m[1]] = decodeXml(m[2]);

  // Curvas: <crs:ToneCurvePV2012...><rdf:Seq><rdf:li>x, y</rdf:li>...
  for (const m of text.matchAll(/<crs:(ToneCurvePV2012(?:Red|Green|Blue)?)>\s*<rdf:Seq>([\s\S]*?)<\/rdf:Seq>/g)) {
    const nums = [...m[2].matchAll(/<rdf:li>\s*([-\d.]+)\s*,\s*([-\d.]+)\s*<\/rdf:li>/g)].flatMap((p) => [Number(p[1]), Number(p[2])]);
    if (nums.length >= 4) settings[m[1]] = nums;
  }
  // Nombre y grupo (elementos con rdf:li) o atributo Name
  const nm = text.match(/<crs:Name>[\s\S]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/);
  const grp = text.match(/<crs:Group>[\s\S]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/);
  const name = decodeXml((nm && nm[1].trim()) || (settings.Name && String(settings.Name)) || fallbackName);
  const out = fromLightroomSettings(settings, name);
  if (grp && grp[1].trim()) out.group = decodeXml(grp[1].trim());
  return out;
}

// ================= .lrtemplate (tabla Lua) =================

// Lector mínimo de tablas Lua: { clave = valor, ... } con números, textos, booleanos y listas.
function parseLuaTable(src) {
  let i = 0;
  const ws = () => { while (i < src.length) { if (/\s/.test(src[i])) i++; else if (src[i] === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; } else break; } };
  function value() {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    const m = src.slice(i).match(/^(true|false|nil|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!m) throw new Error(`Valor inesperado en la posición ${i}`);
    i += m[0].length;
    if (m[0] === 'true') return true; if (m[0] === 'false') return false; if (m[0] === 'nil') return null;
    return Number(m[0]);
  }
  function str() {
    const q = src[i++]; let out = '';
    while (i < src.length && src[i] !== q) { if (src[i] === '\\') { i++; } out += src[i++]; }
    i++; return out;
  }
  function table() {
    i++; // {
    const obj = {}; const arr = [];
    for (;;) {
      ws();
      if (src[i] === '}') { i++; break; }
      if (i >= src.length) throw new Error('Tabla sin cerrar');
      const kv = src.slice(i).match(/^(?:\[\s*"([^"]+)"\s*\]|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*/);
      if (kv) { i += kv[0].length; obj[kv[1] ?? kv[2]] = value(); } else arr.push(value());
      ws();
      if (src[i] === ',' || src[i] === ';') i++;
    }
    return arr.length && !Object.keys(obj).length ? arr : obj;
  }
  ws();
  const head = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/);
  if (head) i += head[0].length;
  return value();
}

export function parseLrtemplate(text, fallbackName = 'Preset') {
  let root;
  try { root = parseLuaTable(text); } catch (err) { throw new Error('No se pudo leer el .lrtemplate: ' + err.message); }
  const settings = root && root.value && root.value.settings;
  if (!settings || typeof settings !== 'object') throw new Error('El .lrtemplate no contiene ajustes de revelado.');
  const name = String(root.title || root.internalName || fallbackName);
  return fromLightroomSettings(settings, name);
}

// ================= .pp3 / .arp (RawTherapee, ART) =================

function parseIni(text) {
  const sec = {}; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(';') || t.startsWith('#')) continue;
    const m = t.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; sec[cur] = sec[cur] || {}; continue; }
    const kv = t.match(/^([^=]+)=(.*)$/);
    if (kv && cur) sec[cur][kv[1].trim()] = kv[2].trim();
  }
  return sec;
}

export function parsePp3(text, fallbackName = 'Preset') {
  const ini = parseIni(text);
  if (!Object.keys(ini).length) throw new Error('El archivo no parece un perfil de RawTherapee (.pp3).');
  const e = defaultEdits(); const mapped = []; const ignored = [];
  const n = (sec, key) => { const v = ini[sec] && ini[sec][key]; const x = Number(v); return v !== undefined && Number.isFinite(x) ? x : undefined; };
  const on = (sec) => !ini[sec] || ini[sec].Enabled === undefined || /true/i.test(ini[sec].Enabled);
  const set = (path, v, label) => {
    if (v === undefined || v === 0) return;
    const spec = SLIDER_GROUPS.flatMap((g) => g.sliders).find((s) => s.path === path);
    setPath(e, path, round(clamp(v, spec.min, spec.max))); mapped.push(label);
  };
  set('light.exposure', n('Exposure', 'Compensation'), 'Exposición');
  set('light.brightness', n('Exposure', 'Brightness'), 'Brillo');
  set('light.contrast', n('Exposure', 'Contrast'), 'Contraste');
  set('color.saturation', n('Exposure', 'Saturation'), 'Saturación');
  if (on('Vibrance')) {
    const p = n('Vibrance', 'Pastels'); const s = n('Vibrance', 'Saturated');
    if (p !== undefined || s !== undefined) set('color.vibrance', ((p || 0) + (s || 0)) / 2, 'Vibrance');
  }
  if (ini['Shadows & Highlights'] && on('Shadows & Highlights')) {
    const h = n('Shadows & Highlights', 'Highlights'); const s = n('Shadows & Highlights', 'Shadows');
    set('light.highlights', h === undefined ? undefined : -h, 'Luces');
    set('light.shadows', s, 'Sombras');
  }
  // Curva de luminancia (Lab "L"): lista "tipo;x;y;x;y;..." con tipo 1 (spline), 3 (NURBS) o 4 (Catmull-Rom)
  if (ini['Luminance Curve'] && on('Luminance Curve') && ini['Luminance Curve'].LCurve) {
    const parts = ini['Luminance Curve'].LCurve.split(';').filter((x) => x !== '').map(Number);
    if (parts.length >= 5 && [1, 3, 4].includes(parts[0]) && parts.slice(1).every(Number.isFinite)) {
      const pts = [];
      for (let i = 1; i + 1 < parts.length; i += 2) pts.push([parts[i], parts[i + 1]]);
      const clean = normalizePoints(pts); clean[0][0] = 0; clean[clean.length - 1][0] = 1;
      if (!isIdentity(clean)) { e.curves.master = clean.map(([x, y]) => [round(x, 4), round(y, 4)]); mapped.push('Curva RGB'); }
    }
  }
  for (const k of ['White Balance', 'HSV Equalizer', 'Color Toning', 'Vignetting', 'ColorToning', 'LensProfile', 'Directional Pyramid Denoising']) {
    if (ini[k] && on(k)) ignored.push(k);
  }
  return { name: fallbackName, edits: migrate(e), report: { mapped: [...new Set(mapped)], ignored } };
}

// ================= punto de entrada por nombre de archivo =================

export function parsePresetText(filename, text) {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const ext = (filename.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  if (ext === 'xmp') return parseXmp(text, base);
  if (ext === 'lrtemplate') return parseLrtemplate(text, base);
  if (ext === 'pp3' || ext === 'arp') return parsePp3(text, base);
  throw new Error(`Formato no soportado: .${ext || '?'}`);
}

export const SUPPORTED_EXTENSIONS = ['json', 'xmp', 'lrtemplate', 'pp3', 'arp'];
