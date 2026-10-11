# Presets incluidos y su procedencia

## Lightroom abiertos (MIT) — `lightroom-peva3-mit.json`

- **Origen:** https://github.com/peva3/Lightroom-Presets (commit `f22f4d8057aaaada6df3f0ed7fbe6b952a30db77`)
- **Autor:** peva3 — **Licencia: MIT** (texto en `LICENSE-peva3-Lightroom-Presets.txt`; el aviso de copyright debe conservarse).
- **Qué es:** presets XMP de Lightroom convertidos automáticamente a los ajustes de esta app con `tools/build-lightroom-pack.mjs`. La conversión es **aproximada**: Lightroom y esta app renderizan distinto, así que el resultado se parece al original pero no es idéntico. Los ajustes sin equivalente (p. ej. Dehaze, Textura, reducción de ruido) se omiten.
- **Nombres de películas** (Kodak, Fuji, Ilford...): son marcas de sus dueños y aparecen solo como referencia descriptiva. Esta app no tiene relación con esas empresas.
- **Verificación pendiente:** la licencia MIT está declarada por el autor del repositorio. No he podido comprobar que cada preset sea obra original suya.

## Perfiles de RawTherapee y ART (GPL-3)

No se incluyen. Los perfiles que trae RawTherapee (18 archivos) son técnicos y casi no aportan ajustes creativos. La app los **puede importar** (`.pp3`, `.arp`) si los cargas tú.

## Presets de Darkroom

No se incluyen ni se extraen: son contenido de sus autores.
