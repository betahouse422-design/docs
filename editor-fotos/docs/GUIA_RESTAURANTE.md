# Guía: del disparo a la impresión

Flujo pensado para fotografiar platillos y ambiente en restaurantes y entregar fotos impresas con marco y logo.

## 1. Abrir las fotos
- **Abrir fotos** (o arrástralas aquí): puedes abrir varias a la vez. Quedan en una **tira de miniaturas** abajo y se guardan en tu dispositivo, aunque cierres la app.
- Cada foto tiene un estado: **pendiente** (sin tocar), **editada** (✎, azul) y **aprobada** (✓, verde).

## 2. Editar
Pestaña **Ajustes**:
- **Tono automático** y **Balance automático** como punto de partida. En restaurantes con luz cálida o mezclada suele bastar con eso.
- **Gotero** (💧): toca en la foto algo que debería ser gris o blanco (un mantel, un plato blanco) y corrige la dominante de color.
- **Luz, color, color por rangos, gradación, curvas**: los ajustes de siempre.
- **Reducción de ruido** (luminosidad y color): para fotos con poca luz. Se nota más al exportar a tamaño completo que en la pantalla.
- **Quitar neblina, claridad, textura, nitidez**: detalle.

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
**Papel y hoja:** tamaño (10×15, 13×18, 15×20, 20×25, A4…), orientación (automática según la foto), 300 ppp, cuántas fotos por hoja y cuántas copias.
**Marco:** generados (borde, doble borde, polaroid, esquinas redondeadas, paspartú) o **tus propios marcos**: carga un PNG con la zona de la foto transparente; la app detecta la ventana sola.
**Posición del logo:** arrástralo sobre la vista previa o usa los botones de posición; tamaño, opacidad y un fondo opcional para que se lea.
**Texto:** pie opcional con variables `{nombre}`, `{fecha}` y `{foto}`.
**Fotos a imprimir:** solo las aprobadas, todas, o las marcadas. Verás cuántas hojas salen y avisos si alguna foto se recorta mucho o tiene poca resolución para ese tamaño.
**Recortar todas al marco:** ajusta de una vez el encuadre de todas a la forma de la ventana del marco (cada foto conserva su centro).

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
- Sin RAW (solo formatos que abre el navegador: JPEG, PNG, WebP; HEIC en Safari).
- Sin gestión de perfiles de color de impresora: se trabaja en sRGB. Para un color crítico, pide una prueba a la imprenta.
- Sin sangrado ni marcas de corte para imprenta.
- Sin pincel de máscaras (hay degradado y radial) ni LUT 3D (`.cube`).
- Sin zoom sobre la foto al editar.
