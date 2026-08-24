#!/usr/bin/env node
/**
 * Generate the release announcement poster (a 1080x1080 layout, ready for
 * Facebook and Instagram) from a JSON copy file plus a screenshot, capturing it
 * with the locally installed Chrome/Edge in headless mode.
 *
 * The capture runs at 2x by default, so the PNG comes out 2160x2160. The layout
 * is still 1080 CSS pixels — the extra density is for the SCREENSHOTS: an app
 * window is ~1900px wide and the poster shows it at ~860, so at 1x Chrome threw
 * away more than half of every UI label and the app photographed as mush.
 * `--scale 1` goes back to a 1080x1080 file when something needs it.
 *
 * The poster style is picked from the version number (see themes.mjs) so every
 * release looks different without anyone choosing; --theme overrides it.
 *
 *   node scripts/poster/make-poster.mjs --spec marketing/poster-1.10.1/poster.json
 *   node scripts/poster/make-poster.mjs --spec <file> --theme stage
 *   node scripts/poster/make-poster.mjs --spec <file> --scale 1
 *   node scripts/poster/make-poster.mjs --list-themes
 *
 * Output lands next to the spec file as <name>.png, with the intermediate HTML
 * kept alongside it so a bad frame can be inspected and re-captured.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPoster } from './render.mjs';
import { THEMES, pickTheme } from './themes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const CHROME_CANDIDATES = [
  process.env.LT_POSTER_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'No Chrome/Edge found for the headless capture. Set LT_POSTER_CHROME to its path.',
    );
  }
  return found;
}

/** Accepts both `--spec=path` and `--spec path`. */
function parseArgs(argv) {
  const args = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const raw = rest[i];
    if (!raw.startsWith('--')) continue;
    const [key, inline] = raw.replace(/^--/, '').split('=');
    if (inline !== undefined) {
      args[key] = inline;
    } else if (rest[i + 1] && !rest[i + 1].startsWith('--')) {
      args[key] = rest[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (args['list-themes']) {
    for (const t of THEMES) {
      console.log(`${t.id.padEnd(11)} layout=${t.layout.padEnd(12)} accent=${t.accent}`);
    }
    return;
  }

  if (!args.spec) {
    console.error('Usage: make-poster.mjs --spec <poster.json> [--theme <id>] [--list-themes]');
    process.exit(1);
  }

  const specPath = path.resolve(REPO, String(args.spec));
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const specDir = path.dirname(specPath);

  // The screenshot path is relative to the spec file, so a poster folder can be
  // moved without editing the JSON.
  const shot = path.resolve(specDir, spec.shot);
  if (!existsSync(shot)) {
    throw new Error(`Screenshot not found: ${shot}`);
  }

  // Optional extra screenshots, for layouts that show the same feature on more
  // than one device (see the `devices` layout). Order matters: mid-size device
  // first, phone second.
  const shots = (spec.shots ?? []).map((rel) => {
    const file = path.resolve(specDir, rel);
    if (!existsSync(file)) {
      throw new Error(`Screenshot not found: ${file}`);
    }
    return file;
  });

  const theme = pickTheme(spec.version, args.theme ? String(args.theme) : spec.theme);

  // Density of the capture, not of the layout: the page is always 1080 CSS px.
  const scale = Number(args.scale ?? spec.scale ?? 2);
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
    throw new Error(`--scale must be between 1 and 4, got "${args.scale ?? spec.scale}"`);
  }

  const fontsDir = path.join(REPO, 'apps', 'desktop', 'public', 'fonts');
  const assets = {
    grotesk700: path.join(fontsDir, 'space-grotesk-700-latin.woff2'),
    inter400: path.join(fontsDir, 'inter-400-latin.woff2'),
    inter600: path.join(fontsDir, 'inter-600-latin.woff2'),
    inter800: path.join(fontsDir, 'inter-800-latin.woff2'),
    inter900: path.join(fontsDir, 'inter-900-latin.woff2'),
  };
  for (const [name, file] of Object.entries(assets)) {
    if (!existsSync(file)) throw new Error(`Missing font ${name}: ${file}`);
  }

  const html = renderPoster({ ...spec, shot, shots }, theme, assets);

  const base = String(args.out ?? spec.out ?? `cartel-${spec.version}-${theme.id}`);
  const htmlPath = path.join(specDir, `${base}.html`);
  const pngPath = path.join(specDir, `${base}.png`);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(htmlPath, html, 'utf8');

  // Chrome refuses --screenshot on a path that already exists in some builds,
  // and a stale PNG next to a failed run is worse than none.
  const chrome = findChrome();
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--force-device-scale-factor=${scale}`,
      '--window-size=1080,1080',
      `--screenshot=${pngPath}`,
      // file:// so the data: URIs and inline fonts resolve without a server.
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ],
    { stdio: 'inherit' },
  );

  console.log(`theme:  ${theme.id} (${theme.layout}, ${theme.accent})`);
  console.log(`size:   ${1080 * scale}x${1080 * scale} (${scale}x)`);
  console.log(`html:   ${htmlPath}`);
  console.log(`poster: ${pngPath}`);
  console.log('Look at the PNG before publishing it — check for clipped text and personal data.');
}

main();
