#include <doctest/doctest.h>
#include <lt_engine/pitch/pitch_cache.h>

using namespace lt;

namespace {

PitchCacheKey key(double semitones, Id track = "track", Id clip = "clip") {
    return PitchCacheKey{"source", std::move(track), std::move(clip), semitones, 48000, 2, "realtime"};
}

}

TEST_CASE("PitchCache prepare happens before realtime lookup") {
    PitchCache cache;
    CHECK(cache.find_processor(key(2.0)) == nullptr);
    auto* prepared = cache.prepare_processor(key(2.0));
    REQUIRE(prepared != nullptr);
    CHECK(cache.find_processor(key(2.0)) == prepared);
    CHECK(cache.diagnostics().processors_prepared == 1);
}

TEST_CASE("PitchCache distinguishes semitone and voice keys") {
    PitchCache cache;
    auto* plus_two = cache.prepare_processor(key(2.0));
    auto* minus_two = cache.prepare_processor(key(-2.0));
    auto* other_voice = cache.prepare_processor(key(2.0, "track-b", "clip"));
    CHECK(plus_two != minus_two);
    CHECK(plus_two != other_voice);
    CHECK(cache.diagnostics().processors_prepared == 3);
}

TEST_CASE("PitchCache missing processor diagnostics are explicit") {
    PitchCache cache;
    CHECK(cache.find_processor(key(12.0)) == nullptr);
    cache.note_missing_processor(key(12.0));
    CHECK(cache.diagnostics().missing_processor_count == 1);
}
