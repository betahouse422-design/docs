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
| `storage.js` | IndexedDB: ediciones por foto y presets propios. |
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

Un preset es un `Edits`. Aplicarlo con intensidad `k` **suma** a lo que ya tienes `(preset − neutro) × k`, limitado al rango de cada deslizador. Las curvas se mezclan hacia la identidad con `k` y, si ya tenías una curva propia en ese canal, se conserva la tuya. Un preset propio no guarda geometría ni máscaras (son de cada foto).

## Almacenamiento

IndexedDB local (`editor-fotos`): `edits` (por foto, clave `nombre|tamaño|fecha`) y `presets`. Si IndexedDB no está disponible, usa memoria. Nada sale del dispositivo.

## Cómo añadir un ajuste nuevo

1. Añade el campo a `defaultEdits()` en `model.js` y, si es un deslizador, a `SLIDER_GROUPS`.
2. Súbele un uniform al shader (`shaders.js`) y pásalo en `Engine.render` (`engine.js`).
3. Escribe su prueba en `tests/render.test.mjs` (qué debe pasar en píxeles).
4. Sube `EDITS_VERSION` solo si cambias el significado de algo que ya existía. Un campo nuevo no lo necesita: `migrate()` lo completa con su valor por defecto.

## Límites conocidos

- Un solo shader con muchas ramas: correcto y rápido en GPU reales; en pruebas con GPU simulada por CPU es lento.
- Sin zoom ni desplazamiento sobre la foto (la vista siempre muestra la foto entera).
- Sin RAW: el navegador solo decodifica formatos de imagen normales (JPEG, PNG, WebP; HEIC en Safari).
- Color: la imagen se trabaja en sRGB. Los perfiles anchos (Display P3) se convierten a sRGB al abrir.
- Los PNG con transparencia se muestran con el fondo negro.
- Fotos mayores de 8192 px por lado se reducen a ese límite al abrir.
