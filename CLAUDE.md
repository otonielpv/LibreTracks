## graphify

> **Excepción explícita:** los agentes BUILDER y REVIEWER del plan
> `docs/plans/audio-thread-parallelism/` no deben ejecutar Graphify en ninguna
> de sus variantes. Esta excepción prevalece sobre las reglas siguientes durante
> todas las vueltas de ese harness.

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

## Dónde va el código nuevo (panel de transporte)

`apps/desktop/src/features/transport/TransportPanelContent.tsx` es un monolito
de ~8400 líneas. Creció a ~99 líneas/día entre abril y julio de 2026 porque es
el camino de menor resistencia: toda feature nueva necesita estado, un efecto y
props, y los tres encajan ahí sin fricción.

**Regla: una feature nueva no añade estado ni lógica al monolito.** Crea su
propio módulo y deja que el monolito solo lo invoque. Patrones ya validados en
el repo:

- **Handlers** → factory `create*Handlers(deps)` con inyección de dependencias,
  instanciada una vez con `useMemo`. El estado volátil se lee por getters/refs
  para que la factory no se recree. Ejemplos: `tracks/trackHeaderHandlers.ts`,
  `compact/compactSongHandlers.ts`, `colors/colorHandlers.ts`.
- **Efectos autocontenidos** → hook propio en `hooks/`. Ejemplos:
  `hooks/useLibraryState.ts`, `hooks/useSongWaveforms.ts`,
  `hooks/useMidiRawMessages.ts`, `hooks/useDragListeners.ts`.
- **Estado compartido entre zonas** → store Zustand con selectores estrechos,
  como `songStore.ts`, `store.ts`, `uiStore.ts`. Si un store nuevo guarda
  estado que los tests deben resetear, añádelo al `beforeEach` de
  `src/test/testUtils.tsx` (un store sobrevive al desmontaje; `useState` no).

`src/features/transport/fileSizeBudget.test.ts` vigila el tamaño de los ficheros
grandes. Si falla, **la opción por defecto es extraer, no subir el límite**. La
regla para saber si un bloque se puede extraer está en
`docs/REDESIGN_transport_refs_to_stores.md`: cuenta cuántas de sus refs se usan
FUERA del bloque; si son muchas no hay frontera ahí y romperlo empeora el
diseño.

No toques el hot path (playhead a 60fps, listeners de drag) sin leer antes ese
documento: se mueve mutando refs sin `setState` a propósito, y un intento previo
de refactor se revirtió por perder esa propiedad.

## Releases

When the user asks to cut a new version, follow `docs/RELEASE_PROCESS.md` step by step. It lists every file that must be version-bumped (7 of them, easy to miss `Cargo.lock` or one of the `package.json`s), the release-notes format the in-app update modal parses, and the Facebook announcement guidelines.
