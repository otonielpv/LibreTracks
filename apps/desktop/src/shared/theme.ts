import { useSyncExternalStore } from "react";

import { THEMED_CSS_COLORS, THEMED_CSS_TINTS } from "./themeColors.generated";

// Tema de color de la interfaz, al estilo de Live (Opciones › Tema).
//
// Un tema son cinco ajustes independientes:
//   - base: lo claro u oscuro de toda la interfaz (oscuro, medio, claro…)
//   - acento: el color de botones, cursor, selecciones
//   - tono: tinte de los grises (neutro, frío, cálido)
//   - alto contraste y brillo
//
// Como funciona: la interfaz se diseñó en oscuro con ~320 colores distintos.
// Cada uno está en la CSS como rgb(var(--lt-c-<hex>, r g b)): sin tema, la
// variable no existe y sale el color de siempre. Al elegir un tema se
// recalcula cada uno con remapThemeRgb (los grises cambian de luminosidad
// conservando su ligero tinte; los colores solo se invierten en bases claras)
// y se escribe la variable en <html>. El canvas no lee CSS:
// pide sus colores con themedRgb()/accentRgba().
//
// Es una preferencia visual por equipo: localStorage, no AppSettings.

export type Rgb = readonly [number, number, number];

export type ThemeBaseId = "dark" | "deep" | "midDark" | "midLight" | "light";
export type ThemeToneId = "neutral" | "cool" | "warm";

export type ThemeSettings = {
  base: ThemeBaseId;
  accent: string;
  tone: ThemeToneId;
  highContrast: boolean;
  /** 0.8 – 1.2; 1 = sin cambio. */
  brightness: number;
};

type ThemeBase = {
  id: ThemeBaseId;
  defaultLabel: string;
  /** Luminosidad de salida (0–1) para las de entrada 0, 0.16, 0.6 y 1.
   * 0 es el fondo más oscuro del diseño, 0.16 un panel, 0.6 texto apagado y
   * 1 texto blanco. Entre puntos, lineal. */
  curve: readonly [number, number, number, number];
};

export const THEME_BASES: readonly ThemeBase[] = [
  { id: "dark", defaultLabel: "Dark (default)", curve: [0, 0.16, 0.6, 1] },
  { id: "deep", defaultLabel: "Deep dark", curve: [0, 0.1, 0.58, 1] },
  { id: "midDark", defaultLabel: "Mid dark", curve: [0.15, 0.27, 0.68, 1] },
  // En claro el fondo más hondo del diseño (pistas, fondos de tarjeta) pasa a
  // blanco y los paneles a grises claros.
  // Entre 0 y 0.16 la pendiente es ~1 para conservar la separación entre
  // pistas, fondo, paneles y regla que tiene el diseño oscuro.
  { id: "midLight", defaultLabel: "Mid light", curve: [0.82, 0.66, 0.17, 0.03] },
  { id: "light", defaultLabel: "Light", curve: [1, 0.86, 0.3, 0.08] },
];

const CURVE_X = [0, 0.16, 0.6, 1] as const;

export type ThemeAccent = {
  id: string;
  defaultLabel: string;
  accent: Rgb;
  /** Extremo oscuro de los degradados de los botones principales. */
  accentStrong: Rgb;
  /** Texto claro teñido del acento (en bases claras se oscurece). */
  accentSoft: Rgb;
  /** Texto sobre un fondo de acento. */
  onAccent: Rgb;
};

export const THEME_ACCENTS: readonly ThemeAccent[] = [
  {
    id: "default",
    defaultLabel: "Turquoise (default)",
    accent: [87, 241, 219],
    accentStrong: [45, 212, 191],
    accentSoft: [216, 255, 247],
    onAccent: [0, 55, 49],
  },
  {
    id: "orange",
    defaultLabel: "Orange",
    accent: [255, 164, 64],
    accentStrong: [236, 128, 28],
    accentSoft: [255, 236, 214],
    onAccent: [58, 28, 0],
  },
  {
    id: "amber",
    defaultLabel: "Amber",
    accent: [255, 206, 92],
    accentStrong: [234, 174, 40],
    accentSoft: [255, 244, 214],
    onAccent: [62, 42, 0],
  },
  {
    id: "green",
    defaultLabel: "Green",
    accent: [128, 222, 112],
    accentStrong: [86, 190, 76],
    accentSoft: [228, 250, 222],
    onAccent: [12, 50, 8],
  },
  {
    id: "blue",
    defaultLabel: "Blue",
    accent: [104, 176, 255],
    accentStrong: [62, 138, 236],
    accentSoft: [222, 237, 255],
    onAccent: [0, 30, 66],
  },
  {
    id: "violet",
    defaultLabel: "Violet",
    accent: [182, 148, 255],
    accentStrong: [146, 108, 240],
    accentSoft: [237, 230, 255],
    onAccent: [36, 14, 82],
  },
  {
    id: "pink",
    defaultLabel: "Pink",
    accent: [255, 128, 186],
    accentStrong: [236, 88, 152],
    accentSoft: [255, 228, 240],
    onAccent: [70, 6, 36],
  },
];

export const THEME_TONES: readonly { id: ThemeToneId; defaultLabel: string; offset: Rgb }[] = [
  { id: "neutral", defaultLabel: "Neutral", offset: [0, 0, 0] },
  { id: "cool", defaultLabel: "Cool", offset: [-5, 0, 9] },
  { id: "warm", defaultLabel: "Warm", offset: [9, 3, -7] },
];

/** Multiplicador de la opacidad de sombras y bordes negros por base. */
const SHADOW_ALPHA: Record<ThemeBaseId, number> = {
  dark: 1,
  deep: 1,
  midDark: 0.8,
  midLight: 0.4,
  light: 0.22,
};

/** Igual para las sombras interiores (inset). */
const INSET_SHADOW_ALPHA: Record<ThemeBaseId, number> = {
  dark: 1,
  deep: 1,
  midDark: 0.8,
  midLight: 0.15,
  light: 0,
};

export const THEME_BRIGHTNESS_MIN = 0.8;
export const THEME_BRIGHTNESS_MAX = 1.2;

export const DEFAULT_THEME: ThemeSettings = {
  base: "dark",
  accent: "default",
  tone: "neutral",
  highContrast: false,
  brightness: 1,
};

/** Compatibilidad: id que identifica el tema "sin cambios". */
export const DEFAULT_THEME_ID = "dark/default/neutral/0/1";

const STORAGE_KEY = "lt.ui.theme";

// ---------------------------------------------------------------------------
// Cálculo de la paleta (puro)

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function normalizeSettings(raw: Partial<ThemeSettings> | null | undefined): ThemeSettings {
  const base = THEME_BASES.some((item) => item.id === raw?.base) ? raw!.base! : DEFAULT_THEME.base;
  const accent = THEME_ACCENTS.some((item) => item.id === raw?.accent)
    ? raw!.accent!
    : DEFAULT_THEME.accent;
  const tone = THEME_TONES.some((item) => item.id === raw?.tone) ? raw!.tone! : DEFAULT_THEME.tone;
  const brightness =
    typeof raw?.brightness === "number" && Number.isFinite(raw.brightness)
      ? clamp(Math.round(raw.brightness * 100) / 100, THEME_BRIGHTNESS_MIN, THEME_BRIGHTNESS_MAX)
      : DEFAULT_THEME.brightness;
  return { base, accent, tone, highContrast: raw?.highContrast === true, brightness };
}

export function themeKey(settings: ThemeSettings): string {
  return `${settings.base}/${settings.accent}/${settings.tone}/${settings.highContrast ? 1 : 0}/${settings.brightness}`;
}

function baseOf(settings: ThemeSettings): ThemeBase {
  return THEME_BASES.find((item) => item.id === settings.base) ?? THEME_BASES[0];
}

export function isLightTheme(settings: ThemeSettings): boolean {
  return baseOf(settings).curve[1] > 0.5;
}

function curveAt(curve: ThemeBase["curve"], x: number): number {
  for (let index = 1; index < CURVE_X.length; index += 1) {
    if (x <= CURVE_X[index]) {
      const x0 = CURVE_X[index - 1];
      const t = (x - x0) / (CURVE_X[index] - x0);
      return curve[index - 1] + (curve[index] - curve[index - 1]) * t;
    }
  }
  return curve[curve.length - 1];
}

/**
 * Recalcula un color neutro del diseño oscuro para el tema. Conserva el ligero
 * tinte del original (su desvío respecto al gris) y solo mueve la luminosidad.
 * Con DEFAULT_THEME devuelve el mismo color.
 */
export function remapThemeRgb(rgb: Rgb, settings: ThemeSettings): Rgb {
  const [r, g, b] = rgb;
  if (Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_MAX_CHROMA) {
    const accentVariant = remapAccentFamilyRgb(rgb, settings);
    if (accentVariant) return accentVariant;
    return remapChromaticRgb(rgb, settings);
  }
  const lightness = (r + g + b) / 765;
  const base = baseOf(settings);
  let y = curveAt(base.curve, lightness);
  if (settings.highContrast) {
    // Separa texto y paneles respecto al nivel de un panel.
    const panel = base.curve[1];
    y = panel + (y - panel) * 1.3;
  }
  // El brillo mueve sobre todo los fondos; el texto casi no cambia.
  const surfaceWeight = 1 - Math.abs(y - base.curve[1]);
  y += (settings.brightness - 1) * 0.5 * surfaceWeight;
  y = clamp(y, 0, 1);

  const tone = THEME_TONES.find((item) => item.id === settings.tone)?.offset ?? [0, 0, 0];
  const grey = lightness * 255;
  const target = y * 255;
  const tint = accentTintedOffset([r - grey, g - grey, b - grey], settings);
  return [0, 1, 2].map((index) =>
    Math.round(clamp(target + tint[index] + tone[index], 0, 255)),
  ) as unknown as Rgb;
}

/** Por encima de esta diferencia entre canales un color se trata como color
 * (rojo de error, ámbar de región…) y no como gris. */
const NEUTRAL_MAX_CHROMA = 42;

/**
 * Colores con tinte (avisos, marcas, insignias). Se diseñaron claros para leerse
 * sobre negro; en una base clara se invierte su luminosidad conservando tono y
 * saturación, así el pastel pasa a ser un tono oscuro legible sobre blanco y un
 * fondo oscuro teñido pasa a un fondo claro teñido. En bases oscuras no cambian.
 */
// El diseño original usa ~20 variantes del turquesa del acento (más claras,
// más oscuras, fondos teñidos) escritas a mano. Se reconocen por el tono y
// pasan al acento elegido conservando lo claras u oscuras que son respecto al
// turquesa. Sin esto, con acento naranja seguían saliendo letras verdes.
const DEFAULT_ACCENT_HSL = rgbToHsl([87, 241, 219]);
const ACCENT_FAMILY_HUE: readonly [number, number] = [155 / 360, 200 / 360];
const ACCENT_FAMILY_MIN_SATURATION = 0.2;

function remapAccentFamilyRgb(
  rgb: Rgb,
  settings: ThemeSettings,
  { tint = false }: { tint?: boolean } = {},
): Rgb | null {
  const [h, s, l] = rgbToHsl(rgb);
  if (h < ACCENT_FAMILY_HUE[0] || h > ACCENT_FAMILY_HUE[1] || s < ACCENT_FAMILY_MIN_SATURATION) {
    return null;
  }
  const palette = buildThemePalette(settings);
  if (settings.accent === DEFAULT_THEME.accent && !palette.light) return null;
  const [accentH, accentS, accentL] = rgbToHsl(palette.accent);
  const [, , baseL] = DEFAULT_ACCENT_HSL;
  // En claro se invierte: lo que era más claro que el acento (texto suave
  // sobre negro) pasa a más oscuro, y los fondos muy oscuros a tintes claros.
  // Un velo translúcido (tint) no se invierte: sigue siendo un velo claro.
  const delta = (l - baseL) * (palette.light && !tint ? -0.6 : 1);
  return hslToRgb(
    (accentH + (h - DEFAULT_ACCENT_HSL[0]) + 1) % 1,
    clamp(accentS * (s / DEFAULT_ACCENT_HSL[1]), 0, 1),
    clamp(accentL + delta, 0.04, 0.97),
  );
}

/** Gris con un leve tinte turquesa (textos apagados del diseño): con otro
 * acento, el tinte pasa a la dirección del acento con la misma intensidad. */
function accentTintedOffset(offset: Rgb, settings: ThemeSettings): Rgb {
  if (settings.accent === DEFAULT_THEME.accent) return offset;
  const magnitude = Math.hypot(offset[0], offset[1], offset[2]);
  if (magnitude < 8) return offset;
  const [h] = rgbToHsl([
    clamp(128 + offset[0], 0, 255),
    clamp(128 + offset[1], 0, 255),
    clamp(128 + offset[2], 0, 255),
  ]);
  if (h < ACCENT_FAMILY_HUE[0] || h > ACCENT_FAMILY_HUE[1]) return offset;
  const accent = (THEME_ACCENTS.find((item) => item.id === settings.accent) ?? THEME_ACCENTS[0]).accent;
  const mean = (accent[0] + accent[1] + accent[2]) / 3;
  const direction = [accent[0] - mean, accent[1] - mean, accent[2] - mean];
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  return direction.map((value) => (value / length) * magnitude) as unknown as Rgb;
}

function remapChromaticRgb(rgb: Rgb, settings: ThemeSettings): Rgb {
  if (!isLightTheme(settings)) return rgb;
  const [h, s, l] = rgbToHsl(rgb);
  const inverted = 0.5 + (0.5 - l) * 0.8;
  return hslToRgb(h, s, clamp(inverted, 0, 1));
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255)) as unknown as Rgb;
}

const luma = ([r, g, b]: Rgb) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/** Acento para fondo claro: mismo tono, saturación contenida y la claridad
 * que da la luma pedida. Se busca por luma y no por L de HSL porque a igual L
 * un violeta o un azul se ven mucho más oscuros que un amarillo; y escalar el
 * RGB, como antes, convertía el naranja en marrón. */
function accentForLight(rgb: Rgb, targetLuma: number): Rgb {
  const [h, s] = rgbToHsl(rgb);
  const saturation = Math.min(0.95, Math.max(s, 0.65));
  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step += 1) {
    const mid = (low + high) / 2;
    if (luma(hslToRgb(h, saturation, mid)) < targetLuma) low = mid;
    else high = mid;
  }
  return hslToRgb(h, saturation, (low + high) / 2);
}

export type ThemePalette = {
  accent: Rgb;
  accentStrong: Rgb;
  accentSoft: Rgb;
  onAccent: Rgb;
  light: boolean;
};

export function buildThemePalette(settings: ThemeSettings): ThemePalette {
  const accent = THEME_ACCENTS.find((item) => item.id === settings.accent) ?? THEME_ACCENTS[0];
  if (!isLightTheme(settings)) {
    return { ...accent, light: false };
  }
  // Sobre fondo claro el acento se usa como texto y como línea: hay que
  // oscurecerlo para que se lea, y el texto encima pasa a ser claro.
  return {
    accent: accentForLight(accent.accent, 0.47),
    accentStrong: accentForLight(accent.accentStrong, 0.38),
    accentSoft: accentForLight(accent.accent, 0.28),
    onAccent: [255, 255, 255],
    light: true,
  };
}

// ---------------------------------------------------------------------------
// Estado

const readStored = (): ThemeSettings => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    if (!raw.startsWith("{")) {
      // Formato antiguo de desarrollo: solo el id del acento.
      return normalizeSettings({ accent: raw });
    }
    return normalizeSettings(JSON.parse(raw) as Partial<ThemeSettings>);
  } catch {
    return DEFAULT_THEME;
  }
};

let current: ThemeSettings = typeof window === "undefined" ? DEFAULT_THEME : readStored();
let currentKey = themeKey(current);
let palette = buildThemePalette(current);
let colorCache = new Map<string, string>();
const listeners = new Set<() => void>();

const rgbVar = ([r, g, b]: Rgb) => `${r} ${g} ${b}`;
const hexToRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(0, 2), 16),
  Number.parseInt(hex.slice(2, 4), 16),
  Number.parseInt(hex.slice(4, 6), 16),
];

/** Pone las variables del tema en <html>. Idempotente. */
export function applyThemeToDom(settings: ThemeSettings = current): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const style = root.style;
  const themePalette = buildThemePalette(settings);
  style.setProperty("--lt-accent-rgb", rgbVar(themePalette.accent));
  style.setProperty("--lt-accent-strong-rgb", rgbVar(themePalette.accentStrong));
  style.setProperty("--lt-accent-soft-rgb", rgbVar(themePalette.accentSoft));
  style.setProperty("--lt-on-accent-rgb", rgbVar(themePalette.onAccent));

  // Velos translúcidos: solo cambian los de la familia del acento (pasan al
  // acento elegido); el resto conserva su color en todas las bases.
  for (const hex of THEMED_CSS_TINTS) {
    const name = `--lt-t-${hex}`;
    const variant = remapAccentFamilyRgb(hexToRgb(hex), settings, { tint: true });
    if (variant) style.setProperty(name, rgbVar(variant));
    else style.removeProperty(name);
  }

  const identity = themeKey(settings) === DEFAULT_THEME_ID;
  for (const hex of THEMED_CSS_COLORS) {
    const name = `--lt-c-${hex}`;
    if (identity) {
      // El valor de reserva de la CSS ya es el color original.
      style.removeProperty(name);
    } else {
      style.setProperty(name, rgbVar(remapThemeRgb(hexToRgb(hex), settings)));
    }
  }
  // Sombras y bordes negros: pensados para separar paneles sobre negro. En una
  // base clara, a plena opacidad ensucian todo de gris; se rebajan.
  const shadowAlpha = SHADOW_ALPHA[settings.base];
  if (shadowAlpha === 1) style.removeProperty("--lt-shadow-alpha");
  else style.setProperty("--lt-shadow-alpha", String(shadowAlpha));
  // Las sombras interiores (botones y pozos "hundidos") van aparte: en claro
  // dejan un halo gris alrededor de cada control; ahí la interfaz es plana.
  const insetAlpha = INSET_SHADOW_ALPHA[settings.base];
  if (insetAlpha === 1) style.removeProperty("--lt-inset-shadow-alpha");
  else style.setProperty("--lt-inset-shadow-alpha", String(insetAlpha));
  style.colorScheme = themePalette.light ? "light" : "dark";
  root.dataset.ltTheme = settings.base;
  root.dataset.ltLight = themePalette.light ? "1" : "0";
}

export function getTheme(): ThemeSettings {
  return current;
}

/** Cambia una parte del tema (p. ej. { base: "light" }). */
export function setTheme(patch: Partial<ThemeSettings>): void {
  const next = normalizeSettings({ ...current, ...patch });
  const nextKey = themeKey(next);
  if (nextKey === currentKey) return;
  current = next;
  currentKey = nextKey;
  palette = buildThemePalette(next);
  colorCache = new Map();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Almacenamiento desactivado: se queda en memoria.
  }
  scheduleApply();
  listeners.forEach((listener) => listener());
}

// Reescribir las ~320 variables obliga a recalcular el estilo de toda la
// página, y con una sesión grande eso tarda. Al arrastrar un deslizador llegan
// decenas de cambios por segundo: se aplica solo el último de cada fotograma.
let pendingApply: number | null = null;
function scheduleApply(): void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    applyThemeToDom(current);
    return;
  }
  if (pendingApply !== null) return;
  pendingApply = window.requestAnimationFrame(() => {
    pendingApply = null;
    applyThemeToDom(current);
  });
}

/** Aplica ya un cambio de tema pendiente (tests). */
export function flushThemeForTests(): void {
  if (pendingApply !== null) {
    window.cancelAnimationFrame(pendingApply);
    pendingApply = null;
  }
  applyThemeToDom(current);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clave estable del tema actual; cambia con cualquier ajuste. */
export function getThemeId(): string {
  return currentKey;
}

export function useThemeId(): string {
  return useSyncExternalStore(subscribe, getThemeId, getThemeId);
}

export function useTheme(): ThemeSettings {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

// ---------------------------------------------------------------------------
// Colores para el canvas

/** True si la base actual es clara (medio claro o claro). */
export function isLightThemeActive(): boolean {
  return palette.light;
}

/** Texto legible encima de `hex`: casi negro o blanco según su luma. */
export function readableTextOn(hex: string): string {
  return luma(hexToRgb(hex.replace("#", ""))) > 0.55 ? "#1b1b1b" : "#ffffff";
}

/** Acento del tema para el canvas, p. ej. accentRgba(0.85). */
export function accentRgba(alpha: number): string {
  const [r, g, b] = palette.accent;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Acento del tema en hex (#rrggbb) para el canvas. */
export function accentHex(): string {
  return themedColor("accent", 1, () => palette.accent, true);
}

/** Un color del diseño oscuro pasado al tema actual, como rgba(). Igual que
 * en la CSS (--lt-t-*), un color con tinte usado como velo (alfa <= 0.5) se
 * deja como está: sobre fondo claro sigue leyéndose como un velo de ese color. */
export function themedRgba(r: number, g: number, b: number, alpha = 1): string {
  return themedColor(
    `${r},${g},${b}`,
    alpha,
    () => (isTint([r, g, b], alpha) ? [r, g, b] : remapThemeRgb([r, g, b], current)),
    false,
  );
}

const isTint = ([r, g, b]: Rgb, alpha: number) =>
  alpha <= 0.5 && Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_MAX_CHROMA;

/** Igual que themedRgba pero devuelve el triplete, para mezclar a mano. */
export function themedRgb(r: number, g: number, b: number): Rgb {
  return currentKey === DEFAULT_THEME_ID ? [r, g, b] : remapThemeRgb([r, g, b], current);
}

/** Atajo para un gris en hex: themedHex("#e5e2e1"). */
export function themedHex(hex: string, alpha = 1): string {
  const [r, g, b] = hexToRgb(hex.replace("#", ""));
  return themedRgba(r, g, b, alpha);
}

function themedColor(key: string, alpha: number, compute: () => Rgb, asHex: boolean): string {
  const cacheKey = `${key}|${alpha}|${asHex ? "h" : "r"}`;
  const cached = colorCache.get(cacheKey);
  if (cached) return cached;
  const [r, g, b] = compute();
  const value = asHex
    ? `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
    : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  colorCache.set(cacheKey, value);
  return value;
}

/** Solo para tests. */
export function resetThemeForTests(): void {
  current = readStored();
  currentKey = themeKey(current);
  palette = buildThemePalette(current);
  colorCache = new Map();
  listeners.forEach((listener) => listener());
}

/** Color del acento elegido tal cual (sin ajustar a la base), como "#rrggbb".
 * Es el color por defecto de lo que el usuario crea (one shots, sonidos). */
export function selectedAccentHex(): string {
  const accent = (THEME_ACCENTS.find((item) => item.id === current.accent) ?? THEME_ACCENTS[0]).accent;
  return `#${accent.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Un gris del diseño oscuro pasado al tema, como "#rrggbb" (para funciones
 * que mezclan colores en hex). */
export function themedHexColor(hex: string): string {
  const clean = hex.replace("#", "");
  return themedColor(`hex:${clean}`, 1, () => themedRgb(...hexToRgb(clean)), true);
}
