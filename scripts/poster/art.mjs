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


/**
 * A phone mid-beta: the app's Play listing with the tester button on it, a
 * stamp across the corner, and the Google Play badge underneath.
 *
 * It is deliberately NOT the `stores` piece with one badge removed. That one
 * says "here is where you get it, it is done"; this poster says the opposite —
 * the listing is not public yet and the reader has to be let in first. The
 * dashed chassis and the stamp are what carry that, and the button repeats the
 * exact words Google Play shows ("Convertirme en tester"), so the poster and
 * the screen the reader lands on say the same thing.
 *
 * `badges[0]` is the official Google Play badge, embedded as downloaded.
 */
function testers(theme, assets, spec) {
  const label = spec.artLabel ?? 'Convertirme en tester';
  const stamp = spec.artStamp ?? 'BETA';
  const [gplay] = assets.badgeUris ?? [];
  const badge = gplay
    ? `<img class="store-badge store-badge-gplay" src="${gplay}" alt="Disponible en Google Play">`
    : `<div class="plate">Google Play</div>`;
  const caption = spec.artCaption;
  const css = `
/* Sized by HEIGHT, unlike the other pieces. A phone drawn from its width
   (9/18.5 of a 430px column is ~670px tall) plus a badge under it overflows
   the art box and lands on top of the feature strip — which is exactly what
   the first render of this poster did. Here the column owns the height and
   the phone shrinks into whatever is left. */
.art-testers{width:100%;height:100%;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:26px;}
/* aspect-ratio, not a content-driven height: a phone as wide as it is tall
   reads as a tablet. Dashed, unlike the shipped-app piece: this build is not
   in the store yet and the frame should not look finished. The stamp hangs off
   the corner, so the chassis is also the positioning context for it. */
.test-phone{position:relative;flex:0 1 auto;height:100%;min-height:0;
  width:auto;max-width:100%;aspect-ratio:9/18.5;border-radius:46px;padding:15px;
  background:#ffffff0f;border:2px dashed ${theme.accent}88;
  box-shadow:0 30px 80px #000000cc;}
.test-screen{height:100%;min-height:0;border-radius:33px;background:${theme.bg};padding:20px 22px 30px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;}
/* the earpiece bar is what makes a rounded rectangle read as a phone */
.test-notch{width:112px;height:9px;border-radius:99px;background:#ffffff2e;
  margin-bottom:auto;flex:0 0 auto;}
.test-icon{width:132px;height:132px;border-radius:30px;display:block;
  box-shadow:0 10px 30px #00000099;}
.test-name{margin-top:20px;font-size:30px;font-weight:800;letter-spacing:-.01em;}
.test-meta{margin-top:6px;font-size:16px;color:#ffffff8c;letter-spacing:.02em;}
/* the real button wording, not a paraphrase: the reader has to recognise it */
.test-cta{margin-top:24px;align-self:stretch;border-radius:999px;padding:14px 0;
  background:${theme.accent};color:${theme.bg};font-size:17px;font-weight:900;
  letter-spacing:.04em;text-transform:uppercase;}
.test-free{margin-top:12px;margin-bottom:auto;font-size:15px;font-weight:600;
  color:${theme.accentSoft};letter-spacing:.14em;}
.test-stamp{position:absolute;top:22px;right:-30px;transform:rotate(9deg);
  background:${theme.accent};color:${theme.bg};border-radius:12px;
  padding:10px 20px;font-size:26px;font-weight:900;letter-spacing:.12em;
  box-shadow:0 12px 30px #000000a6;}
.store-badge{height:56px;width:auto;display:block;}
/* Google's PNG carries its own clear-space margin inside the file, so it needs
   a taller box than a badge without one to read at the same size. */
.store-badge-gplay{height:66px;}
.plate{border:2px solid ${theme.accent}88;border-radius:14px;padding:14px 22px;
  font-size:19px;font-weight:800;letter-spacing:.08em;color:#fff;white-space:nowrap;}
.test-url{font-size:20px;font-weight:800;letter-spacing:-.01em;color:${theme.accent};
  text-align:center;}
`;
  const html = `<div class="art-testers">
  <div class="test-phone">
    <div class="test-screen">
      <div class="test-notch"></div>
      <img class="test-icon" src="${assets.iconUri}" alt="">
      <div class="test-name">LibreTracks</div>
      <div class="test-meta">Música · Directo</div>
      <div class="test-cta">${esc(label)}</div>
      <div class="test-free">GRATIS</div>
    </div>
    <div class="test-stamp">${esc(stamp)}</div>
  </div>
  ${badge}
  ${caption ? `<div class="test-url">${esc(caption)}</div>` : ''}
</div>`;
  return { css, html };
}
export const ART = { kofi, stores, testers };

export function renderArt(name, theme, assets, spec) {
  const piece = ART[name];
  if (!piece) {
    throw new Error(`Unknown art "${name}". Available: ${Object.keys(ART).join(', ')}`);
  }
  return piece(theme, assets, spec);
}
