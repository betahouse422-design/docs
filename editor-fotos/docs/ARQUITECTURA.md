# Arquitectura

App web instalable (PWA), sin servidor ni dependencias de ejecución. HTML, CSS y JavaScript (módulos ES) más WebGL2. Todo el código es propio.

## Capas

```
main.js ──► store.js ──► model.js ◄── curves.js, geometry.js   (código puro, probado en Node)
   │
   ├──► engine.js ──► shaders.js                                (GPU)
   ├──► overlay.js, curve-editor.js, histogram.js               (interacción)
   └──► storage.js                                              (IndexedDB)
```

| Archivo | Responsabilidad |
|---|---|
| `model.js` | Forma de las ediciones (`Edits`), valores neutros, migración de versiones, presets y máscaras. Sin DOM. |
| `curves.js` | Spline cúbica monótona (Fritsch-Carlson), tabla de 256 entradas y edición de puntos. Sin DOM. |
| `geometry.js` | Matemática del recorte (asas, proporciones). Sin DOM. |
| `store.js` | Estado actual + historial (deshacer/rehacer). Sin DOM. |
| `engine.js` | Sube la foto como textura, prepara desenfoque y tabla de curvas, calcula la geometría y dibuja. |
| `shaders.js` | GLSL: pase lineal y pase en espacio de visualización. |
| `import-presets.js` | Convierte presets de Lightroom (.xmp, .lrtemplate) y RawTherapee (.pp3) a las ediciones de esta app. Sin DOM. |
| `layout.js` | Papeles, ppp, rejilla, recorte "cubrir/contener", marcos generados, detección de la ventana de un marco PNG. Sin DOM. |
| `printspec.js` | Especificación de la hoja y del restaurante (logo, papel, marco, texto) con saneado y límites. Sin DOM. |
| `workflow.js` | Estados de las fotos, copiar/pegar ajustes, recorte al marco, avisos de resolución. Sin DOM. |
| `auto.js` | Balance de blancos (inversa del shader), tono automático, origen automático para quitar manchas. Sin DOM. |
| `pdf.js`, `zip.js` | Generadores propios de PDF (una imagen JPEG por página) y ZIP. Sin dependencias. |
| `lut.js` | Lector de LUT 3D `.cube` (validado, con mensajes claros). Sin DOM. |
| `brush.js` | Trazos del pincel de máscaras: limpieza y rasterizado a una imagen de transparencia (lo usan el motor y la capa interactiva). |
| `compose.js` | Dibuja una hoja: marco, foto, logo, texto (Canvas 2D). |
| `photos.js`, `print-ui.js` | Biblioteca de fotos con tira de miniaturas; panel y vista previa de impresión. |
| `storage.js` | IndexedDB: ediciones y presets, y (v2) fotos, restaurantes, logos/marcos. |
| `main.js` | Construye el panel desde el modelo y conecta todo. |

## Principios

1. **No destructivo.** La foto original nunca se modifica. Las ediciones son un JSON versionado que se reaplica.
2. **Un solo modelo.** Todo (interfaz, presets, almacenamiento, motor) usa `Edits`. La lista de deslizadores (`SLIDER_GROUPS`) es la única fuente: la interfaz y las pruebas se generan desde ella.
3. **Neutro = identidad.** Con ajustes en su valor por defecto, la imagen sale igual que entró (probado).
4. **Etapas solo si hacen falta.** El shader se salta cada ajuste que está en su valor neutro.
5. **Vivo vs. confirmado.** Mientras arrastras un control, el cambio se dibuja pero no entra al historial; al soltar se confirma.

## Pipeline (orden de las etapas)

Un solo shader, en este orden:

1. Origen → **lineal** (la GPU decodifica sRGB al leer la textura).
2. **Pase lineal:** exposición → temperatura y tinte → sombras y luces.
3. Paso a **espacio de visualización** (sRGB).
4. **Pase de visualización:** brillo → contraste → negros y blancos → color por rangos (HSL) → saturación → vibrance → curvas → claridad → nitidez → gradación de color → máscaras locales → desvanecer → viñeta → grano.

Motivo del orden: la luz y el balance de blancos se hacen donde la luz se suma físicamente (lineal). El color creativo y las curvas van después. Los efectos que imitan óptica o película van al final para que el resto de ajustes no los altere. El grano es siempre el último.

## Geometría

Orden: voltear → girar 90° → recortar → enderezar (con zoom automático para no mostrar bordes vacíos). El recorte está en coordenadas de la imagen ya girada. El modelo usa origen arriba-izquierda (como la pantalla); el motor convierte al del shader.

## Presets

Un preset es un `Edits`. Aplicarlo con intensidad `k` **suma** a lo que ya tienes `(preset − neutro) × k`, limitado al rango de cada deslizador. Las curvas se mezclan hacia la identidad con `k` y, si ya tenías una curva propia en ese canal, se conserva la tuya. Un preset propio no guarda geometría ni máscaras (son de cada foto). Con intensidad 0 % no se modifica nada.

### Paquetes de presets

Un paquete (`presets/*.json`, formato `editor-fotos-pack`) guarda cada preset solo con sus diferencias respecto al neutro y se descarga la primera vez que se elige. Lleva su origen, autor y licencia, que la interfaz muestra. Se generan con `tools/build-lightroom-pack.mjs`.

## Almacenamiento

IndexedDB local (`editor-fotos`): `edits` (por foto, clave `nombre|tamaño|fecha`) y `presets`. Si IndexedDB no está disponible, usa memoria. Nada sale del dispositivo.

## Cómo añadir un ajuste nuevo

1. Añade el campo a `defaultEdits()` en `model.js` y, si es un deslizador, a `SLIDER_GROUPS`.
2. Súbele un uniform al shader (`shaders.js`) y pásalo en `Engine.render` (`engine.js`).
3. Escribe su prueba en `tests/render.test.mjs` (qué debe pasar en píxeles).
4. Sube `EDITS_VERSION` solo si cambias el significado de algo que ya existía. Un campo nuevo no lo necesita: `migrate()` lo completa con su valor por defecto.

## Límites conocidos

- Un solo shader con muchas ramas: correcto y rápido en GPU reales; en pruebas con GPU simulada por CPU es lento.
- Sin sangrado ni marcas de corte en la impresión; sin perfiles de color de impresora (todo en sRGB).
- Sin RAW: el navegador solo decodifica formatos de imagen normales (JPEG, PNG, WebP; HEIC en Safari).
- Color: la imagen se trabaja en sRGB. Los perfiles anchos (Display P3) se convierten a sRGB al abrir.
- Los PNG con transparencia se muestran con el fondo negro.
- Fotos mayores de 8192 px por lado se reducen a ese límite al abrir.


## Flujo con varias fotos

- Cada foto se guarda en IndexedDB (`photos`) con su archivo original, sus ajustes, su estado y su miniatura. La biblioteca en memoria solo guarda lo ligero.
- Hay **dos motores de GPU**: el de la vista (la foto que editas) y un **motor de trabajo** (miniaturas, impresión, automáticos en lote) con su propio contexto. Así editar y preparar la impresión no se pisan.
- Los ajustes pasan por `batchUpdate`: la misma función sirve para pegar ajustes, aplicar un preset a todas, el modo Auto y el recorte al marco.

## Impresión

1. `cellWindowSizes` calcula el tamaño exacto de la ventana de cada foto en la hoja.
2. Cada foto se renderiza **a ese tamaño** (no a pantalla completa) con el motor de trabajo.
3. `composePage` dibuja marco, foto, logo y texto sobre un canvas del tamaño de la hoja (a 300 ppp si es el export).
4. El canvas se convierte en JPEG y `buildPdf` lo coloca en una página del tamaño del papel.

El logo se guarda como fracción de la celda (centro y ancho), así se ve igual con cualquier papel.

## Constantes que deben coincidir

El balance de blancos de `auto.js` es la inversa exacta del modelo del shader. Si cambias las constantes de temperatura o tinte en `shaders.js`, cambia también `WB_TEMP`, `WB_TINT_G` y `WB_TINT_RB` en `auto.js` (hay una prueba que lo verifica).

## Pincel y brillo

- **Pincel:** una máscara de tipo `brush` guarda trazos (puntos 0..1 y radio como fracción del ancho). El motor los rasteriza con Canvas 2D a una textura RGBA8 de ~1024 px; el canal *i* es la máscara activa *i*. Solo se vuelve a rasterizar cuando cambian los trazos o la proporción de la salida. Las coordenadas son las del recorte final, igual que las otras máscaras: si cambias el recorte, hay que repintar.
- **Bloom y halation:** un solo paso de shader. Muestrea dos anillos de 12 puntos alrededor del píxel en un nivel grueso del mipmap y solo cuenta las zonas claras (umbral por muestra). Bloom mezcla con "screen"; halation suma un tinte rojo-naranja.
- **Marca de agua:** `watermarkBlob` (en `compose.js`) pinta el logo sobre la foto exportada con la misma función que usa la hoja de impresión.

## Zoom, looks y curvas por tono

- **Zoom:** un vertex shader propio (`VERT_VIEW`) recorre solo la parte visible: `v_uv = centro + (uv − 0.5)/z`. Todo el fragment shader trabaja con ese `v_uv`, así que viñeta, máscaras, retoque y mipmaps siguen a la imagen sin cambios. El nivel del mipmap se calcula con el zoom y el tamaño del grano se mide respecto a la imagen. Solo la vista de pantalla pasa `view`; la exportación y la impresión nunca llevan zoom. Las herramientas que dibujan sobre la foto (retoque, gotero) convierten entre coordenadas de la vista y de la imagen con `cropToView` / `viewToCrop` en `main.js`. En Recorte y Máscaras el zoom se suspende.
- **Looks:** el archivo `.cube` se guarda como recurso (`assets`, tipo `look`); las ediciones solo guardan su id, nombre e intensidad. Se sube como textura 3D RGBA16F y se muestrea con filtro lineal (interpolación trilineal). Cada motor (la vista y el de trabajo para miniaturas e impresión) carga la tabla que pide la foto antes de dibujar; si no la tiene, la foto se ve sin look en vez de fallar.
- **Curvas por tono:** tres curvas con x = tono y y = 0.5 como "sin cambio", guardadas en `hslCurves`. Comparten la textura de tablas con las curvas de tono (filas 4 a 6 de 8). Los extremos 0° y 360° se mantienen iguales y los grises no se modifican.
