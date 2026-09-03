// Paso 09 — política de hilos de render.
//
// La tabla se fija aquí contra CONSTANTES ESCRITAS A MANO, no contra el propio
// cálculo. Un test parametrizado que comparase `lt_recommend_worker_threads_for`
// consigo misma pasaría siempre y no protegería de nada: es el error que el
// criterio C8 pide demostrar que no se ha cometido.

#include <doctest/doctest.h>
#include <lt_engine/core/thread_policy.h>

using namespace lt;

namespace {
constexpr std::uint64_t GB = 1024ull * 1024 * 1024;
}

TEST_CASE("step09 C1: la tabla de hilos de render, fijada valor a valor") {
    // >= 8 nucleos logicos -> 4
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 8,  16 * GB) == 4);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 12, 32 * GB) == 4);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 20, 32 * GB) == 4);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 64, 64 * GB) == 4);

    // 4-7 nucleos -> 2
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 4, 8 * GB) == 2);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 6, 8 * GB) == 2);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 7, 4 * GB) == 2);

    // <= 3 nucleos -> 1 (pool desactivado)
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 1, 4 * GB) == 1);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 2, 4 * GB) == 1);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 3, 8 * GB) == 1);
}

TEST_CASE("step09: los hilos de render NO dependen de la RAM") {
    // A proposito, y distinto de Decode: el render no asigna nada por bloque
    // (contrato del paso 02), asi que la RAM no es la restriccion. Si alguien
    // le mete un tope por RAM copiando de Decode, esto lo para.
    for (std::uint64_t ram : {2 * GB, 4 * GB, 8 * GB, 16 * GB, 64 * GB}) {
        CAPTURE(ram);
        CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 12, ram) == 4);
        CHECK(lt_recommend_worker_threads_for(WorkerRole::Render, 4, ram) == 2);
    }
}

TEST_CASE("step09 C2: anadir el rol nuevo no mueve los que ya existian") {
    // Los presupuestos de movil del plan android-low-end dependen de estos
    // valores. Anadir un enum no puede desplazarlos.
    struct Case { int cores; std::uint64_t ram; int decode; int fill; int waveform; };
    // Valores tomados de la implementacion vigente ANTES de anadir Render.
    //
    // Los valores estan LEIDOS de la implementacion vigente, no adivinados: la
    // primera version de este test los invento y fallo en 4 de 12: Fill sube a
    // 3/4/6 (no 2/3/4) y Waveform se queda en 3 con 12 nucleos. Un test de "no
    // se movio" solo sirve si su referencia es lo que habia de verdad.
    const Case cases[] = {
        { 2,  4 * GB, 1, 1, 1 },
        { 4,  8 * GB, 3, 3, 2 },
        { 8, 16 * GB, 4, 4, 3 },
        {12, 32 * GB, 6, 6, 3 },
    };
    for (const auto& c : cases) {
        CAPTURE(c.cores);
        CHECK(lt_recommend_worker_threads_for(WorkerRole::Decode,   c.cores, c.ram) == c.decode);
        CHECK(lt_recommend_worker_threads_for(WorkerRole::Fill,     c.cores, c.ram) == c.fill);
        CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, c.cores, c.ram) == c.waveform);
    }
}

TEST_CASE("step09 C3: el entorno gana al ajuste del usuario y a la politica") {
    CHECK(lt_resolve_render_threads(/*recommended=*/4, /*user=*/2, "1") == 1);
    CHECK(lt_resolve_render_threads(4, 2, "8") == 8);
    CHECK(lt_resolve_render_threads(1, 0, "4") == 4);
}

TEST_CASE("step09: el ajuste del usuario gana a la politica; 0 es Automatico") {
    CHECK(lt_resolve_render_threads(/*recommended=*/4, /*user=*/1, nullptr) == 1);
    CHECK(lt_resolve_render_threads(4, 2, nullptr) == 2);
    CHECK(lt_resolve_render_threads(2, 4, nullptr) == 4);
    CHECK(lt_resolve_render_threads(4, 0, nullptr) == 4);   // Automatico
}

TEST_CASE("step09 C4: un valor invalido cae al recomendado, no crea 999 hilos") {
    for (const char* bad : {"0", "-1", "abc", "", "999", "9999999999999999999", " "}) {
        CAPTURE(bad);
        CHECK(lt_resolve_render_threads(/*recommended=*/4, /*user=*/0, bad) == 4);
    }
    // Y lo mismo por el lado del ajuste del usuario.
    for (int bad : {-5, 0, 99, 1000}) {
        CAPTURE(bad);
        const int r = lt_resolve_render_threads(4, bad, nullptr);
        CHECK(r == 4);
    }
    // El recomendado tambien se acota: nadie puede colar un 500 por ahi.
    CHECK(lt_resolve_render_threads(500, 0, nullptr) == 8);
    CHECK(lt_resolve_render_threads(0, 0, nullptr) == 1);
}
