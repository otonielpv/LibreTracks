import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://libretracks.pages.dev",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "es"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    tailwind({ applyBaseStyles: false }),
    starlight({
      title: {
        en: "LibreTracks Docs",
        es: "Documentacion LibreTracks",
      },
      logo: {
        src: "./src/assets/icon.svg",
        alt: "LibreTracks",
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/otonielpv/LibreTracks" }],
      customCss: ["./src/styles/global.css"],
      sidebar: [
        {
          label: "Documentation",
          translations: { es: "Documentacion" },
          items: [
            { label: "Overview", translations: { es: "Resumen" }, slug: "docs" },
            { label: "Core Concepts", translations: { es: "Conceptos base" }, slug: "docs/core-concepts" },
            { label: "Live Control Flow", translations: { es: "Control en vivo" }, slug: "docs/live-control-flow" },
            { label: "Audio Routing & Metronome", translations: { es: "Routing y metronomo" }, slug: "docs/audio-routing-metronome" },
            { label: "Integration & Ecosystem", translations: { es: "Integracion y ecosistema" }, slug: "docs/integration-ecosystem" },
          ],
        },
      ],
    }),
  ],
});
