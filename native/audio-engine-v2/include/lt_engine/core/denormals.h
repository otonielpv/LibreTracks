#pragma once

// Denormal (subnormal) floats near zero are 10-100x slower on x86: every
// operation that touches one takes a microcode assist. A fade tail, a
// filter decaying to silence (r8brain, the sinc interpolator) or Bungee's
// FFT state after a clip ends all produce them, and a block full of them
// costs a callback overrun nobody can explain from the profile. LMMS turns
// them off in its audio thread and every worker; so do we.
//
// FTZ (flush-to-zero) writes results that would be subnormal as 0; DAZ
// (denormals-are-zero) reads subnormal inputs as 0. The difference to the
// audio is below -760 dBFS. The flags are per thread, so every thread that
// runs DSP needs them: the device callback, the render pool workers, and the
// Bungee / prearm / decode workers.

#include <cstdint>

#if defined(__SSE__) || defined(_M_X64) || defined(_M_AMD64) || defined(__x86_64__) \
    || (defined(_M_IX86_FP) && _M_IX86_FP >= 1)
#include <xmmintrin.h>
#define LT_DENORMALS_X86 1
#elif defined(__aarch64__) && (defined(__GNUC__) || defined(__clang__))
#define LT_DENORMALS_ARM64 1
#elif defined(__arm__) && defined(__ARM_FP) && (defined(__GNUC__) || defined(__clang__))
#define LT_DENORMALS_ARM32 1
#endif

namespace lt {

namespace denormals_detail {

#if defined(LT_DENORMALS_X86)
// MXCSR bit 15 = FTZ, bit 6 = DAZ.
inline constexpr std::uint32_t kMask = 0x8040u;
inline std::uint32_t read_state() noexcept { return _mm_getcsr(); }
inline void write_state(std::uint32_t v) noexcept { _mm_setcsr(v); }
#elif defined(LT_DENORMALS_ARM64)
// FPCR bit 24 = FZ (covers both inputs and outputs on AArch64).
inline constexpr std::uint64_t kMask = 1ull << 24;
inline std::uint64_t read_state() noexcept {
    std::uint64_t v;
    __asm__ __volatile__("mrs %0, fpcr" : "=r"(v));
    return v;
}
inline void write_state(std::uint64_t v) noexcept {
    __asm__ __volatile__("msr fpcr, %0" : : "r"(v));
}
#elif defined(LT_DENORMALS_ARM32)
// FPSCR bit 24 = FZ. NEON already flushes; this covers scalar VFP code.
inline constexpr std::uint32_t kMask = 1u << 24;
inline std::uint32_t read_state() noexcept {
    std::uint32_t v;
    __asm__ __volatile__("vmrs %0, fpscr" : "=r"(v));
    return v;
}
inline void write_state(std::uint32_t v) noexcept {
    __asm__ __volatile__("vmsr fpscr, %0" : : "r"(v));
}
#endif

} // namespace denormals_detail

// Turns FTZ/DAZ on for the calling thread for the rest of its life. For
// threads the engine owns (pool workers, decode / Bungee workers).
inline void disable_denormals_for_current_thread() noexcept {
#if defined(LT_DENORMALS_X86) || defined(LT_DENORMALS_ARM64) || defined(LT_DENORMALS_ARM32)
    using namespace denormals_detail;
    const auto state = read_state();
    if ((state & kMask) != kMask)
        write_state(state | kMask);
#endif
}

// True when the calling thread flushes denormals (always false on a
// platform without support, which tests treat as "skip").
inline bool denormals_disabled_for_current_thread() noexcept {
#if defined(LT_DENORMALS_X86) || defined(LT_DENORMALS_ARM64) || defined(LT_DENORMALS_ARM32)
    using namespace denormals_detail;
    return (read_state() & kMask) == kMask;
#else
    return false;
#endif
}

inline constexpr bool denormal_control_supported() noexcept {
#if defined(LT_DENORMALS_X86) || defined(LT_DENORMALS_ARM64) || defined(LT_DENORMALS_ARM32)
    return true;
#else
    return false;
#endif
}

// FTZ/DAZ for one scope, restoring the previous state on exit. For once-per-job
// work on a thread the engine does not own (an offline render, a batch of
// Bungee builds on the control thread). NOT for the per-block audio path: the
// restore is a control-register write, which serialises the pipeline (~1 us
// per block measured), so the callback uses
// disable_denormals_for_current_thread() instead.
class ScopedNoDenormals {
public:
    ScopedNoDenormals() noexcept {
#if defined(LT_DENORMALS_X86) || defined(LT_DENORMALS_ARM64) || defined(LT_DENORMALS_ARM32)
        using namespace denormals_detail;
        previous_ = read_state();
        if ((previous_ & kMask) != kMask)
            write_state(previous_ | kMask);
#endif
    }
    ~ScopedNoDenormals() noexcept {
#if defined(LT_DENORMALS_X86) || defined(LT_DENORMALS_ARM64) || defined(LT_DENORMALS_ARM32)
        using namespace denormals_detail;
        if ((previous_ & kMask) != kMask)
            write_state(previous_);
#endif
    }
    ScopedNoDenormals(const ScopedNoDenormals&) = delete;
    ScopedNoDenormals& operator=(const ScopedNoDenormals&) = delete;

private:
#if defined(LT_DENORMALS_ARM64)
    std::uint64_t previous_ = 0;
#else
    std::uint32_t previous_ = 0;
#endif
};

} // namespace lt
