// bench_render_callback.cpp
//
// Mide lo que de verdad paga el hilo de audio: `Mixer::render` ENTERA, no sólo
// el coste de Bungee. Es la línea base contra la que se compara cada paso del
// plan docs/plans/audio-thread-parallelism/.
//
// Por qué existe, y por qué reporta cola y no sólo media:
//
//   Los pasos 03/04/05 del plan arreglan violaciones de tiempo real
//   (asignaciones de memoria, un spinlock global, búsquedas lineales). Ninguna
//   de las tres mueve apenas la MEDIA del callback: mueven la COLA. Un banco
//   que sólo diera la media no sabría demostrar que sirvieron para algo, y el
//   paso se aprobaría o se rechazaría a ciegas. De ahí p50/p95/p99/max.
//
//   Y de ahí también el desglose por fases: cuando la cola se dispara, lo
//   primero que hay que saber es en qué parte del callback. El motor ya
//   instrumenta cuatro fases (load / sched / tracks / post); aquí se leen y se
//   reinician en CADA bloque, de forma que el "máximo desde la última lectura"
//   que devuelve take_phase_max_us() es exactamente el valor de ese bloque.
//
//   Esas marcas se truncan a µs enteros, así que el desglose tiene un suelo de
//   resolución: por debajo de ~100 µs por bloque el redondeo pesa más que lo
//   medido y el banco dice "n/a" en vez de publicar el error del reloj como si
//   fuera un hallazgo. Ver kPhaseMeaningfulFloorUs.
//
// El audio de las fuentes va en RAM (store_decoded_source) a propósito: la
// starvation de disco es otro problema, con otra firma, y contaminaría la
// medida. Ver el Hecho 1 del diagnóstico del plan.
//
// Uso:
//   bench_render_callback.exe [--tracks N] [--block F] [--sr R] [--warp 0|1]
//                             [--ratio X] [--semitones S] [--threads T]
//                             [--blocks B] [--warmup W] [--json <ruta>]
//                             [--paced] [--matrix] [--label <texto>]
//
//   --paced   respeta la cadencia real del dispositivo entre bloques y mide
//             CPU total del proceso. Es el modo que detecta workers girando
//             mientras la tarjeta reproduce el buffer anterior.
//   --matrix  ejecuta la matriz de la línea base y escribe las filas al JSON.
//
// El desglose por fases sólo está disponible si LIBRETRACKS_AUDIO_DIAG está
// puesto en el ENTORNO antes de arrancar el proceso. El banco lo intenta poner
// por su cuenta, pero el motor lee la variable una sola vez al construir el
// Mixer y, si el engine es una DLL con otra copia del CRT, no la verá. Cuando
// pasa eso el banco lo dice en vez de reportar ceros como si fueran datos.

#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/render/mixer.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/transport/transport_clock.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#else
#  include <sys/resource.h>
#endif

using namespace lt;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int kChannels = 2;

// ── Configuración de una fila del banco ──────────────────────────────────────

struct Config {
    int    tracks     = 24;
    int    block      = 512;
    int    sample_rate = 48000;
    bool   warp       = false;
    double ratio      = 1.0;
    int    semitones  = 0;
    int    threads    = 1;   // pool de render (paso 08)
    int    blocks     = 600;
    int    warmup     = 150;
    bool   paced      = false;
    std::string label;

    double budget_us() const {
        return static_cast<double>(block) * 1e6 / static_cast<double>(sample_rate);
    }
};

// ── Resultado de una fila ────────────────────────────────────────────────────

struct PhaseSums {
    double load = 0.0, sched = 0.0, tracks = 0.0, post = 0.0;
    double total() const { return load + sched + tracks + post; }
    bool   available = false;
};

struct BenchResult {
    Config cfg;

    double avg_us = 0.0, p50_us = 0.0, p95_us = 0.0, p99_us = 0.0, max_us = 0.0;
    double measured_total_us = 0.0;   // suma de los bloques medidos
    double process_cpu_seconds = 0.0;
    double wall_seconds = 0.0;
    PhaseSums phases;

    // Contadores estructurales. Éstos NO pueden variar entre dos ejecuciones de
    // la misma configuración; es lo que comprueba verify_determinism().
    std::uint64_t rendered_tracks = 0;
    std::uint64_t skipped_tracks  = 0;
    std::uint64_t over_budget     = 0;
    std::uint64_t path_direct     = 0;
    std::uint64_t path_varispeed  = 0;
    std::uint64_t path_stretched  = 0;
    std::uint64_t blocks_rendered = 0;
    int           bungee_voices   = 0;

    double pct(double us) const { return 100.0 * us / cfg.budget_us(); }
    double process_cpu_percent() const {
        const unsigned int logical = std::max(1u, std::thread::hardware_concurrency());
        return wall_seconds > 0.0
            ? 100.0 * process_cpu_seconds / (wall_seconds * logical)
            : 0.0;
    }
};

double process_cpu_seconds() noexcept {
#if defined(_WIN32)
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user))
        return 0.0;
    ULARGE_INTEGER k{}, u{};
    k.LowPart = kernel.dwLowDateTime;
    k.HighPart = kernel.dwHighDateTime;
    u.LowPart = user.dwLowDateTime;
    u.HighPart = user.dwHighDateTime;
    return static_cast<double>(k.QuadPart + u.QuadPart) * 1.0e-7;
#else
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) != 0) return 0.0;
    const double user = static_cast<double>(usage.ru_utime.tv_sec)
                      + static_cast<double>(usage.ru_utime.tv_usec) * 1.0e-6;
    const double system = static_cast<double>(usage.ru_stime.tv_sec)
                        + static_cast<double>(usage.ru_stime.tv_usec) * 1.0e-6;
    return user + system;
#endif
}

// ── Construcción de la sesión sintética ──────────────────────────────────────

std::vector<float> make_sine(Frame frames, int sample_rate, double hz) {
    std::vector<float> out(static_cast<std::size_t>(frames) * kChannels, 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        const double t = static_cast<double>(f) / static_cast<double>(sample_rate);
        const float v = static_cast<float>(0.25 * std::sin(6.283185307179586 * hz * t));
        out[static_cast<std::size_t>(f) * kChannels]     = v;
        out[static_cast<std::size_t>(f) * kChannels + 1] = v;
    }
    return out;
}

// Una canción con `tracks` pistas, cada una con su propia fuente en RAM.
//
// El ratio de warp se impone por la vía por la que lo calcula el motor:
// resolve_warp_time_ratio() hace target_bpm / region.warp_source_bpm, con el
// target tomado en el frame de INICIO de la región. Así que fijando
// warp_source_bpm = song.bpm / ratio sale exactamente el ratio pedido.
Session build_session(const Config& cfg, SourceManager& sources, Frame length) {
    Session session;
    session.id          = "bench-session";
    session.sample_rate = cfg.sample_rate;

    Song song;
    song.id          = "bench-song";
    song.name        = "bench";
    song.start_frame = 0;
    song.end_frame   = length;
    song.bpm         = 120.0;
    song.transpose_semitones = 0;

    Region region;
    region.id          = "bench-region";
    region.name        = "region";
    region.start_frame = 0;
    region.end_frame   = length;
    region.transpose_semitones = static_cast<Semitones>(cfg.semitones);
    if (cfg.warp) {
        region.warp_enabled    = true;
        region.warp_source_bpm = song.bpm / cfg.ratio;
    }
    song.regions.push_back(region);

    // Frecuencias distintas por pista para que el mezclado no sea trivialmente
    // el mismo dato N veces y la caché de bloques trabaje de verdad.
    for (int i = 0; i < cfg.tracks; ++i) {
        const std::string src_id = "src-" + std::to_string(i);
        sources.register_source(src_id, "");
        auto pcm = make_sine(length, cfg.sample_rate, 110.0 + 13.0 * i);
        if (!sources.store_decoded_source(src_id, std::move(pcm), kChannels,
                                          cfg.sample_rate, length).is_ok()) {
            std::fprintf(stderr, "no se pudo registrar la fuente %s\n", src_id.c_str());
            std::exit(2);
        }
        session.sources.push_back(Source{src_id, ""});

        Track track;
        track.id   = "track-" + std::to_string(i);
        track.name = track.id;
        track.kind = TrackKind::Audio;
        track.gain = 0.5f;
        track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
        track.clips.push_back(Clip{"clip-" + std::to_string(i), src_id, 0, 0, length});
        song.tracks.push_back(std::move(track));
    }

    session.songs.push_back(std::move(song));
    return session;
}

// ── Una ejecución ────────────────────────────────────────────────────────────

BenchResult run(const Config& cfg) {
    BenchResult r;
    r.cfg = cfg;

    // Longitud con holgura: los bloques medidos más el calentamiento, más un
    // margen para que ningún clip se acabe a mitad de la medida (un clip
    // agotado deja de renderizarse y falsearía a la baja).
    const Frame length =
        static_cast<Frame>(cfg.block) * (cfg.blocks + cfg.warmup + 64);

    SourceManager sources;
    auto session = std::make_shared<const Session>(build_session(cfg, sources, length));

    TransportClock clock(cfg.sample_rate);
    JumpScheduler  scheduler;
    Mixer          mixer(session, &sources, &clock, &scheduler);

    BungeeVoiceManager voices;
    const bool bungee_ok = voices.prepare(cfg.sample_rate, kChannels, cfg.block * 4);
    if (bungee_ok) {
        voices.rebuild_for_session(*session, sources, /*playhead=*/0);
        mixer.set_bungee_voice_manager(&voices);
        r.bungee_voices = voices.diagnostics().active_voice_count;
    }

    mixer.prepare_render_resources(cfg.block);
    mixer.set_render_thread_count(cfg.threads);
    clock.play();

    std::vector<float> left(static_cast<std::size_t>(cfg.block), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(cfg.block), 0.0f);
    float* out[2] = { left.data(), right.data() };

    // Calentamiento: las voces Bungee tardan unos bloques en converger y los
    // primeros accesos a la caché de bloques son fríos. Medir eso sería medir
    // el arranque, no la reproducción.
    for (int b = 0; b < cfg.warmup; ++b)
        mixer.render(out, kChannels, cfg.block, clock.sample_rate());

    // Los contadores se ponen a cero DESPUÉS del calentamiento para que
    // reflejen sólo la ventana medida.
    TrackRenderer::reset_diagnostics();
    const std::uint64_t rendered0 = mixer.rendered_track_count();
    const std::uint64_t skipped0  = mixer.skipped_track_count();
    const std::uint64_t over0     = mixer.callback_over_budget_count();
    (void)mixer.take_phase_max_us();   // descarta el residuo del calentamiento

    std::vector<double> samples;
    samples.reserve(static_cast<std::size_t>(cfg.blocks));
    PhaseSums phases;

    const auto measured_start = Clock::now();
    auto next_deadline = measured_start;
    const double cpu_start = process_cpu_seconds();

    for (int b = 0; b < cfg.blocks; ++b) {
        const auto t0 = Clock::now();
        mixer.render(out, kChannels, cfg.block, clock.sample_rate());
        const auto t1 = Clock::now();
        samples.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());

        // Leído y reiniciado cada bloque: el "máximo desde la última lectura"
        // es entonces el valor de ESTE bloque, no un máximo histórico.
        const auto ph = mixer.take_phase_max_us();
        phases.load   += static_cast<double>(ph.load);
        phases.sched  += static_cast<double>(ph.sched);
        phases.tracks += static_cast<double>(ph.tracks);
        phases.post   += static_cast<double>(ph.post);

        if (cfg.paced) {
            next_deadline += std::chrono::nanoseconds(
                static_cast<long long>(cfg.budget_us() * 1000.0));
            std::this_thread::sleep_until(next_deadline);
        }
    }
    const double cpu_end = process_cpu_seconds();
    const auto measured_end = Clock::now();
    phases.available = phases.total() > 0.0;

    std::vector<double> sorted = samples;
    std::sort(sorted.begin(), sorted.end());
    double sum = 0.0;
    for (double s : sorted) sum += s;

    auto quantile = [&sorted](double q) {
        if (sorted.empty()) return 0.0;
        const auto idx = static_cast<std::size_t>(q * static_cast<double>(sorted.size() - 1));
        return sorted[idx];
    };

    r.avg_us = sorted.empty() ? 0.0 : sum / static_cast<double>(sorted.size());
    r.p50_us = quantile(0.50);
    r.p95_us = quantile(0.95);
    r.p99_us = quantile(0.99);
    r.max_us = sorted.empty() ? 0.0 : sorted.back();
    r.measured_total_us = sum;
    r.process_cpu_seconds = std::max(0.0, cpu_end - cpu_start);
    r.wall_seconds = std::chrono::duration<double>(
        measured_end - measured_start).count();
    r.phases = phases;

    r.rendered_tracks = mixer.rendered_track_count() - rendered0;
    r.skipped_tracks  = mixer.skipped_track_count()  - skipped0;
    r.over_budget     = mixer.callback_over_budget_count() - over0;
    r.blocks_rendered = static_cast<std::uint64_t>(cfg.blocks);

    const auto td = TrackRenderer::diagnostics();
    r.path_direct    = td.path_direct_count;
    r.path_varispeed = td.path_varispeed_count;
    r.path_stretched = td.path_stretched_count;

    mixer.set_render_thread_count(1);   // para los trabajadores antes de salir
    return r;
}

// ── C6: el banco tiene que ser determinista en estructura ────────────────────
//
// Los tiempos varían entre ejecuciones, obviamente. Los contadores no: si dos
// pasadas de la misma configuración no renderizan las mismas pistas por los
// mismos caminos, el banco no está midiendo lo mismo dos veces y ninguna
// comparación contra la línea base significa nada.
//
// Se comprueba CADA configuración, no una representativa. La primera versión
// sondeaba sólo `configs.front()`, y en `--matrix` esa primera fila es 1 pista,
// buffer 128 y warp APAGADO: comparaba `path_stretched` y `bungee_voices` de 0
// contra 0 y daba OK sin haber tocado nunca el camino del warp, que es el único
// donde el determinismo podría romperse de verdad. La línea base se publicó así
// una vez. El coste de sondear todas es ~18 % del tiempo de la matriz; la
// alternativa es una comprobación que da verde sin mirar.

bool verify_determinism(const Config& cfg, std::string& detail) {
    Config probe = cfg;
    probe.blocks = 50;
    probe.warmup = 20;
    probe.paced = false;

    const BenchResult a = run(probe);
    const BenchResult b = run(probe);

    auto mismatch = [&](const char* name, std::uint64_t x, std::uint64_t y) {
        if (x == y) return false;
        detail += std::string(name) + ": " + std::to_string(x) + " vs "
                + std::to_string(y) + "; ";
        return true;
    };

    bool bad = false;
    bad |= mismatch("rendered_tracks", a.rendered_tracks, b.rendered_tracks);
    bad |= mismatch("skipped_tracks",  a.skipped_tracks,  b.skipped_tracks);
    bad |= mismatch("path_direct",     a.path_direct,     b.path_direct);
    bad |= mismatch("path_varispeed",  a.path_varispeed,  b.path_varispeed);
    bad |= mismatch("path_stretched",  a.path_stretched,  b.path_stretched);
    bad |= mismatch("blocks_rendered", a.blocks_rendered, b.blocks_rendered);
    bad |= mismatch("bungee_voices",
                    static_cast<std::uint64_t>(a.bungee_voices),
                    static_cast<std::uint64_t>(b.bungee_voices));
    return !bad;
}

// ── Suelo de resolución del desglose por fases ───────────────────────────────
//
// `Mixer::render` marca las fases con duration_cast<microseconds>, o sea trunca
// a µs enteros, y hay cuatro marcas por bloque. Eso deja un déficit sistemático
// de ~1-2 µs por bloque que NO es trabajo sin instrumentar: es redondeo.
//
// Da igual en un bloque de 3268 µs (0,04 %) y se lo come todo en uno de 1,8 µs
// (66 %). Reportar «cobertura 44 %» para una fila de 1 pista sería inventarse
// un hallazgo a partir de la resolución del reloj.
//
// Por encima de este suelo el déficit de truncamiento queda por debajo del ±5 %
// que pide el criterio C4: 4 marcas x 1 µs de error máximo = 4 µs, y 4/100 = 4 %.
constexpr double kPhaseMeaningfulFloorUs = 100.0;
constexpr int    kPhaseMarksPerBlock     = 4;

bool phase_coverage_is_meaningful(const BenchResult& r) {
    return r.phases.available && r.avg_us >= kPhaseMeaningfulFloorUs;
}

// ── Salida ───────────────────────────────────────────────────────────────────

void print_header() {
    std::printf("%7s %6s %5s %7s %10s %10s %10s %10s %9s %7s\n",
                "pistas", "bloque", "warp", "ratio",
                "avg us", "p95 us", "p99 us", "max us", "%presup", "hilos");
}

void print_row(const BenchResult& r) {
    std::printf("%7d %6d %5s %7.3f %10.1f %10.1f %10.1f %10.1f %8.1f%% %7d\n",
                r.cfg.tracks, r.cfg.block, r.cfg.warp ? "on" : "off", r.cfg.ratio,
                r.avg_us, r.p95_us, r.p99_us, r.max_us,
                r.pct(r.avg_us), r.cfg.threads);
}

void print_detail(const BenchResult& r) {
    std::printf("\n  caminos: direct=%llu varispeed=%llu stretched=%llu\n",
                static_cast<unsigned long long>(r.path_direct),
                static_cast<unsigned long long>(r.path_varispeed),
                static_cast<unsigned long long>(r.path_stretched));
    std::printf("  pistas: renderizadas=%llu saltadas=%llu | bloques fuera de presupuesto=%llu\n",
                static_cast<unsigned long long>(r.rendered_tracks),
                static_cast<unsigned long long>(r.skipped_tracks),
                static_cast<unsigned long long>(r.over_budget));
    std::printf("  CPU proceso: %.1f%% (%s, %.3f s CPU / %.3f s reloj, %u hilos logicos)\n",
                r.process_cpu_percent(), r.cfg.paced ? "cadencia real" : "sin pausa",
                r.process_cpu_seconds, r.wall_seconds,
                std::max(1u, std::thread::hardware_concurrency()));

    if (!r.phases.available) {
        std::printf("  fases: NO DISPONIBLES. Pon LIBRETRACKS_AUDIO_DIAG=1 en el\n"
                    "         entorno ANTES de lanzar el proceso (el motor lee la\n"
                    "         variable una sola vez, al construir el Mixer).\n");
        return;
    }
    const double tot = r.phases.total();
    const double cov = 100.0 * tot / r.measured_total_us;
    std::printf("  fases (media us/bloque): load=%.2f sched=%.2f tracks=%.2f post=%.2f\n",
                r.phases.load  / static_cast<double>(r.blocks_rendered),
                r.phases.sched / static_cast<double>(r.blocks_rendered),
                r.phases.tracks/ static_cast<double>(r.blocks_rendered),
                r.phases.post  / static_cast<double>(r.blocks_rendered));

    if (!phase_coverage_is_meaningful(r)) {
        std::printf("  cobertura de fases: n/a — el bloque medio son %.1f us y las\n"
                    "    fases se truncan a us enteros (%d marcas por bloque), asi\n"
                    "    que el deficit de truncamiento pesa mas que lo que se mide.\n"
                    "    El dato sale por debajo de %.0f us/bloque.\n",
                    r.avg_us, kPhaseMarksPerBlock, kPhaseMeaningfulFloorUs);
        return;
    }
    std::printf("  cobertura de fases: %.1f%% del tiempo total del callback%s\n",
                cov, (cov >= 95.0 && cov <= 105.0) ? " (dentro del +-5%)"
                                                    : "  <-- FUERA DEL +-5%");
}

void write_json(const std::vector<BenchResult>& results, const std::string& path,
                bool phases_available) {
    std::ofstream f(path);
    if (!f) {
        std::fprintf(stderr, "no se pudo escribir %s\n", path.c_str());
        return;
    }
    f << "{\n  \"phases_available\": " << (phases_available ? "true" : "false")
      << ",\n  \"rows\": [\n";
    for (std::size_t i = 0; i < results.size(); ++i) {
        const BenchResult& r = results[i];
        f << "    {"
          << "\"label\": \"" << r.cfg.label << "\", "
          << "\"tracks\": " << r.cfg.tracks << ", "
          << "\"block\": " << r.cfg.block << ", "
          << "\"sample_rate\": " << r.cfg.sample_rate << ", "
          << "\"warp\": " << (r.cfg.warp ? "true" : "false") << ", "
          << "\"ratio\": " << r.cfg.ratio << ", "
          << "\"semitones\": " << r.cfg.semitones << ", "
          << "\"threads\": " << r.cfg.threads << ", "
          << "\"paced\": " << (r.cfg.paced ? "true" : "false") << ", "
          << "\"blocks\": " << r.cfg.blocks << ", "
          << "\"budget_us\": " << r.cfg.budget_us() << ", "
          << "\"avg_us\": " << r.avg_us << ", "
          << "\"p50_us\": " << r.p50_us << ", "
          << "\"p95_us\": " << r.p95_us << ", "
          << "\"p99_us\": " << r.p99_us << ", "
          << "\"max_us\": " << r.max_us << ", "
          << "\"process_cpu_seconds\": " << r.process_cpu_seconds << ", "
          << "\"wall_seconds\": " << r.wall_seconds << ", "
          << "\"process_cpu_percent\": " << r.process_cpu_percent() << ", "
          << "\"avg_pct_budget\": " << r.pct(r.avg_us) << ", "
          << "\"p95_pct_budget\": " << r.pct(r.p95_us) << ", "
          << "\"bungee_voices\": " << r.bungee_voices << ", "
          << "\"rendered_tracks\": " << r.rendered_tracks << ", "
          << "\"skipped_tracks\": " << r.skipped_tracks << ", "
          << "\"over_budget_blocks\": " << r.over_budget << ", "
          << "\"path_direct\": " << r.path_direct << ", "
          << "\"path_varispeed\": " << r.path_varispeed << ", "
          << "\"path_stretched\": " << r.path_stretched;
        if (r.phases.available) {
            const double n = static_cast<double>(r.blocks_rendered);
            f << ", \"phase_load_us\": "   << r.phases.load / n
              << ", \"phase_sched_us\": "  << r.phases.sched / n
              << ", \"phase_tracks_us\": " << r.phases.tracks / n
              << ", \"phase_post_us\": "   << r.phases.post / n;
            // La cobertura sólo se publica cuando significa algo. Por debajo del
            // suelo de resolución el número sería el error de truncamiento del
            // reloj disfrazado de hallazgo, y un JSON no lleva notas al pie.
            if (phase_coverage_is_meaningful(r)) {
                f << ", \"phase_coverage_pct\": "
                  << 100.0 * r.phases.total() / r.measured_total_us;
            } else {
                f << ", \"phase_coverage_pct\": null";
            }
        }
        f << "}" << (i + 1 < results.size() ? ",\n" : "\n");
    }
    f << "  ]\n}\n";
    std::printf("\nJSON escrito en %s\n", path.c_str());
}

// La matriz de la línea base que pide el paso 01.
std::vector<Config> baseline_matrix(const Config& base) {
    std::vector<Config> out;
    for (int block : {128, 512}) {
        for (int tracks : {1, 4, 8, 16, 24, 32}) {
            Config off = base;
            off.block = block; off.tracks = tracks;
            off.warp = false; off.ratio = 1.0;
            off.label = "warp-off";
            out.push_back(off);

            for (double ratio : {1.0, 1.2}) {
                Config on = off;
                on.warp = true; on.ratio = ratio;
                on.label = ratio == 1.0 ? "warp-on-ratio-1.0" : "warp-on-ratio-1.2";
                out.push_back(on);
            }
        }
    }
    return out;
}

} // namespace

int main(int argc, char** argv) {
    // Intento de conveniencia: si la variable ya viene del entorno no se toca.
    // Si el motor es una DLL con otra copia del CRT esto no llegará, y por eso
    // el banco comprueba después si las fases traen datos en vez de fiarse.
#if defined(_WIN32)
    if (!std::getenv("LIBRETRACKS_AUDIO_DIAG")) _putenv_s("LIBRETRACKS_AUDIO_DIAG", "1");
#else
    if (!std::getenv("LIBRETRACKS_AUDIO_DIAG")) setenv("LIBRETRACKS_AUDIO_DIAG", "1", 0);
#endif

    Config cfg;
    std::string json_path;
    bool matrix = false;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&](const char* what) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "falta el valor de %s\n", what);
                std::exit(2);
            }
            return argv[++i];
        };
        if      (a == "--tracks")    cfg.tracks      = std::atoi(next("--tracks"));
        else if (a == "--block")     cfg.block       = std::atoi(next("--block"));
        else if (a == "--sr")        cfg.sample_rate = std::atoi(next("--sr"));
        else if (a == "--warp")      cfg.warp        = std::atoi(next("--warp")) != 0;
        else if (a == "--ratio")     cfg.ratio       = std::atof(next("--ratio"));
        else if (a == "--semitones") cfg.semitones   = std::atoi(next("--semitones"));
        else if (a == "--threads")   cfg.threads     = std::atoi(next("--threads"));
        else if (a == "--blocks")    cfg.blocks      = std::atoi(next("--blocks"));
        else if (a == "--warmup")    cfg.warmup      = std::atoi(next("--warmup"));
        else if (a == "--paced")     cfg.paced       = true;
        else if (a == "--label")     cfg.label       = next("--label");
        else if (a == "--json")      json_path       = next("--json");
        else if (a == "--matrix")    matrix          = true;
        else {
            std::fprintf(stderr, "argumento desconocido: %s\n", a.c_str());
            return 2;
        }
    }

    if (cfg.tracks <= 0 || cfg.block <= 0 || cfg.sample_rate <= 0 || cfg.blocks <= 0) {
        std::fprintf(stderr, "parámetros fuera de rango\n");
        return 2;
    }

    const std::vector<Config> configs = matrix ? baseline_matrix(cfg)
                                               : std::vector<Config>{cfg};

    // C6: TODAS las configuraciones, no una representativa. Ver el comentario
    // de verify_determinism.
    for (std::size_t i = 0; i < configs.size(); ++i) {
        std::string detail;
        if (!verify_determinism(configs[i], detail)) {
            std::fprintf(stderr,
                "DETERMINISMO ROTO en la configuración %zu de %zu\n"
                "(%d pistas, bloque %d, warp %s, ratio %.3f): dos pasadas dan\n"
                "contadores distintos (%s). El banco no está midiendo lo mismo\n"
                "dos veces; cualquier comparación contra la línea base sería\n"
                "ruido. Abortando.\n",
                i + 1, configs.size(), configs[i].tracks, configs[i].block,
                configs[i].warp ? "on" : "off", configs[i].ratio, detail.c_str());
            return 3;
        }
    }
    std::printf("determinismo estructural: OK en %zu configuración(es), "
                "dos pasadas cada una\n\n", configs.size());

    print_header();
    std::vector<BenchResult> results;
    results.reserve(configs.size());
    bool any_phases = false;
    for (const Config& c : configs) {
        BenchResult r = run(c);
        any_phases = any_phases || r.phases.available;
        print_row(r);
        if (!matrix) print_detail(r);
        results.push_back(std::move(r));
    }

    if (matrix) {
        std::printf("\nDetalle de la fila de 24 pistas con warp (el caso del reporte):\n");
        for (const BenchResult& r : results) {
            if (r.cfg.tracks == 24 && r.cfg.warp && r.cfg.block == 512) {
                print_row(r);
                print_detail(r);
                break;
            }
        }
    }

    if (!json_path.empty()) write_json(results, json_path, any_phases);
    return 0;
}
