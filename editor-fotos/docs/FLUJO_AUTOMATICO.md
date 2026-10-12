# Flujo automático: de la cámara a la impresión

La idea: la cámara deja cada foto en una carpeta de la computadora; la app la detecta, le pone el preset que elegiste,
la coloca en el marco con el logo del restaurante y la manda a imprimir (o la guarda lista en otra carpeta). Todo se
configura **antes** de empezar el evento.

```
Cámara ──► carpeta de la cámara ──► app (Automático) ──► preset ─► marco + logo ─┬─► carpeta de impresión ──► impresora
                                                                                 ├─► impresora (diálogo de impresión)
                                                                                 └─► espera tu aprobación ("Por aprobar")
```

## Qué necesitas de tu lado

1. **Una computadora con Google Chrome o Microsoft Edge.** Safari y Firefox no pueden vigilar una carpeta, y este modo lo necesita.
   La app tiene que abrirse desde `http://localhost` o desde una dirección `https` (ver el README). Chrome te pedirá permiso para
   leer la carpeta de la cámara y escribir en la de salida: pulsa **Permitir** (hay que repetirlo cada vez que abras la app).
2. **Que la cámara deje las fotos en una carpeta.** Eso lo hace el programa del fabricante, no esta app:
   - **Sony:** Imaging Edge Desktop (Remote) guarda cada disparo en una carpeta de la computadora.
   - **Canon:** EOS Utility, disparo remoto con destino a una carpeta.
   - **Nikon:** NX Tether o Camera Control Pro.
   - **Fujifilm:** X Acquire (o el modo de disparo con cable de X RAW STUDIO / Tether).
   - Alternativas sin cable: transferencia Wi-Fi o FTP de la cámara a una carpeta, o la "importación automática" de Lightroom
     Classic / Capture One apuntando a esa carpeta.
   - Dime el **modelo exacto de tu cámara** y te digo cuál usar y cómo configurarlo.
3. **La impresora.** Dime el modelo y el tamaño de papel. Hay dos formas de que imprima sola:
   - **Carpeta de impresión (la más segura):** la app guarda cada foto lista (JPEG o PDF) en una carpeta y el programa de la
     impresora la imprime sin preguntar. Las impresoras de fotos de sublimación (DNP, Citizen, Canon Selphy) y muchas de
     laboratorio traen un programa de "carpeta caliente" (*hot folder*); en Mac también puedes usar una Acción de carpeta de
     Automator ("Imprimir elementos del Finder").
   - **Directo desde Chrome:** abre Chrome así y la impresión sale sin mostrar el diálogo, a la impresora predeterminada:
     `open -a "Google Chrome" --args --kiosk-printing` (cierra Chrome por completo antes). Deja la impresora y el tamaño de papel
     correctos como predeterminados.
4. **Los archivos del restaurante:** su logo (PNG con fondo transparente o SVG) y, si tienes uno, el marco (PNG con la ventana de
   la foto transparente).
5. **La computadora despierta** durante todo el evento: sin suspensión y con la ventana de la app visible (si la pestaña se
   oculta o se minimiza, Chrome puede frenar la vigilancia). Lo ideal es una ventana de Chrome dedicada a esto.

## Preparar el evento (una vez)

1. Pestaña **Imprimir**: elige o crea el **restaurante**, carga su **logo**, el **papel** (ej. 10×15 cm), el **marco**, el sangrado
   si tu imprenta lo pide y el texto del pie. Se guarda solo para ese restaurante.
2. Pestaña **Automático**:
   1. **Carpeta donde llegan las fotos:** la carpeta que usa el programa de la cámara.
   2. **Restaurante, marco y logo:** confirma el resumen.
   3. **Estilo:** elige el preset (arranque, tuyos o la colección de Lightroom) y su intensidad. "Tono automático" ayuda cuando
      la luz del restaurante cambia mucho; con RAW ya parten de un revelado base.
   4. **Qué hacer con cada foto:** guardar en la carpeta de impresión (JPEG, PDF o ambos), mandar a imprimir, o solo preparar.
      Activa **"Pedir mi aprobación"** si quieres ver cómo saldrá cada hoja y aprobarla antes de que se imprima.
3. Pulsa **Probar con una foto…** y elige una foto cualquiera: pasa por exactamente el mismo camino. Revisa el resultado.
4. Pulsa **Empezar**. Solo se procesan las fotos **nuevas** que lleguen a la carpeta (las que ya estaban se ignoran, salvo que
   marques la casilla). Mientras corre, Editar e Imprimir quedan bloqueados; pulsa **Detener** para volver a usarlos.

## Durante el evento

- La pantalla muestra cada foto con su estado: *Esperando → Importando → Aplicando preset y marco → (Por aprobar) → Enviando → Lista*.
- Una foto con **error** no frena a las demás; tiene botón **Reintentar**. **Otra copia** vuelve a imprimir o guardar una foto lista.
- Con aprobación manual: **Aprobar** la entrega, **Descartar** la quita, y **Aprobar las N** entrega todas las pendientes.
- Las fotos procesadas quedan en la biblioteca (pestaña Editar, cuando detengas el modo) por si quieres retocar y reimprimir.

## Límites que debes conocer

- Cada foto tarda unos segundos en procesarse (más si es RAW grande y la computadora es lenta). Si la cámara dispara más rápido
  que eso, se forma cola y salen en orden de disparo. No he medido los tiempos en tu equipo.
- Con varias fotos por hoja (2×2, etc.) cada foto sale en su propia hoja con copias de sí misma; para eventos usa **1 por hoja**.
- Si Chrome pide permiso de nuevo o se cierra, hay que volver a pulsar **Empezar**. Las fotos ya procesadas no se repiten.
- Probado con carpetas simuladas en Chrome y con RAW/JPEG de prueba; **no lo he probado con tu cámara ni tu impresora**. Haz un
  ensayo completo antes del evento.

## Probar el flujo desde el teléfono

En el teléfono no se puede vigilar una carpeta (ni Safari ni Chrome de Android lo permiten), pero sí probar el mismo camino
**foto → preset → marco con logo → resultado** con el botón **📷 Tomar foto y procesar**: abre la cámara, y la foto pasa por
exactamente el mismo flujo que en la computadora. Sirve para ensayar el preset, el marco y el logo con tus manos.

**Opción A: abrirlo desde tu computadora por Wi-Fi** (el teléfono y la computadora deben estar en la misma red):
1. En la computadora, dentro de la carpeta `editor-fotos`: `node tests/serve.mjs 8080 --lan`
2. Mira la línea **"En tu teléfono (mismo Wi-Fi): http://192.168.x.x:8080/"** y escribe esa dirección en el navegador del teléfono.
3. Cuando termines, cierra el servidor con Ctrl+C (mientras corre, cualquier aparato de tu red puede abrir esa dirección).

**Opción B: dejarlo publicado en internet con HTTPS** (para instalarlo como app en el teléfono y no depender de la computadora):
dime y lo preparo en GitHub Pages.

En el teléfono:
1. Pestaña **Imprimir**: crea el restaurante, carga el logo (desde Fotos o Archivos), elige papel y marco.
2. Pestaña **Automático**: elige el preset. La salida queda en **Descargar o compartir**.
3. Pulsa **📷 Tomar foto y procesar**, toma la foto y espera unos segundos.
4. En la lista aparece la foto con **Descargar JPEG**, **Descargar PDF** y, si tu teléfono lo permite, **Compartir** (por ejemplo, a AirDrop o WhatsApp).

Lo que el teléfono guarda (restaurantes, logos, presets, fotos) es independiente de lo que hay en la computadora.
Limitaciones: es una prueba del flujo, no la versión para el evento (esa necesita la computadora con la cámara conectada).
Probado con un teléfono simulado; **no lo he probado en un iPhone ni en un Android reales**.
