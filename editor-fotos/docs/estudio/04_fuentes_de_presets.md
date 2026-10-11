# Fuentes de presets: qué se buscó, qué se verificó y qué se incluyó

Fecha de la búsqueda: octubre de 2026. Todo lo marcado "verificado" lo comprobé yo directamente en el repositorio (clonado), no por una descripción de terceros.

## Resumen

| Fuente | Formato | Licencia | Verificado | Incluido |
|---|---|---|---|---|
| [peva3/Lightroom-Presets](https://github.com/peva3/Lightroom-Presets) | `.xmp` (Lightroom) | MIT (archivo `LICENSE`) | Sí: 451 archivos, todos convierten sin error | **Sí**, 449 presets (se omiten 2 de "reset", que no cambian nada) |
| [xsynaptic/synaptic-lightroom-presets](https://github.com/xsynaptic/synaptic-lightroom-presets) | `.lrtemplate` (Lightroom antiguo) | MIT declarada solo en `bower.json`; sin archivo `LICENSE`; sin cambios desde 2020 | Sí: 80 archivos convierten sin error | No (licencia poco formal). Se pueden importar a mano |
| [RawTherapee](https://github.com/RawTherapee/RawTherapee) (`rtdata/profiles`) | `.pp3` | GPL-3.0 (el programa) | Sí: solo 18 perfiles | No: son técnicos (curvas de película, negativos, píxel shift) y casi no aportan ajustes creativos. Se pueden importar a mano |
| ART (Another RawTherapee) | `.arp` | GPL-3.0 | No: su código está en Bitbucket, no en GitHub; no lo clonamos | No. El importador lee `.arp` solo de forma básica y **no está probado con archivos reales de ART** |
| Colección de películas de RawTherapee / G'MIC (HaldCLUT, `.cube`) | LUT 3D | No declarada en la página de G'MIC para las LUT | Sí (la página no declara licencia de reuso) | No. Esta app aún no soporta LUT 3D |
| Darkroom (presets incluidos) | Propio | Propietario | — | **No**, a propósito |

## Hallazgos que importan

1. **No encontré un repositorio "oficial y popular" de presets de Lightroom con licencia abierta.** Adobe no publica uno, y los packs gratuitos suelen tener términos del vendedor ("no revender"). El de `peva3` es el más completo con licencia MIT clara, pero es reciente (2026) y no pude verificar su popularidad (estrellas, uso) desde aquí.
2. **La licencia de un programa no es la de sus presets.** RawTherapee es GPL-3.0, pero la página de su colección de películas no declara licencia de reutilización para las LUT, así que no las incluí.
3. **MIT cubre la copia, no la procedencia.** La licencia del repositorio de `peva3` la declara su autor. No pude comprobar que cada preset sea obra original suya, ni que no esté inspirado en packs comerciales. Por eso el paquete lleva aviso de procedencia y la advertencia de que es una conversión aproximada.
4. **Los nombres de película (Kodak, Fuji, Ilford...) son marcas.** Aparecen solo como referencia descriptiva.

## Cómo se convierten

`src/import-presets.js` lee las claves de ajuste de Lightroom (`Exposure2012`, `Contrast2012`, `HueAdjustmentRed`, `ToneCurvePV2012`, `ColorGrade*`, `GrainAmount`, `PostCropVignetteAmount`, ...) y las traduce a los ajustes de esta app. Casi todas usan los mismos rangos (−100 a 100), por eso encajan bien.

Lo que **no** tiene equivalente se ignora y se avisa: Dehaze, Textura, reducción de ruido, perfil de lente, calibración de cámara, curva paramétrica, mezcla global de gradación, y detalles de la viñeta (punto medio, redondez, difuminado).

Decisiones aproximadas (revisables en `fromLightroomSettings`):
- **Temperatura:** con signo (`+400`) es un desplazamiento (÷10); sin signo (`6500`) es absoluta respecto a 5500 K (÷20).
- **Nitidez:** la escala de Lightroom va de 0 a 150; aquí de 0 a 100.
- **Blanco y negro:** saturación −100 y el mezclador de grises se traduce a la luminosidad por color.

## Estadísticas de conversión (archivos reales)

- Lightroom XMP (451): 451 convertidos, 0 fallos, media de 14,7 ajustes mapeados por preset.
- Lightroom .lrtemplate (80): 80 convertidos, 0 fallos, media de 11 ajustes.
- RawTherapee .pp3 (18): 18 leídos, 13 sin ningún ajuste aprovechable.

## Cómo regenerar el paquete

```
git clone --depth 1 https://github.com/peva3/Lightroom-Presets.git /ruta/Lightroom-Presets
node tools/build-lightroom-pack.mjs /ruta/Lightroom-Presets/Presets presets/lightroom-peva3-mit.json \
  --id peva3 --name "Lightroom abiertos (MIT)" --repo https://github.com/peva3/Lightroom-Presets \
  --commit $(git -C /ruta/Lightroom-Presets rev-parse HEAD) --license MIT --author peva3
```

## Fuentes consultadas
- ART: [Linux Magazine](https://www.linux-magazine.com/Online/Features/ART-Another-RawTherapee), [LinuxLinks](https://www.linuxlinks.com/art-fork-rawtherapee/)
- Perfiles de RawTherapee: [RawPedia](https://rawpedia.rawtherapee.com/Sidecar_Files_-_Processing_Profiles)
- Películas y LUT: [RawPedia Film Simulation](https://rawpedia.rawtherapee.com/Film_Simulation), [G'MIC color presets](https://gmic.eu/color_presets/)
