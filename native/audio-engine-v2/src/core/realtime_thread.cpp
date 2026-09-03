#include <lt_engine/core/realtime_thread.h>
#include <lt_engine/debug/logging.h>

#include <array>
#include <atomic>

#if defined(_WIN32)
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#  include <avrt.h>
#elif defined(__APPLE__)
#  include <mach/mach.h>
#  include <mach/thread_policy.h>
#  include <pthread.h>
#else
#  include <pthread.h>
#  include <sched.h>
#endif

namespace lt {

namespace {

std::array<std::atomic<std::uint64_t>, 5> g_promotions{};

void note(RealtimePromotion kind) noexcept {
    g_promotions[static_cast<std::size_t>(kind)].fetch_add(1, std::memory_order_relaxed);
}

#if defined(_WIN32)
// `critical` distingue al director (pide lo máximo) del trabajador (pide
// NORMAL). Ver la nota de «igualar, no superar» en el cabecero.
RealtimePromotion promote_win32(bool critical, const char* who) {
    DWORD task_index = 0;
    HANDLE h = AvSetMmThreadCharacteristicsA("Pro Audio", &task_index);
    if (h) {
        const AVRT_PRIORITY prio = critical ? AVRT_PRIORITY_CRITICAL
                                            : AVRT_PRIORITY_NORMAL;
        const BOOL prio_ok = AvSetMmThreadPriority(h, prio);
        // El handle se filtra a propósito: tiene que seguir vivo mientras viva
        // el hilo, y estos hilos duran hasta que se cierra el dispositivo.
        lt_debug_log("[LT_AUDIO_DIAG] %s promoted to MMCSS Pro Audio "
                     "(tid=%lu prio=%s prio_ok=%d)\n",
                     who, GetCurrentThreadId(),
                     critical ? "critical" : "normal", prio_ok ? 1 : 0);
        return critical ? RealtimePromotion::ProAudioCritical
                        : RealtimePromotion::ProAudioNormal;
    }

    const DWORD err = GetLastError();
    if (err == ERROR_THREAD_ALREADY_IN_TASK) {
        // NO es un fallo, y presentarlo como tal costó una investigación: es
        // JUCE, que ya metió su hilo WASAPI en «Pro Audio» (con prioridad
        // NORMAL). El hilo YA tiene planificación multimedia. Tocarle la
        // prioridad base aquí no aporta nada y puede pelearse con MMCSS.
        lt_debug_log("[LT_AUDIO_DIAG] %s ya estaba en una tarea MMCSS "
                     "(tid=%lu, err=1552): el backend lo promocionó antes. "
                     "No es un fallo.\n", who, GetCurrentThreadId());
        note(RealtimePromotion::AlreadyInTask);
        return RealtimePromotion::AlreadyInTask;
    }

    // Sin MMCSS de verdad: al menos levantarlo por encima del pool de decode,
    // que corre a BELOW_NORMAL.
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    lt_debug_log("[LT_AUDIO_DIAG] %s sin MMCSS (err=%lu); respaldo "
                 "THREAD_PRIORITY_TIME_CRITICAL\n", who, err);
    return RealtimePromotion::Fallback;
}
#endif

RealtimePromotion promote(bool critical, const char* who) {
#if defined(_WIN32)
    const RealtimePromotion r = promote_win32(critical, who);
    if (r != RealtimePromotion::AlreadyInTask) note(r);   // AlreadyInTask ya se contó
    return r;
#elif defined(__APPLE__)
    // macOS/iOS: subir la prioridad del hilo POSIX. La política de restricción
    // temporal (THREAD_TIME_CONSTRAINT_POLICY) daría garantías más fuertes pero
    // necesita el periodo del buffer, que este punto no conoce; el backend de
    // audio ya la aplica a su propio hilo.
    struct sched_param param{};
    int policy = 0;
    if (pthread_getschedparam(pthread_self(), &policy, &param) == 0) {
        const int max_prio = sched_get_priority_max(SCHED_FIFO);
        param.sched_priority = critical ? max_prio : std::max(1, max_prio - 1);
        if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &param) == 0) {
            lt_debug_log("[LT_AUDIO_DIAG] %s a SCHED_FIFO prio=%d\n",
                         who, param.sched_priority);
            const RealtimePromotion r = critical ? RealtimePromotion::ProAudioCritical
                                                 : RealtimePromotion::ProAudioNormal;
            note(r);
            return r;
        }
    }
    note(RealtimePromotion::Failed);
    return RealtimePromotion::Failed;
#else
    // Linux/Android: SCHED_FIFO sólo si el proceso tiene permiso (RLIMIT_RTPRIO
    // o CAP_SYS_NICE). Sin permiso no es un error que deba parar nada — el pool
    // se puede seguir usando, simplemente con menos garantías.
    struct sched_param param{};
    const int max_prio = sched_get_priority_max(SCHED_FIFO);
    param.sched_priority = critical ? max_prio : (max_prio > 1 ? max_prio - 1 : max_prio);
    if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &param) == 0) {
        const RealtimePromotion r = critical ? RealtimePromotion::ProAudioCritical
                                             : RealtimePromotion::ProAudioNormal;
        note(r);
        return r;
    }
    lt_debug_log("[LT_AUDIO_DIAG] %s sin SCHED_FIFO (sin permiso); "
                 "sigue a prioridad normal\n", who);
    note(RealtimePromotion::Failed);
    return RealtimePromotion::Failed;
#endif
}

} // namespace

RealtimePromotion promote_audio_thread_to_pro_audio() {
    static thread_local RealtimePromotion cached = RealtimePromotion::Failed;
    static thread_local bool done = false;
    if (done) return cached;
    done = true;
    cached = promote(/*critical=*/true, "audio thread");
    return cached;
}

RealtimePromotion promote_render_worker_thread() {
    static thread_local RealtimePromotion cached = RealtimePromotion::Failed;
    static thread_local bool done = false;
    if (done) return cached;
    done = true;
    cached = promote(/*critical=*/false, "render worker");
    return cached;
}

std::uint64_t realtime_promotion_count(RealtimePromotion kind) noexcept {
    return g_promotions[static_cast<std::size_t>(kind)].load(std::memory_order_relaxed);
}

} // namespace lt
