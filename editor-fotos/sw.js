// Service worker: guarda la app para que abra sin conexión.
// Estrategia: red primero para el HTML/JS (siempre la versión nueva si hay red)
// y caché como respaldo. Sube VERSION al publicar cambios.
const VERSION = 'v2';
const CACHE = `editor-fotos-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'src/main.js', 'src/engine.js', 'src/shaders.js', 'src/model.js', 'src/curves.js', 'src/store.js',
  'src/storage.js', 'src/import-presets.js', 'src/ui-kit.js', 'src/photos.js', 'src/workflow.js', 'src/layout.js', 'src/printspec.js', 'src/compose.js', 'src/pdf.js', 'src/zip.js', 'src/print-ui.js', 'src/histogram.js', 'src/curve-editor.js', 'src/overlay.js', 'src/geometry.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('editor-fotos-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
