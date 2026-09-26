//! Bajar la prioridad del hilo actual para trabajo de fondo que nunca debe
//! competir con el audio (miniaturas de vídeo).
//!
//! Solo Windows por ahora: en Linux y macOS el planificador ya reparte bien un
//! único hilo de fondo, y bajar el `nice` de un hilo concreto necesita
//! `setpriority` con el TID, que no merece una dependencia nueva.

#[cfg(windows)]
pub fn lower_current_thread_priority() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> *mut std::ffi::c_void;
        fn SetThreadPriority(thread: *mut std::ffi::c_void, priority: i32) -> i32;
    }
    const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    // SAFETY: GetCurrentThread devuelve un pseudo-handle válido del propio hilo.
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(not(windows))]
pub fn lower_current_thread_priority() {}
