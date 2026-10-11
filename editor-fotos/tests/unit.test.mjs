import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultEdits, isNeutral, migrate, clone, applyPreset, getPath, setPath,
  SLIDER_GROUPS, STARTER_PRESETS, newMask, EDITS_VERSION, MAX_MASKS, HSL_RANGES,
} from '../src/model.js';
import {
  makeCurve, buildLUT, isIdentity, addPoint, movePoint, removePoint, nearestPoint, MIN_GAP,
} from '../src/curves.js';

// ---------- modelo ----------

test('las ediciones por defecto son neutras', () => {
  assert.equal(isNeutral(defaultEdits()), true);
});

test('cualquier deslizador fuera de su valor neutro deja de ser neutra', () => {
  for (const g of SLIDER_GROUPS) {
    for (const s of g.sliders) {
      if (s.path === 'effects.grainSize') continue;
      const e = defaultEdits();
      setPath(e, s.path, s.max);
      assert.equal(isNeutral(e), false, s.path);
    }
  }
});

test('cada deslizador existe en el modelo y su neutro está dentro del rango', () => {
  const d = defaultEdits();
  for (const g of SLIDER_GROUPS) {
    for (const s of g.sliders) {
      const v = getPath(d, s.path);
      assert.equal(typeof v, 'number', s.path);
      assert.ok(v >= s.min && v <= s.max, s.path);
    }
  }
});

test('migrate completa campos que faltan y descarta basura', () => {
  const e = migrate({ light: { exposure: 1.5 }, color: { hsl: { red: { h: 10 } } }, basura: 1 });
  assert.equal(e.light.exposure, 1.5);
  assert.equal(e.light.contrast, 0);
  assert.equal(e.color.hsl.red.h, 10);
  assert.equal(e.color.hsl.red.s, 0);
  assert.equal(e.v, EDITS_VERSION);
  assert.equal(e.basura, undefined);
  assert.equal(migrate(null).light.exposure, 0);
  assert.equal(migrate('x').light.exposure, 0);
});

test('migrate ignora valores de tipo equivocado', () => {
  const e = migrate({ light: { exposure: 'mucho' }, geometry: { flipH: 'si' } });
  assert.equal(e.light.exposure, 0);
  assert.equal(e.geometry.flipH, false);
});

test('migrate limita las máscaras y sanea las curvas', () => {
  const masks = Array.from({ length: 9 }, () => newMask('radial'));
  const e = migrate({ masks, curves: { master: [[2, -1], [0.5, 0.5], [0, 0]] } });
  assert.equal(e.masks.length, MAX_MASKS);
  assert.deepEqual(e.curves.master[0], [0, 0]);
  assert.ok(e.curves.master.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
});

test('el JSON de ediciones sobrevive ida y vuelta', () => {
  const e = defaultEdits();
  e.light.exposure = 0.7;
  e.masks.push(newMask('linear', 'a'));
  const back = migrate(JSON.parse(JSON.stringify(e)));
  assert.deepEqual(back, e);
});

// ---------- presets ----------

test('intensidad 0 no cambia nada y 1 aplica el preset completo', () => {
  const base = defaultEdits();
  const p = STARTER_PRESETS.find((x) => x.id === 'calido');
  assert.deepEqual(applyPreset(base, p.edits, 0), base);
  const full = applyPreset(base, p.edits, 1);
  assert.equal(full.color.temperature, 28);
  const half = applyPreset(base, p.edits, 0.5);
  assert.equal(half.color.temperature, 14);
});

test('un preset suma sobre lo que ya hay y respeta los límites', () => {
  const base = defaultEdits();
  base.color.temperature = 90;
  const p = STARTER_PRESETS.find((x) => x.id === 'calido');
  assert.equal(applyPreset(base, p.edits, 1).color.temperature, 100);
});

test('aplicar un preset no modifica el objeto original', () => {
  const base = defaultEdits();
  const snapshot = clone(base);
  applyPreset(base, STARTER_PRESETS[0].edits, 1);
  assert.deepEqual(base, snapshot);
});

test('todos los presets de arranque son válidos y no neutros', () => {
  assert.ok(STARTER_PRESETS.length >= 6);
  for (const p of STARTER_PRESETS) {
    assert.equal(isNeutral(p.edits), false, p.id);
    for (const g of SLIDER_GROUPS) for (const s of g.sliders) {
      const v = getPath(p.edits, s.path);
      assert.ok(v >= s.min && v <= s.max, `${p.id} ${s.path}`);
    }
  }
});

test('un preset con curva se mezcla hacia la identidad según la intensidad', () => {
  const p = defaultEdits();
  p.curves.master = [[0, 0], [0.5, 0.7], [1, 1]];
  const half = applyPreset(defaultEdits(), p, 0.5);
  assert.ok(Math.abs(half.curves.master[1][1] - 0.6) < 1e-6);
  const mine = defaultEdits();
  mine.curves.master = [[0, 0], [0.5, 0.4], [1, 1]];
  assert.equal(applyPreset(mine, p, 1).curves.master[1][1], 0.4); // conserva la tuya
});

test('hay 8 rangos HSL', () => assert.equal(HSL_RANGES.length, 8));

// ---------- curvas ----------

test('la curva identidad devuelve x', () => {
  const f = makeCurve([[0, 0], [1, 1]]);
  for (let i = 0; i <= 20; i++) assert.ok(Math.abs(f(i / 20) - i / 20) < 1e-9);
  assert.equal(isIdentity([[0, 0], [1, 1]]), true);
  assert.equal(isIdentity([[0, 0], [0.5, 0.6], [1, 1]]), false);
});

test('la curva pasa exactamente por sus puntos', () => {
  const pts = [[0, 0.05], [0.25, 0.2], [0.6, 0.7], [1, 0.95]];
  const f = makeCurve(pts);
  for (const [x, y] of pts) assert.ok(Math.abs(f(x) - y) < 1e-9);
});

test('la curva es monótona: si los puntos suben, nunca baja', () => {
  const f = makeCurve([[0, 0], [0.1, 0.02], [0.2, 0.5], [0.8, 0.52], [1, 1]]);
  let prev = -1;
  for (let i = 0; i <= 1000; i++) {
    const y = f(i / 1000);
    assert.ok(y >= prev - 1e-12, `retrocede en ${i / 1000}`);
    prev = y;
  }
});

test('la curva no se sale de 0..1', () => {
  const f = makeCurve([[0, 0], [0.3, 0.05], [0.31, 0.95], [1, 1]]);
  for (let i = 0; i <= 1000; i++) {
    const y = f(i / 1000);
    assert.ok(y >= 0 && y <= 1);
  }
});

test('la LUT tiene 256 entradas y extremos correctos', () => {
  const lut = buildLUT([[0, 0.1], [1, 0.9]]);
  assert.equal(lut.length, 256);
  assert.ok(Math.abs(lut[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(lut[255] - 0.9) < 1e-6);
});

test('curva en S: oscurece sombras y aclara luces', () => {
  const f = makeCurve([[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]]);
  assert.ok(f(0.25) < 0.25 + 1e-9 && f(0.75) > 0.75 - 1e-9);
});

test('edición de puntos: añadir, mover con límites y borrar', () => {
  let pts = [[0, 0], [1, 1]];
  let r = addPoint(pts, 0.5, 0.6);
  pts = r.points;
  assert.equal(pts.length, 3);
  assert.equal(r.index, 1);
  // no se puede añadir encima de otro punto
  assert.equal(addPoint(pts, 0.505, 0.1).points.length, 3);
  // mover no cruza vecinos
  const moved = movePoint(pts, 1, 5, 0.3);
  assert.ok(moved[1][0] <= 1 - MIN_GAP + 1e-9);
  const moved2 = movePoint(pts, 1, -5, 0.3);
  assert.ok(moved2[1][0] >= MIN_GAP - 1e-9);
  // los extremos solo se mueven en y
  assert.deepEqual(movePoint(pts, 0, 0.4, 0.2)[0], [0, 0.2]);
  assert.deepEqual(movePoint(pts, 2, 0.4, 0.2)[2], [1, 0.2]);
  // los extremos no se borran, el del medio sí
  assert.equal(removePoint(pts, 0).length, 3);
  assert.equal(removePoint(pts, 2).length, 3);
  assert.equal(removePoint(pts, 1).length, 2);
  assert.equal(nearestPoint(pts, 0.51, 0.61), 1);
  assert.equal(nearestPoint(pts, 0.2, 0.9), -1);
});

test('normalizePoints/makeCurve toleran basura', () => {
  const f = makeCurve([[0.5, 0.5]]);
  assert.ok(Math.abs(f(0.3) - 0.3) < 1e-9); // cae a identidad
  const g = makeCurve([[0, 0], [0, 0.4], [1, 1]]); // x duplicada
  assert.ok(Number.isFinite(g(0.5)));
});

// ---------- store (historial) ----------
import { EditStore } from '../src/store.js';

test('store: cambios vivos no entran al historial hasta confirmar', () => {
  const s = new EditStore();
  s.set('light.exposure', 1);
  s.set('light.exposure', 2);
  assert.equal(s.past.length, 0);
  assert.equal(s.commit(), true);
  assert.equal(s.past.length, 1);
  assert.equal(s.commit(), false); // sin cambios nuevos
});

test('store: deshacer y rehacer', () => {
  const s = new EditStore();
  s.set('light.exposure', 1); s.commit();
  s.set('light.contrast', 30); s.commit();
  assert.equal(s.get().light.contrast, 30);
  s.undo();
  assert.equal(s.get().light.contrast, 0);
  assert.equal(s.get().light.exposure, 1);
  s.undo();
  assert.equal(s.get().light.exposure, 0);
  assert.equal(s.undo(), false);
  s.redo(); s.redo();
  assert.equal(s.get().light.contrast, 30);
  assert.equal(s.redo(), false);
});

test('store: deshacer con cambios vivos los descarta primero', () => {
  const s = new EditStore();
  s.set('light.exposure', 1); s.commit();
  s.set('light.exposure', 3); // vivo
  s.undo();
  assert.equal(s.get().light.exposure, 1);
  assert.equal(s.canRedo(), false);
});

test('store: un cambio nuevo borra el futuro', () => {
  const s = new EditStore();
  s.set('light.exposure', 1); s.commit();
  s.undo();
  assert.equal(s.canRedo(), true);
  s.set('light.contrast', 5); s.commit();
  assert.equal(s.canRedo(), false);
});

test('store: el historial tiene límite', () => {
  const s = new EditStore(undefined, 5);
  for (let i = 1; i <= 12; i++) { s.set('light.exposure', i / 10); s.commit(); }
  assert.equal(s.past.length, 5);
});

test('store: load reinicia el historial y reset es deshacible', () => {
  const s = new EditStore();
  s.set('light.exposure', 1); s.commit();
  s.reset();
  assert.equal(isNeutral(s.get()), true);
  s.undo();
  assert.equal(s.get().light.exposure, 1);
  s.load(defaultEdits());
  assert.equal(s.canUndo(), false);
});

test('store: notifica a los suscriptores y permite darse de baja', () => {
  const s = new EditStore();
  const seen = [];
  const off = s.subscribe((_, k) => seen.push(k));
  s.set('light.exposure', 1); s.commit(); off(); s.set('light.exposure', 2);
  assert.deepEqual(seen, ['live', 'commit']);
});

// ---------- storage (solo la parte sin navegador) ----------
import { presetsToJson, presetsFromJson, fileKey } from '../src/storage.js';

test('presets: ida y vuelta por JSON conserva nombre y ediciones', () => {
  const e = defaultEdits(); e.light.exposure = 0.5;
  const json = presetsToJson([{ id: 'x', name: 'Mi preset', edits: e }]);
  const back = presetsFromJson(json);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Mi preset');
  assert.equal(back[0].edits.light.exposure, 0.5);
  assert.notEqual(back[0].id, 'x'); // id nuevo para no pisar los existentes
});

test('presets: rechaza archivos que no son de esta app', () => {
  assert.throws(() => presetsFromJson('no es json'), /JSON/);
  assert.throws(() => presetsFromJson('{"a":1}'), /presets/);
});

test('presets: ignora entradas inválidas y sanea ediciones', () => {
  const back = presetsFromJson(JSON.stringify({ format: 'editor-fotos-presets', version: 1, presets: [null, { name: 5 }, { name: 'ok', edits: { light: { exposure: 'x' } } }] }));
  assert.equal(back.length, 1);
  assert.equal(back[0].edits.light.exposure, 0);
});

test('fileKey identifica un archivo', () => {
  assert.equal(fileKey({ name: 'a.jpg', size: 10, lastModified: 5 }), 'a.jpg|10|5');
});

// ---------- geometría del recorte ----------
import { fitAspect, moveRect, hitHandle, resizeRect, pixelAspect, aspectValue, MIN_CROP } from '../src/geometry.js';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('recorte: fitAspect devuelve la proporción pedida y cabe en la imagen', () => {
  const r = fitAspect(1, 300, 200); // cuadrado en 300x200
  assert.ok(approx(pixelAspect(r, 300, 200), 1));
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
  const w = fitAspect(16 / 9, 200, 400);
  assert.ok(approx(pixelAspect(w, 200, 400), 16 / 9));
  assert.ok(w.w <= 1 + 1e-9 && w.h <= 1 + 1e-9);
});

test('recorte: moveRect no se sale de la imagen', () => {
  const r = moveRect({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 5, -5);
  assert.ok(approx(r.x, 0.6) && approx(r.y, 0));
});

test('recorte: hitHandle detecta esquinas, bordes y el interior', () => {
  const r = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
  assert.equal(hitHandle(r, 0.2, 0.2), 'tl');
  assert.equal(hitHandle(r, 0.7, 0.7), 'br');
  assert.equal(hitHandle(r, 0.45, 0.2), 't');
  assert.equal(hitHandle(r, 0.7, 0.45), 'r');
  assert.equal(hitHandle(r, 0.45, 0.45), 'move');
  assert.equal(hitHandle(r, 0.95, 0.95), null);
});

test('recorte libre: arrastrar el borde derecho cambia solo el ancho', () => {
  const r = resizeRect({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, 'r', { x: 0.8, y: 0.9 }, null, 100, 100);
  assert.ok(approx(r.x, 0.1) && approx(r.w, 0.7) && approx(r.h, 0.4));
});

test('recorte libre: no se puede invertir ni hacer más pequeño que el mínimo', () => {
  const r = resizeRect({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, 'br', { x: 0.0, y: 0.0 }, null, 100, 100);
  assert.ok(r.w >= MIN_CROP - 1e-9 && r.h >= MIN_CROP - 1e-9);
});

test('recorte con proporción fija: la esquina conserva la proporción', () => {
  const start = fitAspect(3 / 2, 300, 200, { x: 0, y: 0, w: 0.5, h: 0.5 });
  const r = resizeRect({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 * (300 / 200) / (3 / 2) }, 'br', { x: 0.7, y: 0.5 }, 3 / 2, 300, 200);
  assert.ok(approx(pixelAspect(r, 300, 200), 3 / 2, 1e-6), String(pixelAspect(r, 300, 200)));
  assert.ok(r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
  assert.ok(start.w > 0);
});

test('recorte con proporción fija: el borde también la conserva y queda dentro', () => {
  for (const h of ['l', 'r', 't', 'b']) {
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 * 300 / 200 / (4 / 3) }, h, { x: 1.4, y: 1.4 }, 4 / 3, 300, 200);
    assert.ok(approx(pixelAspect(r, 300, 200), 4 / 3, 1e-6), `${h}: ${pixelAspect(r, 300, 200)}`);
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, h);
  }
});

test('aspectValue resuelve "original"', () => {
  assert.equal(aspectValue('orig', 300, 200), 1.5);
  assert.equal(aspectValue(null, 300, 200), null);
  assert.equal(aspectValue(2, 300, 200), 2);
});

// ---------- importador de presets (Lightroom, RawTherapee) ----------
import { parseXmp, parseLrtemplate, parsePp3, parsePresetText, fromLightroomSettings } from '../src/import-presets.js';

const XMP = `<x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:x="adobe:ns:meta/">
 <rdf:RDF>
 <rdf:Description rdf:about="" crs:PresetType="Normal" crs:UUID="ABC" crs:Name="Cálido &amp; suave" crs:Exposure2012="+0.50" crs:Contrast2012="-20" crs:Highlights2012="-40" crs:Shadows2012="+35" crs:Whites2012="+10" crs:Blacks2012="+15" crs:Clarity2012="-15" crs:Dehaze="-10" crs:Texture="0" crs:Saturation="-10" crs:Vibrance="+25" crs:Sharpness="30" crs:Temperature="+400" crs:Tint="+5" crs:HueAdjustmentGreen="+15" crs:SaturationAdjustmentGreen="-20" crs:LuminanceAdjustmentOrange="+5" crs:ColorGradeShadowHue="220" crs:ColorGradeShadowSat="18" crs:ColorGradeHighlightHue="45" crs:ColorGradeHighlightSat="10" crs:ColorGradeBalance="-20" crs:GrainAmount="30" crs:GrainSize="40" crs:PostCropVignetteAmount="-25">
 <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Cálido &amp; suave</rdf:li></rdf:Alt></crs:Name>
 <crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Creativos</rdf:li></rdf:Alt></crs:Group>
 <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 20</rdf:li><rdf:li>128, 110</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
 <crs:ToneCurvePV2012Red><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012Red>
 </rdf:Description></rdf:RDF></x:xmpmeta>`;

test('importar XMP: mapea luz, color, HSL, gradación, efectos y curvas', () => {
  const r = parseXmp(XMP, 'x');
  const e = r.edits;
  assert.equal(r.name, 'Cálido & suave');
  assert.equal(r.group, 'Creativos');
  assert.equal(e.light.exposure, 0.5);
  assert.equal(e.light.contrast, -20); assert.equal(e.light.highlights, -40); assert.equal(e.light.shadows, 35);
  assert.equal(e.light.whites, 10); assert.equal(e.light.blacks, 15);
  assert.equal(e.detail.clarity, -15); assert.equal(e.color.saturation, -10); assert.equal(e.color.vibrance, 25);
  assert.equal(e.detail.sharpness, 20); // 30 de 150 -> 20 de 100
  assert.ok(Math.abs(e.color.temperature - 26.667) < 0.01); assert.equal(e.color.tint, 5);
  assert.equal(e.color.hsl.green.h, 15); assert.equal(e.color.hsl.green.s, -20); assert.equal(e.color.hsl.orange.l, 5);
  assert.deepEqual([e.grading.shadows.hue, e.grading.shadows.sat], [220, 18]);
  assert.deepEqual([e.grading.highlights.hue, e.grading.highlights.sat], [45, 10]);
  assert.equal(e.grading.balance, -20);
  assert.equal(e.effects.grain, 30); assert.equal(e.effects.grainSize, 40); assert.equal(e.effects.vignette, -25);
  assert.equal(e.curves.master.length, 3);
  assert.ok(Math.abs(e.curves.master[1][0] - 128 / 255) < 1e-3 && Math.abs(e.curves.master[1][1] - 110 / 255) < 1e-3);
  assert.equal(isNeutral({ ...defaultEdits(), curves: { ...defaultEdits().curves, r: e.curves.r } }), true, 'una curva identidad no cuenta');
  assert.equal(e.detail.dehaze, -10); // ahora la app tiene "Quitar neblina"
  assert.ok(!r.report.ignored.includes('Dehaze') && !r.report.ignored.includes('Texture'));
  assert.ok(r.report.ignored.includes('GrainFrequency') === false);
  assert.ok(r.report.mapped.includes('Curva RGB'));
});

test('importar XMP: temperatura relativa (+400) y absoluta (6500)', () => {
  assert.ok(Math.abs(fromLightroomSettings({ Temperature: '+400' }).edits.color.temperature - 26.667) < 0.01);
  assert.equal(fromLightroomSettings({ Temperature: '-300' }).edits.color.temperature, -20);
  assert.ok(Math.abs(fromLightroomSettings({ Temperature: '6500' }).edits.color.temperature - 33.333) < 0.01);
  assert.equal(fromLightroomSettings({ Temperature: '5500' }).edits.color.temperature, 0);
});

test('importar: blanco y negro con mezclador de grises', () => {
  const e = fromLightroomSettings({ ConvertToGrayscale: 'True', GrayMixerRed: '+30', GrayMixerBlue: '-40', Contrast2012: '20' }).edits;
  assert.equal(e.color.saturation, -100);
  assert.equal(e.color.hsl.red.l, 30); assert.equal(e.color.hsl.blue.l, -40);
  assert.equal(e.light.contrast, 20);
  assert.equal(fromLightroomSettings({ Treatment: 'Monochrome' }).edits.color.saturation, -100);
});

test('importar: valores fuera de rango se limitan', () => {
  const e = fromLightroomSettings({ Exposure2012: 99, Contrast2012: -500, GrainAmount: 900, HueAdjustmentRed: 300, ColorGradeShadowSat: 500, ColorGradeShadowHue: 900 }).edits;
  assert.equal(e.light.exposure, 5); assert.equal(e.light.contrast, -100); assert.equal(e.effects.grain, 100);
  assert.equal(e.color.hsl.red.h, 100); assert.equal(e.grading.shadows.sat, 100); assert.equal(e.grading.shadows.hue, 360);
  for (const g of SLIDER_GROUPS) for (const s of g.sliders) {
    const v = getPath(e, s.path); assert.ok(v >= s.min && v <= s.max, s.path);
  }
});

const LRT = `s = {
	id = "AAAA",
	internalName = "Prueba 1",
	title = "Prueba 1",
	type = "Develop",
	value = {
		settings = {
			-- comentario
			Clarity2012 = 34,
			ConvertToGrayscale = false,
			CameraProfile = "Adobe Standard",
			Saturation = -33,
			Vibrance = 12,
			HueAdjustmentRed = 16,
			SplitToningShadowHue = 250,
			SplitToningShadowSaturation = 18,
			SplitToningBalance = 42,
			ToneCurvePV2012 = {
				0,
				0,
				64,
				80,
				255,
				255,
			},
			ProcessVersion = "6.7",
		},
	},
	version = 0,
}`;

test('importar .lrtemplate (Lua): lee números, textos, booleanos y listas', () => {
  const r = parseLrtemplate(LRT);
  assert.equal(r.name, 'Prueba 1');
  const e = r.edits;
  assert.equal(e.detail.clarity, 34); assert.equal(e.color.saturation, -33); assert.equal(e.color.vibrance, 12);
  assert.equal(e.color.hsl.red.h, 16);
  assert.deepEqual([e.grading.shadows.hue, e.grading.shadows.sat, e.grading.balance], [250, 18, 42]);
  assert.equal(e.curves.master.length, 3);
  assert.ok(Math.abs(e.curves.master[1][1] - 80 / 255) < 1e-3);
});

test('importar .lrtemplate: rechaza archivos dañados o sin ajustes', () => {
  assert.throws(() => parseLrtemplate('s = { value = { settings = { A = '), /lrtemplate|Tabla|Valor/i);
  assert.throws(() => parseLrtemplate('s = { title = "x" }'), /ajustes/);
});

const PP3 = `[Exposure]
Auto=false
Compensation=1
Brightness=10
Contrast=25
Saturation=-5
Curve=3;0;0;0.08;0;0.187;0.188;0.442;0.58;1;1;

[Vibrance]
Enabled=true
Pastels=20
Saturated=10

[Shadows & Highlights]
Enabled=true
Highlights=30
Shadows=40

[Luminance Curve]
Enabled=true
LCurve=3;0;0;0.5;0.4;1;1;

[White Balance]
Enabled=true
Temperature=5200
`;

test('importar .pp3 (RawTherapee): exposición, vibrance, luces/sombras y curva L', () => {
  const r = parsePp3(PP3, 'Pop 1');
  const e = r.edits;
  assert.equal(r.name, 'Pop 1');
  assert.equal(e.light.exposure, 1); assert.equal(e.light.brightness, 10); assert.equal(e.light.contrast, 25);
  assert.equal(e.color.saturation, -5); assert.equal(e.color.vibrance, 15);
  assert.equal(e.light.highlights, -30); assert.equal(e.light.shadows, 40);
  assert.deepEqual(e.curves.master, [[0, 0], [0.5, 0.4], [1, 1]]);
  assert.ok(r.report.ignored.includes('White Balance'));
});

test('importar .pp3: una sección desactivada no se aplica', () => {
  const r = parsePp3('[Vibrance]\nEnabled=false\nPastels=50\nSaturated=50\n[Exposure]\nCompensation=0.5\n');
  assert.equal(r.edits.color.vibrance, 0); assert.equal(r.edits.light.exposure, 0.5);
});

test('importar: rechaza formatos que no son lo que dicen', () => {
  assert.throws(() => parseXmp('<x>hola</x>'), /XMP/);
  assert.throws(() => parsePp3('esto no es ini'), /pp3/);
  assert.throws(() => parsePresetText('foto.jpg', 'x'), /soportado/);
});

test('parsePresetText elige el lector por extensión y usa el nombre del archivo si falta título', () => {
  assert.equal(parsePresetText('C:\\presets\\Mi Look.xmp', '<x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><rdf:Description crs:Contrast2012="10"></rdf:Description></x:xmpmeta>').name, 'Mi Look');
  assert.equal(parsePresetText('a/b/Perfil.pp3', '[Exposure]\nCompensation=1\n').name, 'Perfil');
  assert.equal(parsePresetText('x.arp', '[Exposure]\nCompensation=0.5\n').edits.light.exposure, 0.5);
});

test('un preset importado se puede aplicar con intensidad', () => {
  const p = parseXmp(XMP).edits;
  const half = applyPreset(defaultEdits(), p, 0.5);
  assert.equal(half.light.contrast, -10);
  assert.equal(half.light.exposure, 0.25);
});

test('preset con curvas y gradación al 0 % deja las ediciones exactamente igual', () => {
  const p = defaultEdits();
  p.curves.master = [[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]];
  p.grading.shadows = { hue: 200, sat: 30 };
  const base = defaultEdits(); base.light.exposure = 0.3;
  assert.deepEqual(applyPreset(base, p, 0), base);
  assert.notDeepEqual(applyPreset(base, p, 0.5), base);
});

// ---------- diseño de impresión ----------
import {
  PAPERS, mmToPx, pageMm, pagePx, insetRect, gridCells, coverCrop, containRect, cropLoss, logoRect, LOGO_POSITIONS,
  builtinFrameGeometry, frameDest, mapWindow, findFrameWindow, windowAspectForBuiltin, ptFromMm,
} from '../src/layout.js';
import { buildPdf } from '../src/pdf.js';

test('mmToPx convierte milímetros a píxeles según los ppp', () => {
  assert.equal(mmToPx(25.4, 300), 300);
  assert.equal(mmToPx(210, 300), 2480);
  assert.equal(mmToPx(297, 300), 3508);
  assert.ok(approx(ptFromMm(25.4), 72));
});

test('pageMm: orientación fija, automática y papel cuadrado/personalizado', () => {
  assert.deepEqual(pageMm('a4', 'portrait'), { w: 210, h: 297 });
  assert.deepEqual(pageMm('a4', 'landscape'), { w: 297, h: 210 });
  assert.deepEqual(pageMm('a4', 'auto', null, 1.5), { w: 297, h: 210 });
  assert.deepEqual(pageMm('a4', 'auto', null, 0.75), { w: 210, h: 297 });
  assert.deepEqual(pageMm('sq20', 'landscape'), { w: 200, h: 200 });
  assert.deepEqual(pageMm('custom', 'portrait', { w: 120, h: 80 }), { w: 80, h: 120 });
  assert.deepEqual(pageMm('custom', 'portrait', { w: 5, h: 99999 }), { w: 20, h: 1000 }); // límites sanos
  assert.ok(PAPERS.every((p) => p.w > 0 && p.h > 0 && p.id && p.label));
});

test('gridCells reparte la hoja en celdas iguales con separación', () => {
  const cells = gridCells({ x: 0, y: 0, w: 1000, h: 600 }, 2, 2, 20);
  assert.equal(cells.length, 4);
  assert.ok(approx(cells[0].w, 490) && approx(cells[0].h, 290));
  assert.ok(approx(cells[1].x, 510) && approx(cells[2].y, 310));
  assert.equal(gridCells({ x: 0, y: 0, w: 100, h: 100 }, 0, 0).length, 1);
});

test('coverCrop y containRect conservan la proporción', () => {
  const c = coverCrop(3000, 2000, 1000, 1000); // foto horizontal en caja cuadrada
  assert.ok(approx(c.sw / c.sh, 1) && approx(c.sx, 500) && approx(c.sy, 0));
  const v = coverCrop(2000, 3000, 1000, 500);
  assert.ok(approx(v.sw / v.sh, 2) && approx(v.sx, 0));
  const r = containRect(3000, 2000, { x: 10, y: 10, w: 600, h: 600 });
  assert.ok(approx(r.w / r.h, 1.5) && approx(r.w, 600) && approx(r.y, 10 + (600 - 400) / 2));
  assert.ok(approx(cropLoss(3000, 2000, 3000, 2000), 0) && cropLoss(3000, 2000, 1000, 1000) > 0.3);
});

test('logoRect coloca el logo por su centro y no se sale de la página', () => {
  const page = { w: 1000, h: 1500 };
  const r = logoRect({ x: 0.5, y: 0.93, widthPct: 20 }, 2, page);
  assert.ok(approx(r.w, 200) && approx(r.h, 100) && approx(r.x, 400));
  const out = logoRect({ x: 1, y: 1, widthPct: 30 }, 1, page);
  assert.ok(out.x + out.w <= 1000 + 1e-9 && out.y + out.h <= 1500 + 1e-9);
  for (const [px, py] of Object.values(LOGO_POSITIONS)) assert.ok(px >= 0 && px <= 1 && py >= 0 && py <= 1);
});

test('marcos generados: la ventana queda dentro del área y la polaroid tiene más borde abajo', () => {
  const rect = { x: 0, y: 0, w: 1200, h: 1800 };
  for (const kind of ['none', 'border', 'double', 'polaroid', 'rounded', 'mat']) {
    const g = builtinFrameGeometry({ kind, widthMm: 8, radiusMm: 5 }, rect, 300);
    assert.ok(g.window.x >= 0 && g.window.y >= 0 && g.window.x + g.window.w <= 1200 + 1e-9 && g.window.y + g.window.h <= 1800 + 1e-9, kind);
  }
  assert.deepEqual(builtinFrameGeometry({ kind: 'none' }, rect, 300).window, rect);
  const pol = builtinFrameGeometry({ kind: 'polaroid', widthMm: 8 }, rect, 300);
  const top = pol.window.y; const bottom = 1800 - (pol.window.y + pol.window.h);
  assert.ok(bottom > top * 3 - 1);
  assert.ok(builtinFrameGeometry({ kind: 'rounded', widthMm: 8, radiusMm: 5 }, rect, 300).radius > 0);
});

// marco de prueba: borde opaco, esquinas transparentes (tocan el borde) y ventana transparente interior
function makeFrame(w, h, win, corners = true) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; d[i] = 120; d[i + 1] = 80; d[i + 2] = 40; d[i + 3] = 255;
    const inWin = x >= win.x && x < win.x + win.w && y >= win.y && y < win.y + win.h;
    const corner = corners && ((x < 12 && y < 12) || (x >= w - 12 && y >= h - 12));
    if (inWin || corner) d[i + 3] = 0;
  }
  return d;
}

test('findFrameWindow encuentra la ventana transparente e ignora las esquinas', () => {
  const w = 600; const h = 400; const win = { x: 60, y: 50, w: 420, h: 250 };
  const r = findFrameWindow(makeFrame(w, h, win), w, h);
  assert.ok(r, 'debe encontrar la ventana');
  assert.ok(Math.abs(r.x - win.x / w) < 0.01 && Math.abs(r.y - win.y / h) < 0.01, JSON.stringify(r));
  assert.ok(Math.abs(r.w - win.w / w) < 0.015 && Math.abs(r.h - win.h / h) < 0.015, JSON.stringify(r));
});

test('findFrameWindow: marco sin ventana o totalmente transparente devuelve null', () => {
  const opaque = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  assert.equal(findFrameWindow(opaque, 200, 200), null);
  assert.equal(findFrameWindow(new Uint8ClampedArray(200 * 200 * 4), 200, 200), null);
});

test('findFrameWindow funciona con imágenes grandes (usa muestreo)', () => {
  const w = 2400; const h = 1600; const win = { x: 300, y: 200, w: 1700, h: 1000 };
  const r = findFrameWindow(makeFrame(w, h, win), w, h);
  assert.ok(Math.abs(r.x - 0.125) < 0.01 && Math.abs(r.w - 1700 / 2400) < 0.01);
});

test('frameDest y mapWindow colocan el marco y su ventana en la hoja', () => {
  const box = { x: 100, y: 100, w: 1000, h: 1000 };
  const d = frameDest(600, 400, box, 'contain');
  assert.ok(approx(d.w / d.h, 1.5) && approx(d.w, 1000));
  assert.deepEqual(frameDest(600, 400, box, 'stretch'), box);
  const cv = frameDest(600, 400, box, 'cover');
  assert.ok(cv.w >= 1000 - 1e-9 && cv.h >= 1000 - 1e-9);
  const m = mapWindow({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, d);
  assert.ok(approx(m.x, d.x + d.w * 0.1) && approx(m.w, d.w * 0.5));
});

test('windowAspectForBuiltin da la proporción de la ventana de la foto', () => {
  const a = windowAspectForBuiltin({ paper: '10x15', orientation: 'landscape', marginMm: 0, frame: { kind: 'none' } });
  assert.ok(approx(a, 152.4 / 101.6, 0.01));
  const b = windowAspectForBuiltin({ paper: '10x15', orientation: 'landscape', marginMm: 0, frame: { kind: 'polaroid', widthMm: 6 } });
  assert.ok(b > 0 && b !== a);
});

// ---------- PDF ----------
const TINY_JPG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4YtPDXT5K2LXwz0+Su/tPDXT5P0rZtPDPT5K/q3Nc131PkMmzvbU4C18M9PkrYtPDXT5K7+18M9PkrZtPDPT5P0r8bzXNd9T91ybO9tTgLTw10+Stm18M9Pkrv7Tw10+Sti08NdPkr8bzXNd9T91ybO9tTnLTw10+Sti18NdPkr0C18NdPkrYtPDXT5P0r9mzXNd9T/JjJs721OAtfDPT5K2bXwz0+Su/tfDPT5K2LXwz0+SvxrNc131P3XJs721OAtPDXT5K2bTw10+T9K7+18M9PkrZtPDXT5P0r8czXNd9T91ybO9tT//Z', 'base64'));

test('buildPdf genera un PDF con la estructura correcta (xref apunta a cada objeto)', () => {
  const pdf = buildPdf([{ jpeg: TINY_JPG, imgW: 48, imgH: 32, widthMm: 152.4, heightMm: 101.6 }, { jpeg: TINY_JPG, imgW: 48, imgH: 32, widthMm: 210, heightMm: 297 }], { title: 'Pedido ñandú' });
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(text.match(/startxref\n(\d+)\n/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  assert.equal(entries.length, 3 + 2 * 3);
  entries.forEach((off, i) => assert.ok(text.slice(off).startsWith(`${i + 1} 0 obj`), `objeto ${i + 1} mal apuntado`));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 432\.000 288\.000\]/); // 152.4 x 101.6 mm = 6 x 4 in
});

test('buildPdf rechaza una lista vacía', () => assert.throws(() => buildPdf([]), /páginas/));

// ---------- especificación de impresión / restaurante ----------
import { defaultPrintSpec, migratePrintSpec, newBrand, migrateBrand, captionText, setLogoPosition, pagesNeeded, expandCopies, FONTS } from '../src/printspec.js';
import { cellWindow, effectiveOrientation, windowAspect } from '../src/layout.js';

test('printspec: valores por defecto son válidos y migrate es idempotente', () => {
  const d = defaultPrintSpec();
  assert.deepEqual(migratePrintSpec(d), d);
  assert.deepEqual(migratePrintSpec(migratePrintSpec(d)), d);
});

test('printspec: migrate sanea valores inválidos y fuera de rango', () => {
  const m = migratePrintSpec({ paper: 'zzz', dpi: 77, marginMm: 999, background: 'rojo', cols: 9, rows: -3, copies: 1000, frame: { kind: 'x', widthMm: -5, color: '#12' }, logo: { widthPct: 1000, x: 5, opacity: 0 }, caption: { sizePt: 1, font: 'comic', text: 'a'.repeat(500) } });
  assert.equal(m.paper, '10x15'); assert.equal(m.dpi, 300); assert.equal(m.marginMm, 50); assert.equal(m.background, '#ffffff');
  assert.equal(m.cols, 4); assert.equal(m.rows, 1); assert.equal(m.copies, 99);
  assert.equal(m.frame.kind, 'border'); assert.equal(m.frame.widthMm, 0); assert.equal(m.frame.color, '#ffffff');
  assert.equal(m.logo.widthPct, 100); assert.equal(m.logo.x, 1); assert.equal(m.logo.opacity, 0.05);
  assert.equal(m.caption.sizePt, 6); assert.equal(m.caption.font, 'serif'); assert.equal(m.caption.text.length, 200);
  assert.deepEqual(migratePrintSpec(null), defaultPrintSpec());
  assert.deepEqual(migratePrintSpec('x'), defaultPrintSpec());
});

test('printspec: restaurante nuevo y migración', () => {
  const b = newBrand('La Casona');
  assert.equal(b.name, 'La Casona'); assert.ok(b.id); assert.deepEqual(b.spec, defaultPrintSpec());
  const m = migrateBrand({ name: 'X'.repeat(200), spec: { paper: 'a4' }, logoId: 5 });
  assert.equal(m.name.length, 60); assert.equal(m.spec.paper, 'a4'); assert.equal(m.logoId, null);
});

test('printspec: texto del pie con variables', () => {
  assert.equal(captionText('{nombre} · {fecha}', { nombre: 'La Casona', fecha: '11/10/2026' }), 'La Casona · 11/10/2026');
  assert.equal(captionText('  {foto}  ', { foto: 'Paella' }), 'Paella');
  assert.equal(captionText(undefined), '');
  assert.ok(FONTS.length >= 4);
});

test('printspec: posición del logo, páginas y copias', () => {
  const s = setLogoPosition(defaultPrintSpec(), 'top-right');
  assert.ok(s.logo.x > 0.5 && s.logo.y < 0.5);
  assert.deepEqual(setLogoPosition(defaultPrintSpec(), 'nada'), defaultPrintSpec());
  assert.equal(pagesNeeded(5, { ...defaultPrintSpec(), cols: 2, rows: 2, copies: 1 }), 2);
  assert.equal(pagesNeeded(3, { ...defaultPrintSpec(), copies: 2 }), 6);
  assert.deepEqual(expandCopies(['a', 'b'], 2), ['a', 'a', 'b', 'b']);
});

test('cellWindow: marco generado y marco cargado', () => {
  const cell = { x: 0, y: 0, w: 1500, h: 1000 };
  const g = cellWindow({ kind: 'border', widthMm: 5 }, cell, 300);
  assert.ok(g.window.w < 1500 && g.custom === false);
  const asset = { w: 3000, h: 2000, window: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
  const c = cellWindow({ kind: 'custom', fit: 'contain' }, cell, 300, asset);
  assert.ok(c.custom && approx(c.window.w, 1200) && approx(c.window.x, 150));
  // marco cargado pero sin ventana detectada: cae a sin marco
  assert.equal(cellWindow({ kind: 'custom' }, cell, 300, { w: 10, h: 10, window: null }).custom, false);
});

test('effectiveOrientation y windowAspect con marco cargado', () => {
  const spec = { ...defaultPrintSpec(), orientation: 'portrait', frame: { ...defaultPrintSpec().frame, kind: 'custom', fit: 'contain' } };
  const wide = { w: 3000, h: 2000, window: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
  assert.equal(effectiveOrientation(spec, wide), 'landscape');
  assert.equal(effectiveOrientation({ ...spec, frame: { ...spec.frame, kind: 'border' } }, wide), 'portrait');
  const a = windowAspect({ ...spec, paper: '10x15' }, wide);
  assert.ok(a > 1.4 && a < 1.6, String(a)); // ventana 80% de un marco 3:2
  const free = windowAspect({ ...defaultPrintSpec(), paper: '10x15', orientation: 'landscape', frame: { ...defaultPrintSpec().frame, kind: 'none' } });
  assert.ok(approx(free, 1.5, 0.01));
});

// ---------- ZIP ----------
import { buildZip, crc32 } from '../src/zip.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('crc32 coincide con el valor conocido de "123456789"', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('buildZip produce un ZIP que unzip abre y cuyo contenido coincide', () => {
  const a = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
  const b = new TextEncoder().encode('hola ñandú');
  const zip = buildZip([{ name: 'hoja-1.jpg', data: a }, { name: 'ñandú/hoja 2.jpg', data: b }]);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  writeFileSync(join(dir, 'x.zip'), zip);
  try {
    const list = execFileSync('unzip', ['-Z1', join(dir, 'x.zip')]).toString().trim().split('\n');
    assert.deepEqual(list.sort(), ['hoja-1.jpg', 'ñandú/hoja 2.jpg'].sort());
    execFileSync('unzip', ['-t', join(dir, 'x.zip')]); // prueba de integridad (CRC)
    execFileSync('unzip', ['-o', '-q', join(dir, 'x.zip'), '-d', join(dir, 'out')]);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out', 'hoja-1.jpg'))), a);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b);
});

// ---------- flujo con varias fotos ----------
import {
  statusAfterEdit, toggleApproved, pasteEdits, cropForAspect, visibleAspect, selectJobIds, summarize,
  nextToReview, neighbor, cropWarnings, orientedDims,
} from '../src/workflow.js';

const ph = (id, status, aspect = 1.5, name = id) => ({ id, status, aspect, name });

test('flujo: estados al editar y al aprobar', () => {
  assert.equal(statusAfterEdit(defaultEdits()), 'pending');
  const e = defaultEdits(); e.light.exposure = 1;
  assert.equal(statusAfterEdit(e), 'edited');
  assert.equal(toggleApproved('edited'), 'approved');
  assert.equal(toggleApproved('approved'), 'edited');
  assert.equal(toggleApproved('pending'), 'approved');
});

test('flujo: pegar ajustes no pisa recorte ni máscaras por defecto', () => {
  const src = defaultEdits(); src.light.exposure = 1; src.geometry.rotate90 = 1; src.masks.push(newMask('radial'));
  const tgt = defaultEdits(); tgt.geometry.crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
  const out = pasteEdits(tgt, src);
  assert.equal(out.light.exposure, 1); assert.equal(out.geometry.rotate90, 0);
  assert.deepEqual(out.geometry.crop, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }); assert.equal(out.masks.length, 0);
  const full = pasteEdits(tgt, src, { geometry: true, masks: true });
  assert.equal(full.geometry.rotate90, 1); assert.equal(full.masks.length, 1);
  assert.equal(src.masks.length, 1, 'no modifica el original');
});

test('flujo: recorte a una proporción en una foto horizontal y en una girada', () => {
  const e = cropForAspect(defaultEdits(), 1, 3000, 2000);
  assert.ok(approx((e.geometry.crop.w * 3000) / (e.geometry.crop.h * 2000), 1, 1e-6));
  const rot = defaultEdits(); rot.geometry.rotate90 = 1;
  const r = cropForAspect(rot, 2, 3000, 2000); // girada: 2000 x 3000
  assert.ok(approx((r.geometry.crop.w * 2000) / (r.geometry.crop.h * 3000), 2, 1e-6));
  assert.ok(approx(visibleAspect(r, 3000, 2000), 2, 1e-6));
  assert.deepEqual(orientedDims(300, 200, 1), { w: 200, h: 300 });
});

test('flujo: selección del pedido y resumen', () => {
  const list = [ph('a', 'approved'), ph('b', 'edited'), ph('c', 'approved'), ph('d', 'pending')];
  assert.deepEqual(selectJobIds(list, 'approved'), ['a', 'c']);
  assert.deepEqual(selectJobIds(list, 'all'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(selectJobIds(list, 'selected', new Set(['b', 'd', 'zzz'])), ['b', 'd']);
  assert.deepEqual(summarize(list), { pending: 1, edited: 1, approved: 2, total: 4 });
});

test('flujo: siguiente por revisar salta las aprobadas y da la vuelta', () => {
  const list = [ph('a', 'approved'), ph('b', 'edited'), ph('c', 'approved'), ph('d', 'pending')];
  assert.equal(nextToReview(list, 'b'), 'd');
  assert.equal(nextToReview(list, 'd'), 'b');
  assert.equal(nextToReview([ph('a', 'approved'), ph('b', 'approved')], 'a'), null);
  assert.equal(nextToReview([], 'a'), null);
  assert.equal(neighbor(list, 'a', 1), 'b'); assert.equal(neighbor(list, 'a', -1), 'a'); assert.equal(neighbor(list, 'd', 5), 'd');
});

test('flujo: avisos de recorte según la proporción de la ventana', () => {
  const list = [ph('h', 'edited', 1.5), ph('v', 'edited', 0.75), ph('s', 'edited', 1.0)];
  const w = cropWarnings(list, 1.5);
  assert.deepEqual(w.map((x) => x.id), ['v', 's']);
  assert.ok(w[0].loss > 0.4);
  assert.deepEqual(cropWarnings(list, 1.5, 0.9), []);
});

import { effectivePpi } from '../src/workflow.js';
import { cellWindowSizes } from '../src/compose.js';

test('effectivePpi: foto de 3000×2000 en 15×10 cm da 508 ppp; recortada, menos', () => {
  const rec = { width: 3000, height: 2000, edits: defaultEdits() };
  // ventana de 15.24 x 10.16 cm a 300 ppp = 1800 x 1200 px
  assert.equal(effectivePpi(rec, 1800, 1200, 300), 500);
  const crop = defaultEdits(); crop.geometry.crop = { x: 0, y: 0, w: 0.5, h: 0.5 };
  assert.equal(effectivePpi({ ...rec, edits: crop }, 1800, 1200, 300), 250);
  const rot = defaultEdits(); rot.geometry.rotate90 = 1;
  assert.ok(effectivePpi({ ...rec, edits: rot }, 1800, 1200, 300) < 500, 'una foto girada en una ventana horizontal pierde resolución al cubrir');
});

test('cropWarnings acepta una proporción distinta por foto', () => {
  const list = [ph('h', 'edited', 1.5), ph('v', 'edited', 0.75)];
  assert.deepEqual(cropWarnings(list, (p) => (p.aspect > 1 ? 1.5 : 0.75)), []);
  assert.deepEqual(cropWarnings(list, () => 1.5).map((x) => x.id), ['v']);
});

// ---------- ajustes automáticos ----------
import { whiteBalanceFromLinear, averagePatchLinear, grayWorldLinear, srgbToLinear, percentile, autoToneFromHistogram, applyAutoTone, WB_TEMP, WB_TINT_G, WB_TINT_RB } from '../src/auto.js';

test('balance de blancos: un gris no necesita corrección', () => {
  assert.deepEqual(whiteBalanceFromLinear(0.2, 0.2, 0.2), { temperature: 0, tint: 0 });
});

test('balance de blancos: una luz cálida (más rojo) pide enfriar y una fría pide calentar', () => {
  const warm = whiteBalanceFromLinear(0.3, 0.2, 0.12);
  assert.ok(warm.temperature < -20, JSON.stringify(warm));
  const cold = whiteBalanceFromLinear(0.12, 0.2, 0.3);
  assert.ok(cold.temperature > 20, JSON.stringify(cold));
  const green = whiteBalanceFromLinear(0.2, 0.28, 0.2); // dominante verde: pide magenta (tinte +)
  assert.ok(green.tint > 15, JSON.stringify(green));
});

test('balance de blancos: es la inversa exacta del modelo del shader', () => {
  // aplica el modelo a un gris con una dominante y comprueba que la solución lo devuelve a gris
  for (const [r, g, b] of [[0.3, 0.2, 0.12], [0.15, 0.2, 0.26], [0.2, 0.25, 0.2], [0.25, 0.16, 0.2], [0.34, 0.21, 0.13]]) {
    const { temperature, tint } = whiteBalanceFromLinear(r, g, b);
    const T = temperature / 100; const N = tint / 100;
    const r2 = r * 2 ** (WB_TEMP * T + WB_TINT_RB * N); const g2 = g * 2 ** (-WB_TINT_G * N); const b2 = b * 2 ** (-WB_TEMP * T + WB_TINT_RB * N);
    assert.ok(Math.abs(r2 - g2) / g2 < 0.03 && Math.abs(b2 - g2) / g2 < 0.03, `${[r, g, b]} -> ${[r2, g2, b2]}`);
  }
});

test('balance de blancos: casos sin información o extremos se limitan', () => {
  assert.deepEqual(whiteBalanceFromLinear(0, 0, 0), { temperature: 0, tint: 0 });
  const ext = whiteBalanceFromLinear(0.9, 0.05, 0.001);
  assert.ok(Math.abs(ext.temperature) <= 100 && Math.abs(ext.tint) <= 100);
  // tungsteno fuerte (típico de restaurantes): ahora SÍ cabe dentro del rango del control
  const tung = whiteBalanceFromLinear(0.36, 0.25, 0.16);
  assert.ok(tung.temperature > -100 && tung.temperature < -50, JSON.stringify(tung));
});

test('gotero y mundo gris: promedios en lineal', () => {
  const w = 10; const h = 10; const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = 200; d[i * 4 + 1] = 150; d[i * 4 + 2] = 100; d[i * 4 + 3] = 255; }
  const p = averagePatchLinear(d, w, h, 5, 5, 2);
  assert.ok(Math.abs(p.r - srgbToLinear(200)) < 1e-9 && Math.abs(p.b - srgbToLinear(100)) < 1e-9);
  const tiny = new Uint8ClampedArray(4 * 4 * 4).fill(150);
  assert.equal(grayWorldLinear(tiny, 4, 4), null, 'muy pocas muestras');
  const big = new Uint8ClampedArray(300 * 300 * 4); for (let i = 0; i < 300 * 300; i++) { big[i * 4] = 180; big[i * 4 + 1] = 150; big[i * 4 + 2] = 120; big[i * 4 + 3] = 255; }
  const g2 = grayWorldLinear(big, 300, 300);
  assert.ok(g2 && g2.r > g2.g && g2.g > g2.b);
});

test('mundo gris ignora píxeles muy saturados y quemados', () => {
  const w = 200; const h = 200; const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const sat = i % 2 === 0; d[i * 4] = sat ? 250 : 130; d[i * 4 + 1] = sat ? 20 : 128; d[i * 4 + 2] = sat ? 20 : 126; d[i * 4 + 3] = 255; }
  const g = grayWorldLinear(d, w, h);
  assert.ok(Math.abs(g.r - g.g) / g.g < 0.1, 'solo cuentan los tonos casi neutros');
});

function histOf(fn) { const h = new Uint32Array(256); for (let i = 0; i < 256; i++) h[i] = Math.round(fn(i / 255) * 1000); return h; }

test('auto tono: sube una foto oscura y baja una clara', () => {
  const dark = autoToneFromHistogram(histOf((x) => (x < 0.3 ? 1 : 0)));
  assert.ok(dark.exposure > 0.5 && dark.shadows > 0, JSON.stringify(dark));
  const bright = autoToneFromHistogram(histOf((x) => (x > 0.75 ? 1 : 0)));
  assert.ok(bright.exposure < -0.5, JSON.stringify(bright)); // una foto muy clara se corrige bajando la exposición
});

test('auto tono: una foto equilibrada casi no cambia y el resultado siempre está en rango', () => {
  const ok = autoToneFromHistogram(histOf((x) => 1));
  assert.ok(Math.abs(ok.exposure) < 0.5 && ok.highlights >= -20 && ok.blacks === 0, JSON.stringify(ok));
  for (const fn of [(x) => x * x, (x) => (1 - x) ** 3, (x) => (x > 0.98 ? 5 : 0.1), () => 0]) {
    const t = autoToneFromHistogram(histOf(fn));
    assert.ok(Math.abs(t.exposure) <= 2 && Math.abs(t.contrast) <= 100 && t.highlights <= 0 && t.shadows >= 0, JSON.stringify(t));
    assert.ok(Object.values(t).every((v) => Number.isFinite(v) && !Object.is(v, -0)));
  }
  assert.equal(percentile(new Uint32Array(256), 0.5), 0);
});

test('applyAutoTone solo toca la luz', () => {
  const e = defaultEdits(); e.color.saturation = 33;
  const out = applyAutoTone(e, { exposure: 0.5, contrast: 5, highlights: -10, shadows: 10, whites: 0, blacks: -5 });
  assert.equal(out.light.exposure, 0.5); assert.equal(out.color.saturation, 33); assert.equal(e.light.exposure, 0);
});

import { chooseSpotSource } from '../src/auto.js';
import { newSpot, MAX_SPOTS } from '../src/model.js';

test('retoque: el origen automático evita copiar de otro detalle', () => {
  // fondo gris liso con una mancha negra en el centro y otra mancha negra a la derecha
  const w = 200; const h = 200; const d = new Uint8ClampedArray(w * h * 4).fill(128);
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = 255;
  const dot = (cx, cy, rr) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rr * rr) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; } };
  dot(100, 100, 6); dot(100 + 26, 100, 6); // otra mancha justo a la derecha, a 2.6 r
  const s = chooseSpotSource(d, w, h, 100, 100, 8);
  const sx = 100 + s.dx; const sy = 100 + s.dy;
  assert.ok(Math.hypot(sx - 126, sy - 100) > 10, `no debe copiar de la otra mancha (${sx.toFixed(0)},${sy.toFixed(0)})`);
  assert.ok(Math.hypot(s.dx, s.dy) >= 8 * 2.7, 'origen fuera de la mancha');
});

test('retoque: cerca del borde de la imagen elige un origen que cabe dentro', () => {
  const w = 100; const h = 100; const d = new Uint8ClampedArray(w * h * 4).fill(150);
  const s = chooseSpotSource(d, w, h, 5, 50, 4);
  assert.ok(5 + s.dx >= 0 && 5 + s.dx < w && 50 + s.dy >= 0 && 50 + s.dy < h);
  assert.deepEqual(chooseSpotSource(new Uint8ClampedArray(4 * 4 * 4), 4, 4, 2, 2, 50), { dx: 150, dy: 0 }, 'sin sitio: valor por defecto');
});

test('modelo: los puntos de retoque se sanean, se limitan y cuentan para "neutra"', () => {
  const e = defaultEdits(); assert.equal(isNeutral(e), true);
  e.spots.push(newSpot(0.5, 0.5)); assert.equal(isNeutral(e), false);
  const m = migrate({ spots: [{ x: 5, y: -2, r: 99, dx: 9, dy: 'x', mode: 'zzz' }, null, 'basura', ...Array.from({ length: 30 }, () => newSpot(0.2, 0.2))] });
  assert.equal(m.spots.length, MAX_SPOTS);
  assert.deepEqual([m.spots[0].x, m.spots[0].y, m.spots[0].r, m.spots[0].dx, m.spots[0].mode], [1, 0, 0.3, 1, 'heal']);
  assert.equal(migrate({}).spots.length, 0);
});

test('un preset no borra ni mezcla los puntos de retoque de la foto', () => {
  const base = defaultEdits(); base.spots.push(newSpot(0.4, 0.4));
  const out = applyPreset(base, STARTER_PRESETS[0].edits, 1);
  assert.equal(out.spots.length, 1);
});

test('bloom y halation: valores por defecto, neutralidad y migración', () => {
  const d = defaultEdits();
  assert.equal(d.effects.bloom, 0); assert.equal(d.effects.halation, 0);
  const e = defaultEdits(); e.effects.bloom = 10;
  assert.equal(isNeutral(e), false);
  const m = migrate({ effects: { halation: 40 } });
  assert.equal(m.effects.halation, 40); assert.equal(m.effects.bloom, 0);
  const old = migrate({ effects: { vignette: -20 } }); // ediciones guardadas antes de existir bloom
  assert.equal(old.effects.bloom, 0);
});

test('pincel: normaliza los trazos y limita su tamaño', async () => {
  const { normalizeStrokes, MAX_STROKES, MAX_STROKE_POINTS } = await import('../src/brush.js');
  const out = normalizeStrokes([
    { r: 9, soft: -3, erase: 1, pts: [[-1, 2], [0.5, 0.5], ['x', null]] },
    { r: 0.05, pts: [] },            // sin puntos: se descarta
    null, { pts: 'no' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].r, 0.4); assert.equal(out[0].soft, 0); assert.equal(out[0].erase, true);
  assert.deepEqual(out[0].pts[0], [0, 1]);
  const many = Array.from({ length: MAX_STROKES + 30 }, () => ({ r: 0.05, soft: 0.5, pts: Array.from({ length: MAX_STROKE_POINTS + 50 }, () => [0.5, 0.5]) }));
  const lim = normalizeStrokes(many);
  assert.equal(lim.length, MAX_STROKES); assert.equal(lim[0].pts.length, MAX_STROKE_POINTS);
  assert.deepEqual(normalizeStrokes('no es una lista'), []);
});

test('máscara de pincel: se crea, sobrevive a migrate y no mezcla campos de otras máscaras', () => {
  const e = defaultEdits();
  const m = newMask('brush'); m.strokes = [{ r: 0.05, soft: 0.4, erase: false, pts: [[0.1, 0.2], [0.3, 0.4]] }];
  e.masks.push(m);
  const back = migrate(JSON.parse(JSON.stringify(e)));
  assert.equal(back.masks[0].type, 'brush');
  assert.equal(back.masks[0].strokes.length, 1);
  assert.equal(back.masks[0].cx, undefined);
  assert.equal(migrate({ masks: [{ type: 'raro' }] }).masks[0].type, 'radial');
  assert.equal(isNeutral(e), false);
});

test('curvas por tono: por defecto planas, neutralidad, migración y extremos unidos', () => {
  const d = defaultEdits();
  assert.deepEqual(d.hslCurves.hue, [[0, 0.5], [1, 0.5]]);
  const e = defaultEdits(); e.hslCurves.sat = [[0, 0.5], [0.5, 0.9], [1, 0.5]];
  assert.equal(isNeutral(e), false);
  const m = migrate({ hslCurves: { hue: [[0, 0.8], [0.4, 0.5], [1, 0.2]], sat: 'no', lum: [[0.2, 0.9]] } });
  assert.equal(m.hslCurves.hue[0][1], m.hslCurves.hue[m.hslCurves.hue.length - 1][1], 'los extremos valen lo mismo');
  assert.deepEqual(m.hslCurves.sat, [[0, 0.5], [1, 0.5]]);
  assert.deepEqual(m.hslCurves.lum, [[0, 0.5], [1, 0.5]]);
  assert.deepEqual(migrate({}).hslCurves, defaultEdits().hslCurves); // fotos guardadas antes de existir
});

test('un preset con curva por tono se mezcla con la intensidad', () => {
  const p = defaultEdits(); p.hslCurves.sat = [[0, 0.5], [0.5, 1], [1, 0.5]];
  const out = applyPreset(defaultEdits(), p, 0.5);
  assert.ok(Math.abs(out.hslCurves.sat[1][1] - 0.75) < 1e-6);
  assert.deepEqual(applyPreset(defaultEdits(), p, 0).hslCurves.sat, [[0, 0.5], [1, 0.5]]);
});

test('LUT .cube: lee una tabla válida (comentarios, título, dominio) y el orden rojo-primero', async () => {
  const { parseCube, identityLut, cubeText } = await import('../src/lut.js');
  const txt = '# comentario\nTITLE "Mi look"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\nLUT_3D_SIZE 2\n' +
    '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1 # fin\n';
  const l = parseCube(txt);
  assert.equal(l.size, 2); assert.equal(l.title, 'Mi look'); assert.equal(l.data.length, 32);
  assert.deepEqual([...l.data.slice(4, 8)], [1, 0, 0, 1]); // el segundo nodo es rojo = 1
  assert.deepEqual([...l.data.slice(16, 20)], [0, 0, 1, 1]); // el quinto, azul = 1
  const id = identityLut(2);
  assert.deepEqual([...l.data], [...id.data]);
  const back = parseCube(cubeText(5, (r, g, b) => [b, g, r]));
  assert.equal(back.size, 5);
  // el segundo nodo tiene rojo de entrada 0.25; la función intercambia rojo y azul, así que sale en el canal azul
  assert.ok(Math.abs(back.data[4] - 0) < 1e-5 && Math.abs(back.data[4 + 2] - 0.25) < 1e-5);
});

test('LUT .cube: rechaza archivos que no sirven con mensajes claros', async () => {
  const { parseCube, MAX_LUT_SIZE } = await import('../src/lut.js');
  assert.throws(() => parseCube(''), /vacío/);
  assert.throws(() => parseCube('hola'), /no es un archivo .cube/i);
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n0 0 0\n'), /1D/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /Faltan datos/);
  assert.throws(() => parseCube('LUT_3D_SIZE 1\n0 0 0'), /no válido/);
  assert.throws(() => parseCube(`LUT_3D_SIZE ${MAX_LUT_SIZE + 1}`), /demasiado grande/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(9)), /más filas/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 x\n'), /no numérico/);
  assert.throws(() => parseCube('0 0 0\n'), /LUT_3D_SIZE/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n' + '0 0 0\n'.repeat(8)), /DOMAIN/);
});

test('look en las ediciones: por defecto vacío, se sanea y cuenta para la neutralidad', () => {
  assert.deepEqual(defaultEdits().look, { id: null, name: '', intensity: 100 });
  const e = defaultEdits(); e.look = { id: 'abc', name: 'Calido', intensity: 80 };
  assert.equal(isNeutral(e), false);
  e.look.intensity = 0; assert.equal(isNeutral(e), true, 'con intensidad 0 no hace nada');
  const m = migrate({ look: { id: 12, name: 'x', intensity: 999 } });
  assert.equal(m.look.id, null); assert.equal(m.look.intensity, 100);
  assert.equal(migrate({ look: { id: 'k', name: 'n', intensity: -5 } }).look.intensity, 0);
  assert.deepEqual(migrate({}).look, { id: null, name: '', intensity: 100 });
});

test('RAW: conversión a half-float y extensiones', async () => {
  const { packRowsHalf, HALF_ONE, isRawName, RAW_EXTENSIONS } = await import('../src/raw.js');
  const half = (h) => { const s = h & 0x8000 ? -1 : 1; const e = (h >> 10) & 0x1f; const m = h & 0x3ff; return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024); };
  const raw = { width: 3, height: 2, data: Uint16Array.from([0, 0, 0, 65535, 65535, 65535, 1, 100, 1000, 12000, 30000, 50000, 65535, 0, 32768, 7, 7, 7]) };
  const out = new Uint16Array(3 * 2 * 4);
  packRowsHalf(raw, 0, 2, out);
  // la primera fila de la salida es la ÚLTIMA fila de la imagen (la textura tiene el origen abajo)
  const expect = [...raw.data.slice(9, 18), ...raw.data.slice(0, 9)];
  for (let p = 0; p < 6; p++) for (let c = 0; c < 3; c++) {
    const want = expect[p * 3 + c] / 65535; const got = half(out[p * 4 + c]);
    assert.ok(Math.abs(got - want) <= Math.max(1e-6, want * 1e-3), `valor ${expect[p * 3 + c]}: ${got} vs ${want}`);
  }
  for (let p = 0; p < 6; p++) assert.equal(out[p * 4 + 3], HALF_ONE);
  assert.equal(isRawName('IMG_0001.CR2'), true); assert.equal(isRawName('foto.DNG'), true); assert.equal(isRawName('foto.jpg'), false);
  assert.equal(isRawName('dng'), false); assert.ok(RAW_EXTENSIONS.includes('arw') && RAW_EXTENSIONS.includes('nef'));
});
