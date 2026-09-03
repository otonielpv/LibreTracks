/// <reference types="@cloudflare/workers-types" />

/**
 * Keeps one canonical host for the site.
 *
 * The project is served on several hostnames at once: the custom domain, the
 * `www` alias, and the `*.pages.dev` deployment that Cloudflare always attaches
 * to a Pages project. Left alone they are duplicates of each other and compete
 * in search results, so everything is funnelled to the apex domain with a
 * permanent redirect.
 *
 * Two deliberate exemptions:
 *
 * - `/api/*` is never redirected. Copies of LibreTracks already installed in
 *   the wild POST their telemetry to the pages.dev endpoint, and those installs
 *   will keep doing so for years. A redirect on a POST is not reliably followed
 *   with the method and body intact, so it would silently drop their data. The
 *   Pages Functions answer on every hostname anyway, so old installs keep
 *   working untouched.
 *
 * - Preview deployments (`<hash>.libretracks.pages.dev`) are left alone, hence
 *   the exact-match host list rather than a `.pages.dev` suffix test. Redirecting
 *   those would make it impossible to check a build before it goes live. They do
 *   get `X-Robots-Tag: noindex` instead: a preview is a byte-identical copy of
 *   the site on a crawlable hostname, and while its canonical points back here,
 *   an indexable duplicate is one more reason for Google to pick the wrong URL
 *   as canonical for the home page.
 */

const CANONICAL_HOST = "libretracks.com";

const REDIRECTED_HOSTS = new Set([
  "libretracks.pages.dev",
  `www.${CANONICAL_HOST}`,
]);

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);

  if (REDIRECTED_HOSTS.has(url.hostname) && !url.pathname.startsWith("/api/")) {
    url.hostname = CANONICAL_HOST;
    url.port = "";
    return Response.redirect(url.toString(), 301);
  }

  const response = await context.next();

  if (url.hostname.endsWith(".pages.dev")) {
    const tagged = new Response(response.body, response);
    tagged.headers.set("X-Robots-Tag", "noindex");
    return tagged;
  }

  return response;
};
