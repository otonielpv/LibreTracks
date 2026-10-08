import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";
import rehypeGuideImageSize from "./src/plugins/rehypeGuideImageSize.mjs";

// `<lastmod>` only helps while Google trusts it, and stamping every URL with the
// build date is the fastest way to lose that trust: one typo fix would claim all
// 48 pages changed. The honest date is the last commit that touched the page's
// own source. Shared layout and CSS churn is deliberately not counted — the
// signal is meant to say when the *content* changed, not when the chrome moved.
const lastCommitCache = new Map();

const lastCommitDate = (relativePath) => {
  if (lastCommitCache.has(relativePath)) return lastCommitCache.get(relativePath);
  let iso;
  try {
    iso =
      execFileSync("git", ["log", "-1", "--format=%cI", "--", relativePath], {
        cwd: new URL(".", import.meta.url),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
  } catch {
    // No git binary, a shallow clone with no commit for this path, or a build
    // from a tarball. Dropping lastmod is valid and leaves the sitemap exactly
    // as it was before, so a build host without history degrades quietly.
    iso = undefined;
  }
  lastCommitCache.set(relativePath, iso);
  return iso;
};

// Maps a built URL back to the file an author would edit. Astro pages follow
// `src/pages/`, but Starlight docs are a content collection and live outside it.
const pageSource = (pathname) => {
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  const candidates =
    clean === ""
      ? ["src/pages/index.astro"]
      : [`src/pages/${clean}.astro`, `src/pages/${clean}/index.astro`];
  const docs = clean.match(/^(?:(es)\/)?docs(?:\/(.+))?$/);
  if (docs) {
    // Guide pages with numbered captures are .mdx (they import Legend/Clip).
    const base = `src/content/docs/${docs[1] ? "es/docs" : "docs"}/${docs[2] ?? "index"}`;
    candidates.push(`${base}.md`, `${base}.mdx`);
  }
  return candidates.find((candidate) => existsSync(new URL(candidate, import.meta.url)));
};

export default defineConfig({
  site: "https://libretracks.com",
  // Cloudflare Pages answers `/download` with a 308 to `/download/`, so any
  // internal link written without the slash makes Google crawl a redirect
  // instead of the page. `always` makes `astro dev` 404 on those links so they
  // are caught here rather than in a Search Console coverage report.
  trailingSlash: "always",
  markdown: {
    rehypePlugins: [rehypeGuideImageSize],
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "es"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    // Starlight pulls in the sitemap integration itself, but without a filter it
    // publishes the private /admin/ dashboards. Declare it explicitly instead.
    // /download/stats/ joins them: it renders its counters client-side, so it is
    // marked noIndex and listing a page we ask Google not to index is a
    // contradiction the coverage report would keep reminding us about.
    sitemap({
      filter: (page) => !/^\/(es\/)?(admin\/|download\/stats\/)/.test(new URL(page).pathname),
      serialize: (item) => {
        const source = pageSource(new URL(item.url).pathname);
        const lastmod = source && lastCommitDate(source);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
    tailwind({ applyBaseStyles: false }),
    starlight({
      components: {
        Head: "./src/components/StarlightHead.astro",
      },
      // Starlight renders docs pages with its own layout, so the verification
      // tag in SiteLayout never reaches them. Inject it here too.
      head: [
        {
          tag: "meta",
          attrs: {
            name: "google-site-verification",
            content: "Flpzp-UREGKOBDVuAhhNDb-mbP-w5ilomf2lQEXhAaY",
          },
        },
      ],
      title: {
        en: "LibreTracks Docs",
        es: "Documentación LibreTracks",
      },
      logo: {
        src: "./src/assets/icon.svg",
        alt: "LibreTracks",
      },
      // Same set as the marketing header in SiteLayout, so the two headers do
      // not offer a different idea of where the community lives.
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/otonielpv/LibreTracks" },
        { icon: "facebook", label: "Facebook", href: "https://www.facebook.com/groups/1795788251804551" },
        { icon: "reddit", label: "Reddit", href: "https://www.reddit.com/r/LibreTracks/" },
        { icon: "youtube", label: "YouTube", href: "https://www.youtube.com/@LibreTracks" },
      ],
      customCss: ["./src/styles/fonts.css", "./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Get started",
          translations: { es: "Empezar" },
          collapsed: false,
          items: [
            { slug: "docs" },
            { slug: "docs/system-requirements" },
            { slug: "docs/start/first-song" },
            { slug: "docs/mobile" },
          ],
        },
        {
          label: "The interface, button by button",
          translations: { es: "La interfaz, botón a botón" },
          collapsed: false,
          autogenerate: { directory: "docs/interface" },
        },
        {
          label: "Building the show",
          translations: { es: "Montar el show" },
          collapsed: false,
          items: [
            { slug: "docs/tasks/library" },
            { slug: "docs/tasks/songs" },
            { slug: "docs/tasks/markers" },
            { slug: "docs/tasks/clips-tracks" },
            { slug: "docs/tasks/tempo" },
            { slug: "docs/pitch-and-warp" },
            { slug: "docs/audio-routing-metronome" },
            { slug: "docs/tasks/video" },
          ],
        },
        {
          label: "Playing live",
          translations: { es: "Tocar en directo" },
          collapsed: false,
          items: [
            { slug: "docs/live-view" },
            { slug: "docs/live-control-flow" },
            { slug: "docs/voice-guide" },
            { slug: "docs/ambient-pads" },
            { slug: "docs/remote-control" },
            { slug: "docs/automation" },
          ],
        },
        {
          label: "Sharing and advanced",
          translations: { es: "Compartir y avanzado" },
          collapsed: false,
          items: [
            { slug: "docs/integration-ecosystem" },
            { slug: "docs/tasks/midi" },
            { slug: "docs/compact-view" },
            { slug: "docs/core-concepts" },
          ],
        },
        {
          label: "Help",
          translations: { es: "Ayuda" },
          collapsed: false,
          autogenerate: { directory: "docs/help" },
        },
      ],
    }),
  ],
});
