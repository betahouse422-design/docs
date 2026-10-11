# Darkroom 7.4 (macOS): análisis estático de la arquitectura

Análisis de una copia propia y legítima de la app (`/Applications/Darkroom.app`, `co.bergen.Darkroom`).
Método: símbolos, strings, metadatos, modelos de datos y archivos de recursos de los 26 binarios propios (ejecutable, 24 frameworks y 1 extensión), más Ghidra 12.3 en `CurvesTool` y `Maier`. Solo se leyó código decompilado de `Maier` (construcción del pipeline). No se extrajeron claves ni secretos y no se reproduce el código de los algoritmos.

Leyenda: **[C]** confirmado en el binario · **[D]** deducido por nombres o estructura.

---

## 1. Qué es
- App de **Mac Catalyst**, escrita en **Swift** (el motor de render es C++/Objective-C++), binario universal (x86_64 + arm64), **sin cifrar** (FairPlay no aplica en Mac). [C]
- Trabaja sobre la biblioteca de Apple Fotos sin importar (PhotoKit). Sandbox activado; acceso a Fotos, red como cliente, iCloud (CloudKit y CloudDocuments), grupos de apps y llavero compartido. [C]
- Arquitectura **The Composable Architecture (TCA)**: cada herramienta tiene `State`, `Action` y `Reducer`. [C]

## 2. Módulos

| Capa | Módulos | Función |
|---|---|---|
| App | `Darkroom` (17 MB) | Pantallas, navegación, arranque |
| Herramientas | `AdjustmentTool`, `CurvesTool`, `PresetTool`, `TransformTool`, `WhiteBalanceTool`, `MetadataTool` | Estado e interfaz de cada herramienta |
| Motor de imagen | `Maier`, `MaierMiddleware`, `MaierUI` | Render en GPU (Metal), cola de tareas, vista Metal |
| Datos | `DarkroomFoundation`, `PersistenceKit`, `DataAdapters` | Modelo de ediciones, Core Data, acceso a Fotos |
| Presets | `FilterKit`, `PresetTool` | Presets y packs |
| Interfaz | `DarkroomUIFoundation`, `LibrarySidebar`, `EditingPhotoStrip`, `SoundKit` | Temas, barra lateral, tira de fotos, sonidos |
| Negocio | `IAPKit`, `CampaignKit`, `CampaignBuilder`, `AccountKit`, `BackendService`, `DiagnosticsKit` | Compras, promociones, cuenta, servidor, informes de fallos |
| Librerías | `CommonDependencies` (36 MB) | RevenueCat (+ UI de paywall), TCA y sus dependencias |

## 3. Recorrido de una edición
1. `DataAdapters` lee Fotos (`PHAssetLoader`, `PhotoKitDataAdapter`) o archivos sueltos y edita metadatos con ImageIO. [C]
2. `MaierMiddleware` gestiona activación de fotos y una cola de tareas (vistas previas, histogramas de curvas y matiz, máscaras, balance de blancos automático). [C]
3. Cada herramienta modifica un objeto **`HSLEdits`** (los ajustes). El original nunca se toca. [C]
4. `Maier` convierte esos ajustes en un **grafo de etapas de GPU** (sección 5) y `MaierUI` lo dibuja con Metal. [C]
5. `PersistenceKit` guarda en Core Data (`LocalAssetEntity`: identificadores local y de nube, ediciones, pack, intensidad, orden de favoritos; más un libro de contabilidad de presets). [C]
6. Copias de presets en CloudKit (`CloudKitService`). [D]

## 4. Datos y modelos
- `HSLEdits`: luz y tono (`exposure`, `contrast`, `highlights`, `shadows`, `clarity`), color (`saturation`, `vibrance`, `temperature`, ajustes por rango de matiz), `grainAmount`, `cropRect`, `rotation`, `filterId`, `curves`, `colorGrading`, `lutGenerator`. [C]
- **Curvas:** los puntos se interpolan con splines (Catmull-Rom, B-spline cúbico, Hermite, natural, lineal) para generar una **LUT 1D**. [C]
- **Máscaras:** lineal, radial, por color, por luminosidad, por profundidad y de segmentación semántica. La profundidad usa un modelo de ML (`DepthAnythingV2Small`). [C]
- **Presets:** un `Filter` es un `HSLEdits` guardado con intensidad, orden y marca de pago. Packs de serie, remotos (`fetchLatestRemoteFilterPacks`) y propios (`myFilterPacks.json`). [C]

## 5. El motor `Maier`
- Grafo de nodos en C++ (`pipeline::option::*PipelineOption`, `graph::node::INode`). Las plataformas de GPU se registran en `MetalPlatform::doInit`. [C]
- Cada etapa añade un nodo solo si su ajuste no está en el valor por defecto. [C]

### Orden de las etapas [C]
`maier::util::buildFilterGraph` recibe un vector de descriptores y los aplica en orden: la salida de uno es la entrada del siguiente.

**Elección de variante** (`maier::render`, leído del código):
- Foto **no RAW** (`currentAssetIsRAW() == false`) → pipeline **por defecto** (un solo pase).
- Foto **RAW** → pipeline **lineal** y después `renderNonLinear` → pipeline **no lineal** (dos pases).

**Pipeline por defecto, foto (19 etapas):**
`clarity → highlightsAndShadows → brightness → contrast → halation → bloom → colorTool → saturation → fade → blacksAndWhites → vibrance → temperature → tint → whiteBalance → curves → colorGrading → splitTone → vignette → grain`

**Vídeo (16 etapas):** igual, sin `clarity`, `halation` ni `bloom`.

**Corrección de color previa (3 etapas), antes de la lista principal:**
`applyTransferFunctionCorrection → applyColorPrimariesCorrection → applyToDisplaySpaceCorrection`

**RAW, pase lineal (7):**
`clarity → exposure → linearToDisplay → unbias → highlightsAndShadows → displayToLinear → blacksAndWhites`

**RAW, pase no lineal (16):**
`brightness → contrast → halation → bloom → colorTool → saturation → fade → vibrance → temperature → tint → whiteBalance → curves → colorGrading → splitTone → vignette → grain`

Notas:
- La **exposición** (`rawExposure`) solo se lee y aplica cuando la foto es RAW. [C]
- La **nitidez** no está en el grafo: se precalcula (`PrecomputeSharpenImage`). También se precalculan histogramas, claridad, grano y bloom. [C]
- El **grano** va siempre el último y la **curva** y el **color grading** cerca del final. [C]

### Datos y shaders
- `default.metallib` (1,7 MB) con kernels `do*` por etapa y conversiones entre sRGB, Display P3, Rec.2020, Adobe RGB, DCI-P3 y ACEScg. [C]
- Sombras y luces: tablas `.dkl` de **256 entradas RGBA float**, con variantes `000` y `200` (extremos del deslizador). Sombras `000` oscurece (25 % → 0,10) y `200` levanta (25 % → 0,51). Luces `000` recupera blancos (100 % → 0,81). [C]
- Temperatura, tinte y vibrance: tablas de ~2 MB cuyo formato no se descifró. [C] (existencia) / sin descifrar.
- Grano: texturas PNG reales (`photoGrain*`, `videoGrain*`) en vez de ruido sintético. [C]
- `bw01.cube`: LUT 3D de 32 puntos para blanco y negro. [C]

## 6. Servicios externos
- **Cuenta:** Firebase Auth, Sign in with Apple, perfil en Firestore (`AccountKit`). [C]
- **Compartir presets:** `/api/preset/share` y `/api/preset/unshare` (`BackendService`). [C]
- **Suscripciones:** RevenueCat (`IAPKit` + `CommonDependencies`). [C]
- **Promociones:** `CampaignKit` (decide) y `CampaignBuilder` (editor). [D]
- **Notificaciones:** OneSignal y una extensión de servicio. [C]
- **Informes de fallos:** `DiagnosticsKit` (formulario, envío, detector de memoria alta). [C]
- Dominios en el ejecutable: solo `darkroom.co` (ayuda, legal, presets, novedades) y enlaces de redes sociales. [C]

## 7. Observaciones
- Pantallas internas en producción: `HSLInternalSettingsViewController`, `InternalCampaignEditorViewController`; `CampaignBuilder` va dentro del paquete. [C]
- Clases `Mock*` y un `DarkroomStoreKitConfig.storekit` de pruebas dentro del paquete. [C]
- El paquete conserva datos internos de compilación del desarrollador (omitidos aquí a propósito). [C]
- `bw01.cube` fue exportado con un plugin de Lightroom a partir de un preset de terceros (licencia desconocida). `Maier` incluye una licencia Apache 2.0. [C]

## 8. Límites
- No se descifró el formato de las tablas de temperatura, tinte y vibrance.
- No se analizó el interior de cada kernel de Metal (solo nombres y tablas de datos).
- No se capturó tráfico de red: los datos que se envían y los hosts exactos del servidor quedan sin confirmar.
- No se revisó el código de terceros (Firebase, OneSignal, gRPC, OpenSSL, abseil).
