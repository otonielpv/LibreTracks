import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://libretracks.com",
  // Cloudflare Pages answers `/download` with a 308 to `/download/`, so any
  // internal link written without the slash makes Google crawl a redirect
  // instead of the page. `always` makes `astro dev` 404 on those links so they
  // are caught here rather than in a Search Console coverage report.
  trailingSlash: "always",
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
    sitemap({
      filter: (page) => !/\/(es\/)?admin\//.test(new URL(page).pathname),
    }),
    tailwind({ applyBaseStyles: false }),
    starlight({
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
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Overview & Core",
          translations: { es: "Resumen y conceptos" },
          collapsed: false,
          items: [
            { label: "Overview", translations: { es: "Resumen" }, slug: "docs" },
            { label: "System Requirements", translations: { es: "Requisitos del sistema" }, slug: "docs/system-requirements" },
            { label: "Core Concepts", translations: { es: "Conceptos base" }, slug: "docs/core-concepts" },
            { label: "Compact View", translations: { es: "Vista Compacta" }, slug: "docs/compact-view" },
            { label: "Pitch, Warp & The T Button", translations: { es: "Cambio de tono, warp y el botón T" }, slug: "docs/pitch-and-warp" },
          ],
        },
        {
          label: "Live Playback & Routing",
          translations: { es: "Directo y salidas de audio" },
          collapsed: false,
          items: [
            { label: "Audio Routing & Metronome", translations: { es: "Salidas de audio y metrónomo" }, slug: "docs/audio-routing-metronome" },
            { label: "Live View", translations: { es: "Vista Live" }, slug: "docs/live-view" },
            { label: "Live Control Flow", translations: { es: "Control en vivo" }, slug: "docs/live-control-flow" },
            { label: "Voice Guide", translations: { es: "Voz guía" }, slug: "docs/voice-guide" },
            { label: "Ambient Pads", translations: { es: "Pads de ambiente" }, slug: "docs/ambient-pads" },
            { label: "Automation", translations: { es: "Automatizaciones" }, slug: "docs/automation" },
            { label: "Custom Remote", translations: { es: "Remote personalizable" }, slug: "docs/remote-control" },
            { label: "Integration & Ecosystem", translations: { es: "Integración y ecosistema" }, slug: "docs/integration-ecosystem" },
          ],
        },
      ],
    }),
  ],
});
