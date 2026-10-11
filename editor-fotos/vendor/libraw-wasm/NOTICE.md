# libraw-wasm (copia incluida)

Esta carpeta contiene, sin modificar, los archivos publicados de **libraw-wasm 1.6.0**
(<https://github.com/ybouane/LibRaw-Wasm>, paquete npm `libraw-wasm`): `index.js`, `worker.js`, `libraw.wasm` e `index.d.ts`.
Se incluyen aquí para que la app funcione sin conexión y sin descargar nada de internet.

Qué hay dentro y con qué licencia:

| Componente | Licencia |
|---|---|
| Envoltorio de libraw-wasm (`index.js`, `worker.js`, código C++ de enlace) | ISC |
| **LibRaw** (decodificador RAW, compilado en `libraw.wasm`) | LGPL 2.1 **o** CDDL 1.0, a elección (<https://www.libraw.org/>) |
| Little CMS 2 (gestión de color, compilado en `libraw.wasm`) | MIT |
| Emscripten (código de soporte generado en `worker.js`) | MIT / University of Illinois-NCSA |

Para uso personal basta con conservar este aviso. Si algún día distribuyes la app a terceros, revisa las condiciones de
la LGPL/CDDL de LibRaw: pide poder sustituir la biblioteca (aquí es un archivo `.wasm` separado, así que se puede cambiar)
y ofrecer su código fuente (<https://github.com/LibRaw/LibRaw>).

Actualizar: `npm pack libraw-wasm@<versión>`, descomprimir y copiar `dist/index.js`, `dist/worker.js`,
`dist/libraw.wasm` e `dist/index.d.ts` a esta carpeta.
