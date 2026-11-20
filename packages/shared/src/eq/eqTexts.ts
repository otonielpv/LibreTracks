/**
 * Textos del ecualizador (plan track-eq-2, E6): una sola fuente para el
 * escritorio (que los mete en su i18n como `eq`) y el remote (que no usa
 * react-i18next y los lee con `eqTranslator`).
 */

const es = {
  title: "Ecualizador",
  open: "EQ",
  openFor: "Ecualizador de {{name}}",
  graph: "Curva del ecualizador",
  band: "Banda {{number}}",
  enableBand: "Encender la banda {{number}}",
  kindOf: "Tipo de la banda {{number}}",
  frequencyOf: "Frecuencia de la banda {{number}}",
  gainOf: "Ganancia de la banda {{number}}",
  qOf: "Q de la banda {{number}}",
  slopeOf: "Pendiente de la banda {{number}}",
  off: "apagada",
  bypass: "Bypass",
  rta: "RTA",
  rtaHint: "Analizador de espectro: lo que sale de la pista después del ecualizador",
  reset: "Reiniciar",
  remove: "Quitar EQ",
  close: "Cerrar el ecualizador",
  appliesTo: "Se aplica a {{count}} pistas",
  copyToSelected: "Copiar EQ de {{name}} a las seleccionadas",
  presets: {
    title: "Presets",
    factory: "De fábrica",
    user: "Mis presets",
    empty: "Aún no has guardado ninguno",
    saveAs: "Guardar como…",
    namePlaceholder: "Nombre del preset",
    save: "Guardar",
    cancel: "Cancelar",
    delete: "Borrar el preset {{name}}",
    loadFailed: "No se pudieron cargar los presets",
    names: {
      "factory-vocal-clean": "Voz: limpiar graves",
      "factory-bass-definition": "Bajo: definición",
      "factory-kick": "Bombo",
      "factory-acoustic": "Guitarra acústica",
      "factory-hpf-80": "Quitar graves (HPF 80)",
      "factory-telephone": "Teléfono",
    },
  },
  kind: {
    lowCut: "Corte de graves",
    lowShelf: "Shelf de graves",
    peak: "Campana",
    highShelf: "Shelf de agudos",
    highCut: "Corte de agudos",
    notch: "Notch",
  },
};

const en: typeof es = {
  title: "Equalizer",
  open: "EQ",
  openFor: "Equalizer for {{name}}",
  graph: "Equalizer curve",
  band: "Band {{number}}",
  enableBand: "Turn band {{number}} on",
  kindOf: "Band {{number}} type",
  frequencyOf: "Band {{number}} frequency",
  gainOf: "Band {{number}} gain",
  qOf: "Band {{number}} Q",
  slopeOf: "Band {{number}} slope",
  off: "off",
  bypass: "Bypass",
  rta: "RTA",
  rtaHint: "Spectrum analyzer: what the track puts out after the equalizer",
  reset: "Reset",
  remove: "Remove EQ",
  close: "Close the equalizer",
  appliesTo: "Applies to {{count}} tracks",
  copyToSelected: "Copy EQ from {{name}} to the selected tracks",
  presets: {
    title: "Presets",
    factory: "Factory",
    user: "My presets",
    empty: "You haven't saved any yet",
    saveAs: "Save as…",
    namePlaceholder: "Preset name",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete preset {{name}}",
    loadFailed: "Couldn't load the presets",
    names: {
      "factory-vocal-clean": "Vocal: clean lows",
      "factory-bass-definition": "Bass: definition",
      "factory-kick": "Kick",
      "factory-acoustic": "Acoustic guitar",
      "factory-hpf-80": "Remove lows (HPF 80)",
      "factory-telephone": "Telephone",
    },
  },
  kind: {
    lowCut: "Low cut",
    lowShelf: "Low shelf",
    peak: "Bell",
    highShelf: "High shelf",
    highCut: "High cut",
    notch: "Notch",
  },
};

export const EQ_TEXTS = { es, en };

export type EqLanguage = keyof typeof EQ_TEXTS;

/**
 * Un `t` para claves `eq.*` con `{{var}}`, como el de i18next. Lo que no
 * existe se devuelve tal cual (o `defaultValue`).
 */
export function eqTranslator(language: EqLanguage) {
  const texts = { eq: EQ_TEXTS[language] } as Record<string, unknown>;
  return (key: string, options?: Record<string, unknown>): string => {
    let node: unknown = texts;
    for (const part of key.split(".")) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    }
    const template =
      typeof node === "string"
        ? node
        : typeof options?.defaultValue === "string"
          ? options.defaultValue
          : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      options && name in options ? String(options[name]) : "",
    );
  };
}
