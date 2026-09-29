#include <doctest/doctest.h>

#include <lt_engine/devices/driver_call_guard.h>

#include <stdexcept>
#include <string>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#endif

using namespace lt;

// Each case stands in for an ASIO driver misbehaving inside createDevice().
// Before the guard existed, any of these unwound into Rust and aborted the app.

TEST_CASE("driver guard: a driver that behaves reports ok and its work is kept") {
    int channels = 0;
    const auto result = call_driver_guarded([&] { channels = 4; });
    CHECK(result.ok);
    CHECK(result.error == nullptr);
    CHECK(channels == 4);
}

TEST_CASE("driver guard: a std::exception thrown by the driver is contained") {
    const auto result = call_driver_guarded([] {
        throw std::runtime_error("ASIO init failed");
    });
    CHECK_FALSE(result.ok);
    REQUIRE(result.error != nullptr);
    CHECK(std::string(result.error).find("std::exception") != std::string::npos);
}

TEST_CASE("driver guard: a non-std exception thrown by the driver is contained") {
    // Drivers built with other toolchains throw whatever they like.
    const auto result = call_driver_guarded([] { throw 42; });
    CHECK_FALSE(result.ok);
    REQUIRE(result.error != nullptr);
    CHECK(std::string(result.error).find("unknown type") != std::string::npos);
}

TEST_CASE("driver guard: the guard is reusable after a failure") {
    CHECK_FALSE(call_driver_guarded([] { throw 1; }).ok);
    CHECK(call_driver_guarded([] {}).ok);
}

#if defined(_WIN32)
TEST_CASE("driver guard: an SEH fault inside the driver is contained (Windows)") {
    // RaiseException is the deterministic stand-in for a driver that reads a
    // bad pointer: same dispatch path as a hardware access violation.
    const auto result = call_driver_guarded([] {
        RaiseException(EXCEPTION_ACCESS_VIOLATION, 0, 0, nullptr);
    });
    CHECK_FALSE(result.ok);
    REQUIRE(result.error != nullptr);
    CHECK(std::string(result.error).find("SEH") != std::string::npos);
}
#endif
