# Guía: del disparo a la impresión

Flujo pensado para fotografiar platillos y ambiente en restaurantes y entregar fotos impresas con marco y logo.

## 1. Abrir las fotos
- Formatos: JPEG, PNG, WebP (HEIC en Safari) y **RAW** (ARW, CR2/CR3, NEF, DNG, RAF, ORF, RW2 y más; ver "RAW" abajo).
- **Abrir fotos** (o arrástralas aquí): puedes abrir varias a la vez. Quedan en una **tira de miniaturas** abajo y se guardan en tu dispositivo, aunque cierres la app.
- Cada foto tiene un estado: **pendiente** (sin tocar), **editada** (✎, azul) y **aprobada** (✓, verde).

## RAW
- Un RAW se **revela** al abrirlo (tarda 1 o 2 segundos) con el balance de blancos de la cámara y un tono automático de partida. Tiene una etiqueta **RAW** en la miniatura.
- Editas a media resolución para que vaya rápido. Al **acercar el zoom**, al **exportar** o al **imprimir** se revela otra vez a tamaño completo (tarda unos segundos la primera vez).
- Un RAW conserva más luz que un JPEG: puedes subir o bajar la exposición y recuperar luces y sombras con mucho más margen.
- Si un archivo RAW no se puede revelar, la app te lo dice y no lo agrega.

## 2. Editar
Pestaña **Ajustes**:
- **Tono automático** y **Balance automático** como punto de partida. En restaurantes con luz cálida o mezclada suele bastar con eso.
- **Gotero** (💧): toca en la foto algo que debería ser gris o blanco (un mantel, un plato blanco) y corrige la dominante de color.
- **Luz, color, color por rangos, gradación, curvas**: los ajustes de siempre.
- **Bloom y halation** (en Efectos): bloom da un brillo suave alrededor de las luces (velas, lámparas, reflejos) y halation le añade el halo cálido de la película. Ve con poco: con 20–40 ya se nota. En presets está "Resplandor (velas)".
- **Reducción de ruido** (luminosidad y color): para fotos con poca luz. Se nota más al exportar a tamaño completo que en la pantalla.
- **Quitar neblina, claridad, textura, nitidez**: detalle.

**Zoom:** botones **− / Ajustar / + / 1:1** abajo a la derecha de la foto, las teclas **+ − 0**, la rueda del ratón (o pellizcar en el trackpad o con dos dedos) y doble clic. Para mover la foto acercada, arrástrala (en Retoque o gotero, mantén **Espacio** o usa el botón central). Con **1:1** ves un píxel de la foto por píxel de pantalla: sirve para revisar nitidez y manchas. En Recorte y en Máscaras el zoom se pausa.

**Curvas por tono** (pestaña Curvas, a la derecha de RGB): *Tono→Tono* cambia un color hacia otro, *Tono→Sat.* sube o baja la saturación de un color y *Tono→Lum.* lo aclara u oscurece. El eje horizontal es el color; la línea central es "sin cambio". Los grises no se tocan.

**Looks (LUT 3D `.cube`)** (Ajustes → Look): "Cargar .cube…" y elige uno; la intensidad lo mezcla con tu foto. Se aplica al final de tus ajustes. Los archivos se guardan en tu dispositivo. Solo LUT 3D, de hasta 65³.

Pestaña **Máscaras**: ajustes solo en una zona. Hay degradado, radial y **pincel**: pulsa "+ Pincel", pinta sobre la foto la zona a cambiar (se ve en rojo) y mueve los deslizadores de exposición, color, etc. Con "Goma" quitas lo pintado. Si cambias el recorte después de pintar, repinta.

Pestaña **Retoque**: toca una migaja o una mancha para quitarla. Arrastra el círculo punteado para elegir de dónde se copia la textura.

Pestaña **Presets**: 8 de arranque, 449 de película y estilos (con búsqueda), y los tuyos.
- **Crear el tuyo:** edita una foto, escribe un nombre y pulsa "Guardar ajustes actuales como preset".
- **Aplicar a todas las fotos:** elige un preset y pulsa "Aplicar a todas las fotos" (o "A las marcadas").
- La **intensidad** de 0 a 100 % mezcla el preset con tus ajustes.

**Copiar ajustes:** en la tira, "Copiar ajustes" en una foto y "Pegar en seleccionadas" en las que marques con la casilla de cada miniatura. No pisa el recorte de cada foto.
**Auto (tira):** aplica el tono y el balance automáticos a las fotos marcadas.

## 3. Aprobar
- **✓ Aprobar** (o la tecla **A**): marca la foto como lista y pasa a la siguiente pendiente.
- Las flechas del teclado cambian de foto.
- Si editas una foto aprobada, vuelve a "editada": hay que aprobarla de nuevo (así nunca se imprime algo que cambiaste sin revisar).

## 4. Imprimir (botón **Imprimir** arriba del panel)
**Restaurante y logo:** crea un restaurante por cliente, carga su logo (PNG con fondo transparente, o SVG) y todo lo siguiente se guarda **para ese restaurante**.
**Color y corte (para la imprenta):** al final del panel. Si tu imprenta te da un perfil de color (`.icc`), cárgalo y elige "Convertir al perfil de la imprenta": las fotos se convierten a ese perfil al exportar y el perfil va dentro del archivo. "Simular la impresión en pantalla" muestra aproximadamente cómo saldrá (y marca lo que el papel no alcanza). Un perfil CMYK solo sirve para simular. Sin perfil, el archivo sale en sRGB con su perfil incrustado. **Sangrado** extiende el fondo y las fotos (si el margen es 0) por fuera del corte, y **Marcas de corte** las dibuja; el PDF declara TrimBox y BleedBox. Pregunta a tu imprenta qué necesita.
**Papel y hoja:** tamaño (10×15, 13×18, 15×20, 20×25, A4…), orientación (automática según la foto), 300 ppp, cuántas fotos por hoja y cuántas copias.
**Marco:** generados (borde, doble borde, polaroid, esquinas redondeadas, paspartú) o **tus propios marcos**: carga un PNG con la zona de la foto transparente; la app detecta la ventana sola.
**Posición del logo:** arrástralo sobre la vista previa o usa los botones de posición; tamaño, opacidad y un fondo opcional para que se lea.
**Texto:** pie opcional con variables `{nombre}`, `{fecha}` y `{foto}`.
**Fotos a imprimir:** solo las aprobadas, todas, o las marcadas. Verás cuántas hojas salen y avisos si alguna foto se recorta mucho o tiene poca resolución para ese tamaño.
**Recortar todas al marco:** ajusta de una vez el encuadre de todas a la forma de la ventana del marco (cada foto conserva su centro).

**Foto suelta con logo:** en **Exportar** (modo Editar) activa "Poner el logo de un restaurante", elige el restaurante, la esquina, el tamaño y la opacidad. Sirve para mandar una foto por WhatsApp con el logo. Se recuerda tu elección.

Salidas:
- **Descargar PDF:** al tamaño exacto del papel. Es lo más fiable para una imprenta.
- **Descargar JPEG:** uno por hoja (un ZIP si son varias).
- **Imprimir…:** abre el diálogo de impresión del navegador.

## Consejos
- Revisa los avisos antes de imprimir. "Resolución baja" significa que la foto original es chica para ese papel.
- Si usas un marco cargado, prueba primero con una sola foto para ver cómo queda.
- La calidad final se ve al exportar a tamaño completo, no en la pantalla.
- Tus fotos y ajustes viven en el navegador de este dispositivo. Si limpias los datos del sitio, se borran. Exporta lo importante.

## Límites actuales
- Algunos RAW muy nuevos o con compresiones raras pueden no abrirse (depende de LibRaw 0.21).
- Los perfiles de impresora solo se usan si son RGB; con un perfil CMYK se puede simular pero no exportar en CMYK. Para un color crítico, pide una prueba a la imprenta.
- Sin máscaras con IA (cielo, piel, sujeto).
- Sin edición de metadatos ni integración directa con Apple Fotos (en el iPhone, "Abrir fotos" te deja elegirlas desde Fotos).
