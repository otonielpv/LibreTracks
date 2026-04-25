import i18n from "i18next";
import { initReactI18next } from "react-i18next";

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
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;