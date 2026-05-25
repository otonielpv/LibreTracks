// bench_bungee_warp_backends.cpp
//
// Re-evaluates Bungee Basic as a warp/time-stretch backend using the upstream
// Bungee::Stream API. This intentionally avoids the LibreTracks Bungee pitch
// wrapper because that wrapper is tuned for pitch-at-speed-1 and can obscure
// whether Bungee's own streaming integration works for tempo changes.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

#include <lt_engine/pitch/rubberband_warp_voice.h>

#include <bungee/Bungee.h>
#include <bungee/Stream.h>

namespace {

constexpr int kSampleRate = 48000;
constexpr int kBlockFrames = 512;
constexpr int kSeconds = 18;
constexpr int kChannels = 2;

struct Stereo {
    int sample_rate = kSampleRate;
    std::vector<float> l;
    std::vector<float> r;
};

struct Metrics {
    std::string name;
    double ratio = 1.0;
    double pitch = 1.0;
    int hop = 0;
    int voices = 1;
    double avg_us = 0.0;
    double p95_us = 0.0;
    double max_us = 0.0;
    double latency_ms = 0.0;
    double rms = 0.0;
    double peak = 0.0;
    double worst_step = 0.0;
    double silent_pct = 0.0;
    std::filesystem::path wav;
};

float clamp_sample(float v) {
    return std::max(-1.0f, std::min(1.0f, v));
}

Stereo make_fixture() {
    const int frames = kSampleRate * kSeconds;
    Stereo s;
    s.sample_rate = kSampleRate;
    s.l.assign(static_cast<std::size_t>(frames), 0.0f);
    s.r.assign(static_cast<std::size_t>(frames), 0.0f);

    auto env = [](double t, double start, double attack, double decay) {
        if (t < start) return 0.0;
        const double x = t - start;
        if (x < attack) return x / std::max(attack, 1e-6);
        return std::exp(-(x - attack) / decay);
    };

    for (int i = 0; i < frames; ++i) {
        const double t = static_cast<double>(i) / kSampleRate;
        const double bar = std::fmod(t, 2.0);
        const double beat = std::fmod(t, 0.5);

        double chord = 0.0;
        const double freqs[] = { 110.0, 164.8138, 220.0, 329.6276, 440.0 };
        for (double f : freqs) {
            chord += 0.08 * std::sin(2.0 * 3.14159265358979323846 * f * t);
        }
        chord *= 0.75 + 0.25 * std::sin(2.0 * 3.14159265358979323846 * 0.18 * t);

        double kick = env(bar, 0.0, 0.004, 0.09)
            * std::sin(2.0 * 3.14159265358979323846 * (55.0 + 30.0 * std::exp(-bar * 25.0)) * t);
        double snare = env(bar, 1.0, 0.002, 0.055)
            * (std::sin(2.0 * 3.14159265358979323846 * 190.0 * t)
               + 0.35 * std::sin(2.0 * 3.14159265358979323846 * 1117.0 * t));
        double hat = env(beat, 0.0, 0.001, 0.025)
            * std::sin(2.0 * 3.14159265358979323846 * 7800.0 * t);

        const double left = chord + 0.42 * kick + 0.18 * snare + 0.07 * hat;
        const double right = 0.96 * chord + 0.36 * kick + 0.22 * snare - 0.05 * hat;
        s.l[static_cast<std::size_t>(i)] = clamp_sample(static_cast<float>(left));
        s.r[static_cast<std::size_t>(i)] = clamp_sample(static_cast<float>(right));
    }
    return s;
}

std::uint16_t read_u16_le(const unsigned char* p) {
    return static_cast<std::uint16_t>(p[0])
        | (static_cast<std::uint16_t>(p[1]) << 8);
}

std::uint32_t read_u32_le(const unsigned char* p) {
    return static_cast<std::uint32_t>(p[0])
        | (static_cast<std::uint32_t>(p[1]) << 8)
        | (static_cast<std::uint32_t>(p[2]) << 16)
        | (static_cast<std::uint32_t>(p[3]) << 24);
}

float read_wav_sample(const unsigned char* p,
                      std::uint16_t format,
                      std::uint16_t bits) {
    if (format == 3 && bits == 32) {
        float v = 0.0f;
        std::memcpy(&v, p, sizeof(v));
        return std::isfinite(v) ? clamp_sample(v) : 0.0f;
    }

    if (format != 1) return 0.0f;
    if (bits == 16) {
        const auto v = static_cast<std::int16_t>(read_u16_le(p));
        return static_cast<float>(v) / 32768.0f;
    }
    if (bits == 24) {
        std::int32_t v = static_cast<std::int32_t>(p[0])
            | (static_cast<std::int32_t>(p[1]) << 8)
            | (static_cast<std::int32_t>(p[2]) << 16);
        if (v & 0x00800000) v |= ~0x00ffffff;
        return static_cast<float>(v) / 8388608.0f;
    }
    if (bits == 32) {
        const auto v = static_cast<std::int32_t>(read_u32_le(p));
        return static_cast<float>(static_cast<double>(v) / 2147483648.0);
    }
    return 0.0f;
}

bool load_wav(const std::filesystem::path& path, Stereo& s) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;

    unsigned char header[12] = {};
    in.read(reinterpret_cast<char*>(header), sizeof(header));
    if (in.gcount() != static_cast<std::streamsize>(sizeof(header))
        || std::memcmp(header, "RIFF", 4) != 0
        || std::memcmp(header + 8, "WAVE", 4) != 0) {
        return false;
    }

    std::uint16_t format = 0;
    std::uint16_t channels = 0;
    std::uint16_t bits = 0;
    std::uint32_t sample_rate = 0;
    std::vector<unsigned char> data;

    while (in) {
        unsigned char chunk[8] = {};
        in.read(reinterpret_cast<char*>(chunk), sizeof(chunk));
        if (in.gcount() != static_cast<std::streamsize>(sizeof(chunk))) break;
        const std::uint32_t size = read_u32_le(chunk + 4);
        std::vector<unsigned char> payload(size);
        if (size > 0)
            in.read(reinterpret_cast<char*>(payload.data()), size);
        if (!in) break;
        if ((size & 1u) != 0u)
            in.ignore(1);

        if (std::memcmp(chunk, "fmt ", 4) == 0 && size >= 16) {
            format = read_u16_le(payload.data());
            channels = read_u16_le(payload.data() + 2);
            sample_rate = read_u32_le(payload.data() + 4);
            bits = read_u16_le(payload.data() + 14);
            if (format == 0xfffe && size >= 40) {
                format = read_u16_le(payload.data() + 24);
            }
        } else if (std::memcmp(chunk, "data", 4) == 0) {
            data = std::move(payload);
        }
    }

    if (channels == 0 || sample_rate == 0 || data.empty()) return false;
    if (!((format == 1 && (bits == 16 || bits == 24 || bits == 32))
        || (format == 3 && bits == 32))) {
        return false;
    }

    const std::uint16_t bytes_per_sample = static_cast<std::uint16_t>(bits / 8);
    const std::uint32_t frame_bytes = channels * bytes_per_sample;
    if (frame_bytes == 0) return false;
    const std::size_t available_frames = data.size() / frame_bytes;
    const std::size_t max_frames = static_cast<std::size_t>(sample_rate) * kSeconds;
    const std::size_t frames = std::min(available_frames, max_frames);

    s = Stereo{};
    s.sample_rate = static_cast<int>(sample_rate);
    s.l.assign(frames, 0.0f);
    s.r.assign(frames, 0.0f);
    for (std::size_t i = 0; i < frames; ++i) {
        const unsigned char* frame = data.data() + i * frame_bytes;
        s.l[i] = read_wav_sample(frame, format, bits);
        const unsigned char* right = frame + (channels > 1 ? bytes_per_sample : 0);
        s.r[i] = read_wav_sample(right, format, bits);
    }
    return true;
}

bool load_first_sample_wav(Stereo& s, std::filesystem::path& path) {
    const std::filesystem::path sample_dir = "samples";
    if (!std::filesystem::exists(sample_dir)) return false;

    try {
        for (const auto& entry : std::filesystem::recursive_directory_iterator(sample_dir)) {
            if (!entry.is_regular_file()) continue;
            auto ext = entry.path().extension().string();
            std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) {
                return static_cast<char>(std::tolower(c));
            });
            if (ext != ".wav") continue;
            Stereo loaded;
            if (load_wav(entry.path(), loaded)) {
                s = std::move(loaded);
                path = entry.path();
                return true;
            }
        }
    } catch (const std::filesystem::filesystem_error&) {
        return false;
    }
    return false;
}

std::string sanitize_path_part(std::string value) {
    for (char& c : value) {
        const bool ok = (c >= 'a' && c <= 'z')
            || (c >= 'A' && c <= 'Z')
            || (c >= '0' && c <= '9')
            || c == '-' || c == '_';
        if (!ok) c = '_';
    }
    return value.empty() ? "sample" : value;
}

bool write_wav_float32(const std::filesystem::path& path, const Stereo& s) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    if (!out) return false;
    const std::uint32_t frames =
        static_cast<std::uint32_t>(std::min(s.l.size(), s.r.size()));
    const std::uint16_t channels = 2;
    const std::uint16_t bits = 32;
    const std::uint32_t byte_rate = static_cast<std::uint32_t>(s.sample_rate) * channels * (bits / 8);
    const std::uint16_t block_align = channels * (bits / 8);
    const std::uint32_t data_bytes = frames * block_align;
    const std::uint32_t riff_size = 36 + data_bytes;

    auto put_u16 = [&](std::uint16_t v) {
        out.put(static_cast<char>(v & 0xff));
        out.put(static_cast<char>((v >> 8) & 0xff));
    };
    auto put_u32 = [&](std::uint32_t v) {
        out.put(static_cast<char>(v & 0xff));
        out.put(static_cast<char>((v >> 8) & 0xff));
        out.put(static_cast<char>((v >> 16) & 0xff));
        out.put(static_cast<char>((v >> 24) & 0xff));
    };

    out.write("RIFF", 4); put_u32(riff_size); out.write("WAVE", 4);
    out.write("fmt ", 4); put_u32(16); put_u16(3); put_u16(channels);
    put_u32(static_cast<std::uint32_t>(s.sample_rate)); put_u32(byte_rate); put_u16(block_align); put_u16(bits);
    out.write("data", 4); put_u32(data_bytes);
    for (std::uint32_t i = 0; i < frames; ++i) {
        const float l = std::isfinite(s.l[i]) ? s.l[i] : 0.0f;
        const float r = std::isfinite(s.r[i]) ? s.r[i] : 0.0f;
        out.write(reinterpret_cast<const char*>(&l), sizeof(l));
        out.write(reinterpret_cast<const char*>(&r), sizeof(r));
    }
    return true;
}

void analyse_audio(Metrics& m, const Stereo& s) {
    const std::size_t n = std::min(s.l.size(), s.r.size());
    double sum_sq = 0.0;
    std::size_t silent = 0;
    float prev = 0.0f;
    bool have_prev = false;
    for (std::size_t i = 0; i < n; ++i) {
        const float mono = 0.5f * (s.l[i] + s.r[i]);
        if (!std::isfinite(mono)) continue;
        sum_sq += static_cast<double>(mono) * mono;
        m.peak = std::max(m.peak, static_cast<double>(std::abs(mono)));
        if (std::abs(mono) < 1e-5f) ++silent;
        if (have_prev)
            m.worst_step = std::max(m.worst_step, static_cast<double>(std::abs(mono - prev)));
        prev = mono;
        have_prev = true;
    }
    m.rms = std::sqrt(sum_sq / std::max<std::size_t>(1, n));
    m.silent_pct = 100.0 * static_cast<double>(silent) / std::max<std::size_t>(1, n);
}

void analyse_times(Metrics& m, std::vector<double> times) {
    if (times.empty()) return;
    std::sort(times.begin(), times.end());
    m.avg_us = std::accumulate(times.begin(), times.end(), 0.0) / times.size();
    m.p95_us = times[static_cast<std::size_t>(0.95 * static_cast<double>(times.size() - 1))];
    m.max_us = times.back();
}

Stereo read_window(const Stereo& src, long long cursor, int frames) {
    Stereo w;
    w.sample_rate = src.sample_rate;
    w.l.assign(static_cast<std::size_t>(frames), 0.0f);
    w.r.assign(static_cast<std::size_t>(frames), 0.0f);
    const long long total = static_cast<long long>(std::min(src.l.size(), src.r.size()));
    for (int i = 0; i < frames; ++i) {
        const long long p = cursor + i;
        if (p >= 0 && p < total) {
            w.l[static_cast<std::size_t>(i)] = src.l[static_cast<std::size_t>(p)];
            w.r[static_cast<std::size_t>(i)] = src.r[static_cast<std::size_t>(p)];
        }
    }
    return w;
}

Metrics run_bungee_stream(const Stereo& src,
                          double ratio,
                          double pitch,
                          int hop,
                          int voices,
                          const std::filesystem::path& out_dir) {
    using Edition = Bungee::Basic;
    using Stretcher = Bungee::Stretcher<Edition>;
    using Stream = Bungee::Stream<Edition>;

    const int input_per_block = static_cast<int>(
        std::ceil(static_cast<double>(kBlockFrames) * ratio));
    const int max_input = std::max(input_per_block, kBlockFrames) + 16;
    Bungee::SampleRates rates{src.sample_rate, src.sample_rate};

    struct Voice {
        std::unique_ptr<Stretcher> stretcher;
        std::unique_ptr<Stream> stream;
        long long cursor = 0;
    };
    std::vector<Voice> state(static_cast<std::size_t>(voices));
    for (auto& v : state) {
        v.stretcher = std::make_unique<Stretcher>(rates, kChannels, hop);
        v.stream = std::make_unique<Stream>(*v.stretcher, max_input, kChannels);
    }

    Stereo out;
    out.l.reserve(src.l.size());
    out.r.reserve(src.r.size());
    std::vector<float> mix_l(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<float> mix_r(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<float> tmp_l(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<float> tmp_r(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<double> times;

    const int blocks = static_cast<int>(src.l.size() / input_per_block) - 4;
    for (int b = 0; b < std::max(0, blocks); ++b) {
        std::fill(mix_l.begin(), mix_l.end(), 0.0f);
        std::fill(mix_r.begin(), mix_r.end(), 0.0f);
        const auto t0 = std::chrono::steady_clock::now();
        for (auto& v : state) {
            const Stereo in = read_window(src, v.cursor, input_per_block);
            const float* in_ptrs[2] = { in.l.data(), in.r.data() };
            float* out_ptrs[2] = { tmp_l.data(), tmp_r.data() };
            const int produced = v.stream->process(
                in_ptrs, out_ptrs, input_per_block,
                static_cast<double>(kBlockFrames), pitch);
            v.cursor += input_per_block;
            for (int i = 0; i < kBlockFrames; ++i) {
                const float scale = 1.0f / static_cast<float>(voices);
                mix_l[static_cast<std::size_t>(i)] +=
                    (i < produced ? tmp_l[static_cast<std::size_t>(i)] : 0.0f) * scale;
                mix_r[static_cast<std::size_t>(i)] +=
                    (i < produced ? tmp_r[static_cast<std::size_t>(i)] : 0.0f) * scale;
            }
        }
        const auto us = std::chrono::duration<double, std::micro>(
            std::chrono::steady_clock::now() - t0).count();
        if (b > 12) times.push_back(us);
        out.l.insert(out.l.end(), mix_l.begin(), mix_l.end());
        out.r.insert(out.r.end(), mix_r.begin(), mix_r.end());
    }

    Metrics m;
    m.name = "bungee_stream";
    m.ratio = ratio;
    m.pitch = pitch;
    m.hop = hop;
    m.voices = voices;
    if (!state.empty() && state[0].stream)
        m.latency_ms = 1000.0 * state[0].stream->latency() / src.sample_rate;
    analyse_times(m, std::move(times));
    analyse_audio(m, out);
    m.wav = out_dir / ("bungee_stream_hop" + std::to_string(hop)
        + "_voices" + std::to_string(voices)
        + "_ratio" + std::to_string(static_cast<int>(ratio * 1000.0))
        + ".wav");
    write_wav_float32(m.wav, out);
    return m;
}

Metrics run_rubberband_r2(const Stereo& src,
                          double ratio,
                          int voices,
                          const std::filesystem::path& out_dir) {
    const int input_per_block = static_cast<int>(
        std::ceil(static_cast<double>(kBlockFrames) * ratio));
    const int max_input = std::max(input_per_block, kBlockFrames) + 16;

    std::vector<lt::RubberBandWarpVoice> state(static_cast<std::size_t>(voices));
    for (auto& v : state) {
        v.configure(src.sample_rate, kChannels, max_input);
        v.reset_source_cursor(0);
    }

    Stereo out;
    out.l.reserve(src.l.size());
    out.r.reserve(src.r.size());
    std::vector<float> mix_l(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<float> mix_r(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<float> tmp_l(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<float> tmp_r(static_cast<std::size_t>(kBlockFrames), 0.0f);
    std::vector<double> times;

    const int blocks = static_cast<int>(src.l.size() / input_per_block) - 4;
    for (int b = 0; b < std::max(0, blocks); ++b) {
        std::fill(mix_l.begin(), mix_l.end(), 0.0f);
        std::fill(mix_r.begin(), mix_r.end(), 0.0f);
        const auto t0 = std::chrono::steady_clock::now();
        for (auto& v : state) {
            const Stereo in = read_window(src, v.source_cursor(), input_per_block);
            const float* in_ptrs[2] = { in.l.data(), in.r.data() };
            float* out_ptrs[2] = { tmp_l.data(), tmp_r.data() };
            const int produced = v.render_block(
                in_ptrs, input_per_block, out_ptrs, kBlockFrames, ratio);
            for (int i = 0; i < kBlockFrames; ++i) {
                const float scale = 1.0f / static_cast<float>(voices);
                mix_l[static_cast<std::size_t>(i)] +=
                    (i < produced ? tmp_l[static_cast<std::size_t>(i)] : 0.0f) * scale;
                mix_r[static_cast<std::size_t>(i)] +=
                    (i < produced ? tmp_r[static_cast<std::size_t>(i)] : 0.0f) * scale;
            }
        }
        const auto us = std::chrono::duration<double, std::micro>(
            std::chrono::steady_clock::now() - t0).count();
        if (b > 12) times.push_back(us);
        out.l.insert(out.l.end(), mix_l.begin(), mix_l.end());
        out.r.insert(out.r.end(), mix_r.begin(), mix_r.end());
    }

    Metrics m;
    m.name = "rubberband_r2";
    m.ratio = ratio;
    m.pitch = 1.0;
    m.hop = 0;
    m.voices = voices;
    m.latency_ms = state.empty() ? 0.0
        : 1000.0 * static_cast<double>(state[0].output_latency_frames()) / src.sample_rate;
    analyse_times(m, std::move(times));
    analyse_audio(m, out);
    m.wav = out_dir / ("rubberband_r2_voices" + std::to_string(voices)
        + "_ratio" + std::to_string(static_cast<int>(ratio * 1000.0))
        + ".wav");
    write_wav_float32(m.wav, out);
    return m;
}

void print_row(const Metrics& m) {
    std::cout
        << std::left << std::setw(16) << m.name
        << " hop=" << std::setw(3) << m.hop
        << " voices=" << std::setw(2) << m.voices
        << " ratio=" << std::fixed << std::setprecision(3) << m.ratio
        << " avg_us=" << std::setw(8) << std::setprecision(1) << m.avg_us
        << " p95_us=" << std::setw(8) << m.p95_us
        << " max_us=" << std::setw(8) << m.max_us
        << " lat_ms=" << std::setw(7) << std::setprecision(2) << m.latency_ms
        << " rms=" << std::setw(7) << std::setprecision(4) << m.rms
        << " peak=" << std::setw(7) << m.peak
        << " step=" << std::setw(7) << m.worst_step
        << " silent=" << std::setw(6) << std::setprecision(2) << m.silent_pct << "%"
        << " wav=" << m.wav.string()
        << "\n";
}

} // namespace

int main() {
    Stereo input;
    std::filesystem::path input_path;
    const bool using_sample = load_first_sample_wav(input, input_path);
    if (!using_sample) {
        input = make_fixture();
        input_path = "synthetic_fixture";
    }

    const auto out_dir = std::filesystem::absolute(
        using_sample
            ? std::filesystem::path("bench-out/warp-bungee-samples")
                / sanitize_path_part(input_path.stem().string())
            : std::filesystem::path("bench-out/warp-bungee"));
    write_wav_float32(out_dir / (using_sample ? "input_sample.wav" : "input_fixture.wav"), input);

    std::vector<Metrics> rows;
    const double ratios[] = { 1.05, 1.10, 1.213333 };
    const int hops[] = { -1, 0, 1 };
    for (double ratio : ratios) {
        for (int hop : hops) {
            rows.push_back(run_bungee_stream(input, ratio, 1.0, hop, 1, out_dir));
            rows.push_back(run_bungee_stream(input, ratio, 1.0, hop, 3, out_dir));
        }
        rows.push_back(run_rubberband_r2(input, ratio, 1, out_dir));
        rows.push_back(run_rubberband_r2(input, ratio, 3, out_dir));
    }

    std::cout << "LibreTracks Bungee warp backend bench\n";
    std::cout << "Input audio: " << input_path.string()
              << " (" << input.sample_rate << " Hz, "
              << std::min(input.l.size(), input.r.size()) << " frames)\n";
    std::cout << "Output WAVs: " << out_dir.string() << "\n";
    std::cout << "512-frame callback budget: " << std::fixed << std::setprecision(1)
              << (1000000.0 * static_cast<double>(kBlockFrames) / input.sample_rate)
              << " us\n";
    for (const auto& m : rows)
        print_row(m);
    return 0;
}
