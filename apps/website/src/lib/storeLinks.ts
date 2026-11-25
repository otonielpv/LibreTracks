/**
 * Store listing URLs per site language. The Spanish and Portuguese pages
 * point at their App Store storefront; the English one uses the region-neutral
 * URL so Apple redirects to the visitor's store. On Google Play `hl` only
 * picks the language of the listing page, the region follows the visitor.
 * The Play URL is derived from the applicationId (`com.libretracks.app`, see
 * apps/desktop/src-tauri/gen/android/app/build.gradle.kts).
 */
export function storeLinks(lang: "en" | "es" | "pt") {
  return {
    appStore:
      lang === "es"
        ? "https://apps.apple.com/es/app/libretracks/id6811346212"
        : lang === "pt"
          ? "https://apps.apple.com/br/app/libretracks/id6811346212"
          : "https://apps.apple.com/app/libretracks/id6811346212",
    googlePlay:
      lang === "es"
        ? "https://play.google.com/store/apps/details?id=com.libretracks.app&hl=es"
        : lang === "pt"
          ? "https://play.google.com/store/apps/details?id=com.libretracks.app&hl=pt_BR"
          : "https://play.google.com/store/apps/details?id=com.libretracks.app",
  };
}
