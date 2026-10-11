# Editor de fotos personal

Pensado para fotografiar en restaurantes y entregar fotos impresas con marco y logo. Mira **`docs/GUIA_RESTAURANTE.md`** para el flujo completo.

Editor de fotos que se abre en el navegador y se **instala como app** en Mac, iPhone, iPad y Android. Funciona sin conexión y todo se procesa en tu dispositivo: ninguna foto se sube a ningún servidor.

Código propio (HTML, CSS, JavaScript y WebGL2), sin dependencias de ejecución. Diseñado a partir del estudio de la arquitectura de un editor comercial, pero con código, fórmulas y valores propios.

## Qué hace

**Flujo de trabajo:** abrir varias fotos → editar con presets → **aprobar** → **marco y logo del restaurante** → **PDF / JPEG / imprimir**.

- **Varias fotos a la vez:** tira de miniaturas con estados (pendiente, editada, aprobada), copiar y pegar ajustes, aplicar un preset o el modo automático a todas.
- **Impresión:** restaurantes con logo y configuración propia, papel y 300 ppp, varias por hoja, marcos generados y **marcos PNG cargables** (la ventana se detecta sola), logo movible, texto con variables, PDF, JPEG/ZIP y diálogo de impresión.
- **Automáticos:** balance de blancos con gotero y automático, tono automático.
- **Máscaras:** degradado, radial y **pincel** con goma.
- **Marca de agua:** exporta una foto suelta con el logo de un restaurante.
- **Retoque:** quitar manchas y migajas (reparar o clonar).
- **Luz:** exposición, brillo, contraste, luces, sombras, blancos, negros.
- **Color:** temperatura, tinte, saturación, vibrance, color por rangos (8 colores: matiz, saturación, luminosidad), gradación de color en sombras, medios y luces.
- **Curvas:** RGB y por canal, con puntos que se arrastran (táctil o ratón).
- **Detalle y efectos:** claridad, textura, quitar neblina, nitidez, reducción de ruido (luminosidad y color), bloom y halation, viñeta, grano, desvanecer.
- **Recorte y geometría:** recorte con proporciones, girar 90°, espejo, enderezar.
- **Máscaras locales:** hasta 4 (degradado y radial) con ajustes propios dentro de la zona.
- **Presets:** 8 de arranque, **449 presets de película y estilos** (paquete MIT incluido, con búsqueda y grupos), guardar los tuyos, intensidad de 0 a 100 %, exportar e importar.
- **Importar presets de otros editores:** Lightroom (`.xmp`, `.lrtemplate`) y RawTherapee (`.pp3`, `.arp`). La conversión es aproximada.
- **Comodidades:** deshacer y rehacer (Ctrl/Cmd+Z), antes y después (mantén pulsado), histograma con aviso de recortes, restablecer, retomar tus ajustes al reabrir la misma foto, exportar a JPEG, PNG o WebP a máxima resolución.

## Usarla en tu Mac

Necesitas [Node.js](https://nodejs.org) 18 o superior (solo para el servidor local de desarrollo).

```
cd editor-fotos
node tests/serve.mjs 8080
```

Abre `http://localhost:8080` en Chrome, Edge o Safari.

Para instalarla: en Chrome o Edge, menú **Instalar app**; en Safari (macOS Sonoma o posterior), **Archivo ▸ Añadir al Dock**.

> No se puede abrir `index.html` con doble clic: los módulos de JavaScript exigen un servidor (aunque sea local).

## Usarla en el teléfono

Para instalarla en el teléfono la app debe estar publicada en una dirección **https** (los navegadores lo exigen). Es un sitio estático: no hay que compilar nada, basta con subir esta carpeta.

Opciones gratuitas: GitHub Pages, Cloudflare Pages o Netlify, apuntando a la carpeta `editor-fotos`. También puede servirse desde la carpeta `public/` de otro sitio web (las rutas son relativas, así que funciona dentro de un subdirectorio).

Después:
- **iPhone / iPad:** abre la dirección en Safari ▸ botón Compartir ▸ **Añadir a pantalla de inicio**.
- **Android:** abre la dirección en Chrome ▸ menú ▸ **Instalar app**.

Al actualizar la app, sube `VERSION` en `sw.js` para que los dispositivos descarguen la versión nueva.

## Pruebas

```
npm install      # solo instala playwright-core (para las pruebas)
npm test
```

- `tests/unit.test.mjs` — modelo, curvas, historial, presets, importador, geometría, impresión, PDF, ZIP, automáticos (Node, sin navegador).
- `tests/render.test.mjs` — comprueba cada ajuste **en píxeles reales** en un Chromium sin pantalla (WebGL por software).
- `tests/compose.test.mjs` — dibuja hojas de impresión y comprueba píxeles (marco, foto, logo, texto, rejilla).
- `tests/ui.test.mjs` — recorre la interfaz de edición: abrir, deslizadores, curvas, recorte, máscaras, presets, exportar, teléfono y táctil.
- `tests/workflow.test.mjs` — el flujo completo: varias fotos, aprobación, copiar ajustes, restaurantes, logo, marcos, PDF y ZIP (se validan con `pdfinfo` y `unzip`), automáticos y retoque.

Si Chromium no está en la ruta por defecto: `CHROMIUM_PATH=/ruta/a/chrome npm test`.

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js
src/        model.js curves.js geometry.js store.js import-presets.js   código puro (sin DOM)
            layout.js printspec.js workflow.js auto.js pdf.js zip.js   código puro de impresión y flujo
            engine.js shaders.js                        GPU (WebGL2)
            compose.js                                                    hoja de impresión (Canvas 2D)
            main.js photos.js print-ui.js ui-kit.js overlay.js curve-editor.js histogram.js storage.js
presets/    paquete de presets (MIT) y su aviso de licencia
tools/      generador de paquetes e iconos
tests/      pruebas
icons/      iconos
docs/       ARQUITECTURA.md y estudio/ (notas de estudio)
```

Lee `docs/ARQUITECTURA.md` para entender cómo está hecha y cómo añadir un ajuste nuevo.

## Límites actuales

Sin RAW, sin zoom sobre la foto, sin vídeo, sin LUT 3D (`.cube`), sin máscaras con IA, sin sangrado ni marcas de corte para imprenta. Los presets importados se parecen al original pero no son idénticos: cada programa renderiza distinto y los ajustes sin equivalente (Dehaze, Textura, reducción de ruido...) se omiten.

La lista de ideas pendientes, sacada del estudio, está en `docs/estudio/03_funciones_a_considerar.md`. De dónde salen los presets y bajo qué licencia: `presets/NOTICE.md` y `docs/estudio/04_fuentes_de_presets.md`.
