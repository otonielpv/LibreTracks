#include <lt_engine/devices/driver_call_guard.h>

#include <exception>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#endif

namespace lt {
namespace {

struct GuardedCall {
    const std::function<void()>* fn = nullptr;
    DriverCallResult             result;
};

void run_with_cxx_guard(void* raw) {
    auto& call = *static_cast<GuardedCall*>(raw);
    try {
        (*call.fn)();
    } catch (const std::exception&) {
        call.result = {false, "C++ exception (std::exception)"};
    } catch (...) {
        call.result = {false, "C++ exception (unknown type)"};
    }
}

#if defined(_WIN32)
// __try cannot share a function with C++ objects that need unwinding (C2712),
// so the C++-guarded work runs behind a plain function pointer.
bool run_with_seh_guard(void (*fn)(void*), void* ctx) {
    __try {
        fn(ctx);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}
#endif

} // namespace

DriverCallResult call_driver_guarded(const std::function<void()>& fn) {
    GuardedCall call;
    call.fn = &fn;
#if defined(_WIN32)
    if (!run_with_seh_guard(&run_with_cxx_guard, &call))
        return {false, "SEH fault inside the driver"};
#else
    run_with_cxx_guard(&call);
#endif
    return call.result;
}

} // namespace lt
