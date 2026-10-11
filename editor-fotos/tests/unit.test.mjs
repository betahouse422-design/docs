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
