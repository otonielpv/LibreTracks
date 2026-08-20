# 08 — Poder diagnosticar sin un cable

**Depende de:** 01.
**Toca:** `apps/desktop/src-tauri/src/infra/`, `resource_monitor.rs`, UI de
ajustes, `docs/TELEMETRY.md`.
**Riesgo:** bajo.

## Problema

Reconstruir este incidente exigió un cable USB, `adb logcat -b all` y suerte de
que el buffer circular no se hubiera vaciado todavía. El tombstone ni siquiera
se generó (`crash_dump helper failed to exec` — no había memoria ni para eso).

Para cualquier usuario que no sea el desarrollador, este fallo es «se me apagó
el móvil» y no hay nada más que decir. Necesitamos que el dispositivo cuente qué
pasó **por sí solo**.

## Cambio pedido

### 1. Registro persistente de sesiones de carga

Un fichero rotativo (`load-history.jsonl`, últimas ~50 entradas) en el directorio
de datos de la app. Una línea por operación de carga/importación:

```json
{"ts":"2026-08-20T08:48:33Z","op":"import_ltset","package_bytes":2172357899,
 "device_class":"Constrained","available_ram_bytes":1041235968,
 "free_disk_bytes":10737418240,"sources":36,
 "phase_ms":{"stage":0,"extract":142000,"prepare":null},
 "peak_ram_cache_mb":487,"outcome":"interrupted"}
```

Lo importante es `outcome`: si la app muere a mitad, la entrada queda con
`"interrupted"` y en el arranque siguiente **sabemos que la anterior no
terminó**. Eso es precisamente lo que faltó aquí.

### 2. Detección de arranque tras muerte anómala

Al arrancar, si la última entrada está `interrupted`, mostrar un aviso discreto:

> La última sesión no terminó de cargarse. Puede que el dispositivo se quedara
> sin memoria. [Ver detalles] [Descartar]

### 3. Pantalla de diagnóstico

En Ajustes, una vista que muestre: clase de dispositivo, RAM física/disponible,
presupuestos activos (caché, hilos, límite de disco), espacio libre, y las
últimas cargas con su resultado. Con un botón **«Copiar informe»**.

Esto convierte un reporte de usuario de «se apagó» en un texto pegable.

### 4. Que los logs del engine lleguen a logcat

Verificar que `lt_debug_log` sale por `__android_log_print` en Android, no a un
fichero que nadie mira. Las etiquetas `[LT_THREADS]`, `[LT_STARVATION]`,
`[LT_DEVICE]`, `[LT_MEMPRESSURE]` deben ser visibles con
`adb logcat -s LibreTracks`.

## Criterios de aceptación

- [ ] `load-history.jsonl` se escribe en cada carga e importación, rota a 50
      entradas y **nunca crece sin límite**. Test.
- [ ] Una entrada se marca `interrupted` si el proceso muere durante la carga:
      test que simula la muerte (escribir la entrada al empezar, completarla al
      terminar; si no se completó, queda interrumpida).
- [ ] El aviso de arranque tras muerte anómala aparece una sola vez y se puede
      descartar. Test.
- [ ] La pantalla de diagnóstico muestra los valores reales del perfil del paso
      01; verificado en el Oppo con los números que ya conocemos
      (≈2,58 GB físicos, ~1 GB disponibles, 10 GB libres).
- [ ] «Copiar informe» produce texto plano pegable, **sin rutas de usuario ni
      nombres de ficheros de audio** (es información que el usuario va a pegar
      en un foro público).
- [ ] `adb logcat -s LibreTracks` muestra las cuatro etiquetas en el dispositivo.
- [ ] Sin telemetría remota: todo queda en el dispositivo salvo que el usuario
      copie y pegue. Documentado en `docs/TELEMETRY.md`.

## Notas para el implementador

- Escribir el JSONL debe ser barato y no bloquear la carga: es una línea por
  fase, no un log continuo.
- Ojo con el medidor de RAM en Linux: hay un bug ya arreglado por sumar RSS
  compartido de procesos WebKitGTK (`resource_monitor.rs`). En Android la WebView
  también es un proceso aparte — no cometas el mismo error al reportar memoria.
