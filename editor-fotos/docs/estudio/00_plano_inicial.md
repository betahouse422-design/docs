# Plano para tu propio editor de fotos (diseño original)

Basado en la estructura que vimos (módulos, flujo y orden de etapas), con código y fórmulas propios. Los fragmentos de código son pseudocódigo en Swift para fijar interfaces; no es código de Darkroom.

## 1. Principios
1. **No destructivo:** el original no se toca. Guardas una lista de ajustes y los reaplicas.
2. **Un solo modelo de ediciones** compartido por todo (`Edits`).
3. **Pipeline como lista ordenada de etapas.** Cada etapa dice si está activa (valor distinto del neutro) y, si lo está, transforma una textura.
4. **Herramientas = estado + vista.** Ninguna herramienta calcula píxeles; solo modifican `Edits`.
5. **Render en GPU, con caché** de lo costoso (histogramas, desenfoques, grano).

## 2. Módulos sugeridos

```
App/            pantallas y navegación
Model/          Edits, Preset, Mask, Asset
Engine/         Pipeline, Stage, kernels de GPU, caché
Tools/          una carpeta por herramienta (estado + vista)
Library/        acceso a fotos, miniaturas, álbumes
Storage/        base de datos y presets
```

## 3. Modelo de datos

```swift
struct Edits: Codable, Equatable {
    // luz
    var exposure = 0.0      // -4...+4 (EV)
    var brightness = 0.0    // -1...1
    var contrast = 0.0      // -1...1
    var highlights = 0.0    // -1...1
    var shadows = 0.0       // -1...1
    var whites = 0.0, blacks = 0.0
    // color
    var temperature = 0.0, tint = 0.0
    var saturation = 0.0, vibrance = 0.0
    var hsl: [ColorRange: HSLShift] = [:]
    // curvas: puntos por canal
    var curves: [Channel: [CGPoint]] = [:]
    // detalle y efectos
    var clarity = 0.0, sharpness = 0.0
    var vignette = 0.0, grain = 0.0
    // geometría
    var crop: CGRect? ; var rotation = 0.0
    // máscaras locales
    var local: [LocalEdit] = []
    var isNeutral: Bool { self == Edits() }
}

struct Preset { var name: String; var edits: Edits; var intensity: Double }
```

`Edits` neutro = no hace nada. Todo ajuste tiene valor neutro (normalmente 0).

## 4. Pipeline
```swift
protocol Stage {
    var isActive: Bool { get }
    func encode(_ input: Texture, _ ctx: RenderContext) -> Texture
}
func render(_ source: Texture, _ edits: Edits) -> Texture {
    stages(for: edits).filter(\.isActive).reduce(source) { $1.encode($0, ctx) }
}
```

### Orden recomendado
1. Convertir a espacio de trabajo (lineal si es posible).
2. Pase lineal: **exposición → balance de blancos (temperatura/tinte) → sombras y luces**.
3. Paso a espacio de visualización (gamma).
4. Pase no lineal: **brillo → contraste → color por rangos (HSL) → saturación y vibrance → curvas → color grading**.
5. Detalle: **claridad → nitidez**.
6. Efectos: **viñeta → grano**. El grano va siempre el último.

Por qué ese orden: la luz y el balance de blancos se hacen donde la luz es físicamente aditiva (lineal); el color estilístico y las curvas se aplican después; y los efectos que simulan óptica o película, al final, para que no los afecten el resto de ajustes.

## 5. Fórmulas de partida (estándar, con parámetros tuyos)
Trabaja en float, rango 0...1.

- **Exposición (lineal):** `rgb * 2^EV`.
- **Contraste:** `(x - 0.5) * (1 + c) + 0.5`, o una curva S (por ejemplo, mezcla con `smoothstep`).
- **Brillo:** suma o gamma: `x^(1 / (1 + b))`.
- **Saturación:** `lum + (rgb - lum) * (1 + s)`, con `lum = dot(rgb, (0.2126, 0.7152, 0.0722))`.
- **Vibrance:** como saturación, pero con peso menor en píxeles ya saturados: `s_eff = s * (1 - sat_actual)`.
- **Temperatura/tinte:** multiplicadores por canal en espacio lineal (más azul/amarillo = temperatura; más verde/magenta = tinte).
- **Sombras/luces:** construye una LUT 1D: `lut[x] = x + a * w_sombras(x) - b * w_luces(x)`, con `w_sombras(x) = (1 - x)^2` y `w_luces(x) = x^2`. Ajusta forma y fuerza al gusto.
- **Curvas:** interpola los puntos con una spline monótona (por ejemplo Fritsch-Carlson), genera una LUT de 256 o 1024 entradas y aplícala por canal.
- **Claridad:** contraste local: `x + k * (x - blur(x, radio_grande))`, limitado a los medios tonos.
- **Nitidez:** unsharp mask: `x + k * (x - blur(x, radio_pequeño))`.
- **Viñeta:** `x * (1 - v * smoothstep(r0, r1, distancia_al_centro))`.
- **Grano:** ruido (gaussiano o blue noise) generado por ti, escalado con la luminancia (más visible en medios tonos), mezclado en el final.
- **Color grading:** tintes distintos para sombras, medios y luces, con pesos suaves.

## 6. Presets y almacenamiento
- Un preset es un `Edits` con nombre e intensidad. Intensidad = interpolar entre `Edits()` y el preset: `lerp(neutro, preset, k)`.
- Guarda cada foto como `{ id, edits (JSON), fecha }` en SQLite o Core Data.
- Archivo de presets en JSON, versionado.

## 7. Máscaras locales
- `Mask` = textura de un canal (0...1) más un `Edits` local.
- Resultado: `mix(imagen, imagen_con_edits_locales, mascara)`.
- Tipos para empezar: lineal (degradado), radial (elipse). Después: por luminosidad, por color. Después: por profundidad (modelo de ML).

## 8. Rendimiento
- Mientras arrastras un deslizador: renderiza una **versión reducida** (por ejemplo 1500 px). Al soltar, renderiza completo.
- Cachea la salida de las etapas anteriores a la que cambió, para no recalcular todo.
- Precalcula una vez: histograma, desenfoques para claridad y nitidez, textura de grano.

## 9. Orden de construcción
1. `Edits` + guardar y cargar (JSON).
2. Pipeline con 3 etapas (exposición, contraste, saturación) y vista previa.
3. Resto de la luz y el color.
4. Curvas (editor + LUT).
5. Detalle y efectos.
6. Presets.
7. Recorte y rotación.
8. Máscaras.
9. RAW (si lo necesitas).

## 10. Pruebas
- Test de "neutro": `render(img, Edits()) == img` (idéntico).
- Test por etapa: valor 0 = sin cambio; valor máximo = dentro de rango.
- Imágenes de referencia: gradiente gris, carta de colores, foto con piel.
