```txt
Stack: Tauri + React + TypeScript + Rust
Tipo de app: escritorio + control remoto web
Primer objetivo: editor/reproductor multitrack tipo timeline
Seguridad remota inicial: abierta en la red local
Prioridad: prototipo rápido, pero con arquitectura limpia
```

Tauri v2 encaja bien porque permite usar React/TypeScript en la interfaz y Rust para la lógica nativa/backend, con soporte multiplataforma para Windows, macOS y Linux. La documentación oficial también confirma que Tauri puede crearse con plantillas React y que el backend Rust puede comunicarse con el frontend mediante comandos/eventos. ([Tauri][1])

# Plan de desarrollo inicial

## Estado actual del proyecto

Estado a 19/04/2026:

- Ya existe la base del monorepo con `apps/`, `crates/`, `docs/`, `samples/` y `tests/`.
- Ya existe una app desktop React con placeholder visual y una base Tauri en Rust.
- Ya existe el crate `libretracks-core` con modelo de dominio, validaciones y tests unitarios Rust escritos.
- Ya existe el crate `libretracks-project` con lectura/escritura de `song.json`, estructura de carpeta de canción y tests unitarios Rust escritos.
- `libretracks-project` ya importa WAVs al almacenamiento interno, detecta duración y crea `Track`/`Clip` automáticamente.
- `libretracks-audio` ya tiene un transporte lógico mínimo testeable con `play/pause/stop/seek`, clips activos y mezcla básica por pista/grupo.
- Ya hay tests frontend mínimos en `apps/desktop` ejecutándose con Vitest.
- El frontend desktop ya arranca en modo web con Vite y responde localmente.
- Rust ya está instalado en esta máquina.
- Los tests Rust de `libretracks-core` y `libretracks-project` ya se han ejecutado correctamente en esta máquina.
- La app desktop de Tauri ya pasa `cargo check`.
- La app desktop ya puede importar WAVs desde un selector nativo, crear una canción básica y lanzar una primera reproducción local.
- La app desktop ya muestra secciones básicas, sección actual y permite programar/cancelar saltos musicales desde el panel de transporte.
- Todavía no está implementado el timeline editable ni el control de mezcla en tiempo real.

## Objetivo de la primera etapa

Antes de pensar en una app grande, el primer objetivo debería ser:

> Reproducir varias pistas de audio sincronizadas desde una línea de tiempo básica, con mute, volumen, grupos y guardado de proyecto.

El control remoto vendría después, porque primero necesitamos que el motor local sea estable.

---

# Fase 0 — Preparación del proyecto

## Objetivo

Crear la base técnica del repositorio, con arquitectura limpia y tests desde el principio.

## Resultado esperado

Un repositorio funcionando con:

* Tauri v2.
* React.
* TypeScript.
* Rust.
* Estructura modular.
* Tests frontend.
* Tests Rust.
* Linter/formato.
* Primer modelo de dominio.

## Estructura inicial recomendada

```txt
libretracks/
├── apps/
│   ├── desktop/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── features/
│   │   │   ├── shared/
│   │   │   └── main.tsx
│   │   │
│   │   ├── src-tauri/
│   │   │   ├── src/
│   │   │   │   ├── main.rs
│   │   │   │   ├── commands/
│   │   │   │   ├── audio/
│   │   │   │   ├── project/
│   │   │   │   ├── timeline/
│   │   │   │   └── remote/
│   │   │   └── tauri.conf.json
│   │   │
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   └── remote/
│       ├── src/
│       └── package.json
│
├── crates/
│   ├── libretracks-core/
│   ├── libretracks-audio/
│   ├── libretracks-project/
│   └── libretracks-remote/
│
├── docs/
│   ├── architecture.md
│   ├── audio-engine.md
│   ├── project-format.md
│   └── roadmap.md
│
├── samples/
│   └── demo-song/
│
├── tests/
│   └── e2e/
│
├── Cargo.toml
├── package.json
└── README.md
```

---

# Fase 1 — Núcleo de dominio

## Objetivo

Definir bien los conceptos centrales antes de hacer una interfaz compleja.

## Entidades principales

### Project

Representa un proyecto o biblioteca local.

```ts
type Project = {
  id: string;
  name: string;
  songs: Song[];
  setlists: Setlist[];
};
```

### Song

```ts
type Song = {
  id: string;
  title: string;
  artist?: string;
  bpm: number;
  key?: string;
  timeSignature: string;
  durationSeconds: number;
  tracks: Track[];
  groups: TrackGroup[];
  clips: Clip[];
  sections: Section[];
};
```

### Track

```ts
type Track = {
  id: string;
  name: string;
  groupId?: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  outputBusId: string;
};
```

### TrackGroup

```ts
type TrackGroup = {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  outputBusId: string;
};
```

### Clip

```ts
type Clip = {
  id: string;
  trackId: string;
  filePath: string;
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  durationSeconds: number;
  gain: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
};
```

### Section

```ts
type Section = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
};
```

---

# Fase 2 — Formato de proyecto

## Objetivo

Guardar canciones de forma portable, fácil de compartir y fácil de respaldar.

Recomiendo que cada canción sea una carpeta:

```txt
songs/
└── digno-y-santo/
    ├── song.json
    ├── audio/
    │   ├── drums.wav
    │   ├── bass.wav
    │   ├── keys.wav
    │   ├── click.wav
    │   └── guide.wav
    └── cache/
        └── waveforms/
```

## Ejemplo de `song.json`

```json
{
  "version": 1,
  "id": "song_001",
  "title": "Digno y Santo",
  "artist": "Ejemplo",
  "bpm": 72,
  "key": "D",
  "timeSignature": "4/4",
  "groups": [
    {
      "id": "group_click_guide",
      "name": "Click + Guide",
      "volume": 1,
      "muted": false,
      "outputBusId": "monitor"
    },
    {
      "id": "group_rhythm",
      "name": "Batería + Bajo",
      "volume": 1,
      "muted": false,
      "outputBusId": "main"
    }
  ],
  "tracks": [
    {
      "id": "track_click",
      "name": "Click",
      "groupId": "group_click_guide",
      "volume": 1,
      "pan": 0,
      "muted": false,
      "solo": false,
      "outputBusId": "monitor"
    },
    {
      "id": "track_bass",
      "name": "Bass",
      "groupId": "group_rhythm",
      "volume": 1,
      "pan": 0,
      "muted": false,
      "solo": false,
      "outputBusId": "main"
    }
  ],
  "clips": [
    {
      "id": "clip_click",
      "trackId": "track_click",
      "filePath": "audio/click.wav",
      "timelineStartSeconds": 0,
      "sourceStartSeconds": 0,
      "durationSeconds": 240,
      "gain": 1
    }
  ],
  "sections": [
    {
      "id": "section_intro",
      "name": "Intro",
      "startSeconds": 0,
      "endSeconds": 16
    }
  ]
}
```

---

# Fase 3 — Motor de audio mínimo

## Objetivo

Construir la parte más importante: reproducir pistas sincronizadas.

## Funciones iniciales

El motor de audio debe poder:

* Cargar varios archivos.
* Reproducirlos desde una misma posición de transporte.
* Mantener sincronía.
* Hacer play.
* Hacer pause.
* Hacer stop.
* Hacer seek.
* Aplicar volumen por pista.
* Aplicar mute por pista.
* Aplicar volumen por grupo.
* Aplicar mute por grupo.
* Detectar sección actual.
* Programar salto a otra sección.
* Ejecutar saltos instantáneos, al final de sección o cuantizados a compases.
* Cancelar saltos programados.

## Librerías Rust candidatas

Para empezar:

```txt
cpal        -> acceso a dispositivos de audio
symphonia   -> decodificación de formatos de audio
hound       -> lectura/escritura WAV simple
rubato      -> time-stretching futuro
pitch_shift -> pitch shifting futuro, habría que investigar alternativas
```

Yo empezaría con:

```txt
WAV primero.
MP3/FLAC/M4A después.
```

Aunque quieres soportar formatos comunes, no conviene empezar por todos. Primero hay que validar el motor con WAV, porque los multitracks profesionales suelen venir en WAV y es el caso más limpio.

---

# Fase 4 — Timeline visual básico

## Objetivo

Crear una interfaz parecida en concepto a Ableton, pero más simple.

## Pantalla inicial

```txt
┌─────────────────────────────────────────────────────────────┐
│ LibreTracks                         BPM 72 | Key D | 4/4     │
├─────────────────────────────────────────────────────────────┤
│ [Play] [Stop] [00:42.500]                                   │
├─────────────────────────────────────────────────────────────┤
│ Grupos                                                      │
│ Click + Guide     Vol 100%    Mute                          │
│ Batería + Bajo    Vol 100%    Mute                          │
├─────────────────────────────────────────────────────────────┤
│ Timeline                                                    │
│                                                             │
│ Click      |██████████████████████████████████              │
│ Guide      |██████████████████████████████████              │
│ Drums      |██████████████████████████████████              │
│ Bass       |██████████████████████████████████              │
│ Keys       |██████████████████████████████████              │
│                                                             │
│ Intro | Verso | Coro | Puente | Final                       │
└─────────────────────────────────────────────────────────────┘
```

## Funciones de timeline v0.1

* Mostrar pistas.
* Mostrar clips como bloques.
* Zoom horizontal básico.
* Mover el cursor de reproducción.
* Seleccionar clip.
* Mover clip.
* Guardar posición del clip.
* Reproducir desde posición actual.

## Funciones de timeline v0.2

* Cortar clip.
* Recortar inicio.
* Recortar final.
* Snap a grid.
* Secciones.
* Mostrar salto pendiente.
* Mostrar destino del salto y punto de ejecución.
* Fade in/out.
* Duplicar clip.

---

# Fase 5 — Grupos y salidas

## Objetivo

Permitir una mezcla sencilla adaptada a iglesias.

## Grupos iniciales por defecto

Al importar una canción, podríamos sugerir:

```txt
Click + Guide
Drums + Bass
Keys + Pads
Guitars
Vocals
Other
```

## Output buses iniciales

```txt
Main
Monitor
```

Después:

```txt
Main L/R
Monitor L/R
Click mono
Guide mono
Custom 1/2
Custom 3/4
```

## Primer objetivo realista

En el MVP:

* Poder elegir dispositivo de audio.
* Poder reproducir todo en estéreo.
* Poder definir buses internamente.
* Preparar la arquitectura para salidas múltiples.

Las salidas múltiples reales pueden ser delicadas porque dependen mucho del sistema operativo y de la interfaz de audio. Conviene diseñarlo desde el principio, pero no bloquear el MVP por eso.

---

# Fase 6 — Control remoto web

## Objetivo

Permitir que iPad, móvil o tablet controle la app del ordenador.

Tauri permite que el backend Rust se comunique con el frontend usando eventos/canales, y para comunicación externa podemos levantar un servidor local HTTP/WebSocket dentro de Rust o como proceso auxiliar. Tauri también documenta el uso de sidecars para empaquetar binarios externos si más adelante nos conviniera separar el servidor remoto del proceso principal. ([Tauri][2])

## Funcionamiento inicial

En la app de escritorio:

```txt
Control remoto activado

Conéctate desde:
http://192.168.1.45:3840

[QR]
```

En el iPad/móvil:

```txt
LibreTracks Remote

Canción actual: Digno y Santo
Tiempo: 01:24 / 04:32
Sección: Coro

[ Play ] [ Stop ]

Grupos:
Click + Guide    [Mute] Vol 80%
Drums + Bass     [Mute] Vol 90%
Keys + Pads      [Mute] Vol 100%
```

## Seguridad inicial

Como has dicho “por ahora todo el mundo”, la primera versión puede estar abierta en red local.

Aun así, yo dejaría la arquitectura preparada para añadir luego:

* PIN.
* Contraseña.
* Modo solo lectura.
* Permisos por dispositivo.
* Expulsar dispositivo.

No lo implementaría ahora, solo lo tendría en cuenta.

---

# Fase 7 — Setlists y modo directo

## Objetivo

Preparar la app para un culto real.

## Funciones

* Crear setlist.
* Añadir canciones.
* Reordenar canciones.
* Cargar canción actual.
* Ver canción siguiente.
* Pasar a la siguiente.
* Bloquear edición accidental.
* Controlar todo desde remoto.
* Mantener configuración de grupos por canción.

## Vista de directo

```txt
┌────────────────────────────────────┐
│ Canción actual                     │
│ Digno y Santo                      │
│ 01:24 / 04:32                      │
│ Sección: Coro                      │
│                                    │
│ Siguiente: Grande y Fuerte         │
│                                    │
│ [PLAY] [STOP] [NEXT]               │
└────────────────────────────────────┘
```

---

# Roadmap inicial por versiones

## v0.0.1 — Base técnica

Objetivo:

```txt
Proyecto creado y funcionando.
```

Estado actual:

```txt
Base web arrancable. El frontend desktop ya se puede iniciar con Vite, pero falta toolchain Rust para arrancar Tauri.
```

Incluye:

* Tauri + React + Rust.
* Pantalla inicial.
* Comando Rust llamado desde React.
* Tests mínimos.
* README inicial.
* Licencia MIT provisional.
* Estructura de carpetas.

---

## v0.1.0 — Reproductor multitrack local

Objetivo:

```txt
Reproducir varias pistas sincronizadas.
```

Incluye:

* Importar archivos WAV.
* Crear canción.
* Crear tracks automáticamente.
* Play.
* Stop.
* Pause.
* Seek.
* Volumen por pista.
* Mute por pista.
* Guardar proyecto.
* Abrir proyecto.

Esta sería la primera versión “wow, esto empieza a funcionar”.

---

## v0.2.0 — Timeline básico editable

Objetivo:

```txt
Mover y organizar clips en una línea de tiempo.
```

Incluye:

* Timeline visual.
* Clips visibles.
* Mover clips.
* Recortar inicio/final.
* Cursor de reproducción.
* Indicador de sección actual.
* Visualización de salto programado/cancelable.
* Zoom básico.
* Duración total de canción.
* Guardado no destructivo.

---

## v0.3.0 — Grupos y mezcla

Objetivo:

```txt
Organizar pistas por grupos.
```

Incluye:

* Crear grupos.
* Asignar tracks a grupos.
* Mute por grupo.
* Volumen por grupo.
* Solo por pista.
* Solo por grupo.
* Buses Main/Monitor en modelo interno.
* Configuración básica de dispositivo de audio.

---

## v0.4.0 — Control remoto

Objetivo:

```txt
Controlar desde iPad/móvil en red local.
```

Incluye:

* Servidor local.
* URL local visible.
* QR de conexión.
* Web app remota.
* Play/stop desde remoto.
* Mute/volumen de grupos desde remoto.
* Estado en tiempo real.
* Canción actual.
* Tiempo actual.
* Sección actual.

---

## v0.5.0 — Setlists y modo directo

Objetivo:

```txt
Usar la app en una reunión real.
```

Incluye:

* Crear setlist.
* Ordenar canciones.
* Siguiente/anterior canción.
* Modo directo.
* Bloqueo de edición.
* Vista remota optimizada para directo.
* Guardado de setlists.

---

## v0.6.0 — Edición musical básica

Objetivo:

```txt
Preparar canciones con más precisión.
```

Incluye:

* BPM grid.
* Snap a compás.
* Secciones.
* Click generado por BPM.
* Compás configurable.
* Fade in/out.
* Duplicar clips.
* Cortar clips.

---

## v0.7.0 — Formatos comunes

Objetivo:

```txt
Soportar más archivos de audio.
```

Incluye:

* WAV.
* MP3.
* FLAC.
* AIFF.
* M4A si la librería elegida lo permite bien.
* Conversión opcional a formato interno/cache.
* Validación de archivos al importar.

---

## v0.8.0 — Tempo y tono

Objetivo:

```txt
Cambiar tempo y tono.
```

Incluye:

* Cambio de tempo básico.
* Cambio de tono básico.
* Pre-render/cache para evitar carga en directo.
* Tests de estabilidad.
* Advertencia de calidad si el cambio es extremo.

Esta fase la dejaría lejos del inicio. Es compleja.

---

# Testing recomendado

## Frontend

Herramientas:

```txt
Vitest
React Testing Library
Playwright
```

Tests:

* Renderizar timeline.
* Seleccionar pista.
* Mutear pista.
* Cambiar volumen.
* Mover clip.
* Crear grupo.
* Guardar cambios.

## Rust Core

Herramientas:

```txt
cargo test
```

Tests:

* Crear canción válida.
* Añadir track.
* Añadir clip.
* Mover clip.
* Cortar clip.
* Validar duración.
* Validar referencias rotas.
* Serializar/deserializar `song.json`.

## Audio Engine

Tests:

* Estado inicial.
* Play cambia estado.
* Stop resetea posición.
* Pause conserva posición.
* Seek cambia posición.
* Mute aplica ganancia 0.
* Grupo mutea sus pistas.
* Volumen final = volumen de pista × volumen de grupo.
* Clips fuera de rango no reproducen.
* Clips desplazados entran en el tiempo correcto.

## Remote

Tests:

* Cliente conecta.
* Cliente recibe estado inicial.
* Comando play modifica transporte.
* Comando stop modifica transporte.
* Cambio de volumen desde remoto actualiza escritorio.
* Varios clientes reciben el mismo estado.

---

# Principios técnicos del proyecto

Yo pondría estas reglas desde el principio:

## 1. Edición no destructiva

Nunca modificar el audio original.

Cortar, mover o recortar solo cambia metadatos.

## 2. Audio primero

La UI puede ser fea al principio, pero el audio debe ser estable.

## 3. Core testeable sin UI

El núcleo debe poder probarse sin abrir la app.

## 4. Remoto solo controla

El audio siempre sale del ordenador principal.

## 5. Proyecto portable

Una canción debe poder copiarse a otro ordenador como carpeta.

## 6. Directo seguro

En modo directo, evitar acciones destructivas o accidentales.

---

# Primera lista de tareas real

## Milestone 1 — Crear base

```txt
[x] Crear repo
[x] Crear app Tauri + React
[x] Configurar TypeScript
[x] Configurar Rust workspace
[x] Configurar Vitest
[x] Configurar cargo test
[x] Crear README inicial
[x] Añadir licencia MIT provisional
[x] Crear docs/architecture.md
```

Nota: la base está preparada, pero faltan instalar dependencias y disponer de toolchain Rust para ejecutar Tauri y tests Rust reales.

## Milestone 2 — Modelo de dominio

```txt
[x] Crear crate libretracks-core
[x] Definir Song
[x] Definir Track
[x] Definir TrackGroup
[x] Definir Clip
[x] Definir Section
[x] Definir OutputBus
[x] Crear validadores
[x] Crear serialización JSON
[x] Tests de creación/validación escritos en Rust
```

## Milestone 3 — Proyecto/canciones

```txt
[x] Crear crate libretracks-project
[x] Guardar song.json
[x] Abrir song.json
[x] Crear estructura de carpeta de canción
[x] Importar archivos a audio/
[x] Detectar duración básica de audio
[x] Crear tracks automáticamente desde archivos
[x] Tests de guardar/cargar escritos en Rust
```

## Milestone 4 — Audio mínimo

```txt
[x] Crear crate libretracks-audio
[x] Cargar WAV
[x] Reproducir un WAV
[x] Reproducir varios WAV
[ ] Sincronizar inicio
[x] Play
[x] Stop
[x] Pause
[x] Seek
[x] Volumen por pista
[x] Mute por pista
[x] Detectar sección actual
[x] Programar/cancelar salto lógico entre secciones
[x] Tests del transporte
```

Nota: el MVP ya saca audio real por dispositivo desde Tauri, pero la sincronía inicial sigue siendo una primera aproximación y todavía no hay mezcla interactiva en vivo. El transporte ya contempla saltos lógicos entre secciones para no bloquear el diseño futuro del timeline.

## Milestone 5 — UI inicial

```txt
[x] Pantalla de inicio
[ ] Botón crear canción
[x] Botón importar pistas
[x] Lista de tracks
[x] Botones play/stop
[x] Sliders de volumen
[x] Botones mute
[ ] Guardar proyecto
[ ] Abrir proyecto
```

Nota: importar pistas ya está conectado a Tauri y permite probar carga y reproducción de WAVs, pero crear canción, guardar y abrir proyecto siguen pendientes.

Nota adicional: el panel de transporte ya expone sección actual, salto pendiente y botones de cuantización a 2/4 compases, aunque todavía no existe un timeline visual editable.

## Milestone 6 — Timeline básico

```txt
[ ] Mostrar regla temporal
[ ] Mostrar pistas verticalmente
[ ] Mostrar clips como bloques
[ ] Cursor de reproducción
[ ] Mostrar sección actual
[ ] Mostrar salto programado
[ ] Cancelar salto desde la UI
[ ] Zoom horizontal básico
[ ] Selección de clip
[ ] Mover clip
[ ] Persistir posición del clip
```

## Milestone 7 — Grupos

```txt
[ ] Crear grupo
[ ] Asignar track a grupo
[ ] Volumen de grupo
[ ] Mute de grupo
[ ] Mostrar grupos en UI
[ ] Aplicar grupo en audio engine
[ ] Tests de mezcla pista/grupo
```

## Milestone 8 — Remoto básico

```txt
[x] Crear crate libretracks-remote
[ ] Levantar servidor local
[ ] Mostrar IP/puerto en escritorio
[ ] Generar QR
[x] Crear app web remota
[ ] WebSocket estado
[ ] Comando play
[ ] Comando stop
[ ] Comando mute grupo
[ ] Comando volumen grupo
```

---

# Qué haría primero exactamente

Yo empezaría con este orden:

```txt
1. Crear repo Tauri + React + Rust.
2. Crear modelos Song, Track, Clip, Group.
3. Guardar y cargar song.json.
4. Importar varios WAV.
5. Reproducir varios WAV sincronizados.
6. Crear UI mínima para play/stop/mute/volumen.
7. Añadir timeline visual simple.
8. Añadir grupos.
9. Añadir remoto.
```

No empezaría por el diseño visual completo. Primero comprobaría que la base técnica funciona.

---

# Decisión sobre nombre interno

Para no perder tiempo, usaría un nombre provisional:

```txt
libretracks
```

Luego se puede cambiar.

---

# Decisión sobre licencia

Como todavía no sabes si será gratis para siempre o quizá de pago económico:

```txt
Licencia inicial recomendada: MIT
```

Razón: te da flexibilidad. Puedes mantener el código abierto y a la vez publicar instaladores oficiales, soporte, versiones empaquetadas o servicios alrededor del proyecto.
