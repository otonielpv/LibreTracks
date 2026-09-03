# 02 — Detector de violaciones de tiempo real

**Depende de:** nada. Puede ir en paralelo con 01.
**Toca:** `native/audio-engine-v2/tests/`, y un cabecero nuevo de instrumentación.
**Riesgo:** ninguno en release. El detector **no debe existir** en builds de
producción.

## Problema

Los pasos 03, 04 y 05 arreglan violaciones de tiempo real. Sin un instrumento
que las detecte, sus criterios de aceptación serían «he mirado el código y ya no
asigna», que no es verificable y que un agente puede afirmar de buena fe estando
equivocado.

El hallazgo 5.1 del diagnóstico es exactamente un caso de esto: alguien ya
arregló la copia de `Track` por el mismo motivo y **dejó vivo el `malloc` de dos
líneas más abajo**, porque no había nada que lo delatara.

## Cambio pedido

### 1. Un cabecero `rt_guard.h`

En `native/audio-engine-v2/include/lt_engine/diagnostics/rt_guard.h`, compilado
sólo cuando `LT_ENGINE_RT_GUARD` está definido (que sólo lo define el target de
tests):

```cpp
namespace lt::rt {

// Marca el hilo actual como "en tiempo real" mientras vive. Reentrante.
class ScopedRealtimeSection {
public:
    ScopedRealtimeSection() noexcept;
    ~ScopedRealtimeSection() noexcept;
};

// Contadores del hilo actual desde el último reset.
struct Violations {
    std::uint64_t allocations = 0;
    std::uint64_t deallocations = 0;
};

Violations violations() noexcept;
void reset_violations() noexcept;

} // namespace lt::rt
```

- `ScopedRealtimeSection` pone/quita un `thread_local bool`.
- Un `operator new` / `operator delete` global, **definido sólo en el binario de
  tests**, incrementa los contadores cuando ese flag está puesto, y delega en
  `std::malloc`/`std::free`.
- Cuando `LT_ENGINE_RT_GUARD` no está definido, `ScopedRealtimeSection` es un
  tipo vacío y `violations()` devuelve ceros. **Coste cero en release.**

### 2. Cablearlo en `Mixer::render`

Una única línea al principio de `Mixer::render`:

```cpp
lt::rt::ScopedRealtimeSection rt_section;
```

En release compila a nada. No añadas el guard a otras funciones: el contrato es
«dentro del callback», y `Mixer::render` es el callback.

### 3. Un test que lo usa

`tests/test_rt_no_allocations.cpp`: construye una sesión sintética (reutiliza los
helpers de `test_audio_fixtures.h`), la reproduce N bloques, y afirma sobre
`lt::rt::violations()`.

**Este test va a fallar cuando se escriba**, porque el bug 5.1 sigue vivo. Eso es
correcto y esperado: márcalo como *expected failure* con un comentario que apunte
al paso 03, o déjalo desactivado con un `// habilitar en el paso 03` explícito.
**No lo hagas pasar bajando el listón.**

Decide cuál de las dos formas usas y **dilo en la bitácora**, para que el paso 03
sepa qué tiene que activar.

## Criterios de aceptación

- [ ] C1 — Con `LT_ENGINE_RT_GUARD` activo, un test que llama a `malloc` dentro
      de un `ScopedRealtimeSection` ve `violations().allocations >= 1`, y fuera
      de la sección ve 0. Test directo del propio detector.
- [ ] C2 — Las secciones **anidadas** funcionan: entrar dos veces y salir una
      deja el hilo todavía marcado. Test.
- [ ] C3 — El detector es **por hilo**: un hilo secundario que asigna memoria
      mientras el principal está en una sección no incrementa el contador del
      principal. Test con dos hilos y sincronización por `std::latch` o
      similar, **no por `sleep`**.
- [ ] C4 — Sin `LT_ENGINE_RT_GUARD`, `sizeof(ScopedRealtimeSection) <= 1`, la
      clase es trivialmente destructible, y `violations()` devuelve ceros.
      Verificado con `static_assert`.
- [ ] C5 — El engine de producción (`lt_audio_engine_v2` en Release, sin el
      define) **no exporta ni define** `operator new` global. Verificado
      inspeccionando símbolos o compilando y comprobando que el define no llega.
      Es el criterio de seguridad de este paso: un `operator new` global en la
      DLL de producción sería un desastre.
- [ ] C6 — `tests/test_rt_no_allocations.cpp` existe, reproduce ≥ 100 bloques
      de una sesión de ≥ 4 pistas, y reporta el número de asignaciones. Su
      estado inicial (rojo esperado o desactivado) está **documentado en la
      bitácora** con la razón.
- [ ] C7 — Prueba de que sabe fallar: introduce a propósito un `new int[4]` en
      `Mixer::render`, comprueba que el test lo detecta, y quítalo. Pega ambas
      salidas.
- [ ] C8 — `npm run test:native` pasa (con el test nuevo en el estado que hayas
      documentado en C6).

## Notas para el implementador

- Sustituir `operator new` global es legal en C++ pero es una sola definición
  por programa. Por eso va **sólo en el binario de tests**, nunca en la
  biblioteca. Si lo pones en un `.cpp` de la librería, romperás cualquier
  ejecutable que enlace con ella.
- No uses `std::atomic` para los contadores si son `thread_local`: no hace
  falta y es más lento. Sí necesitas que el flag sea `thread_local`.
- Cuidado con la recursión: tu `operator new` no puede asignar memoria.
- Este detector **no** cubre locks. La contención del `std::mutex` del
  `BlockCache` ya tiene sus propios contadores (`read_wait_max_us_`,
  `read_wait_count_` en `sources/block_cache.cpp:59-67`); el paso 01 los expone
  en el banco. No dupliques ese trabajo aquí.
- El detector es una herramienta para los pasos siguientes. No lo uses para
  «arreglar» nada en este paso: aquí sólo se construye y se demuestra que
  funciona.
