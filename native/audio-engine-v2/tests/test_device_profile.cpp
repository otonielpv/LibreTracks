// Tests for device_profile.h — the "how much can this machine spend" policy.
//
// The point of most of these is REGRESSION: the low-end Android work must not
// change a single number on desktop. The expected values below are written as
// literals on purpose. Deriving them from the code under test would make the
// test agree with whatever the code does, which is exactly the failure mode
// this repo has been bitten by before.

#include <doctest/doctest.h>
#include <lt_engine/devices/audio_device_manager.h>

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

DeviceProbe ios_probe(std::uint64_t ram_bytes, int cores) {
    DeviceProbe probe = handheld_probe(ram_bytes, 0, cores);
    probe.is_ios = true;
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

TEST_CASE("the waveform pool scales with the machine but stays under Fill") {
    // Waveform analysis is cosmetic and runs while Decode and Fill are already
    // busy (an import), so it scales with the box but never leads it. It used
    // to be a hardcoded single worker on the host side, which made a 25-stem
    // import analyse strictly one file at a time.
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, 2, 8 * kGb) == 1);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, 4, 8 * kGb) == 2);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, 8, 16 * kGb) == 3);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, 16, 32 * kGb) == 4);

    // A low-RAM box gets one regardless of how many cores it reports.
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, 16, 4 * kGb) == 1);

    // Never ahead of the I/O pool it shares a disk with.
    for (int cores : {2, 4, 8, 16}) {
        CHECK(lt_recommend_worker_threads_for(WorkerRole::Waveform, cores, 16 * kGb)
              <= lt_recommend_worker_threads_for(WorkerRole::Fill, cores, 16 * kGb));
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
    // Two decoders, not one: preparation is the one phase where parallelism
    // pays, and a single worker left a 36-stem session ~36 minutes from being
    // playable. Fill stays at one — it is disk I/O on a single eMMC.
    CHECK(profile.decode_threads == 2);
    CHECK(profile.fill_threads == 1);
    // Sized so a 36-stem set's protected read-ahead windows still fit; see
    // the measurement in device_profile.h.
    CHECK(profile.source_cache_mb == 128);
    // A quarter of ~1.07 GB is ~274 MB, so the 128 MB cap is what binds.
    CHECK(profile.usable_budget_bytes == 128 * kMb);
}

TEST_CASE("a middling handheld is neither Constrained nor Roomy") {
    // 6 GB phone with 2 GB free: comfortably off the edge, but not the 3 GB
    // that earns desktop-sized read-ahead.
    const auto profile = lt_device_profile_for(handheld_probe(6 * kGb, 2 * kGb, 8));

    CHECK(profile.device_class == DeviceClass::Handheld);
    CHECK(profile.decode_threads == 3);
    CHECK(profile.fill_threads == 2);
    CHECK(profile.source_cache_mb == 192);
    // A quarter of 2 GB is 512 MB, so the middling tier's 256 MB cap binds.
    CHECK(profile.usable_budget_bytes == 256 * kMb);
}

TEST_CASE("a modern 8 GB phone is not throttled like a 2.5 GB one") {
    // A Moto G86 (8 GB, UFS storage) idling with ~4 GB free. Reported from the
    // field: it was getting the same budgets as the CPH1931 because there were
    // only two handheld tiers, and jumps stuttered while the fill pool refilled
    // the read-ahead window.
    const auto moto = lt_device_profile_for(handheld_probe(8 * kGb, 4 * kGb, 8));
    const auto oppo =
        lt_device_profile_for(handheld_probe(2706168ull * 1024, 1122700ull * 1024, 8));

    CHECK(moto.device_class == DeviceClass::RoomyHandheld);

    // Strictly more of everything than the constrained device: this is the
    // whole point of the tier existing.
    CHECK(moto.source_cache_mb > oppo.source_cache_mb);
    CHECK(moto.protected_blocks_per_source > oppo.protected_blocks_per_source);
    CHECK(moto.decode_threads > oppo.decode_threads);
    CHECK(moto.fill_threads > oppo.fill_threads);

    // A jump has to refill the read-ahead window before the first sample
    // sounds, so a roomy phone gets the desktop-sized one.
    CHECK(moto.protected_blocks_per_source == 48);
    CHECK(moto.source_cache_mb == 512);
}

TEST_CASE("the three handheld tiers are ordered, with no gap between them") {
    // Same device, three amounts of memory free. Each step up must give at
    // least as much as the one below — a tier that accidentally inverted would
    // hand a bigger phone a smaller budget.
    const auto tight = lt_device_profile_for(handheld_probe(8 * kGb, 1 * kGb, 8));
    const auto middling = lt_device_profile_for(handheld_probe(8 * kGb, 2 * kGb, 8));
    const auto roomy = lt_device_profile_for(handheld_probe(8 * kGb, 4 * kGb, 8));

    CHECK(tight.device_class == DeviceClass::Constrained);
    CHECK(middling.device_class == DeviceClass::Handheld);
    CHECK(roomy.device_class == DeviceClass::RoomyHandheld);

    CHECK(tight.source_cache_mb <= middling.source_cache_mb);
    CHECK(middling.source_cache_mb <= roomy.source_cache_mb);
    CHECK(tight.protected_blocks_per_source <= middling.protected_blocks_per_source);
    CHECK(middling.protected_blocks_per_source <= roomy.protected_blocks_per_source);
    CHECK(tight.usable_budget_bytes <= middling.usable_budget_bytes);
    CHECK(middling.usable_budget_bytes <= roomy.usable_budget_bytes);

    // ...and a roomy phone still never claims desktop-scale memory: the app
    // shares the device with the system, which kills long before "free" hits 0.
    CHECK(roomy.usable_budget_bytes <= 512 * kMb);
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
    CHECK(profile.source_cache_mb == 128);
}

TEST_CASE("iOS uses a physical-memory fallback without throttling an iPhone 13") {
    // iOS cannot report MemAvailable. A 4 GB iPhone 13 used to fall back to a
    // quarter of physical (1 GB) and was therefore permanently Constrained.
    const auto iphone13 = lt_device_profile_for(ios_probe(4 * kGb, 6));

    CHECK(iphone13.device_class == DeviceClass::Handheld);
    CHECK(iphone13.decode_threads == 3);
    CHECK(iphone13.fill_threads == 2);
    CHECK(iphone13.source_cache_mb == 192);
    CHECK(iphone13.protected_blocks_per_source == 24);

    // The fallback must remain safe for older 2 GB devices.
    const auto old_iphone = lt_device_profile_for(ios_probe(2 * kGb, 4));
    CHECK(old_iphone.device_class == DeviceClass::Constrained);
    CHECK(old_iphone.source_cache_mb == 128);
}

TEST_CASE("handheld first-play prefetch stays inside the shared cache") {
    const auto iphone13 = lt_device_profile_for(ios_probe(4 * kGb, 6));
    const int requested = 48000 * 20;
    const int capped = lt_playback_prefetch_window_frames(
        iphone13, 48000, 27, requested);

    CHECK(capped < requested);
    CHECK(capped >= 48000 * 2);
    CHECK(capped == 559240);

    const auto desktop = lt_device_profile_for(desktop_probe(16 * kGb, 8));
    CHECK(lt_playback_prefetch_window_frames(
              desktop, 48000, 27, requested) == requested);
}

TEST_CASE("unknown core count does not produce a zero-thread pool") {
    // hardware_concurrency() may return 0; the pools must still be usable.
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 0)).decode_threads >= 1);
    CHECK(lt_device_profile_for(desktop_probe(8 * kGb, 0)).fill_threads >= 1);
    CHECK(lt_device_profile_for(handheld_probe(2 * kGb, 1 * kGb, 0)).decode_threads >= 1);
}

TEST_CASE("a handheld cache holds a real session's read-ahead windows") {
    // Playback streams from disk; the memory goes on the read-ahead window that
    // eviction may not touch, once per PLAYING track. The budget has to hold
    // that whole working set with slack, or the cache thrashes and the audio
    // thread is served silence — 43.5 million silenced frames on the CPH1931
    // when a 48 MB budget met 36 sources holding the desktop 48-block window.
    constexpr std::size_t kBlockBytes = 4096 * sizeof(float) * 2;  // 32 KiB
    constexpr std::size_t kRealisticSources = 36;  // the user's WhatAGod set

    for (const auto& profile :
         {lt_device_profile_for(handheld_probe(2706168ull * 1024, 1122700ull * 1024, 8)),
          lt_device_profile_for(handheld_probe(6 * kGb, 3 * kGb, 8))}) {
        const std::size_t working_set =
            kRealisticSources * profile.protected_blocks_per_source * kBlockBytes;
        const std::size_t budget_bytes = profile.source_cache_mb * 1024 * 1024;

        CHECK(budget_bytes > working_set);
        // Real headroom, not a hair over: a cache the exact size of its
        // protected set has nowhere to put the blocks it is fetching.
        CHECK(budget_bytes >= working_set * 2);
    }
}

TEST_CASE("a handheld reads less far ahead than a desktop") {
    // The per-track cost of streaming, and therefore the track ceiling on a
    // phone. Flash needs far less lead than the desktop default assumes, and
    // shortening the window is what buys tracks — a bigger budget alone does
    // not, because the window is reserved per playing source.
    const auto oppo =
        lt_device_profile_for(handheld_probe(2706168ull * 1024, 1122700ull * 1024, 8));
    const auto desktop = lt_device_profile_for(desktop_probe(16 * kGb, 8));

    CHECK(oppo.protected_blocks_per_source < desktop.protected_blocks_per_source);
    // Still enough lead to cover a disk hiccup: at 4096-frame blocks and
    // 44.1 kHz, 16 blocks is ~1.5 s.
    CHECK(oppo.protected_blocks_per_source >= 16);

    // Desktop keeps BlockCache's shipping default, unchanged.
    CHECK(desktop.protected_blocks_per_source == 48);
}

TEST_CASE("a handheld's decode pool is smaller than the desktop policy would pick") {
    // Regression: the decode pool kept calling lt_recommend_worker_threads()
    // (physical-RAM only) after the rest of step 02 moved to the profile, so a
    // real CPH1931 logged "decode pool: 2 worker(s)" while its profile said 1.
    // Caught on the device, not by a test — hence this one.
    const auto oppo =
        lt_device_profile_for(handheld_probe(2706168ull * 1024, 1122700ull * 1024, 8));

    // The fill pool is where the handheld profile diverges: one reader, not
    // the two the RAM-only policy picks, because a second only queues behind
    // the first on a single eMMC.
    CHECK(oppo.fill_threads == 1);
    CHECK(lt_recommend_worker_threads_for(WorkerRole::Fill, 8, 2706168ull * 1024) == 2);
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

// Backends that cannot sustain a small buffer.
//
// Asking DirectSound for 128 frames does not give low latency, it gives
// underruns — and an underrunning DirectSound device drops whole buffers, so
// the audio jumps forward repeatedly. The user hears "crackling AND too fast",
// which sounds like a pitch bug and is not one. Measured on one device:
// 512 frames played clean at 29.0 ms out; 128 crackled and ran fast.
//
// The clamp is what stops a settings dialog from offering a combination the
// backend cannot honour. WASAPI and ASIO keep their own minimum, which is the
// whole reason to prefer them for low latency.
TEST_CASE("small buffers are clamped only on the backends that cannot hold them") {
    CHECK(lt_min_buffer_frames_for_backend("DirectSound") == 512);
    CHECK(lt_min_buffer_frames_for_backend("Windows Audio (MME)") == 512);
    // Case-insensitive: JUCE spells these differently across versions.
    CHECK(lt_min_buffer_frames_for_backend("directsound") == 512);

    // 0 means "trust the driver" — these are the low-latency paths.
    CHECK(lt_min_buffer_frames_for_backend("Windows Audio") == 0);
    CHECK(lt_min_buffer_frames_for_backend("ASIO") == 0);
    CHECK(lt_min_buffer_frames_for_backend("CoreAudio") == 0);
    CHECK(lt_min_buffer_frames_for_backend("") == 0);
}
