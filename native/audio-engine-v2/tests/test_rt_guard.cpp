#include <lt_engine/diagnostics/rt_guard.h>

#include <doctest/doctest.h>

#include <cstdlib>
#include <latch>
#include <new>
#include <thread>

namespace {

void* allocate_or_throw(std::size_t size) {
    if (void* memory = std::malloc(size))
        return memory;
    throw std::bad_alloc{};
}

} // namespace

void* operator new(std::size_t size) {
    lt::rt::detail::record_allocation();
    return allocate_or_throw(size);
}

void* operator new[](std::size_t size) {
    lt::rt::detail::record_allocation();
    return allocate_or_throw(size);
}

void operator delete(void* memory) noexcept {
    lt::rt::detail::record_deallocation();
    std::free(memory);
}

void operator delete[](void* memory) noexcept {
    lt::rt::detail::record_deallocation();
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept {
    lt::rt::detail::record_deallocation();
    std::free(memory);
}

void operator delete[](void* memory, std::size_t) noexcept {
    lt::rt::detail::record_deallocation();
    std::free(memory);
}

TEST_CASE("realtime guard counts allocations only inside its section") {
    lt::rt::reset_violations();
    auto* outside = new int[4];
    delete[] outside;
    CHECK(lt::rt::violations().allocations == 0);
    CHECK(lt::rt::violations().deallocations == 0);

    {
        lt::rt::ScopedRealtimeSection realtime;
        auto* inside = new int[4];
        CHECK(lt::rt::violations().allocations >= 1);
        delete[] inside;
        CHECK(lt::rt::violations().deallocations >= 1);
    }
}

TEST_CASE("realtime guard sections are reentrant") {
    lt::rt::reset_violations();
    {
        lt::rt::ScopedRealtimeSection outer;
        {
            lt::rt::ScopedRealtimeSection inner;
        }
        auto* allocation = new int[4];
        delete[] allocation;
    }
    CHECK(lt::rt::violations().allocations >= 1);
}

TEST_CASE("realtime guard violations are local to each thread") {
    lt::rt::reset_violations();
    std::latch main_is_realtime{1};
    std::latch worker_allocated{1};

    std::thread worker([&] {
        main_is_realtime.wait();
        auto* allocation = new int[4];
        delete[] allocation;
        worker_allocated.count_down();
    });

    {
        lt::rt::ScopedRealtimeSection realtime;
        main_is_realtime.count_down();
        worker_allocated.wait();
        CHECK(lt::rt::violations().allocations == 0);
        CHECK(lt::rt::violations().deallocations == 0);
    }
    worker.join();
}
