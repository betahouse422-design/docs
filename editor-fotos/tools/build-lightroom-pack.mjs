// Convierte una carpeta de presets .xmp de Lightroom en un paquete JSON para esta app.
// Uso: node tools/build-lightroom-pack.mjs <carpeta> <salida.json> --id X --name "Nombre"
//        --repo URL --commit HASH --license MIT --author NOMBRE
// Guarda solo las diferencias respecto a los ajustes neutros (el paquete pesa menos).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parsePresetText } from '../src/import-presets.js';
import { defaultEdits, isNeutral } from '../src/model.js';

const [dir, out, ...rest] = process.argv.slice(2);
const opt = (k, d = '') => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
if (!dir || !out) { console.error('Uso: node tools/build-lightroom-pack.mjs <carpeta> <salida.json> [--id --name --repo --commit --license --author]'); process.exit(1); }

function walk(d, o = []) {
  for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, o); else if (/\.xmp$/i.test(f)) o.push(p); }
  return o;
}

// diferencia recursiva respecto al neutro (las listas, como las curvas, se guardan enteras)
function diff(a, b) {
  if (Array.isArray(a) || typeof a !== 'object' || a === null) return JSON.stringify(a) === JSON.stringify(b) ? undefined : a;
  const o = {};
  for (const k of Object.keys(a)) { const d = diff(a[k], b ? b[k] : undefined); if (d !== undefined && !(typeof d === 'object' && !Array.isArray(d) && !Object.keys(d).length)) o[k] = d; }
  return Object.keys(o).length ? o : undefined;
}

const neutral = defaultEdits();
const presets = []; const skipped = []; const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ids = new Set();
for (const f of walk(dir)) {
  try {
    const r = parsePresetText(f, readFileSync(f, 'utf8'));
    if (isNeutral(r.edits)) { skipped.push(relative(dir, f)); continue; }
    const folder = relative(dir, f).split(sep)[0];
    const group = r.group || folder;
    let id = `${opt('id', 'pk')}-${slug(group)}-${slug(r.name)}`; let n = 2; while (ids.has(id)) id = `${id.replace(/-\d+$/, '')}-${n++}`;
    ids.add(id);
    const e = diff(r.edits, neutral) || {}; delete e.v;
    presets.push({ id, name: r.name, group, edits: e });
  } catch (err) { skipped.push(`${relative(dir, f)}: ${err.message}`); }
}
const groups = [...new Set(presets.map((p) => p.group))];
const pack = {
  format: 'editor-fotos-pack', version: 1, id: opt('id', 'pk'), name: opt('name', 'Paquete'),
  source: { repo: opt('repo'), commit: opt('commit'), license: opt('license'), author: opt('author') },
  note: 'Conversión aproximada a los ajustes de esta app; no es idéntica al original.',
  groups, presets,
};
writeFileSync(out, JSON.stringify(pack));
console.log(`${presets.length} presets en ${groups.length} grupos -> ${out} (${(JSON.stringify(pack).length / 1024).toFixed(0)} KB). Omitidos: ${skipped.length}`);
if (skipped.length) console.log(skipped.slice(0, 8).join('\n'));
