export type RemoteLanguage = "en" | "es";

function detectLanguage(): RemoteLanguage {
  const candidates: string[] = [];

  if (typeof document !== "undefined" && document.documentElement.lang) {
    candidates.push(document.documentElement.lang);
  }

  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages)) {
      candidates.push(...navigator.languages);
    }
    if (navigator.language) {
      candidates.push(navigator.language);
    }
  }

  if (candidates.some((value) => value.toLowerCase().startsWith("es"))) {
    return "es";
  }

  return "en";
}

const STRINGS = {
  en: {
    appTitle: "Remote",
    time: "Time",
    barBeat: "Bar.Beat",
    bpm: "BPM",
    region: "Song",
    play: "Play",
    pause: "Pause",
    stop: "Stop",
    click: "Click",
    clickVolume: "Click Level",
    on: "On",
    off: "Off",
    immediate: "Immediate",
    bars: "Bars",
    section: "Section",
    next: "Next",
    vamp: "Vamp",
    vampMode: "Vamp Mode",
    vampBars: "Vamp Bars",
    songTrigger: "Song Trigger",
    songTransition: "Song Transition",
    songEnd: "Song end",
    jumpToSong: "Jump to Song",
    cleanCut: "Clean cut",
    fadeOut: "Fade out",
    cancelJump: "Cancel jump",
    pending: "Pending",
    jump: "Jump",
    center: "Center",
    transport: "Transport",
    mixer: "Mixer",
    settings: "Settings",
    connectionError: "Could not connect to LibreTracks desktop.",
    nextMarker: "Next marker",
    playing: "Playing",
    paused: "Paused",
    stopped: "Stopped",
    idle: "Idle",
    empty: "Empty",
    folder: "Folder",
    audio: "Audio",
  },
  es: {
    appTitle: "Remote",
    time: "Tiempo",
    barBeat: "Compás",
    bpm: "BPM",
    region: "Canción",
    play: "Reproducir",
    pause: "Pausa",
    stop: "Detener",
    click: "Click",
    clickVolume: "Nivel Click",
    on: "Activo",
    off: "Apagado",
    immediate: "Inmediato",
    bars: "Compases",
    section: "Seccion",
    next: "Siguiente",
    vamp: "Vamp",
    vampMode: "Modo Vamp",
    vampBars: "Compases Vamp",
    songTrigger: "Trigger de Cancion",
    songTransition: "Transicion de Cancion",
    songEnd: "Fin de cancion",
    jumpToSong: "Saltar a Cancion",
    cleanCut: "Corte limpio",
    fadeOut: "Fade out",
    cancelJump: "Cancelar salto",
    pending: "Armado",
    jump: "Salto",
    center: "Centro",
    transport: "Transporte",
    mixer: "Mezclador",
    settings: "Config",
    connectionError: "No se pudo conectar con LibreTracks desktop.",
    nextMarker: "Siguiente marca",
    playing: "Reproduciendo",
    paused: "Pausado",
    stopped: "Detenido",
    idle: "En espera",
    empty: "Vacío",
    folder: "Carpeta",
    audio: "Audio",
  },
} as const;

export function getRemoteStrings() {
  return STRINGS[detectLanguage()];
}
