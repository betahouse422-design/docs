# Instalar y abrir el editor en otra computadora

No hay nada que "instalar" en el sentido normal: es una página web que corre en tu computadora. Necesitas **bajar la carpeta**,
tener **Node.js** (solo para servirla en `localhost`) y abrirla en **Google Chrome** (o Edge). Todo se procesa en tu equipo; las
fotos no se suben a ningún lado.

## 1. Programas necesarios

| Programa | Para qué | Dónde |
|---|---|---|
| **Google Chrome** (o Microsoft Edge) | Abrir la app. El modo automático (carpeta de la cámara) **solo funciona en Chrome o Edge**. | <https://www.google.com/chrome> |
| **Node.js, versión LTS** | Servir la app en `localhost`. | <https://nodejs.org> (descarga el instalador y acepta todo) |
| **Git** (opcional) | Bajar el código con un comando. Sin Git puedes bajar un ZIP. | <https://git-scm.com> |

## 2. Bajar el código

El código está en tu repositorio de GitHub `betahouse422-design/docs`, rama `claude/ghidra-installation-ltks17`, carpeta `editor-fotos`.

**Con Git** (Terminal en Mac, o "Git Bash"/PowerShell en Windows), un comando por vez:
```
git clone -b claude/ghidra-installation-ltks17 https://github.com/betahouse422-design/docs.git
cd docs/editor-fotos
```
Te pedirá iniciar sesión en GitHub si el repositorio es privado.

**Sin Git:** en GitHub abre el repositorio, cambia a la rama `claude/ghidra-installation-ltks17`, botón verde **Code → Download ZIP**,
descomprime y entra a la carpeta `editor-fotos`.

Para **actualizar** más adelante: `git pull origin claude/ghidra-installation-ltks17` (o baja el ZIP otra vez).

## 3. Abrirlo

**Forma fácil (doble clic):**
- **Mac:** abre `editor-fotos/inicio/Iniciar-Mac.command`. La primera vez macOS puede decir que no se puede abrir: clic derecho →
  **Abrir** → **Abrir**. Si no tiene permiso de ejecución, en Terminal: `chmod +x inicio/Iniciar-Mac.command`.
- **Windows:** abre `editor-fotos\inicio\Iniciar-Windows.bat`.

Se abre Chrome en **http://localhost:8080/**. Deja la ventana negra (Terminal) abierta mientras uses el editor; al cerrarla se apaga.

**Forma manual:** en una Terminal, dentro de la carpeta `editor-fotos`:
```
node tests/serve.mjs 8080
```
y abre <http://localhost:8080/> en Chrome. (Debe ser `localhost`: así Chrome permite elegir carpetas.)

## 4. Primera vez

1. Pulsa **Probar con una imagen de ejemplo** para ver que todo funciona.
2. Pestaña **Imprimir**: crea el restaurante, carga su logo, elige papel y marco.
3. Pestaña **Automático**: sigue `docs/FLUJO_AUTOMATICO.md` (carpeta de la cámara, preset, salida).
4. Chrome pedirá permiso para leer y escribir en las carpetas: pulsa **Permitir**.

## 5. Para que imprima sola (opcional)

Cierra Chrome por completo y ábrelo con impresión directa a la impresora predeterminada:
- **Mac:** `open -a "Google Chrome" --args --kiosk-printing http://localhost:8080/`
- **Windows:** `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing http://localhost:8080/`

Antes, deja la impresora y el tamaño de papel correctos como predeterminados del sistema.

## Si algo falla

- **"node: command not found" / "no se reconoce node":** instala Node.js y abre una Terminal nueva.
- **La página no carga:** mira que la ventana del servidor siga abierta y entra a `http://localhost:8080/` (no `127.0.0.1` ni un archivo `.html` suelto).
- **No aparece "Elegir carpeta…" o dice que el navegador no puede:** estás en Safari o Firefox; usa Chrome o Edge.
- **Ver los cambios tras actualizar:** recarga con Cmd+Shift+R (Mac) o Ctrl+Shift+R (Windows), o abre `http://localhost:8080/?nosw`.
- **Las fotos y presets viven en el navegador de ESA computadora.** Si cambias de equipo, no se mueven solos: exporta tus presets
  (pestaña Presets → Exportar) y vuelve a cargar los logos y marcos.
