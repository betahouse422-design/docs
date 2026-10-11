# Funciones observadas en Darkroom que esta app aún no tiene

Lista de ideas sacada del estudio de la estructura de Darkroom (nombres de acciones y componentes de cada herramienta). Son *funciones*, no código. Sirven como lista de pendientes para adaptar la app a tu trabajo; prioriza según lo que necesites.

Marca: **[C]** = visto en los nombres de acciones o tipos; **[D]** = deducido.

## Presets
- Renombrar, ocultar y marcar como favorito un preset. [C]
- Reordenar presets con arrastrar y soltar. [C]
- "Actualizar" un preset con los ajustes actuales (sin crear otro). [C]
- Packs de presets (agrupar) y un pack de favoritos. [C]
- Compartir y dejar de compartir un preset (requiere un servidor). [C]
- Miniaturas de cada preset aplicadas a la foto actual. [D]

## Balance de blancos
- Botón "Auto". [C]
- Cuentagotas: tocar un punto neutro de la foto para fijar el balance. [C]
- Lupa de color al mantener pulsado. [C]
- En RAW: control de temperatura en kelvin reales. [C]

## Máscaras
- Máscaras por rango de color, por rango de luminosidad y por profundidad (modelo de ML). [C]
- Máscaras de segmentación semántica (cielo, personas...). [C]
- Mostrar la máscara como superposición de color. [D]
- Restablecer una sola máscara. [C]

## Geometría
- Cambiar la orientación de la proporción (vertical/horizontal) con un toque. [C]
- Estilo de cuadrícula en el recorte (tercios, diagonales...). [C]
- Restablecer solo la geometría. [C]

## Biblioteca y flujo
- Explorar una biblioteca de fotos con álbumes, ordenar, marcar y rechazar. [C]
- Copiar ajustes de una foto y pegarlos en otras (por lotes). [D]
- Tira de fotos mientras editas. [C]
- Edición de metadatos: fecha, ubicación, zona horaria. [C]

## Motor
- Pase lineal y pase no lineal separados para RAW (esta app trabaja en un solo shader). [C]
- Cálculos previos con caché (histogramas, claridad, grano) para que arrastrar sea fluido en fotos enormes. [C]
- Soporte de vídeo. [C]
- Gestión de color amplia (Display P3, Rec.2020...). [C]
- Versionado de ediciones por si cambia el comportamiento de un ajuste. [C] — **ya incluido** en esta app (`EDITS_VERSION`).
