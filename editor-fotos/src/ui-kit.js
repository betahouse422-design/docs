// Utilidades de interfaz compartidas (DOM). Sin estado de la app.

export const $ = (s, r = document) => r.querySelector(s);

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

// ---------- avisos ----------
let toastTimer = 0;
export function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = isErr ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2200);
}

// ---------- deslizadores ----------
export function fmt(spec, v) {
  if (spec.unit === 'EV') return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
  if (spec.unit === '°') return `${v.toFixed(1)}°`;
  if (spec.unit) return `${Math.round(v * 100) / 100} ${spec.unit}`;
  return String(Math.round(v));
}

// Fila con deslizador. opts: { label, min, max, step, neutral, unit, track, get(), set(v) (vivo), commit() }
export function sliderRow(opts) {
  const id = 's' + Math.random().toString(36).slice(2, 8);
  const input = el('input', { type: 'range', id, min: opts.min, max: opts.max, step: opts.step });
  if (opts.track) input.classList.add('track-' + opts.track);
  const out = el('output', { for: id });
  const label = el('label', { for: id, title: 'Doble clic para restablecer' }, opts.label);
  const row = el('div', { class: 'srow' }, label, out, input);
  const neutral = opts.neutral ?? 0;
  const setValue = (v) => {
    input.value = v; out.textContent = fmt(opts, Number(v));
    row.classList.toggle('changed', Math.abs(Number(v) - neutral) > 1e-9);
  };
  input.addEventListener('input', () => { const v = Number(input.value); opts.set(v); out.textContent = fmt(opts, v); row.classList.toggle('changed', Math.abs(v - neutral) > 1e-9); });
  input.addEventListener('change', () => opts.commit());
  label.addEventListener('dblclick', () => { opts.set(neutral); setValue(neutral); opts.commit(); });
  setValue(opts.get());
  return { row, setValue, refresh: () => setValue(opts.get()) };
}

export function download(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
