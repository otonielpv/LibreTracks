# Guía para agentes en LibreTracks

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

## Rendimiento

Mide **siempre en build de release** antes de afirmar que hay un problema. El
PerfHud (`Ctrl+Shift+F`) da en desarrollo picos de frame y de IPC que son
artefactos de React en modo dev + Vite/HMR: el 2026-07-20 llevaron a diagnosticar
un cuello de botella en el motor que no existía en release. Lo que sí es fiable
en desarrollo son los `renderCounts`, porque son estructurales.

## Releases

Cuando se pida cortar una versión, seguir `docs/RELEASE_PROCESS.md` paso a paso.
Lista los 7 ficheros que hay que bumpear (es fácil olvidar `Cargo.lock` o uno de
los `package.json`), el formato de notas que parsea el modal de actualización
in-app y las pautas del anuncio de Facebook.

## Tests

- `npm test` orquesta las suites del workspace.
- `npm run lint` es typecheck (`tsc --noEmit`) en desktop, remote y shared.
- Los crates nativos van aparte: `npm run test:native` (el FFI no compila sin el
  engine).
