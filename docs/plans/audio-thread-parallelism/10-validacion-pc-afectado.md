# 10 — Validación en el PC afectado y cierre de las dos firmas

**Depende de:** 09 aprobado. **Es la puerta de cierre del reporte real.**
**Toca:** diagnósticos del motor, documentación y, sólo si la medida lo
justifica, un plan separado para streaming.
**Riesgo:** bajo. No cambia DSP ni el transporte.

## Problema

El log recibido después de completar el paso 01 demuestra que el usuario no
tiene una sola firma:

1. vio `Carga de audio` al 96 % al activar warp;
2. el motor registró 172 eventos `[LT_STARVATION]`, incluidos cortes de cientos
   de milisegundos en el tramo más reciente.

El pool de render resuelve la primera firma. No rellena bloques desde disco y
por tanto no puede resolver la segunda. Además, el log no identifica versión,
commit, dispositivo, buffer, voces Bungee ni las estadísticas detalladas de
relleno necesarias para correlacionar el incidente.

## Cambio pedido

### 1. Hacer que un log exportado sea autosuficiente

Al inicializar el motor, escribir una cabecera única con:

- versión de LibreTracks y, cuando exista, identificador de build/commit;
- CPU lógica, RAM física, `DeviceClass`, caché y ventanas protegidas;
- hilos de render, fill y decode efectivos, incluidos overrides;
- backend/dispositivo de audio, sample rate y tamaño de buffer;
- disponibilidad de Bungee.

No registrar rutas de proyectos, nombres de canciones ni otros datos personales.

### 2. Totales con ciclo de vida inequívoco

Los baselines estáticos del logger sobreviven a reemplazos internos de
`SourceManager`; el log recibido muestra contadores `total` que vuelven a cero
sin un marcador de nueva sesión. Mover el estado al objeto propietario o
detectar el descenso y escribir un marcador de reset. Un `total` nunca puede
parecer acumulativo si cambió su fuente.

La captura detallada debe incluir, en la misma ventana temporal:
`callback_load`, `over_budget`, `active_voices`, caminos direct/stretched,
`source_cache_miss_frames`, `fill_q`, colas urgente/normal, `read_wait_us`,
`fill_hold_us`, tiempos/fallos de apertura y lectura, `pf+=` y working set.

### 3. Ensayo A/B controlado en Release

En el PC del usuario, enchufado y con el mismo plan de energía, limpiar el log
y reproducir la misma sección durante 60 s por caso:

| Caso | Warp | Hilos render |
| --- | --- | ---: |
| A | off | automático |
| B | on | 1 |
| C | on | automático |

No importar, generar waveforms ni cambiar de canción durante la ventana. Anotar
número de pistas/clips simultáneos, ratio, buffer, dispositivo, carga media y
máxima, callbacks fuera de presupuesto, voces y frames silenciados.

### 4. Clasificar antes de corregir

- `over_budget > 0`, `stretched > 0`, sin misses: cuello de Bungee/render.
- misses con callback dentro de presupuesto: streaming/caché/disco.
- ambas: dos fallos simultáneos; no atribuir uno al otro.

Si C mantiene starvation en reproducción secuencial estable, abrir un plan
separado a partir de las estadísticas observadas. No adivinar entre aumentar
caché, reducir working-set floor, cambiar prefetch o tocar el pool: cada una
ataca una firma distinta y alguna puede empeorar un PC de 8 GB.

## Criterios de aceptación

- [ ] C1 — Un log nuevo permite identificar versión/build, perfil, caché,
      workers, backend, sample rate y buffer sin información externa. Test de
      formato sin rutas ni nombres de usuario.
- [ ] C2 — Los totales de starvation son monótonos dentro de una generación y
      todo reset lleva marcador. Test que reemplaza/limpia `SourceManager`.
- [ ] C3 — Una captura de diagnóstico contiene en la misma ventana las métricas
      de callback, Bungee, caché, colas, I/O, page faults y working set listadas
      arriba. Los contadores se verifican rompiendo deliberadamente su sonda.
- [ ] C4 — Los casos A/B/C se ejecutan en build Release en el i5-11400H y se
      adjuntan completos a `state/10.md`; no basta una captura del PerfHud.
- [ ] C5 — C frente a B demuestra la mejora del pool con el mismo número de
      voces. Si no hay mejora clara, queda `PENDIENTE-HUMANO` con la cifra real,
      nunca maquillada.
- [ ] C6 — `PENDIENTE-HUMANO`: en C no hay crujido y la carga sostenida queda
      con margen por debajo del presupuesto. Anotar también temperatura/frecuencia
      si Windows muestra throttling.
- [ ] C7 — En reproducción secuencial estable hay cero frames nuevos de
      starvation. Si no se cumple, el **plan de paralelismo puede aprobarse como
      mejora**, pero el reporte original no se cierra: se crea el plan de
      streaming con la causa ya medida.
- [ ] C8 — `npm test` y `cargo check --all-targets` pasan.

## Notas para BUILDER y REVIEWER

- No conviertas C4-C7 en tests temporizados de CI: son medidas humanas sobre el
  hardware afectado.
- La RTX 3050 no es una variable del DSP; no añadas detección de GPU.
- No pruebes esta etapa en desarrollo. El PerfHud de desarrollo exagera carga
  por React/Vite; la comparación válida es Release.
