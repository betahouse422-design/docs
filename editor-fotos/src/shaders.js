// Shaders GLSL ES 3.00 (WebGL2). Escritos para esta app.
//
// Convenciones:
// - La textura de origen es sRGB8_ALPHA8: al muestrearla la GPU ya entrega
//   valores LINEALES (y filtra/hace mipmaps en lineal, que es lo correcto).
// - Primero un pase en espacio lineal (exposición, balance de blancos,
//   sombras y luces) y luego un pase en espacio de visualización (sRGB).
// - Coordenadas y arriba (y=0 abajo), igual que OpenGL.

export const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Copia reducida del origen (el hardware elige el mipmap adecuado).
export const DOWN_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

// Desenfoque gaussiano separable de 13 muestras.
export const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_step; // tamaño de un texel en la dirección del desenfoque
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float f = float(i);
    float w = exp(-(f * f) / 18.0);
    sum += texture(u_tex, v_uv + u_step * f).rgb * w;
    wsum += w;
  }
  o = vec4(sum / wsum, 1.0);
}`;

export const MAIN_FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_src;   // origen, lineal, con mipmaps
uniform sampler2D u_blur;  // origen muy desenfocado (para claridad)
uniform sampler2D u_brush; // pincel de máscaras: canal i = máscara activa i
uniform sampler2D u_lut;   // 256x8: filas master, r, g, b, tono, sat, lum (valor en .r)

// geometría
uniform vec2 u_orientedSize; // tamaño del origen tras girar 90° (px)
uniform vec4 u_crop;         // x, y, w, h en espacio orientado (0..1)
uniform vec2 u_cropPx;       // tamaño del recorte (px)
uniform float u_angle;       // enderezar (rad)
uniform float u_fit;         // zoom para que no se vean bordes al enderezar
uniform int u_rot;           // 0..3 (giros de 90° horarios)
uniform vec2 u_flip;
uniform float u_lod0;        // mipmap base según la reducción
uniform float u_outLong;     // lado largo de la salida (px)
uniform vec2 u_outSize;

// ajustes globales
uniform float u_exposure, u_brightness, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_sat, u_vib;
uniform float u_clarity, u_sharp, u_texture, u_dehaze, u_denoise, u_cdenoise;
uniform vec2 u_srcTexel;     // 1 / tamaño del origen
uniform float u_maxLod;      // último nivel del mipmap del origen
uniform int u_spotCount;
uniform vec4 u_spotA[16];    // cx, cy (imagen girada, y arriba), radio (fracción del ancho), difuminado
uniform vec4 u_spotB[16];    // dx, dy (hacia la zona de origen), opacidad, modo (0 = reparar, 1 = clonar)
uniform float u_fade, u_vignette, u_grain, u_grainSize, u_bloom, u_halation;
uniform int u_hslOn;
uniform vec3 u_hsl[8];
uniform int u_curvesOn;
uniform int u_hslCurvesOn;
uniform int u_gradOn;
uniform vec4 u_gradS, u_gradM, u_gradH; // hue(grados), sat(0..1), -, -
uniform float u_balance;

// máscaras locales
uniform int u_maskCount;
uniform vec4 u_mA[4]; // tipo, difuminado, invertir, -
uniform vec4 u_mB[4]; // lineal: x0,y0,x1,y1 · radial: cx,cy,rx,ry
uniform vec4 u_mC[4]; // ángulo, exposición, contraste, saturación
uniform vec4 u_mD[4]; // temperatura, luces, sombras, -

in vec2 v_uv;
out vec4 o;

// ---------- utilidades de color ----------
vec3 srgb2lin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 lin2srgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0;
  float s = 0.0;
  if (d > 1e-5) {
    s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-6);
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, clamp(s, 0.0, 1.0), l);
}
vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x * 6.0;
  float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
  vec3 rgb;
  if (h < 1.0) rgb = vec3(c, x, 0.0);
  else if (h < 2.0) rgb = vec3(x, c, 0.0);
  else if (h < 3.0) rgb = vec3(0.0, c, x);
  else if (h < 4.0) rgb = vec3(0.0, x, c);
  else if (h < 5.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float lutLookup(float row, float x) {
  return texture(u_lut, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, (row + 0.5) / 8.0)).r;
}

// ---------- geometría ----------
vec2 orientedToSrc(vec2 p) {
  if (u_flip.x > 0.5) p.x = 1.0 - p.x;
  if (u_flip.y > 0.5) p.y = 1.0 - p.y;
  if (u_rot == 1) return vec2(1.0 - p.y, p.x);
  if (u_rot == 2) return vec2(1.0 - p.x, 1.0 - p.y);
  if (u_rot == 3) return vec2(p.y, 1.0 - p.x);
  return p;
}

// ---------- máscaras ----------
float maskWeight(int i, vec2 uv, float aspect) {
  vec4 A = u_mA[i];
  vec4 B = u_mB[i];
  vec4 C = u_mC[i];
  float feather = clamp(A.y, 0.0, 1.0);
  float w;
  if (A.x > 1.5) {
    vec4 bm = texture(u_brush, vec2(uv.x, 1.0 - uv.y));
    w = i == 0 ? bm.r : (i == 1 ? bm.g : (i == 2 ? bm.b : bm.a));
  } else if (A.x < 0.5) {
    vec2 p0 = B.xy * vec2(aspect, 1.0);
    vec2 p1 = B.zw * vec2(aspect, 1.0);
    vec2 p = uv * vec2(aspect, 1.0);
    vec2 dir = p1 - p0;
    float t = dot(p - p0, dir) / max(dot(dir, dir), 1e-6);
    float h = mix(0.02, 0.5, feather);
    w = 1.0 - smoothstep(0.5 - h, 0.5 + h, t);
  } else {
    vec2 q = (uv - B.xy) * vec2(aspect, 1.0);
    float ca = cos(C.x);
    float sa = sin(C.x);
    q = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    vec2 rad = max(vec2(B.z * aspect, B.w), vec2(1e-4));
    float d = length(q / rad);
    w = 1.0 - smoothstep(max(1.0 - feather, 0.0), 1.0 + 1e-4, d);
  }
  return A.z > 0.5 ? 1.0 - w : w;
}

vec3 applyLocal(vec3 d, int i) {
  vec4 C = u_mC[i];
  vec4 D = u_mD[i];
  vec3 c = srgb2lin(clamp(d, 0.0, 1.0));
  c *= exp2(C.y);
  float t = D.x / 100.0;
  c.r *= exp2(t * 0.7);
  c.b *= exp2(-t * 0.7);
  float ld = clamp(pow(max(luma(c), 0.0), 1.0 / 2.4), 0.0, 1.0);
  c *= exp2(D.z / 100.0 * 1.5 * (1.0 - ld) * (1.0 - ld) + D.y / 100.0 * 1.5 * ld * ld);
  d = lin2srgb(c);
  float k = C.z / 100.0;
  d = clamp(d, 0.0, 1.0);
  d = k > 0.0 ? mix(d, d * d * (3.0 - 2.0 * d), k) : 0.5 + (d - 0.5) * (1.0 + k * 0.8);
  float g = luma(d);
  d = mix(vec3(g), d, 1.0 + C.w / 100.0);
  return d;
}

vec3 sampleSrc(vec2 uv) { return textureLod(u_src, uv, u_lod0).rgb; }

// Retoque de manchas: copia textura de otra zona. "Reparar" conserva la luz y el color
// de donde está la mancha (corrige la diferencia de iluminación con el desenfoque).
// Diferencia de luz y color entre el entorno de la mancha y el entorno de la zona de origen,
// medida en un anillo FUERA de la mancha (el centro está contaminado por la propia mancha).
vec3 ringCorrection(vec2 center, float R, vec2 off2) {
  vec3 t = vec3(0.0);
  vec3 s = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    vec2 o = vec2(cos(a), sin(a)) * (R * 1.7) / u_orientedSize;
    t += sampleSrc(orientedToSrc(center + o));
    s += sampleSrc(orientedToSrc(center + o + off2));
  }
  return (t - s) / 8.0;
}

vec3 applySpots(vec2 ou, vec2 su, vec3 c) {
  for (int i = 0; i < 16; i++) {
    if (i >= u_spotCount) break;
    vec4 A = u_spotA[i];
    vec4 B = u_spotB[i];
    float dist = length((ou - A.xy) * u_orientedSize);
    float R = A.z * u_orientedSize.x;
    float w = 1.0 - smoothstep(R * (1.0 - A.w), R, dist);
    if (w <= 0.0) continue;
    vec2 su2 = orientedToSrc(ou + B.xy);
    vec3 s = sampleSrc(su2);
    if (B.w < 0.5) s = max(s + ringCorrection(A.xy, R, B.xy), 0.0);
    c = mix(c, s, w * B.z);
  }
  return c;
}

// Reducción de ruido que respeta los bordes: promedia vecinos parecidos.
// Luminosidad: vecinos de color parecido. Color: vecinos de luminosidad parecida (mezcla el color).
vec3 denoise(vec2 su, vec3 c0) {
  float aL = u_denoise / 100.0;
  float aC = u_cdenoise / 100.0;
  if (aL <= 0.0 && aC <= 0.0) return c0;
  vec2 px = u_srcTexel * exp2(u_lod0);
  float sigL = mix(0.012, 0.22, aL);
  float sigC = mix(0.03, 0.40, aC);
  vec3 g0 = sqrt(max(c0, 0.0));
  float y0 = luma(g0);
  vec3 sumL = c0; float wL = 1.0;
  vec3 sumC = c0; float wC = 1.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    float rad = i < 6 ? 1.5 : 3.2;
    vec3 s = sampleSrc(su + vec2(cos(a), sin(a)) * rad * px);
    vec3 gs = sqrt(max(s, 0.0));
    float dc = distance(gs, g0);
    float wl = exp(-(dc * dc) / (sigL * sigL));
    sumL += s * wl; wL += wl;
    float dy = abs(luma(gs) - y0);
    float wc = exp(-(dy * dy) / (sigC * sigC));
    sumC += s * wc; wC += wc;
  }
  vec3 base = mix(c0, sumL / wL, aL);
  float yb = luma(base);
  vec3 chroma = mix(c0, sumC / wC, aC);
  float yc = max(luma(chroma), 1e-5);
  return mix(base, chroma * (yb / yc), aC);
}

void main() {
  // --- de la posición de salida a la del origen ---
  vec2 pq = (v_uv - 0.5) * u_cropPx * u_fit;
  float ca = cos(u_angle);
  float sa = sin(u_angle);
  vec2 r = vec2(ca * pq.x - sa * pq.y, sa * pq.x + ca * pq.y);
  vec2 ou = vec2(u_crop.x + u_crop.z * 0.5, u_crop.y + u_crop.w * 0.5) + r / u_orientedSize;
  vec2 su = orientedToSrc(ou);

  vec3 c = sampleSrc(su); // lineal
  if (u_spotCount > 0) c = applySpots(ou, su, c);
  c = denoise(su, c);
  vec3 srcDisp = lin2srgb(c);

  // =============== PASE LINEAL ===============
  c *= exp2(u_exposure);

  float t = u_temp / 100.0;
  float tn = u_tint / 100.0;
  c.r *= exp2(t * 0.7 + tn * 0.1);
  c.b *= exp2(-t * 0.7 + tn * 0.1);
  c.g *= exp2(-tn * 0.5);

  if (u_shadows != 0.0 || u_highlights != 0.0) {
    float ld = clamp(pow(max(luma(c), 0.0), 1.0 / 2.4), 0.0, 1.0);
    float wS = (1.0 - ld) * (1.0 - ld);
    float wH = ld * ld;
    c *= exp2(u_shadows / 100.0 * 1.6 * wS + u_highlights / 100.0 * 1.6 * wH);
  }

  // =============== PASE EN ESPACIO DE VISUALIZACIÓN ===============
  vec3 d = lin2srgb(c);

  if (u_brightness != 0.0) {
    d = pow(clamp(d, 0.0, 1.0), vec3(exp2(-u_brightness / 100.0 * 0.9)));
  }
  if (u_contrast != 0.0) {
    float k = u_contrast / 100.0;
    d = clamp(d, 0.0, 1.0);
    d = k > 0.0 ? mix(d, d * d * (3.0 - 2.0 * d), k) : 0.5 + (d - 0.5) * (1.0 + k * 0.8);
  }
  if (u_whites != 0.0 || u_blacks != 0.0) {
    float lo = -u_blacks / 100.0 * 0.12;
    float hi = 1.0 - u_whites / 100.0 * 0.12;
    d = (d - lo) / max(hi - lo, 0.05);
  }
  d = clamp(d, 0.0, 1.0);

  // color por rangos (HSL)
  if (u_hslOn == 1) {
    vec3 hsl = rgb2hsl(d);
    float hdeg = hsl.x * 360.0;
    float centers[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 225.0, 270.0, 320.0);
    float dh = 0.0;
    float ds = 0.0;
    float dl = 0.0;
    for (int i = 0; i < 8; i++) {
      float dist = abs(hdeg - centers[i]);
      dist = min(dist, 360.0 - dist);
      float w = 1.0 - smoothstep(0.0, 55.0, dist);
      dh += w * u_hsl[i].x;
      ds += w * u_hsl[i].y;
      dl += w * u_hsl[i].z;
    }
    float sw = smoothstep(0.02, 0.2, hsl.y);
    hsl.x = fract(hsl.x + dh / 100.0 * (30.0 / 360.0) * sw + 1.0);
    hsl.y = clamp(hsl.y * (1.0 + ds / 100.0 * sw), 0.0, 1.0);
    hsl.z = clamp(hsl.z + dl / 100.0 * 0.3 * sw * (1.0 - abs(2.0 * hsl.z - 1.0) * 0.5), 0.0, 1.0);
    d = hsl2rgb(hsl);
  }

  // curvas por tono: cambian tono, saturación o luminosidad según el color de cada píxel
  if (u_hslCurvesOn == 1) {
    vec3 hc = rgb2hsl(clamp(d, 0.0, 1.0));
    float cw = smoothstep(0.02, 0.2, hc.y); // los grises no tienen tono: no se tocan
    float dHue = (lutLookup(4.0, hc.x) - 0.5) * 2.0;
    float dSat = (lutLookup(5.0, hc.x) - 0.5) * 2.0;
    float dLum = (lutLookup(6.0, hc.x) - 0.5) * 2.0;
    hc.x = fract(hc.x + dHue * (60.0 / 360.0) * cw + 1.0);
    hc.y = clamp(hc.y * (1.0 + dSat * cw), 0.0, 1.0);
    hc.z = clamp(hc.z + dLum * 0.3 * cw * (1.0 - abs(2.0 * hc.z - 1.0) * 0.5), 0.0, 1.0);
    d = hsl2rgb(hc);
  }

  if (u_sat != 0.0) {
    float g = luma(d);
    d = mix(vec3(g), d, 1.0 + u_sat / 100.0);
  }
  if (u_vib != 0.0) {
    float mx = max(d.r, max(d.g, d.b));
    float mn = min(d.r, min(d.g, d.b));
    float m = mx - mn;
    vec3 hsl = rgb2hsl(clamp(d, 0.0, 1.0));
    float hdeg = hsl.x * 360.0;
    float skin = 1.0 - smoothstep(0.0, 25.0, abs(hdeg - 28.0)); // protege tonos de piel
    float wv = (1.0 - smoothstep(0.0, 0.7, m)) * (1.0 - 0.55 * skin);
    float g = luma(d);
    d = mix(vec3(g), d, 1.0 + u_vib / 100.0 * wv * 1.4);
  }
  d = clamp(d, 0.0, 1.0);

  // curvas (maestra y luego cada canal)
  if (u_curvesOn == 1) {
    d.r = lutLookup(1.0, lutLookup(0.0, d.r));
    d.g = lutLookup(2.0, lutLookup(0.0, d.g));
    d.b = lutLookup(3.0, lutLookup(0.0, d.b));
  }

  // quitar neblina: resta el velo (canal más oscuro de la imagen desenfocada) y recupera contraste
  if (u_dehaze != 0.0) {
    float k = u_dehaze / 100.0;
    // el velo se estima a escala gruesa (un nivel alto del mipmap): seguiría al objeto si fuera fino
    vec3 bl = lin2srgb(textureLod(u_src, su, clamp(u_maxLod - 2.0, 0.0, u_maxLod)).rgb);
    if (k > 0.0) {
      float veil = min(bl.r, min(bl.g, bl.b)) * k * 0.85;
      d = (d - veil) / max(1.0 - veil, 0.05);
      d = clamp(d, 0.0, 1.0);
      d = mix(d, d * d * (3.0 - 2.0 * d), k * 0.25);
    } else {
      d = mix(d, vec3(0.86), -k * 0.32 * (0.35 + 0.65 * luma(d)));
    }
    d = clamp(d, 0.0, 1.0);
  }

  // claridad (contraste local) y nitidez (detalle fino)
  if (u_clarity != 0.0) {
    vec3 bl = lin2srgb(texture(u_blur, su).rgb);
    float lm = luma(d);
    float mid = 1.0 - pow(abs(2.0 * lm - 1.0), 2.0);
    d += (srcDisp - bl) * (u_clarity / 100.0) * 1.3 * mid;
  }
  if (u_texture != 0.0) {
    vec3 mid = lin2srgb(textureLod(u_src, su, u_lod0 + 3.0).rgb);
    d += (srcDisp - mid) * (u_texture / 100.0) * 1.1;
  }
  if (u_sharp != 0.0) {
    vec3 fine = lin2srgb(textureLod(u_src, su, u_lod0 + 1.3).rgb);
    d += (srcDisp - fine) * (u_sharp / 100.0) * 1.8;
  }
  d = clamp(d, 0.0, 1.0);

  // gradación de color (sombras / medios / luces)
  if (u_gradOn == 1) {
    float L = luma(d);
    float b = u_balance / 100.0;
    float wS = 1.0 - smoothstep(0.0, 0.55 + 0.3 * b, L);
    float wH = smoothstep(0.45 + 0.3 * b, 1.0, L);
    float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
    vec3 tS = hsl2rgb(vec3(u_gradS.x / 360.0, 1.0, 0.5)) - 0.5;
    vec3 tM = hsl2rgb(vec3(u_gradM.x / 360.0, 1.0, 0.5)) - 0.5;
    vec3 tH = hsl2rgb(vec3(u_gradH.x / 360.0, 1.0, 0.5)) - 0.5;
    d += (tS * u_gradS.y * wS + tM * u_gradM.y * wM + tH * u_gradH.y * wH) * 0.4;
    d = clamp(d, 0.0, 1.0);
  }

  // ajustes locales (máscaras)
  float aspect = u_outSize.x / u_outSize.y;
  for (int i = 0; i < 4; i++) {
    if (i >= u_maskCount) break;
    float w = maskWeight(i, v_uv, aspect);
    if (w > 0.0) d = mix(d, applyLocal(d, i), w);
  }

  // bloom y halation: halo de las zonas muy claras. Se muestrean anillos alrededor del píxel en un nivel
  // grueso del mipmap y solo cuentan las luces (cada muestra se filtra por su brillo antes de promediar).
  if (u_bloom > 0.0 || u_halation > 0.0) {
    float Lsrc = max(1.0 / u_srcTexel.x, 1.0 / u_srcTexel.y);
    float glowLod = clamp(u_maxLod - 5.0, 0.0, u_maxLod);
    vec3 acc = vec3(0.0);
    float wsum = 1.0;
    {
      vec3 t0 = textureLod(u_src, su, glowLod).rgb;
      acc += t0 * smoothstep(0.55, 0.95, luma(t0));
    }
    for (int k = 0; k < 24; k++) {
      bool inner = k < 12;
      float ring = inner ? 0.04 : 0.095;
      float a = 6.2831853 * float(k) / 12.0 + (inner ? 0.0 : 0.26);
      vec2 off = vec2(cos(a), sin(a)) * ring * Lsrc * u_srcTexel;
      vec3 t = textureLod(u_src, su + off, glowLod).rgb;
      float wt = inner ? 0.9 : 0.6;
      acc += t * smoothstep(0.55, 0.95, luma(t)) * wt;
      wsum += wt;
    }
    vec3 glow = lin2srgb(acc / wsum);
    float glowL = luma(glow);
    if (u_bloom > 0.0) {
      vec3 add = glow * (u_bloom / 100.0) * 1.4;
      d = 1.0 - (1.0 - d) * (1.0 - clamp(add, 0.0, 1.0)); // mezcla "screen": nunca quema de golpe
    }
    if (u_halation > 0.0) {
      // la película refleja luz roja/naranja alrededor de las luces: tiñe el halo
      vec3 tint = vec3(1.0, 0.38, 0.12);
      d += tint * glowL * (u_halation / 100.0) * 1.0;
    }
    d = clamp(d, 0.0, 1.0);
  }

  // desvanecer (levanta los negros)
  if (u_fade > 0.0) {
    float f = u_fade / 100.0 * 0.14;
    d = d * (1.0 - f) + f;
  }

  // viñeta
  if (u_vignette != 0.0) {
    vec2 q = (v_uv - 0.5) * vec2(aspect, 1.0);
    float rr = length(q) / (0.5 * length(vec2(aspect, 1.0)));
    float m = smoothstep(0.30, 1.05, rr);
    float v = u_vignette / 100.0;
    d = v < 0.0 ? d * (1.0 + v * m) : mix(d, vec3(1.0), v * m * 0.7);
  }

  // grano (ruido fijo: no parpadea al mover deslizadores)
  if (u_grain > 0.0) {
    float cell = max(1.0, u_grainSize / 100.0 * 4.0 * (u_outLong / 1500.0));
    vec2 gp = floor(gl_FragCoord.xy / cell);
    float n = (hash(gp) + hash(gp + 17.1) + hash(gp + 31.7)) / 3.0 - 0.5;
    float L = luma(d);
    float amp = u_grain / 100.0 * 0.22 * (0.35 + 0.65 * (1.0 - abs(2.0 * L - 1.0)));
    d += n * amp;
  }

  o = vec4(clamp(d, 0.0, 1.0), 1.0);
}`;
