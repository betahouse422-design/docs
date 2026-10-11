# Notas de estudio: motor de render `Maier` (Darkroom 7.4)

Notas propias, escritas en mis palabras tras leer el código decompilado. No contienen su código. Sirven de especificación funcional para construir una app propia. Lo marcado **[C]** se leyó directamente; **[D]** es deducción.

Estado: lote 1 de varios. Ver "Pendiente" al final.

---

## 1. `maier::render` (punto de entrada de render, caso foto no RAW y RAW lineal)

**Qué recibe:** el identificador de la foto, las ediciones (`Edits`), la lista de máscaras, tres texturas (entrada, salida y una auxiliar), un indicador booleano, las regiones de render y otro booleano. [C]

**Qué hace, en orden:**
1. **Comprueba que el activo esté inicializado** (`assetInitialized`). Si no lo está, registra una advertencia ("render llamado antes de inicializar") y devuelve 0 sin hacer nada. [C]
2. **Toma un candado de pipeline** (`ScopedPipelineLock`). Si no consigue el candado, devuelve 0. Esto evita que dos renders corran a la vez sobre la misma foto. [C]
3. **Comprueba que la foto sea todavía la actual** (`isAssetCurrent`). Si el usuario ya cambió de foto, aborta con el mensaje "el activo X no es el actual (Y). Abortando render" y devuelve 0. [C]
4. **Detecta cambios en las máscaras.** Guarda en variables estáticas el número de máscaras y el número de máscaras basadas en imagen. Si cualquiera de los dos cambió desde la última vez, marca el pipeline como "sucio" y fuerza reconstruir las máscaras de imagen. [C]
5. **Elige la variante de pipeline:** si la foto **no** es RAW, construye el pipeline por defecto (un pase). Si es RAW, construye el **lineal**. [C]
6. **Si no es vídeo**, y una bandera de la foto está activa (byte en el desplazamiento 0xb4), **prepara las texturas transitorias de claridad** a partir de las ediciones. [C] (Qué indica esa bandera: [D], probablemente "la claridad está activa y necesita sus texturas auxiliares").
7. **Renderiza** el pipeline construido a la textura de salida (`renderAssetPipeline`). [C]
8. **Libera** el pipeline y el candado, y devuelve el resultado. [C]

**Lecciones de diseño:**
- El render tiene tres defensas contra estados viejos: activo inicializado, candado y "sigue siendo la foto actual". Útil en una app donde el usuario cambia de foto rápido.
- El pipeline se vuelve a **construir en cada llamada** a partir de las ediciones; la reutilización viene de la caché por debajo, no de guardar el pipeline. [C]
- Los cambios en las máscaras invalidan lo precalculado, no el pipeline entero. [C]

**Mejoras que veo:**
- Las "variables estáticas" de conteo de máscaras son estado global: dificultan tener dos fotos a la vez (por ejemplo, vista dividida o tira de miniaturas en paralelo). En tu app, guarda ese estado dentro de un objeto por foto.
- Reconstruir el pipeline en cada render es barato mientras haya pocas etapas; en el tuyo puedes cachear el pipeline y reconstruir solo cuando cambie el conjunto de ajustes activos.

---

## 2. `maier::renderNonLinear` (segundo pase para RAW)

**Estructura casi idéntica a `render`:** mismas comprobaciones (activo inicializado, candado, activo actual, mismos mensajes), pero:
- Siempre construye el pipeline **no lineal** (no depende de si es RAW; ya se asume que lo es). [C]
- Pasa a la construcción un parámetro fijo a 1 y otro a 0 (rama de "no hay ediciones locales" o "pase intermedio"). [D]
- No recalcula conteos de máscaras ni prepara texturas de claridad: eso ya lo hizo el pase lineal. [C]
- Renderiza usando la **misma textura como entrada y salida intermedia** (el segundo argumento de textura se repite), es decir, continúa sobre el resultado del primer pase. [C]

**Lección:** para RAW, el flujo completo es `render` (lineal) → `renderNonLinear`. Cada uno toma su propio candado, así que entre los dos pases otro hilo podría entrar. El comprobador de "activo actual" es lo que protege.

---

## 3. Configuración de render (`renderInMaier` y `buildRenderConfig`)

Esta parte traduce las ediciones a un bloque de parámetros para la GPU.

**Cómo se arma:**
1. Parte de una **plantilla de 256 bytes** copiada en un bloque local (valores iniciales). [C]
2. Rellena **ranuras de coma flotante** leyendo cada propiedad de las ediciones, en este orden: [C]
   `intensity`, un 1.0 fijo, `rawExposure` (**solo si la foto es RAW**, si no 0), `brightness`, `contrast`, `clarity`, `highlights`, `shadows`, `whitePoint`, `blackPoint`, `saturation`, `vibrance`, `temperature`, `tint`, un indicador `usesLegacyWhiteBalanceRendering`, `fade`, `grainAmount`, `sharpness`, `bloom`, `halation`, cuatro valores de split tone (saturación y color de luces; saturación y color de sombras), `vignette`.
3. Lee **tres indicadores**: `hasCurveAdjustments`, `hasColorToolAdjustments` y `colorGrading.hasAdjustments`. Estos deciden si se activan esas etapas. [C]
4. Recorre la lista de **ediciones locales** (`localEdits`) con una enumeración rápida y las agrega a la configuración (cada una ligada a una máscara). [C]

**Lecciones de diseño:**
- Hay una **sola estructura plana de floats** que viaja a la GPU. Esto simplifica los shaders y hace barato actualizarla mientras arrastras un deslizador.
- Los ajustes "complejos" (curvas, color por rangos, color grading) no van en la estructura: se señalan con un booleano y sus datos viajan como tablas o texturas aparte (LUT). [C]
- El indicador de balance de blancos "legacy" muestra que **el comportamiento cambió entre versiones** y conservan el viejo para fotos antiguas. Idea valiosa: versiona tus ediciones desde el principio.

**Mejoras que veo:**
- Los rangos de cada valor no están documentados en el binario. Define los tuyos (por ejemplo, todo en -1...1) y normaliza en un solo sitio.
- La estructura de 256 bytes con orden fijo es frágil: añadir un ajuste obliga a cambiar el layout en Swift y en el shader a la vez. En tu app, genera el layout desde una sola definición.

---

## 4. Ya cubierto en el documento principal
- `buildFilterGraph`: ver `Darkroom_analisis.md`, sección 5.
- Orden de etapas por variante: ver el mismo documento.

---

## Pendiente (siguientes lotes)
1. Curvas: `CurvesToolReducer`, `LUTGenerator.generate1DLUTWithEdits`, `DKCurvesLUTProcessor`, la etapa `Curves`.
2. Sombras y luces: `UseLUTMix`, `PrecomputeHistograms`, formato de las tablas.
3. Color: `ColorTool`, `ColorGrading` (`setColorGradingLUT`), `WhiteBalance`, `Temperature`, `Tint`, `Vibrance`, `Saturation`, `SplitTone`.
4. Máscaras: `IMaskConverter::applyLocalEdits`, los convertidores lineal, radial, imagen y profundidad.
5. Detalle y efectos: claridad, nitidez, grano, bloom, halación, viñeta.
6. Presets: `FilterKit` (`makeEditsFrom:appliedFilter:`), `PresetTool`, `PersistenceKit`.
7. Aplicación: flujo de herramientas con TCA, arranque, compras.
