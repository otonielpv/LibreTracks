// Runtime polyfills for the older WebKit that ships with the macOS versions we
// still support (the Tauri WebView uses the *system* Safari). esbuild down-levels
// modern *syntax*, but it does not add missing *runtime methods* — so anything
// newer than the floor must be polyfilled here.
//
// Floor: macOS 10.15 Catalina ships Safari 13.1. The methods below all landed in
// Safari 15.4, so without these the app throws on Catalina/Big Sur. The headline
// case was Array.prototype.at(-1), used across the transport/timeline (e.g. the
// drag-drop drop handler and clip selection) — calling it blanked the screen.
//
// Import this FIRST, before any app code (see main.tsx). Every definition is
// guarded (only installed when absent) and non-enumerable, so on a modern WebKit
// this file is a no-op.

function define(target: object, name: string, value: unknown): void {
  if (!(name in target)) {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

// Array/String/TypedArray .prototype.at(index) — Safari 15.4
function relativeIndex(this: { length: number; [k: number]: unknown }, index: number) {
  const len = this.length;
  const i = Math.trunc(index) || 0;
  const k = i < 0 ? len + i : i;
  return k < 0 || k >= len ? undefined : this[k];
}
define(Array.prototype, "at", relativeIndex);
define(String.prototype, "at", relativeIndex);
// All TypedArrays share %TypedArray%.prototype via Int8Array's prototype chain.
const typedArrayProto = Object.getPrototypeOf(Int8Array.prototype);
if (typedArrayProto) {
  define(typedArrayProto, "at", relativeIndex);
}

// Array.prototype.findLast / findLastIndex — Safari 15.4
define(Array.prototype, "findLast", function findLast(
  this: unknown[],
  predicate: (value: unknown, index: number, array: unknown[]) => boolean,
  thisArg?: unknown,
) {
  for (let i = this.length - 1; i >= 0; i--) {
    if (predicate.call(thisArg, this[i], i, this)) return this[i];
  }
  return undefined;
});
define(Array.prototype, "findLastIndex", function findLastIndex(
  this: unknown[],
  predicate: (value: unknown, index: number, array: unknown[]) => boolean,
  thisArg?: unknown,
) {
  for (let i = this.length - 1; i >= 0; i--) {
    if (predicate.call(thisArg, this[i], i, this)) return i;
  }
  return -1;
});

// Object.hasOwn(obj, key) — Safari 15.4
define(Object, "hasOwn", function hasOwn(target: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(target, key);
});

// CanvasRenderingContext2D / Path2D .roundRect(x, y, w, h, radii) — Safari 16.4.
// The whole timeline is canvas-drawn; without this the first roundRect call
// throws inside the render loop and nothing paints (no header, clips, waveform
// or markers — just an empty canvas). The app only ever passes a single numeric
// radius, so a uniform-radius implementation covers every call site.
function roundRectPolyfill(
  this: CanvasPath,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: number | number[] = 0,
): void {
  let r = 0;
  if (typeof radii === "number") {
    r = radii;
  } else if (Array.isArray(radii) && radii.length > 0 && typeof radii[0] === "number") {
    r = radii[0];
  }
  const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
  r = Math.max(0, Math.min(r, max));
  this.moveTo(x + r, y);
  this.arcTo(x + w, y, x + w, y + h, r);
  this.arcTo(x + w, y + h, x, y + h, r);
  this.arcTo(x, y + h, x, y, r);
  this.arcTo(x, y, x + w, y, r);
  this.closePath();
}
if (typeof CanvasRenderingContext2D !== "undefined") {
  define(CanvasRenderingContext2D.prototype, "roundRect", roundRectPolyfill);
}
if (typeof Path2D !== "undefined") {
  define(Path2D.prototype, "roundRect", roundRectPolyfill);
}
// OffscreenCanvas (and its 2D context) is itself Safari 16.4 — on older WebKit
// it doesn't exist and WaveformTileCache falls back to a normal canvas, so its
// context is the CanvasRenderingContext2D already patched above. Guard anyway.
if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
  define(OffscreenCanvasRenderingContext2D.prototype, "roundRect", roundRectPolyfill);
}
