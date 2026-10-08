// Images for the Guides page (/guias, /guides) and its articles, made from
// the user-guide screenshots (desktop/ and desktop-en/):
//  - cards/<lang>/: thumbnails fitted into 800x450 on the app's background,
//    so tall menus and wide rulers both read at card size;
//  - articles/<lang>/: the full screenshots as 1600px WebP (the 2x captures
//    are 3880px PNGs, far too heavy for a marketing page).
//
//   node scripts/guide-cards.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = createRequire(path.join(repoRoot, "package.json"))("sharp");
const pub = path.join(repoRoot, "apps", "website", "public", "guide");

// card name → screenshot (same file name in desktop/ and desktop-en/)
const CARDS = {
  routing: "desktop/track-route-list.png",
  markers: "desktop/ruler.png",
  live: "desktop/live-view.png",
  pitch: "desktop/toolbar-warp-panel.png",
  video: "desktop/video-wizard-2.png",
  remote: "remote/remote-controls.png",
  share: "desktop/file-menu.png",
  library: "desktop/library-panel.png",
};
// article image name → screenshot
const ARTICLE_IMAGES = {
  "compact-view": "desktop/compact-view.png",
  "live-view": "desktop/live-view.png",
  "track-route": "desktop/track-route-list.png",
  "metronome": "desktop/metronome-popover.png",
  "hardware-outputs": "desktop/settings-audio-2.png",
};
const W = 800;
const H = 450;
const PAD = 28;

for (const [lang, suffix] of [["es", ""], ["en", "-en"]]) {
  const out = path.join(pub, "cards", lang);
  mkdirSync(out, { recursive: true });
  for (const [name, rel] of Object.entries(CARDS)) {
    const [dir, file] = rel.split("/");
    const src = path.join(pub, `${dir}${suffix}`, file);
    const shot = await sharp(src)
      .resize(W - 2 * PAD, H - 2 * PAD, { fit: "inside" })
      .toBuffer();
    await sharp({ create: { width: W, height: H, channels: 3, background: "#121212" } })
      .composite([{ input: shot, gravity: "center" }])
      .webp({ quality: 82 })
      .toFile(path.join(out, `${name}.webp`));
  }
  console.log(`cards ${lang}: ${Object.keys(CARDS).length}`);

  const articles = path.join(pub, "articles", lang);
  mkdirSync(articles, { recursive: true });
  for (const [name, rel] of Object.entries(ARTICLE_IMAGES)) {
    const [dir, file] = rel.split("/");
    await sharp(path.join(pub, `${dir}${suffix}`, file))
      .resize({ width: 1600, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(articles, `${name}.webp`));
  }
  console.log(`articles ${lang}: ${Object.keys(ARTICLE_IMAGES).length}`);
}
