import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { isTauriApp, setUiLanguage } from "@libretracks/shared/desktopApi";

import en from "./en";
import es from "./es";

export type AppLanguage = "en" | "es";

export function getSystemLanguage(): AppLanguage {
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("es")) {
    return "es";
  }

  return "en";
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    lng: getSystemLanguage(),
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
  });

// The backend names auto-created songs and sessions ("Canción 1") in the
// language on screen, which it cannot work out alone while the user follows
// the system language: tell it now and on every change.
function reportUiLanguage(language: string) {
  if (!isTauriApp) return;
  void setUiLanguage(language).catch(() => undefined);
}
i18n.on("languageChanged", reportUiLanguage);
reportUiLanguage(i18n.language || getSystemLanguage());

export default i18n;