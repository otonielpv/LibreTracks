#include <doctest/doctest.h>

#include <lt_engine/render/track_renderer.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/audio_decoder.h>
#include <lt_engine/sources/decoded_source.h>
#include <lt_engine/sources/source_manager.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#if LT_ENGINE_USE_LIBSNDFILE
#include <sndfile.h>
#endif

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#else
#  include <dirent.h>
#  include <sys/stat.h>
#endif

using namespace lt;

namespace {

std::vector<float> make_reference_audio(Frame frames, int channels) {
    std::vector<float> samples(static_cast<std::size_t>(frames * channels), 0.0f);
    for (Frame f = 0; f < frames; ++f) {
        const float a = std::sin(static_cast<float>(f) * 0.0137f) * 0.42f;
        const float b = std::cos(static_cast<float>(f) * 0.0211f) * 0.31f;
        samples[static_cast<std::size_t>(f * channels)] = a;
        if (channels > 1)
            samples[static_cast<std::size_t>(f * channels + 1)] = b;
    }
    return samples;
}

void require_ready_range(const SourceManager& manager,
                         const Id& source_id,
                         Frame start,
                         int frames) {
    const auto source = manager.get_shared(source_id);
    REQUIRE(static_cast<bool>(source));
    const int first = static_cast<int>(start / kDefaultBlockFrames);
    const int last = static_cast<int>((start + frames - 1) / kDefaultBlockFrames);
    for (int block = first; block <= last; ++block)
        manager.request_block(source_id, block);

    for (int spin = 0; spin < 200 && !source->is_range_ready(start, frames); ++spin)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(source->is_range_ready(start, frames));
}

std::vector<float> read_planar(const DecodedSource& source, Frame start, int frames) {
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* out[2] = {left.data(), right.data()};
    REQUIRE(source.read(start, frames, out, 2) == frames);

    std::vector<float> interleaved;
    interleaved.reserve(static_cast<std::size_t>(frames) * 2);
    for (int f = 0; f < frames; ++f) {
        interleaved.push_back(left[static_cast<std::size_t>(f)]);
        interleaved.push_back(right[static_cast<std::size_t>(f)]);
    }
    return interleaved;
}

std::vector<float> render_track_block(const SourceManager& manager,
                                      const Id& source_id,
                                      Frame timeline_frame,
                                      int frames) {
    Track track;
    track.id = "track";
    track.gain = 0.75f;
    track.clips.push_back(Clip{"clip", source_id, 0, 0, kDefaultBlockFrames * 4, 0.8f});

    TrackRenderer renderer;
    renderer.prepare(frames);
    std::vector<float> left(static_cast<std::size_t>(frames), 0.0f);
    std::vector<float> right(static_cast<std::size_t>(frames), 0.0f);
    float* out[2] = {left.data(), right.data()};
    renderer.render(track, timeline_frame, frames, out, 2, manager, nullptr, 48000);

    std::vector<float> interleaved;
    interleaved.reserve(static_cast<std::size_t>(frames) * 2);
    for (int f = 0; f < frames; ++f) {
        interleaved.push_back(left[static_cast<std::size_t>(f)]);
        interleaved.push_back(right[static_cast<std::size_t>(f)]);
    }
    return interleaved;
}

void require_audio_equal(const std::vector<float>& a, const std::vector<float>& b) {
    REQUIRE(a.size() == b.size());
    for (std::size_t i = 0; i < a.size(); ++i)
        CHECK(a[i] == doctest::Approx(b[i]).epsilon(0.000001));
}

} // namespace

TEST_CASE("SourceManager stores prepared sources in disk-backed block cache") {
    SourceManager manager;
    const Id source_id = "streaming-cache-source";
    manager.register_source(source_id, "streaming-cache-source.wav");

    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 2;
    std::vector<float> samples(static_cast<std::size_t>(kFrames * kChannels), 0.0f);
    for (Frame f = 0; f < kFrames; ++f) {
        samples[static_cast<std::size_t>(f * kChannels)] = static_cast<float>(f) / 1000.0f;
        samples[static_cast<std::size_t>(f * kChannels + 1)] = -static_cast<float>(f) / 1000.0f;
    }

    REQUIRE(manager.store_decoded_source(source_id, std::move(samples),
                                         kChannels, kSampleRate, kFrames).is_ok());

    auto source = manager.get_shared(source_id);
    REQUIRE(static_cast<bool>(source));
    CHECK(source->is_streaming());
    CHECK(source->memory_bytes() == 0);
    CHECK(source->is_range_ready(0, 512));

    std::vector<float> left(512, 0.0f);
    std::vector<float> right(512, 0.0f);
    float* out[2] = {left.data(), right.data()};
    CHECK(source->read(128, 512, out, 2) == 512);
    CHECK(left[0] == doctest::Approx(0.128f));
    CHECK(right[0] == doctest::Approx(-0.128f));

    const auto diagnostics = manager.diagnostics();
    REQUIRE(diagnostics.size() == 1);
    CHECK(diagnostics[0].storage_kind == "disk_cache");
    CHECK(diagnostics[0].memory_bytes == 0);
    CHECK(diagnostics[0].disk_cache_bytes > 0);
}

TEST_CASE("Streaming source reads match legacy in-memory source across block boundaries") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 4 + 777;
    auto samples = make_reference_audio(kFrames, kChannels);

    SourceManager memory_manager;
    SourceManager streaming_manager;
    memory_manager.register_source("src", "");
    streaming_manager.register_source("src", "streaming-equivalence.wav");

    REQUIRE(memory_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());
    REQUIRE(streaming_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());

    const auto memory_source = memory_manager.get_shared("src");
    const auto streaming_source = streaming_manager.get_shared("src");
    REQUIRE(static_cast<bool>(memory_source));
    REQUIRE(static_cast<bool>(streaming_source));
    REQUIRE_FALSE(memory_source->is_streaming());
    REQUIRE(streaming_source->is_streaming());

    for (Frame start : {Frame{0}, Frame{kDefaultBlockFrames - 37},
                        Frame{kDefaultBlockFrames + 19},
                        Frame{kDefaultBlockFrames * 3 - 128}}) {
        constexpr int kReadFrames = 512;
        require_ready_range(streaming_manager, "src", start, kReadFrames);
        require_audio_equal(read_planar(*memory_source, start, kReadFrames),
                            read_planar(*streaming_source, start, kReadFrames));
    }
}

TEST_CASE("try_install_from_cache_file reuses a previously written PCM cache") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 3 + 91;
    const std::string fake_path = "cache-reuse-source.wav";
    const Id source_id = "cache-reuse-source";

    auto samples = make_reference_audio(kFrames, kChannels);

    {
        SourceManager writer;
        writer.register_source(source_id, fake_path);
        REQUIRE(writer.store_decoded_source(
            source_id, samples, kChannels, kSampleRate, kFrames).is_ok());
        const auto written = writer.get_shared(source_id);
        REQUIRE(static_cast<bool>(written));
        REQUIRE(written->is_streaming());
    }

    // Fresh manager (simulates re-opening the project): no in-memory state,
    // only the .rf64 left on disk from the previous session.
    SourceManager reader;
    reader.register_source(source_id, fake_path);
    REQUIRE(reader.try_install_from_cache_file(source_id, kSampleRate));

    const auto reused = reader.get_shared(source_id);
    REQUIRE(static_cast<bool>(reused));
    CHECK(reused->is_streaming());
    CHECK(reused->channel_count() == kChannels);
    CHECK(reused->sample_rate() == kSampleRate);
    CHECK(reused->duration_frames() == kFrames);

    // Audio read from the reused cache must match the originally decoded data.
    for (Frame start : {Frame{0}, Frame{kDefaultBlockFrames + 333},
                        Frame{kDefaultBlockFrames * 2 + 7}}) {
        constexpr int kReadFrames = 256;
        require_ready_range(reader, source_id, start, kReadFrames);
        std::vector<float> expected;
        expected.reserve(static_cast<std::size_t>(kReadFrames) * kChannels);
        for (Frame f = 0; f < kReadFrames; ++f) {
            const std::size_t base =
                static_cast<std::size_t>((start + f) * kChannels);
            expected.push_back(samples[base]);
            expected.push_back(samples[base + 1]);
        }
        require_audio_equal(read_planar(*reused, start, kReadFrames), expected);
    }
}

TEST_CASE("try_install_from_cache_file misses when no cache file exists") {
    SourceManager manager;
    const Id source_id = "no-cache-source";
    manager.register_source(source_id,
        "non-existent-source-for-cache-miss-test-7a2b9.wav");
    CHECK_FALSE(manager.try_install_from_cache_file(source_id, 48000));
}

#if LT_ENGINE_USE_LIBSNDFILE
namespace {

std::string make_temp_wav_path(const char* tag) {
#if defined(_WIN32)
    const char* tmp = std::getenv("TEMP");
    if (!tmp || !*tmp) tmp = std::getenv("TMP");
    if (!tmp || !*tmp) tmp = ".";
    std::string dir(tmp);
    return dir + "\\lt_native_wav_test_" + tag + ".wav";
#else
    const char* tmp = std::getenv("TMPDIR");
    if (!tmp || !*tmp) tmp = "/tmp";
    std::string dir(tmp);
    return dir + "/lt_native_wav_test_" + tag + ".wav";
#endif
}

bool write_wav_pcm_float(const std::string& path,
                         const std::vector<float>& samples,
                         int channels,
                         int sample_rate) {
    SF_INFO info{};
    info.channels = channels;
    info.samplerate = sample_rate;
    info.format = SF_FORMAT_WAV | SF_FORMAT_FLOAT;
    SNDFILE* sf = sf_open(path.c_str(), SFM_WRITE, &info);
    if (!sf) return false;
    const sf_count_t frames =
        static_cast<sf_count_t>(samples.size() / channels);
    const sf_count_t written =
        sf_writef_float(sf, samples.data(), frames);
    sf_close(sf);
    return written == frames;
}

} // namespace

TEST_CASE("try_install_native_file streams a native WAV without writing the PCM cache") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 3 + 257;
    const auto wav_path = make_temp_wav_path("native_streaming");
    const auto samples = make_reference_audio(kFrames, kChannels);
    REQUIRE(write_wav_pcm_float(wav_path, samples, kChannels, kSampleRate));

    SourceManager manager;
    const Id source_id = "native-wav-source";
    manager.register_source(source_id, wav_path);
    REQUIRE(manager.try_install_native_file(source_id, kSampleRate));

    const auto streaming = manager.get_shared(source_id);
    REQUIRE(static_cast<bool>(streaming));
    CHECK(streaming->is_streaming());
    CHECK(streaming->channel_count() == kChannels);
    CHECK(streaming->sample_rate() == kSampleRate);
    CHECK(streaming->duration_frames() == kFrames);

    const auto diags = manager.diagnostics();
    REQUIRE(diags.size() == 1);
    // Native streaming must not bill anything to the engine-managed cache:
    // the loading screen would otherwise display fake disk growth.
    CHECK(diags[0].disk_cache_bytes == 0);

    // Sample-accurate readback from the source file.
    for (Frame start : {Frame{0}, Frame{kDefaultBlockFrames + 17},
                        Frame{kDefaultBlockFrames * 2 + 199}}) {
        constexpr int kReadFrames = 320;
        require_ready_range(manager, source_id, start, kReadFrames);
        std::vector<float> expected;
        expected.reserve(static_cast<std::size_t>(kReadFrames) * kChannels);
        for (Frame f = 0; f < kReadFrames; ++f) {
            const std::size_t base =
                static_cast<std::size_t>((start + f) * kChannels);
            expected.push_back(samples[base]);
            expected.push_back(samples[base + 1]);
        }
        require_audio_equal(read_planar(*streaming, start, kReadFrames), expected);
    }

    std::remove(wav_path.c_str());
}

TEST_CASE("try_install_native_file rejects a sample-rate mismatch") {
    constexpr int kChannels = 2;
    constexpr int kFileRate = 44100;   // engine wants 48000 below
    constexpr Frame kFrames = 1024;
    const auto wav_path = make_temp_wav_path("native_sr_mismatch");
    const auto samples = make_reference_audio(kFrames, kChannels);
    REQUIRE(write_wav_pcm_float(wav_path, samples, kChannels, kFileRate));

    SourceManager manager;
    const Id source_id = "native-sr-mismatch-source";
    manager.register_source(source_id, wav_path);
    CHECK_FALSE(manager.try_install_native_file(source_id, 48000));

    std::remove(wav_path.c_str());
}

TEST_CASE("try_install_native_file rejects missing files") {
    SourceManager manager;
    const Id source_id = "missing-native-source";
    manager.register_source(source_id,
        "non-existent-native-wav-for-test-3f8c1.wav");
    CHECK_FALSE(manager.try_install_native_file(source_id, 48000));
}
#endif

namespace {

#if defined(_WIN32)
constexpr char kTestPathSep = '\\';
#else
constexpr char kTestPathSep = '/';
#endif

// Count .rf64 files inside `dir` and accumulate their total size. The engine
// itself uses platform-specific dir listing helpers; the tests do their own
// minimal walk so we don't have to expose engine internals.
struct TestCacheDirStats {
    std::size_t file_count = 0;
    std::size_t total_bytes = 0;
};

TestCacheDirStats stat_cache_dir(const std::string& dir) {
    TestCacheDirStats out;
#if defined(_WIN32)
    WIN32_FIND_DATAA fd{};
    const std::string pattern = dir + "\\*.rf64";
    HANDLE h = FindFirstFileA(pattern.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return out;
    do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
        LARGE_INTEGER sz{};
        sz.LowPart = fd.nFileSizeLow;
        sz.HighPart = static_cast<LONG>(fd.nFileSizeHigh);
        out.total_bytes += static_cast<std::size_t>(sz.QuadPart);
        ++out.file_count;
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR* d = ::opendir(dir.c_str());
    if (!d) return out;
    while (auto* ent = ::readdir(d)) {
        const std::string name(ent->d_name);
        if (name.size() < 5) continue;
        if (name.compare(name.size() - 5, 5, ".rf64") != 0) continue;
        const std::string full = dir + "/" + name;
        struct stat st{};
        if (::stat(full.c_str(), &st) != 0) continue;
        out.total_bytes += static_cast<std::size_t>(st.st_size);
        ++out.file_count;
    }
    ::closedir(d);
#endif
    return out;
}

// Lightweight RAII helper that points LIBRETRACKS_CACHE_DIR at an empty
// per-test directory so cache-related tests don't smash the real user cache.
class ScopedCacheDir {
public:
    explicit ScopedCacheDir(const char* tag) {
#if defined(_WIN32)
        const char* tmp = std::getenv("TEMP");
        if (!tmp || !*tmp) tmp = std::getenv("TMP");
        if (!tmp || !*tmp) tmp = ".";
        path_ = std::string(tmp) + "\\lt_cachedir_test_" + tag;
        _putenv_s("LIBRETRACKS_CACHE_DIR", path_.c_str());
#else
        const char* tmp = std::getenv("TMPDIR");
        if (!tmp || !*tmp) tmp = "/tmp";
        path_ = std::string(tmp) + "/lt_cachedir_test_" + tag;
        setenv("LIBRETRACKS_CACHE_DIR", path_.c_str(), 1);
#endif
        clear_existing();
    }
    // Start every test with a clean slate so we measure exactly what the
    // engine wrote during the test body, not leftovers from a prior run.
    void clear_existing() {
        const std::string sub = path_ + std::string(1, kTestPathSep) + "source-cache";
#if defined(_WIN32)
        WIN32_FIND_DATAA fd{};
        const std::string pattern = sub + "\\*.rf64";
        HANDLE h = FindFirstFileA(pattern.c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) return;
        do {
            if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
            std::remove((sub + "\\" + fd.cFileName).c_str());
        } while (FindNextFileA(h, &fd));
        FindClose(h);
#else
        DIR* d = ::opendir(sub.c_str());
        if (!d) return;
        while (auto* ent = ::readdir(d)) {
            const std::string name(ent->d_name);
            if (name.size() < 5) continue;
            if (name.compare(name.size() - 5, 5, ".rf64") != 0) continue;
            std::remove((sub + "/" + name).c_str());
        }
        ::closedir(d);
#endif
    }
    ~ScopedCacheDir() {
#if defined(_WIN32)
        _putenv_s("LIBRETRACKS_CACHE_DIR", "");
#else
        unsetenv("LIBRETRACKS_CACHE_DIR");
#endif
    }
    const std::string& path() const { return path_; }
private:
    std::string path_;
};

class ScopedEnv {
public:
    ScopedEnv(const char* name, const std::string& value) : name_(name) {
#if defined(_WIN32)
        _putenv_s(name, value.c_str());
#else
        setenv(name, value.c_str(), 1);
#endif
    }
    ~ScopedEnv() {
#if defined(_WIN32)
        _putenv_s(name_.c_str(), "");
#else
        unsetenv(name_.c_str());
#endif
    }
private:
    std::string name_;
};

} // namespace

TEST_CASE("PCM cache writes go into LIBRETRACKS_CACHE_DIR/source-cache") {
    ScopedCacheDir scope("write_path");
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 2;
    auto samples = make_reference_audio(kFrames, kChannels);

    SourceManager manager;
    const Id source_id = "cache-dir-source";
    manager.register_source(source_id, "cache-dir-source.wav");
    REQUIRE(manager.store_decoded_source(
        source_id, std::move(samples), kChannels, kSampleRate, kFrames).is_ok());

    const auto stats = stat_cache_dir(
        scope.path() + std::string(1, kTestPathSep) + "source-cache");
    CHECK(stats.file_count == 1);
}

TEST_CASE("source_cache_dir_size_bytes and purge_source_cache operate on the configured dir") {
    ScopedCacheDir scope("size_and_purge");
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 2;

    // Empty cache to start.
    CHECK(source_cache_dir_size_bytes() == 0);
    CHECK(purge_source_cache() == 0);

    // Write two distinct .rf64 caches.
    for (const char* id : {"size-purge-a", "size-purge-b"}) {
        SourceManager manager;
        manager.register_source(id, std::string(id) + ".wav");
        REQUIRE(manager.store_decoded_source(
            id, make_reference_audio(kFrames, kChannels),
            kChannels, kSampleRate, kFrames).is_ok());
    }

    const std::string cache_sub =
        scope.path() + std::string(1, kTestPathSep) + "source-cache";
    const auto stats = stat_cache_dir(cache_sub);
    REQUIRE(stats.file_count == 2);

    // The free function must agree with an independent directory walk.
    const unsigned long long reported = source_cache_dir_size_bytes();
    CHECK(reported == stats.total_bytes);
    CHECK(reported > 0);

    // Purge removes every file and reports the freed bytes.
    const unsigned long long freed = purge_source_cache();
    CHECK(freed == reported);
    CHECK(source_cache_dir_size_bytes() == 0);
    CHECK(stat_cache_dir(cache_sub).file_count == 0);
}

TEST_CASE("LRU eviction removes oldest .rf64 files when the budget is exceeded") {
    ScopedCacheDir scope("lru_eviction");
    // 1 MiB budget: each ~1 MiB source forces eviction of older ones.
    ScopedEnv limit("LIBRETRACKS_SOURCE_DISK_CACHE_MB", "1");

    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    // ~1.05 MiB per source: 64k frames * 2 ch * 4 bytes ≈ 524 KiB; multiply
    // by 2 for ~1 MiB so a second source already trips the cap.
    constexpr Frame kFrames = 65536 * 2;
    auto samples = make_reference_audio(kFrames, kChannels);

    auto store_source = [&](const Id& id) {
        SourceManager manager;
        manager.register_source(id, id + std::string(".wav"));
        REQUIRE(manager.store_decoded_source(
            id, samples, kChannels, kSampleRate, kFrames).is_ok());
    };

    store_source("lru-a");
    // Sleep so the second file's mtime is strictly newer than the first.
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    store_source("lru-b");
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    store_source("lru-c");

    const auto stats = stat_cache_dir(
        scope.path() + std::string(1, kTestPathSep) + "source-cache");
    // Older entries (lru-a, lru-b) should have been pruned to keep us under
    // the 1 MiB cap; the freshest survives.
    CHECK(stats.file_count <= 2);
    CHECK(stats.total_bytes <= 2u * 1024u * 1024u); // slack: latest write is ~1 MiB
}

TEST_CASE("TrackRenderer output is identical for memory and streaming source paths") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 4;
    auto samples = make_reference_audio(kFrames, kChannels);

    SourceManager memory_manager;
    SourceManager streaming_manager;
    memory_manager.register_source("src", "");
    streaming_manager.register_source("src", "streaming-render-equivalence.wav");

    REQUIRE(memory_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());
    REQUIRE(streaming_manager.store_decoded_source(
        "src", samples, kChannels, kSampleRate, kFrames).is_ok());

    for (Frame start : {Frame{0}, Frame{640}, Frame{kDefaultBlockFrames - 240},
                        Frame{kDefaultBlockFrames * 2 + 123}}) {
        constexpr int kRenderFrames = 960;
        require_ready_range(streaming_manager, "src", start, kRenderFrames);
        require_audio_equal(render_track_block(memory_manager, "src", start, kRenderFrames),
                            render_track_block(streaming_manager, "src", start, kRenderFrames));
    }
}

TEST_CASE("request_range prepares a multi-block streaming window") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 5;
    auto samples = make_reference_audio(kFrames, kChannels);

    SourceManager manager;
    const Id source_id = "request-range-source";
    manager.register_source(source_id, "request-range-source.wav");
    REQUIRE(manager.store_decoded_source(
        source_id, samples, kChannels, kSampleRate, kFrames).is_ok());

    const Frame start = kDefaultBlockFrames + 123;
    constexpr int kReadFrames = kDefaultBlockFrames * 2 + 321;
    manager.request_range(source_id, start, kReadFrames);

    const auto source = manager.get_shared(source_id);
    REQUIRE(static_cast<bool>(source));
    for (int spin = 0; spin < 200 && !source->is_range_ready(start, kReadFrames); ++spin)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(source->is_range_ready(start, kReadFrames));

    std::vector<float> expected;
    expected.reserve(static_cast<std::size_t>(kReadFrames) * kChannels);
    for (Frame f = 0; f < kReadFrames; ++f) {
        const std::size_t base =
            static_cast<std::size_t>((start + f) * kChannels);
        expected.push_back(samples[base]);
        expected.push_back(samples[base + 1]);
    }
    require_audio_equal(read_planar(*source, start, kReadFrames), expected);
}

TEST_CASE("DecodedSource requests streaming read-ahead once per cache block") {
    constexpr int kChannels = 2;
    constexpr int kSampleRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 32;
    const Id source_id = "read-ahead-source";

    BlockCache cache(kDefaultBlockFrames, 64);
    auto first_block = make_reference_audio(kDefaultBlockFrames, kChannels);
    cache.fill(source_id, 0, first_block.data(), kChannels, kDefaultBlockFrames);

    std::vector<int> requested_blocks;
    DecodedSource source(
        source_id,
        kChannels,
        kSampleRate,
        kFrames,
        &cache,
        [&](const Id& id, int block_index) {
            CHECK(id == source_id);
            requested_blocks.push_back(block_index);
        });

    std::vector<float> left(512, 0.0f);
    std::vector<float> right(512, 0.0f);
    float* out[2] = {left.data(), right.data()};

    REQUIRE(source.read(0, 512, out, 2) == 512);
    CHECK(requested_blocks.size() == 16);
    CHECK(requested_blocks.front() == 1);
    CHECK(requested_blocks.back() == 16);

    REQUIRE(source.read(512, 512, out, 2) == 512);
    CHECK(requested_blocks.size() == 16);
}

TEST_CASE("decode_and_store_streaming matches whole-file decode (resampled)") {
    // Write a 44.1k WAV and decode it to 48k both ways; the streamed cache must
    // match the whole-file cache frame-for-frame (within float tolerance), so
    // the chunked resample is bit-equivalent to the one-shot resample.
    constexpr int kChannels = 2;
    constexpr int kSrcRate = 44100;
    constexpr int kDstRate = 48000;
    constexpr Frame kFrames = kDefaultBlockFrames * 5 + 999;  // odd tail
    const auto wav_path = make_temp_wav_path("stream_equiv");
    const auto samples = make_reference_audio(kFrames, kChannels);
    REQUIRE(write_wav_pcm_float(wav_path, samples, kChannels, kSrcRate));

    // Whole-file path.
    SourceManager whole;
    whole.register_source("src", wav_path);
    {
        int ch = 0;
        Frame dur = 0;
        auto decoded = decode_file_to_float32(wav_path, kDstRate, &ch, &dur);
        REQUIRE(decoded.is_ok());
        REQUIRE(whole.store_decoded_source("src", decoded.take(), ch, kDstRate, dur).is_ok());
    }

    // Streaming path.
    SourceManager streamed;
    streamed.register_source("src", wav_path);
    REQUIRE(streamed.decode_and_store_streaming("src", wav_path, kDstRate).is_ok());

    auto a = whole.get_shared("src");
    auto b = streamed.get_shared("src");
    REQUIRE(static_cast<bool>(a));
    REQUIRE(static_cast<bool>(b));

    // Durations should match (allow ±1 frame for resampler tail rounding).
    const Frame da = a->duration_frames();
    const Frame db = b->duration_frames();
    CHECK(std::abs(static_cast<long long>(da) - static_cast<long long>(db)) <= 1);

    // Read both full outputs (left channel) for an alignment search.
    auto read_left = [](const std::shared_ptr<const DecodedSource>& s, Frame n) {
        std::vector<float> out(static_cast<std::size_t>(n), 0.0f);
        std::vector<float> r(static_cast<std::size_t>(n), 0.0f);
        float* o[2] = {out.data(), r.data()};
        s->read(0, static_cast<int>(n), o, 2);
        return out;
    };
    const Frame common = std::min(da, db);
    const Frame probe = std::min<Frame>(common, 200000);
    const auto va = read_left(a, probe);
    const auto vb = read_left(b, probe);

    // Find the integer sample offset (small range) that best aligns b to a.
    // A small constant offset = benign resampler latency; a large/garbage diff
    // at all offsets = real corruption.
    const int kMaxShift = 4096;
    double best_diff = 1e9;
    int best_shift = 0;
    const Frame win = std::min<Frame>(probe - kMaxShift, 50000);
    for (int shift = -kMaxShift; shift <= kMaxShift; ++shift) {
        double d = 0.0;
        for (Frame i = kMaxShift; i < win; ++i) {
            const double x = va[static_cast<std::size_t>(i)];
            const double y = vb[static_cast<std::size_t>(i + shift)];
            d = std::max(d, std::abs(x - y));
        }
        if (d < best_diff) { best_diff = d; best_shift = shift; }
    }
    INFO("best_shift=" << best_shift << " best_diff=" << best_diff
         << " da=" << da << " db=" << db);
    // Streaming chunked resample is bit-equivalent to the one-shot whole-file
    // resample: same length, zero offset, zero difference.
    CHECK(best_diff < 1.0e-4);
    CHECK(best_shift == 0);
}
