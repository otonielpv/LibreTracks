import type { OpenWithFile } from "./desktopApi";

/**
 * A qué flujo va cada tipo de fichero cuando el sistema nos lo manda abrir
 * (doble click en el explorador, "Abrir con", arrastrarlo al icono de la app).
 *
 * Ninguno de estos flujos es nuevo: son exactamente los mismos que se disparan
 * desde el menú Archivo y la pantalla de inicio. Este módulo solo elige cuál,
 * y vive fuera de React para que las cuatro decisiones se puedan probar sin
 * montar nada.
 */
export type OpenWithDeps = {
  /**
   * Si hay una sesión cargada ahora mismo. Es una función, no un valor, porque
   * el despacho ocurre dentro de un oyente de larga vida: leerlo al construir
   * las dependencias congelaría la respuesta al estado del arranque.
   */
  hasOpenSession: () => boolean;
  /** `.ltsession`: abrirla, reemplazando la que hubiera. */
  openSession: (path: string) => void;
  /** `.ltset`: importar la sesión entera (pregunta dónde dejarla). */
  importSet: (path: string) => void;
  /** `.lttemplate`: crear una sesión nueva con esa estructura. */
  createFromTemplate: (path: string) => void;
  /** `.ltpkg`: importar la canción en la sesión abierta. */
  importSongPackage: (path: string) => void;
  /** `.ltpkg` sin sesión donde meterlo: avisar y no tocar nada. */
  warnSongPackageNeedsSession: (fileName: string) => void;
};

/**
 * El nombre del fichero dentro de una ruta, para los mensajes al usuario.
 *
 * Parte por las dos barras a la vez: la ruta viene de Rust tal cual la dio el
 * sistema, así que en Windows lleva `\` y en macOS/Linux `/`, y el mismo
 * binario del front se ejecuta en los tres.
 */
export function openWithFileName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

/**
 * Lanza el flujo que corresponda al fichero recibido.
 *
 * Un `.ltpkg` es el único que puede no tener a dónde ir: es una canción, y
 * necesita una sesión que la aloje. Abrir o crear una sesión por nuestra cuenta
 * sería adivinar demasiado — el usuario hizo doble click en una canción, no
 * pidió una sesión nueva —, así que se avisa y se le deja decidir.
 */
export function dispatchOpenWithFile(file: OpenWithFile, deps: OpenWithDeps) {
  switch (file.kind) {
    case "session":
      deps.openSession(file.path);
      return;
    case "set":
      deps.importSet(file.path);
      return;
    case "template":
      deps.createFromTemplate(file.path);
      return;
    case "songPackage":
      if (deps.hasOpenSession()) {
        deps.importSongPackage(file.path);
      } else {
        deps.warnSongPackageNeedsSession(openWithFileName(file.path));
      }
      return;
    default: {
      // Un tipo nuevo en Rust que aquí no se haya cableado: mejor no hacer nada
      // que hacer lo que no es. `never` convierte el olvido en error de tipos.
      const unhandled: never = file.kind;
      void unhandled;
    }
  }
}
