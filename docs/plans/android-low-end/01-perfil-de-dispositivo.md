# 01 — Perfil de dispositivo: memoria *disponible*, no memoria física

**Depende de:** nada. Es el primer paso; todos los demás lo consumen.
**Toca:** `native/audio-engine-v2/include/lt_engine/core/thread_policy.h`,
`native/audio-engine-v2/src/core/` (fichero nuevo), tests del engine.
**Riesgo:** bajo. Añade una función y un escalón; no cambia comportamiento en PC.

## Problema

`lt_physical_ram_bytes()` devuelve la RAM **física** del aparato. En Android eso
no tiene ninguna relación con lo que la app puede usar: el límite real es el
heap por proceso que impone `ActivityManager` (aquí `heapgrowthlimit = 384m`) y
la memoria realmente disponible en el sistema (`MemAvailable`), que en el
momento del fallo era ~1 GB de 2,58 GB.

Los dos consumidores de esa cifra (`lt_recommend_worker_threads` y
`source_cache_mb_for_ram`) toman por tanto decisiones calibradas para un PC de
4 GB cuando están en un móvil que efectivamente tiene ~0,4 GB utilizables.

## Cambio pedido

Introducir un **perfil de dispositivo** único que centralice «cuánto puede
gastar esta máquina», y hacer que ambos consumidores lo usen.

### 1. Nueva API en `thread_policy.h` (o un `device_profile.h` nuevo)

```cpp
namespace lt {

enum class DeviceClass {
    Workstation,   // >16 GB
    Desktop,       // 8-16 GB
    ModestDesktop, // 4-8 GB
    Handheld,      // Android/iOS, o <4 GB
    Constrained,   // Handheld con <3 GB disponibles
};

struct DeviceProfile {
    DeviceClass  device_class;
    std::uint64_t physical_ram_bytes;
    std::uint64_t available_ram_bytes; // MemAvailable en Linux/Android
    std::uint64_t usable_budget_bytes; // lo que la app se permite gastar
    int           decode_threads;
    int           fill_threads;
    std::size_t   source_cache_mb;
};

// Resuelto UNA vez y cacheado (function-local static).
const DeviceProfile& lt_device_profile();
}
```

### 2. Lectura de memoria disponible

En Linux/Android, parsear `MemAvailable:` de `/proc/meminfo`. Si no existe la
línea (kernels muy viejos), usar `MemFree + Buffers + Cached`. Si falla todo,
caer a `physical / 2`.

### 3. Presupuesto utilizable

- `Handheld` / `Constrained`: `usable_budget = min(available_ram / 4, 256 MB)`.
  Razón: la app compite con el resto del sistema y con la propia WebView (que
  en Android es un proceso aparte, `SandboxedProcessService`). Un cuarto de lo
  disponible es lo máximo que se puede tomar sin provocar LMK.
- Resto de clases: comportamiento **idéntico al actual** (esto es innegociable —
  ver criterios de aceptación).

### 4. Clasificación

```
__ANDROID__ definido → Handheld
  y available_ram < 1,5 GB → Constrained
resto → los escalones actuales por RAM física
```

### 5. Log de arranque

Emitir una línea `[LT_DEVICE]` con clase, RAM física, RAM disponible,
presupuesto, hilos y caché. Debe aparecer en `logcat`.

## Criterios de aceptación

- [ ] `lt_device_profile()` existe, devuelve una referencia a un perfil cacheado
      y es seguro llamarla desde varios hilos (function-local static + C++11).
- [ ] En Android el perfil reporta `available_ram_bytes > 0` leído de
      `/proc/meminfo`, verificado en el dispositivo real con
      `adb logcat | grep LT_DEVICE`.
- [ ] **Regresión cero en escritorio:** para RAM física de 4, 8, 16 y 32 GB sin
      `__ANDROID__`, `decode_threads`, `fill_threads` y `source_cache_mb`
      devuelven **exactamente los mismos valores que la implementación actual**.
      Hay un test parametrizado que lo comprueba comparando contra las
      constantes esperadas (2/3/4/6 hilos, 512/1024/2048/3072 MB).
- [ ] Existe un test que, forzando `available_ram_bytes` a 1,0 GB y
      `__ANDROID__`, obtiene `DeviceClass::Constrained`.
- [ ] Las variables de entorno existentes (`LIBRETRACKS_FILL_THREADS`,
      `LIBRETRACKS_SOURCE_CACHE_MB`) **siguen teniendo prioridad** sobre el
      perfil. Test que lo verifica.
- [ ] El perfil se resuelve una sola vez: un test llama 100 veces y comprueba
      que `/proc/meminfo` se leyó una única vez (inyectando un contador, o
      comprobando que el puntero devuelto es siempre el mismo).
- [ ] `cargo check --all-targets` y la build del engine pasan en Windows.
- [ ] La línea `[LT_DEVICE]` aparece en el arranque en el Oppo y reporta
      `class=Constrained` o `class=Handheld`.

## Notas para el implementador

- No toques `lt_physical_ram_bytes()`: sigue siendo útil y otros sitios la usan.
- `/proc/meminfo` se lee con `std::ifstream`; nada de `popen`.
- Este paso **no debe cambiar ningún valor en PC**. Si un test de escritorio
  cambia de resultado, la implementación está mal.
