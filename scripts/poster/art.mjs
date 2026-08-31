// Artwork for posters that are NOT announcing a feature.
//
// Every layout in themes.mjs is built around a screenshot, because a release
// poster has one job: show the thing that changed. A donation drive or a store
// launch has no such thing to show — bolting a screenshot of the timeline onto
// "ya estamos en Google Play" says nothing, and a grab of the live view with a
// real session in it actively confuses the message.
//
// So those posters draw their subject instead. Each piece returns its own `css`
// alongside the markup: the art is self-contained and nothing leaks into the
// screenshot layouts.
//
// Third-party marks (Ko-fi, Google Play, App Store) are NEVER redrawn here.
// They are downloaded from each brand's own page into the poster folder, listed
// in the spec's `badges`, and embedded exactly as they came — that is what
// their usage rules require and what makes them recognisable at a glance.

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * The Ko-fi mark on a light card, with the destination URL under it.
 *
 * The card is not decoration: the official symbol is drawn in near-black with
 * an orange heart, and on a dark poster its outline disappears. Ko-fi's own
 * guidance is to place it on a light ground, which is what the card is.
 *
 * `badges[0]` must be the plain symbol (no wordmark, no "Support me on"): the
 * badges that carry text only exist in English, and an English sentence in the
 * middle of a Spanish poster reads as a mistake.
 */
function kofi(theme, assets = {}, spec = {}) {
  const symbol = (assets.badgeUris ?? [])[0];
  const caption = spec.artCaption;
  const css = `
.art-kofi{width:100%;display:flex;flex-direction:column;align-items:center;gap:34px;}
.kofi-card{width:100%;max-width:376px;aspect-ratio:1;border-radius:64px;background:#fff;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 30px 80px #000000cc;}
.kofi-card img{width:68%;height:auto;display:block;}
.kofi-url{font-size:31px;font-weight:800;letter-spacing:-.01em;color:${theme.accent};
  text-align:center;}
`;
  const html = `<div class="art-kofi">
  ${symbol ? `<div class="kofi-card"><img src="${symbol}" alt="Ko-fi"></div>` : ''}
  ${caption ? `<div class="kofi-url">${esc(caption)}</div>` : ''}
</div>`;
  return { css, html };
}

/**
 * A phone showing the app's own store listing, with both official store badges
 * under it. The icon is the real `apps/website/public/icon.svg`, so the poster
 * shows exactly what a user will be looking for once they are in the store.
 */
function stores(theme, assets, spec) {
  const label = spec.artLabel ?? 'Instalar';
  const [gplay, apple] = assets.badgeUris ?? [];
  // No badges in the folder yet? Fall back to plain name plates, so the poster
  // still renders while the real artwork is being downloaded.
  const plates =
    gplay && apple
      ? `<img class="store-badge store-badge-gplay" src="${gplay}" alt="Disponible en Google Play">
    <img class="store-badge" src="${apple}" alt="Consíguelo en el App Store">`
      : `<div class="plate">Google Play</div>
    <div class="plate">App Store</div>`;
  const css = `
.art-stores{width:100%;display:flex;flex-direction:column;align-items:center;gap:30px;}
/* aspect-ratio, not a content-driven height: a phone as wide as it is tall
   reads as a tablet, and the whole point of this piece is "in your pocket". */
.phone{width:100%;max-width:330px;aspect-ratio:9/18.5;border-radius:46px;padding:15px;
  background:#ffffff0f;border:2px solid ${theme.accent}55;box-shadow:0 30px 80px #000000cc;}
.phone-screen{height:100%;border-radius:33px;background:${theme.bg};padding:20px 26px 34px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;}
/* the earpiece bar is what makes a rounded rectangle read as a phone */
.notch{width:112px;height:9px;border-radius:99px;background:#ffffff2e;
  margin-bottom:auto;flex:0 0 auto;}
.app-icon{width:146px;height:146px;border-radius:33px;display:block;
  box-shadow:0 10px 30px #00000099;}
.app-name{margin-top:22px;font-size:31px;font-weight:800;letter-spacing:-.01em;}
.app-meta{margin-top:6px;font-size:17px;color:#ffffff8c;letter-spacing:.02em;}
.app-install{margin-top:28px;align-self:stretch;border-radius:999px;padding:16px 0;
  background:${theme.accent};color:${theme.bg};font-size:21px;font-weight:900;
  letter-spacing:.08em;text-transform:uppercase;}
.app-free{margin-top:14px;margin-bottom:auto;font-size:16px;font-weight:600;
  color:${theme.accentSoft};letter-spacing:.16em;}
.store-plates{display:flex;gap:18px;align-items:center;}
/* Official badges, embedded exactly as downloaded from each store's brand page.
   Google's PNG carries its own clear-space margin and Apple's does not, so
   matching the two box heights would draw Google visibly smaller — hence the
   taller box for it. */
.store-badge{height:56px;width:auto;display:block;}
.store-badge-gplay{height:66px;}
.plate{border:2px solid ${theme.accent}88;border-radius:14px;padding:14px 22px;
  font-size:19px;font-weight:800;letter-spacing:.08em;color:#fff;white-space:nowrap;}
`;
  const html = `<div class="art-stores">
  <div class="phone">
    <div class="phone-screen">
      <div class="notch"></div>
      <img class="app-icon" src="${assets.iconUri}" alt="">
      <div class="app-name">LibreTracks</div>
      <div class="app-meta">Música · Directo</div>
      <div class="app-install">${esc(label)}</div>
      <div class="app-free">GRATIS</div>
    </div>
  </div>
  <div class="store-plates">${plates}</div>
</div>`;
  return { css, html };
}

export const ART = { kofi, stores };

export function renderArt(name, theme, assets, spec) {
  const piece = ART[name];
  if (!piece) {
    throw new Error(`Unknown art "${name}". Available: ${Object.keys(ART).join(', ')}`);
  }
  return piece(theme, assets, spec);
}
