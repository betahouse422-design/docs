// Histograma de la imagen que se ve en pantalla.

const SAMPLE_W = 192;

export function computeHistogram(sourceCanvas, scratch) {
  const h = Math.max(1, Math.round(SAMPLE_W * sourceCanvas.height / sourceCanvas.width));
  scratch.width = SAMPLE_W; scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, SAMPLE_W, h);
  const { data } = ctx.getImageData(0, 0, SAMPLE_W, h);
  const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  for (let i = 0; i < data.length; i += 4) {
    hist.r[data[i]]++; hist.g[data[i + 1]]++; hist.b[data[i + 2]]++;
    hist.l[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  }
  return hist;
}

// Cuántos píxeles están recortados en negro / blanco (0..1)
export function clipping(hist) {
  let total = 0; let lo = 0; let hi = 0;
  for (let i = 0; i < 256; i++) { total += hist.l[i]; }
  for (let i = 0; i < 3; i++) lo += hist.l[i];
  for (let i = 253; i < 256; i++) hi += hist.l[i];
  return total ? { shadows: lo / total, highlights: hi / total } : { shadows: 0, highlights: 0 };
}

export function drawHistogram(canvas, hist) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width; const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!hist) return;
  // raíz cuadrada para que un pico enorme no aplaste el resto
  const f = (v) => Math.sqrt(v);
  let max = 1;
  for (const k of ['r', 'g', 'b']) for (let i = 1; i < 255; i++) max = Math.max(max, f(hist[k][i]));
  const plot = (arr, color) => {
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, h - Math.min(1, f(arr[i]) / max) * (h - 2));
    ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  };
  ctx.globalCompositeOperation = 'lighter';
  plot(hist.r, 'rgba(230,60,60,.55)');
  plot(hist.g, 'rgba(60,200,90,.55)');
  plot(hist.b, 'rgba(70,110,255,.6)');
  ctx.globalCompositeOperation = 'source-over';
}
