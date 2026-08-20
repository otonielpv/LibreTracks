// Tests for the handheld memory budgets (step 02 of the low-end Android plan)
// and for BlockCache::release_unprotected, the hand-memory-back-under-pressure
// path that step 03 will wire to Android's onTrimMemory.
//
// The load-bearing test here is "playback survives": handing memory back must
// never cost the audio thread the blocks it is about to read. A cache that
// frees everything is easy; one that frees everything EXCEPT the read-ahead
// window is the point.

#include <doctest/doctest.h>

#include <lt_engine/core/device_profile.h>
#include <lt_engine/sources/block_cache.h>

#include <string>
#include <vector>

using namespace lt;

namespace {

constexpr std::uint64_t kGb = 1024ull * 1024 * 1024;
constexpr std::uint64_t kMb = 1024ull * 1024;

// A block of `frames` stereo frames, filled with a recognisable value so a
// later read can prove it got THIS block's samples back.
std::vector<float> make_block(int frames, float value) {
    return std::vector<float>(static_cast<size_t>(frames) * 2, value);
}

}  // namespace

TEST_CASE("disk cache limit: desktop policy is unchanged") {
    // 10% of free, floored at 4 GiB. Literals on purpose.
    CHECK(lt_disk_cache_limit_for(100 * kGb, DeviceClass::Desktop) == 10 * kGb);
    CHECK(lt_disk_cache_limit_for(500 * kGb, DeviceClass::Workstation) == 50 * kGb);

    // Below the floor, the floor wins — even on a nearly full drive.
    CHECK(lt_disk_cache_limit_for(10 * kGb, DeviceClass::Desktop) == 4 * kGb);
    CHECK(lt_disk_cache_limit_for(1 * kGb, DeviceClass::ModestDesktop) == 4 * kGb);
    // A failed stat reports 0 free; desktop still lands on the floor.
    CHECK(lt_disk_cache_limit_for(0, DeviceClass::Desktop) == 4 * kGb);
}

TEST_CASE("disk cache limit: a handheld never claims gigabytes") {
    // The import that started all this consumed 4.91 GB of a 10 GB free
    // partition, and the desktop policy would call a 4 GiB cache reasonable.
    CHECK(lt_disk_cache_limit_for(10 * kGb, DeviceClass::Constrained) == 512 * kMb);
    CHECK(lt_disk_cache_limit_for(10 * kGb, DeviceClass::Handheld) == 512 * kMb);

    // Well under the 512 MB cap, 10% is what binds.
    CHECK(lt_disk_cache_limit_for(2 * kGb, DeviceClass::Handheld) == 2 * kGb / 10);
}

TEST_CASE("disk cache limit: a nearly full phone gets no cache at all") {
    // Under 1 GB free we stop writing rather than push the device over.
    CHECK(lt_disk_cache_limit_for(900 * kMb, DeviceClass::Constrained) == 0);
    CHECK(lt_disk_cache_limit_for(0, DeviceClass::Handheld) == 0);
    // ...and the desktop rule is untouched by that.
    CHECK(lt_disk_cache_limit_for(900 * kMb, DeviceClass::Desktop) == 4 * kGb);
}

TEST_CASE("release_unprotected keeps the freshest blocks per source") {
    BlockCache cache(kDefaultBlockFrames, 4096, 48);

    // Two sources, 10 blocks each, filled oldest-to-newest.
    for (int i = 0; i < 10; ++i) {
        const auto block = make_block(kDefaultBlockFrames, static_cast<float>(i));
        cache.fill("song-a", i, block.data(), 2, kDefaultBlockFrames);
        cache.fill("song-b", i, block.data(), 2, kDefaultBlockFrames);
    }
    REQUIRE(cache.diagnostics().blocks_cached == 20);

    const size_t freed = cache.release_unprotected(3);

    CHECK(freed > 0);
    // 3 per source survive; the other 14 are gone.
    CHECK(cache.diagnostics().blocks_cached == 6);
    // The freshest (highest index, filled last) are the ones kept.
    for (const char* source : {"song-a", "song-b"}) {
        CHECK(cache.has_block(source, 9));
        CHECK(cache.has_block(source, 8));
        CHECK(cache.has_block(source, 7));
        CHECK_FALSE(cache.has_block(source, 0));
        CHECK_FALSE(cache.has_block(source, 6));
    }
}

TEST_CASE("playback survives a release: protected blocks still read correctly") {
    // The regression that matters. If release_unprotected ever frees a block
    // the audio thread is about to read, playback goes silent instead of
    // glitching — and this test is what stands between us and that.
    BlockCache cache(kDefaultBlockFrames, 4096, 48);

    for (int i = 0; i < 8; ++i) {
        const auto block = make_block(kDefaultBlockFrames, static_cast<float>(i) + 0.5f);
        cache.fill("playing", i, block.data(), 2, kDefaultBlockFrames);
    }

    cache.release_unprotected(2);

    // Read the way the audio thread does, and check the SAMPLES, not just
    // presence: a block whose PCM was freed under us would read as garbage.
    std::vector<float> left(64), right(64);
    float* out[2] = {left.data(), right.data()};

    REQUIRE(cache.read("playing", 7, 0, 64, out, 2));
    CHECK(left[0] == doctest::Approx(7.5f));
    CHECK(right[63] == doctest::Approx(7.5f));

    REQUIRE(cache.read("playing", 6, 0, 64, out, 2));
    CHECK(left[0] == doctest::Approx(6.5f));

    // ...and the evicted ones simply miss, which the fill workers handle.
    CHECK_FALSE(cache.read("playing", 0, 0, 64, out, 2));
}

TEST_CASE("release_unprotected reports the bytes it actually freed") {
    BlockCache cache(kDefaultBlockFrames, 4096, 48);

    for (int i = 0; i < 6; ++i) {
        const auto block = make_block(kDefaultBlockFrames, 1.0f);
        cache.fill("song", i, block.data(), 2, kDefaultBlockFrames);
    }
    const size_t before = cache.diagnostics().bytes_used;

    const size_t freed = cache.release_unprotected(2);
    const size_t after = cache.diagnostics().bytes_used;

    CHECK(freed == before - after);
    CHECK(after < before);
    // 4 of 6 blocks, stereo float32.
    CHECK(freed == 4 * static_cast<size_t>(kDefaultBlockFrames) * 2 * sizeof(float));
}

TEST_CASE("release_unprotected with keep=0 empties the cache") {
    BlockCache cache(kDefaultBlockFrames, 4096, 48);
    for (int i = 0; i < 5; ++i) {
        const auto block = make_block(kDefaultBlockFrames, 1.0f);
        cache.fill("song", i, block.data(), 2, kDefaultBlockFrames);
    }

    cache.release_unprotected(0);

    CHECK(cache.diagnostics().blocks_cached == 0);
    CHECK(cache.diagnostics().bytes_used == 0);
}

TEST_CASE("release_unprotected on an empty cache is a no-op") {
    BlockCache cache(kDefaultBlockFrames, 4096, 48);
    CHECK(cache.release_unprotected(4) == 0);
    CHECK(cache.diagnostics().blocks_cached == 0);
}

TEST_CASE("a source with fewer blocks than the keep count loses none") {
    BlockCache cache(kDefaultBlockFrames, 4096, 48);
    for (int i = 0; i < 2; ++i) {
        const auto block = make_block(kDefaultBlockFrames, 1.0f);
        cache.fill("small", i, block.data(), 2, kDefaultBlockFrames);
    }

    CHECK(cache.release_unprotected(10) == 0);
    CHECK(cache.diagnostics().blocks_cached == 2);
}
