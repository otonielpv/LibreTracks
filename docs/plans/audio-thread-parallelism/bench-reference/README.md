# Bancos de referencia

Los dos programas con los que se midió el
[diagnóstico](../00-DIAGNOSTICO.md) el 2026-09-03. Están aquí para que el
[paso 01](../01-banco-y-linea-base.md) los promocione a
`native/audio-engine-v2/bench/` con su entrada de CMake.

**No son código de producción tal como están**, y no forman parte de ningún
target hoy.

| Fichero | Qué mide | Hecho del diagnóstico |
| --- | --- | --- |
| `bungee_voice_cost.cpp` | Coste de N voces Bungee por bloque, variando buffer, hop, ratio y pitch | Hecho 2 |
| `bungee_thread_scaling.cpp` | Speedup real de repartir esas voces entre hilos, con prioridad Pro Audio y barrera de espera activa | Hecho 3 |

Ambos enlazan **directamente contra `bungee.lib`**, no contra
`lt_audio_engine_v2`. Es a propósito: aíslan el coste de la librería del de
nuestro código. El banco que mide `Mixer::render` entera lo construye el paso 01.

## Cómo se compilaron

```
cl /nologo /O2 /std:c++20 /EHsc /I "%BUNGEE%\include" <fichero>.cpp ^
   /link "%BUNGEE%\windows-x86_64\bungee.lib" avrt.lib
```

con `BUNGEE=C:\Users\otoni\Downloads\bungee-v2.4.24`, y `bungee.dll` copiado
junto al ejecutable.

Dos detalles que cuestan una tarde si se pierden:

- Los cabeceros de Bungee **no incluyen** `<vector>`, `<cmath>` ni `<span>`:
  hay que incluirlos **antes** que ellos o no compilan. Los ficheros ya lo
  hacen; no reordenes.
- `bungee_thread_scaling.cpp` necesita `NOMINMAX` antes de `<windows.h>`, o la
  macro `min` de Windows rompe `std::min`.

## Uso

```
bungee_voice_cost.exe   <sr> <block> <hop> <ratio> <pitch>
bungee_thread_scaling.exe <sr> <block>
```
