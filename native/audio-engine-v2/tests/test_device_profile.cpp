// Tests for device_profile.h — the "how much can this machine spend" policy.
//
// The point of most of these is REGRESSION: the low-end Android work must not
// change a single number on desktop. The expected values below are written as
// literals on purpose. Deriving them from the code under test would make the
// test agree with whatever the code does, which is exactly the failure mode
// this repo has been bitten by before.

#include <doctest/doctest.h>

#include <lt_engine/core/device_profile.h>

using namespace lt;

namespace {

constexpr std::uint64_t kGb = 1024ull * 1024 * 1024;
constexpr std::uint64_t kMb = 1024ull * 1024;

DeviceProbe desktop_probe(std::uint64_t ram_bytes, int cores) {
    DeviceProbe probe;
    probe.physical_ram_bytes = ram_bytes;
    probe.available_ram_bytes = 0;  // desktop never reports this
    probe.cores = cores;
    probe.is_handheld = false;
    return probe;
}

DeviceProbe handheld_probe(std::uint64_t ram_bytes, std::uint64_t available_bytes, int cores) {
    DeviceProbe probe;
    probe.physical_ram_bytes = ram_bytes;
    probe.available_ram_bytes = available_bytes;
    probe.cores = cores;
    probe.is_handheld = true;
    return probe;
}

}  // namespace

TEST_CASE("desktop source cache budget is unchanged by the handheld work") {
    // Literals, not lookups: 512 / 1024 / 2048 / 3072 is the shipping policy.
    CHECK(lt_device_profile_for(desktop_probe(4 * kGb, 8)).source_cache_mb == 512);
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 8)).source_cache_mb == 512);
    CHECK(lt_device_profile_for(desktop_probe(16 * kGb, 8)).source_cache_mb == 1024);
    CHECK(lt_device_profile_for(desktop_probe(32 * kGb, 16)).source_cache_mb == 2048);
    CHECK(lt_device_profile_for(desktop_probe(64 * kGb, 16)).source_cache_mb == 3072);
}

TEST_CASE("desktop worker counts are unchanged by the handheld work") {
    // Decode: min(cores-1, ram_cap) clamped to [2,6] (or [1,6] on <=2 cores).
    CHECK(lt_device_profile_for(desktop_probe(4 * kGb, 8)).decode_threads == 2);
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 8)).decode_threads == 3);
    CHECK(lt_device_profile_for(desktop_probe(16 * kGb, 8)).decode_threads == 4);
    CHECK(lt_device_profile_for(desktop_probe(32 * kGb, 16)).decode_threads == 6);

    // Fill: capped at 4, and at 2 when cores or RAM are low.
    CHECK(lt_device_profile_for(desktop_probe(4 * kGb, 8)).fill_threads == 2);
    CHECK(lt_device_profile_for(desktop_probe(16 * kGb, 8)).fill_threads == 4);

    // Dual core keeps a whole core for the audio callback.
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 2)).decode_threads == 1);
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 2)).fill_threads == 1);
}

TEST_CASE("the profile matches the querying thread_policy on desktop") {
    // If these ever disagree, one of the two policies has drifted.
    for (std::uint64_t ram : {4 * kGb, 8 * kGb, 16 * kGb, 32 * kGb}) {
        for (int cores : {2, 4, 8, 16}) {
            const auto profile = lt_device_profile_for(desktop_probe(ram, cores));
            CHECK(profile.decode_threads ==
                  lt_recommend_worker_threads_for(WorkerRole::Decode, cores, ram));
            CHECK(profile.fill_threads ==
                  lt_recommend_worker_threads_for(WorkerRole::Fill, cores, ram));
        }
    }
}

TEST_CASE("desktop never gets a spending budget") {
    // usable_budget_bytes only steers handheld code; leaving it 0 keeps desktop
    // behaviour driven by the existing per-consumer policies.
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 8)).usable_budget_bytes == 0);
    CHECK(lt_device_profile_for(desktop_probe(64 * kGb, 16)).usable_budget_bytes == 0);
}

TEST_CASE("the Oppo CPH1931 classifies as Constrained") {
    // The exact device from docs/plans/android-low-end/00-DIAGNOSTICO.md:
    // 2 706 168 kB installed, ~1.0 GB available while idle, 8 cores.
    const auto profile =
        lt_device_profile_for(handheld_probe(2706168ull * 1024, 1122700ull * 1024, 8));

    CHECK(profile.device_class == DeviceClass::Constrained);
    CHECK(profile.decode_threads == 1);
    CHECK(profile.fill_threads == 1);
    CHECK(profile.source_cache_mb == 48);
    // A quarter of ~1.07 GB is ~274 MB, so the 128 MB cap is what binds.
    CHECK(profile.usable_budget_bytes == 128 * kMb);
}

TEST_CASE("a roomier handheld is not treated as Constrained") {
    // 6 GB phone with 3 GB free: still a phone (small cache, few threads), but
    // not on the edge.
    const auto profile = lt_device_profile_for(handheld_probe(6 * kGb, 3 * kGb, 8));

    CHECK(profile.device_class == DeviceClass::Handheld);
    CHECK(profile.decode_threads == 2);
    CHECK(profile.fill_threads == 2);
    CHECK(profile.source_cache_mb == 96);
    CHECK(profile.usable_budget_bytes == 256 * kMb);  // quarter of 3 GB, capped
}

TEST_CASE("handheld budgets follow AVAILABLE memory, not installed memory") {
    // Same 4 GB device, different amounts free. Judging by installed RAM alone
    // (what thread_policy does) would rate these identically — the whole reason
    // this file exists.
    const auto idle = lt_device_profile_for(handheld_probe(4 * kGb, 2 * kGb, 8));
    const auto busy = lt_device_profile_for(handheld_probe(4 * kGb, 400 * kMb, 8));

    CHECK(idle.device_class == DeviceClass::Handheld);
    CHECK(busy.device_class == DeviceClass::Constrained);
    CHECK(busy.source_cache_mb < idle.source_cache_mb);
    CHECK(busy.usable_budget_bytes < idle.usable_budget_bytes);
}

TEST_CASE("a handheld with unknown available memory falls back to a quarter of physical") {
    // Some kernel without MemAvailable: assume a quarter is ours rather than
    // pretending we have desktop headroom.
    const auto profile = lt_device_profile_for(handheld_probe(2 * kGb, 0, 8));

    CHECK(profile.device_class == DeviceClass::Constrained);  // 512 MB < 1.5 GB
    CHECK(profile.source_cache_mb == 48);
}

TEST_CASE("unknown core count does not produce a zero-thread pool") {
    // hardware_concurrency() may return 0; the pools must still be usable.
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 0)).decode_threads >= 1);
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 0)).fill_threads >= 1);
    CHECK(lt_device_profile_for(handheld_probe(2 * kGb, 1 * kGb, 0)).decode_threads >= 1);
}

TEST_CASE("the cached profile is resolved once and stays stable") {
    const DeviceProfile& first = lt_device_profile();
    const DeviceProfile& second = lt_device_profile();

    CHECK(&first == &second);  // same object: no re-read of /proc/meminfo
    CHECK(first.decode_threads >= 1);
    CHECK(first.fill_threads >= 1);
    CHECK(first.source_cache_mb > 0);
    CHECK(lt_device_class_name(first.device_class) != nullptr);
}
