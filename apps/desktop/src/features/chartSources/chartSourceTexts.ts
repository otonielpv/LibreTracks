/**
 * Texts of the chart sources (Planning Center), under the `chartSources` key
 * of the app's i18n. English and Spanish side by side so a missing one shows
 * in review and in `chartSourceTexts.test.ts`.
 */
const en = {
  account: {
    name: "Planning Center",
    explainer: "Bring lyrics and chords from your Planning Center account into your songs.",
    connect: "Connect with Planning Center",
    connecting: "Waiting for the browser…",
    connected: "Connected",
    notConnected: "Not connected",
    expired: "Session expired",
    reconnect: "Connect again",
    disconnect: "Disconnect",
    accountLabel: "{{name}} · {{organization}}",
  },
  errors: {
    notConfigured: "This build cannot connect to Planning Center.",
    signedOut: "Your Planning Center session ended. Connect again.",
    noServicesAccess: "Your user has no access to Services in this Planning Center organization.",
    notFound: "That song or arrangement is no longer in Planning Center.",
    rateLimited: "Planning Center asks to wait {{seconds}} s. Try again in a moment.",
    network: "Could not reach Planning Center: {{message}}",
    provider: "Planning Center answered with an error ({{status}}). {{detail}}",
    unexpected: "Unexpected answer from Planning Center: {{message}}",
    noText: "This arrangement has no lyrics or chords as text (maybe only a PDF).",
  },
} as const;

type Texts<T> = { [K in keyof T]: T[K] extends string ? string : Texts<T[K]> };

const es: Texts<typeof en> = {
  account: {
    name: "Planning Center",
    explainer: "Trae la letra y los acordes de tu cuenta de Planning Center a tus canciones.",
    connect: "Conectar con Planning Center",
    connecting: "Esperando al navegador…",
    connected: "Conectada",
    notConnected: "Sin conectar",
    expired: "Sesión caducada",
    reconnect: "Vuelve a conectar",
    disconnect: "Desconectar",
    accountLabel: "{{name}} · {{organization}}",
  },
  errors: {
    notConfigured: "Esta versión no puede conectarse a Planning Center.",
    signedOut: "La sesión de Planning Center ha terminado. Vuelve a conectar.",
    noServicesAccess: "Tu usuario no tiene acceso a Services en esta organización de Planning Center.",
    notFound: "Esa canción o ese arreglo ya no está en Planning Center.",
    rateLimited: "Planning Center pide esperar {{seconds}} s. Prueba de nuevo en un momento.",
    network: "No se pudo contactar con Planning Center: {{message}}",
    provider: "Planning Center respondió con un error ({{status}}). {{detail}}",
    unexpected: "Respuesta inesperada de Planning Center: {{message}}",
    noText: "Este arreglo no tiene letra ni acordes como texto (quizá solo un PDF).",
  },
};

export const CHART_SOURCE_TEXTS = { en, es };
