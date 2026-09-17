import { existsSync, rmSync } from "node:fs";

/**
 * Borrado en plan "lo intento" de la carpeta temporal de un spec.
 *
 * Cuando corre el `after`, la app todavía tiene la sesión abierta: la sesión de
 * WebDriver —y con ella el proceso— no termina hasta después. En Windows eso
 * deja la carpeta con un handle vivo y `rmSync` lanza EPERM. Es una carrera del
 * arnés al desmontar, no un fallo del producto, y dejar que tumbe el spec pone
 * roja una suite verde por una carpeta que está en %TEMP% y que el sistema
 * acaba reclamando igual.
 *
 * Reintenta un rato por si el handle se suelta solo y, si no, lo deja escrito y
 * sigue. Lo que NO hace es tragarse un fallo de la prueba: esto solo se llama
 * desde los hooks de limpieza.
 */
export function removeWorkDir(dir: string | undefined | null): void {
  if (!dir || !existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[cleanup] no se pudo borrar ${dir} (${message}); lo deja al sistema`);
  }
}
