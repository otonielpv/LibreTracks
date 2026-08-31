import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderArt } from './art.mjs';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function dataUri(file, mime) {
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

function fontFace(family, weight, file) {
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(${dataUri(file, 'font/woff2')}) format('woff2');}`;
}

/**
 * Motifs are pure CSS backgrounds so the poster stays a single self-contained
 * HTML file — no external assets, nothing to go missing at capture time.
 */
function motifCss(theme) {
  switch (theme.motif) {
    case 'rays':
      return `background-image:repeating-conic-gradient(from 205deg at 88% 6%, ${theme.accent}14 0deg 3deg, transparent 3deg 11deg);`;
    case 'waveform':
      return `background-image:repeating-linear-gradient(90deg, ${theme.accent}1f 0 2px, transparent 2px 13px);
        -webkit-mask-image:linear-gradient(180deg, transparent 0%, #000 42%, #000 58%, transparent 100%);`;
    case 'stagelight':
      return `background-image:
        radial-gradient(58% 42% at 22% 8%, ${theme.accent}1c 0%, transparent 70%),
        radial-gradient(52% 38% at 82% 4%, ${theme.accent}16 0%, transparent 72%),
        repeating-linear-gradient(90deg, ${theme.accent}0e 0 1px, transparent 1px 96px);`;
    case 'dots':
      return `background-image:radial-gradient(${theme.accent}26 1.6px, transparent 1.7px);background-size:26px 26px;`;
    case 'grid':
    default:
      return `background-image:linear-gradient(${theme.accent}12 1px, transparent 1px), linear-gradient(90deg, ${theme.accent}12 1px, transparent 1px);background-size:64px 64px;`;
  }
}

function featureBlocks(features) {
  return features
    .map(
      (f) => `<div class="feat">
        <div class="feat-title">${esc(f.title)}</div>
        <div class="feat-body">${esc(f.body)}</div>
      </div>`,
    )
    .join('\n');
}

function numberedFeatures(features) {
  return features
    .map(
      (f, i) => `<div class="nfeat">
        <div class="nfeat-num">${String(i + 1).padStart(2, '0')}</div>
        <div>
          <div class="feat-title">${esc(f.title)}</div>
          <div class="feat-body">${esc(f.body)}</div>
        </div>
      </div>`,
    )
    .join('\n');
}

/**
 * Build the poster markup. `spec` carries the copy; `theme` the look.
 * Layouts differ enough that each gets its own body template rather than a
 * pile of conditionals inside one.
 */
export function renderPoster(spec, theme, assets) {
  const { version, chip, headline, headlineAccent, sub, badge, features, shot, shots = [] } =
    spec;

  // A poster that draws its subject instead of screenshotting it picks its
  // layout from the spec, not from the theme: the theme still owns the palette
  // and the motif, but `art` has no screenshot to place.
  const layout = spec.layout ?? theme.layout;
  const art = layout === 'art' ? renderArt(spec.art, theme, assets, spec) : null;
  const artCss = art ? art.css : '';

  const fonts = [
    fontFace('Space Grotesk', 700, assets.grotesk700),
    fontFace('Inter', 400, assets.inter400),
    fontFace('Inter', 600, assets.inter600),
    fontFace('Inter', 800, assets.inter800),
    fontFace('Inter', 900, assets.inter900),
  ].join('\n');

  const toShotUri = (file) =>
    dataUri(file, path.extname(file).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png');
  const shotUri = shot ? toShotUri(shot) : null;
  // Layouts that show a device family read the extra screenshots in order:
  // the first is the mid-size device, the second the phone.
  const extraUris = shots.map(toShotUri);

  const brand = `<div class="brand">
      <div class="brand-name">LIBRETRACKS</div>
      <div class="brand-tag">MULTITRACK PARA DIRECTO</div>
    </div>`;
  const badgeHtml = badge ? `<div class="badge">${esc(badge)}</div>` : '';
  // The pill above the headline is the version for a release announcement.
  // Posters that are not a release — a donation drive, a store launch — pass
  // `chip` instead: there the version number says nothing and the slot is
  // better spent on the message.
  const chipText = chip ? esc(chip) : `v${esc(version)}`;
  const versionChip = `<span class="vchip">${chipText}</span>`;

  // Newlines in the headline are deliberate line breaks: a poster headline is
  // typeset by hand, not left to wrap wherever the box happens to end.
  const headlineHtml = `<h1>${esc(headline).replace(/\n/g, '<br>')}<span class="dot">${esc(headlineAccent ?? '.')}</span></h1>`;

  let body;
  if (layout === 'art') {
    body = `<div class="l-art">
      <div class="art-main">
        <div class="art-copy">
          ${versionChip}
          ${headlineHtml}
          <p class="sub">${esc(sub)}</p>
        </div>
        <div class="art-figure">${art.html}</div>
      </div>
      <div class="feats-row">${featureBlocks(features)}</div>
    </div>`;
  } else if (layout === 'split') {
    body = `<div class="l-split">
      <div class="col-left">
        ${versionChip}
        ${headlineHtml}
        <p class="sub">${esc(sub)}</p>
        <div class="feats-col">${featureBlocks(features)}</div>
      </div>
      <div class="col-right"><img class="shot shot-tall" src="${shotUri}" alt=""></div>
    </div>`;
  } else if (layout === 'bleed-right') {
    body = `<div class="l-bleed">
      <div class="bleed-copy">
        ${versionChip}
        ${headlineHtml}
        <p class="sub">${esc(sub)}</p>
      </div>
      <div class="bleed-shot"><img class="shot" src="${shotUri}" alt=""></div>
      <div class="feats-row">${featureBlocks(features)}</div>
    </div>`;
  } else if (layout === 'tilt') {
    body = `<div class="l-tilt">
      <div class="tilt-shot"><img class="shot" src="${shotUri}" alt=""></div>
      <div class="tilt-copy">
        ${versionChip}
        ${headlineHtml}
        <p class="sub">${esc(sub)}</p>
      </div>
      <div class="feats-row">${featureBlocks(features)}</div>
    </div>`;
  } else if (layout === 'devices') {
    const tablet = extraUris[0]
      ? `<img class="shot dev-tablet" src="${extraUris[0]}" alt="">`
      : '';
    const phone = extraUris[1]
      ? `<img class="shot dev-phone" src="${extraUris[1]}" alt="">`
      : '';
    body = `<div class="l-devices">
      <div class="dev-copy">
        ${versionChip}
        ${headlineHtml}
        <p class="sub">${esc(sub)}</p>
      </div>
      <div class="devices">
        <img class="shot dev-desktop" src="${shotUri}" alt="">
        ${tablet}
        ${phone}
      </div>
      <div class="feats-row">${featureBlocks(features)}</div>
    </div>`;
  } else if (layout === 'list') {
    body = `<div class="l-list">
      <div class="list-head">
        ${versionChip}
        ${headlineHtml}
        <p class="sub">${esc(sub)}</p>
      </div>
      <div class="list-grid">
        <div class="nfeats">${numberedFeatures(features)}</div>
        <div class="list-shot"><img class="shot" src="${shotUri}" alt=""></div>
      </div>
    </div>`;
  } else {
    body = `<div class="l-spot">
      <div class="spot-copy">
        ${versionChip}
        ${headlineHtml}
        <p class="sub">${esc(sub)}</p>
      </div>
      <div class="spot-shot"><img class="shot" src="${shotUri}" alt=""></div>
      <div class="feats-row">${featureBlocks(features)}</div>
    </div>`;
  }

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<style>
${fonts}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1080px}
body{
  font-family:'Inter',system-ui,sans-serif;
  background:${theme.bg};
  color:#fff;
  overflow:hidden;
  position:relative;
}
.bgglow{position:absolute;inset:0;background:${theme.bgGlow};}
.motif{position:absolute;inset:0;opacity:.75;${motifCss(theme)}}
.frame{position:absolute;inset:0;padding:64px 64px 56px;display:flex;flex-direction:column;}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;flex:0 0 auto;}
.brand-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:40px;letter-spacing:.02em;color:${theme.accent};line-height:1;}
.brand-tag{margin-top:8px;font-size:14px;font-weight:600;letter-spacing:.34em;color:#ffffffb0;}
.badge{border:2px solid ${theme.accent};color:${theme.accent};border-radius:999px;padding:14px 26px;font-size:16px;font-weight:800;letter-spacing:.14em;white-space:nowrap;}
.vchip{display:inline-block;background:${theme.accent};color:${theme.bg};font-weight:900;font-size:19px;letter-spacing:.06em;padding:7px 16px;border-radius:8px;margin-bottom:20px;}
h1{font-size:96px;font-weight:${theme.headlineWeight};line-height:.96;letter-spacing:-.03em;}
.dot{color:${theme.accent};}
.sub{margin-top:20px;font-size:26px;font-weight:400;color:#ffffffcc;line-height:1.34;max-width:20ch;}
.shot{display:block;border-radius:14px;border:1px solid ${theme.accent}44;box-shadow:0 30px 80px #000000cc;}
.feat-title{font-size:23px;font-weight:800;letter-spacing:-.01em;}
.feat-body{margin-top:5px;font-size:18px;color:#ffffff9c;line-height:1.32;}
.feats-row{flex:0 0 auto;display:flex;gap:26px;}
.feats-row .feat{flex:1;border-left:3px solid ${theme.accent};padding-left:15px;}
.feats-col{margin-top:38px;display:flex;flex-direction:column;gap:22px;}
.feats-col .feat{border-left:3px solid ${theme.accent};padding-left:15px;}

/* spotlight */
.l-spot{flex:1;display:flex;flex-direction:column;padding-top:52px;}
.spot-copy{flex:0 0 auto;}
.spot-shot{flex:1;display:flex;align-items:center;margin:38px 0 34px;min-height:0;}
.spot-shot .shot{width:100%;max-height:100%;object-fit:cover;object-position:top left;}

/* bleed-right — the perspective turn and the overhang past the right margin
   are the identity here. The shot sits BELOW the headline rather than under
   it: overlapping the two made the app unreadable and put white text over the
   bright waveforms. */
.l-bleed{flex:1;display:flex;flex-direction:column;padding-top:46px;overflow:hidden;}
.bleed-copy{flex:0 0 auto;max-width:760px;}
.bleed-shot{flex:1 1 auto;display:flex;align-items:center;min-height:0;
  margin:24px -128px 40px 0;}
.bleed-shot .shot{width:100%;max-height:100%;object-fit:cover;object-position:top left;
  transform:perspective(1900px) rotateY(-9deg);}
.l-bleed .feats-row{flex:0 0 auto;margin-top:auto;}

/* split — the right column is wide and the shot overhangs the frame, because
   the screenshots are ~2:1: fitted inside a narrow column the app renders too
   small to read anything in it. Cropping to the left of the image keeps the
   track headers and waveforms, which is the part worth showing. */
.l-split{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 470px;gap:38px;
  padding-top:52px;align-items:center;}
.col-left h1{font-size:74px;}
.col-left .sub{font-size:22px;max-width:22ch;}
.col-right{margin-right:-104px;}
.shot-tall{width:574px;height:660px;object-fit:cover;object-position:top left;}

/* tilt — headline on top, the screenshot tilted below it. The screenshots are
   all ~2:1 landscape, so putting the app in a narrow side column shrinks it to
   nothing; and overlapping it with the headline hid both. The tilt (plus the
   overhang past the right margin) is what sets this layout apart from the
   spotlight one, not the stacking order. */
.l-tilt{flex:1;display:flex;flex-direction:column;padding-top:50px;overflow:hidden;}
.l-tilt .tilt-copy{order:1;flex:0 0 auto;}
/* The rotation swings the corners outward, so the shot needs slack on every
   side or it collides with the feature strip and clips against the frame. */
.l-tilt .tilt-shot{order:2;flex:1 1 auto;display:flex;align-items:center;
  min-height:0;margin:26px -78px 48px 0;}
.l-tilt .tilt-shot .shot{width:100%;max-height:94%;object-fit:cover;
  object-position:top left;transform:rotate(-2.4deg);}
.l-tilt .feats-row{order:3;flex:0 0 auto;}
.tilt-copy h1{font-size:88px;}
.tilt-copy .sub{margin-top:16px;}

/* devices — the same feature on three screen sizes. The shots are absolutely
   positioned inside a flexible box: each one is sized by WIDTH only, so its
   own aspect ratio decides the height and nothing is squashed. They overlap on
   purpose (desktop behind, phone in front) — that stack is what says "this runs
   everywhere" at a glance. */
.l-devices{flex:1;display:flex;flex-direction:column;padding-top:28px;overflow:hidden;}
.dev-copy{flex:0 0 auto;}
.dev-copy h1{font-size:76px;}
.dev-copy .sub{margin-top:12px;font-size:23px;max-width:30ch;}
/* The box is sized by the flex row, and every shot is placed by WIDTH only so
   its own aspect ratio sets the height. Keep the tallest shot (the desktop one)
   under the row height or the stack runs over the feature strip. */
.devices{flex:1 1 auto;position:relative;margin:20px -70px 44px -20px;min-height:0;}
/* The bottom margin is the guard rail: the phone sits in FRONT of everything
   and its lower edge must clear the feature strip, or a column reads as
   covered by a screenshot. */
.devices .shot{position:absolute;}
/* The desktop and tablet shots are cropped from the bottom (their marker grid
   stops before the window does, and the empty half reads as dead space on a
   poster); the phone one already fills its frame. */
.dev-desktop{width:860px;height:380px;object-fit:cover;object-position:top left;right:-16px;top:0;}
.dev-tablet{width:376px;height:168px;object-fit:cover;object-position:top left;left:0;bottom:52px;z-index:2;}
.dev-phone{width:308px;left:214px;bottom:18px;z-index:3;}
.l-devices .feats-row{flex:0 0 auto;}
.l-devices .feat-title{font-size:21px;}
.l-devices .feat-body{font-size:17px;}

/* list — numbered features beside a framed shot. The grid must stretch (not
   centre) its rows, otherwise the shot floats at its natural size and leaves
   the top half of the poster empty. */
.l-list{flex:1;display:flex;flex-direction:column;padding-top:50px;overflow:hidden;}
.list-head{flex:0 0 auto;}
.list-head h1{font-size:74px;}
.list-grid{flex:1 1 auto;display:grid;grid-template-columns:minmax(0,1fr) 500px;
  gap:40px;margin:36px 0 8px;align-items:stretch;min-height:0;}
.nfeats{display:flex;flex-direction:column;justify-content:center;gap:30px;}
.nfeat{display:flex;gap:16px;align-items:flex-start;}
.nfeat-num{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:22px;color:${theme.accent};min-width:34px;padding-top:2px;}
/* Height-driven: the shot fills the grid row and is cropped horizontally,
   rather than sizing to a fixed width and leaving the row half empty. */
.list-shot{display:flex;min-height:0;margin-right:-84px;}
.list-shot .shot{width:100%;height:100%;object-fit:cover;object-position:top left;}

/* art — no screenshot at all: copy on the left, drawn subject on the right.
   The figure column is fixed-width so the headline keeps a stable measure,
   and the spec artWidth widens it for pieces that need the room. */
.l-art{flex:1;display:flex;flex-direction:column;padding-top:50px;overflow:hidden;}
.art-main{flex:1 1 auto;display:grid;
  grid-template-columns:minmax(0,1fr) ${spec.artWidth ?? 400}px;
  gap:48px;align-items:center;min-height:0;padding-bottom:62px;}
.art-copy h1{font-size:${spec.headlineSize ?? 96}px;}
.art-copy .sub{font-size:25px;max-width:24ch;}
.art-figure{display:flex;align-items:center;justify-content:center;
  height:100%;max-height:100%;}
.l-art .feats-row{flex:0 0 auto;margin-top:auto;}
${artCss}
</style></head>
<body>
<div class="bgglow"></div><div class="motif"></div>
<div class="frame">
  <div class="topbar">${brand}${badgeHtml}</div>
  ${body}
</div>
</body></html>`;
}
