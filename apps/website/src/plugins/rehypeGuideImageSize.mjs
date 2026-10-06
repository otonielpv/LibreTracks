import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// The user-guide captures under /guide/ are taken at 2x device pixel ratio
// (tests/e2e/specs/guide-shots.e2e.ts) so they stay sharp on HiDPI screens
// and when zoomed. Without a width attribute the browser lays them out at
// their pixel size, i.e. twice as large as the interface really looks. This
// stamps width/height (pixels / 2, see sizeOf) on every such <img>, which also reserves
// the space and avoids layout shift while it loads.
const publicDir = new URL("../../public/", import.meta.url);
const cache = new Map();

const sizeOf = async (src) => {
  if (cache.has(src)) return cache.get(src);
  let size = null;
  try {
    const file = fileURLToPath(new URL(src.replace(/^\//, ""), publicDir));
    const meta = await sharp(readFileSync(file)).metadata();
    // Narrow crops (one track header, one menu) are unreadable at true size,
    // so they are shown up to 1.6x larger — still sharp, since the pixels are
    // 2x. Wide captures stay at true size and the column scales them down.
    let width = meta.width / 2;
    if (width < 480) width = Math.min(meta.width / 1.25, 480);
    size = { width: Math.round(width), height: Math.round((meta.height * width) / meta.width) };
  } catch {
    size = null;
  }
  cache.set(src, size);
  return size;
};

export default function rehypeGuideImageSize() {
  return async (tree) => {
    const images = [];
    const walk = (node) => {
      if (node.type === "element" && node.tagName === "img") {
        const src = node.properties?.src;
        if (typeof src === "string" && src.startsWith("/guide/")) images.push(node);
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    await Promise.all(
      images.map(async (node) => {
        const size = await sizeOf(node.properties.src);
        if (!size) return;
        node.properties.width = size.width;
        node.properties.height = size.height;
        node.properties.loading = "lazy";
        node.properties.decoding = "async";
      }),
    );
  };
}
