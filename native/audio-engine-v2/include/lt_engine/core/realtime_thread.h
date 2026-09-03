#pragma once

// ---------------------------------------------------------------------------
// realtime_thread — promoción de un hilo a prioridad de audio.
//
// Existía sólo dentro de audio_device_manager.cpp, para el hilo del callback.
// El pool de render del paso 08 necesita lo mismo para sus trabajadores, y un
// trabajador a prioridad normal es PEOR que no tener pool: el planificador lo
// desaloja y se convierte en el rezagado que revienta el bloque.
//
// ── Igualar, no superar ────────────────────────────────────────────────────
//
// El log del usuario afectado (hecho 1.1 del diagnóstico) mostró 61 mensajes
// `MMCSS promotion FAILED (err=1552)` sobre 134 promociones. 1552 es
// ERROR_THREAD_ALREADY_IN_TASK, y el culpable es JUCE: su hilo WASAPI se mete
// en la tarea «Pro Audio» al entrar en run() y lo hace con
// **AVRT_PRIORITY_NORMAL** (juce_WASAPI_windows.cpp:1492-1505). Nuestra
// promoción llega después, recibe 1552, y el handle que haría falta para subir
// la prioridad MMCSS lo tiene JUCE y no lo publica.
//
// O sea: en WASAPI el director corre a NORMAL, no a CRITICAL. Si los
// trabajadores entraran a CRITICAL quedarían POR ENCIMA del único hilo con una
// fecha límite dura — una inversión de prioridad fabricada por nosotros.
//
// Por eso hay dos funciones y no una: el director pide lo máximo que pueda, y
// los trabajadores piden deliberadamente NORMAL, que es la clase en la que el
// director acaba en el caso realista.
// ---------------------------------------------------------------------------

#include <cstdint>

namespace lt {

// Qué consiguió una promoción. Se cuenta para poder responder «¿a qué prioridad
// corría de verdad?» sin adivinar, que es justo lo que costó rastrear en el log.
enum class RealtimePromotion {
    Failed,           // ni MMCSS ni respaldo: el hilo va a prioridad normal
    Fallback,         // sin MMCSS; respaldo de prioridad de hilo del SO
    AlreadyInTask,    // ya estaba en una tarea multimedia (la puso otro, p.ej. JUCE)
    ProAudioNormal,   // MMCSS «Pro Audio» a prioridad normal
    ProAudioCritical, // MMCSS «Pro Audio» a prioridad crítica
};

// Promociona el hilo llamante como HILO DE CALLBACK. Pide lo máximo posible.
// Idempotente por hilo.
RealtimePromotion promote_audio_thread_to_pro_audio();

// Promociona el hilo llamante como TRABAJADOR DEL POOL DE RENDER.
//
// Pide «Pro Audio» a prioridad NORMAL a propósito: ver la nota de arriba. No
// subas esto a CRITICAL sin comprobar antes a qué clase llegó el director en el
// backend real, o el reparto de trabajo acabará compitiendo con quien tiene que
// entregar el buffer.
RealtimePromotion promote_render_worker_thread();

// Cuántas promociones de cada clase se han hecho en el proceso. Para el
// diagnóstico del pool: si los trabajadores no llegan a la clase esperada, hay
// que saberlo por un contador, no por una corazonada.
std::uint64_t realtime_promotion_count(RealtimePromotion kind) noexcept;

} // namespace lt
