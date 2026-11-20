/**
 * RTA por evento (plan track-eq-2, paso 07, E8): el anfitrión emite
 * `audio:eq_spectrum { trackId, bands }` mientras su analizador está puesto.
 * Un invitado de red o el remote no pueden leer el motor que suena; guardan
 * el último evento y el editor lo lee como si fuera la lectura directa.
 *
 * El analizador del anfitrión tiene una sola ranura: si otro cliente lo pide
 * para otra pista, el evento trae esa pista y aquí no se pinta nada.
 */
export type EqSpectrumEvent = { trackId: string; bands: number[] };

export function createSpectrumFeed() {
  let last: EqSpectrumEvent | null = null;
  return {
    push(event: EqSpectrumEvent) {
      last = event;
    },
    /** Las bandas del último evento si son de `trackId`; si no, vacío. */
    read(trackId: string): number[] {
      return last && last.trackId === trackId ? last.bands : [];
    },
    clear() {
      last = null;
    },
  };
}

export type SpectrumFeed = ReturnType<typeof createSpectrumFeed>;
