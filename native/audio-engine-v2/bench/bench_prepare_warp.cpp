// Experimental per-track preparation, outside the production engine/UI.
// Uses the same TrackRenderer/Bungee path, before mixer gain/pan/mute/FX.
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/pitch/bungee_voice_manager.h>
#include <lt_engine/sources/audio_decoder.h>
#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#if defined(_WIN32)
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif

using namespace lt;
using Clock = std::chrono::steady_clock;
constexpr int sr = 48000;

static std::uint64_t peak_rss() {
#if defined(_WIN32)
    PROCESS_MEMORY_COUNTERS m{};
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &m, sizeof(m))) throw std::runtime_error("RSS unavailable");
    return m.PeakWorkingSetSize;
#else
    rusage r{};
    if (getrusage(RUSAGE_SELF, &r)) throw std::runtime_error("RSS unavailable");
#if defined(__APPLE__)
    return r.ru_maxrss;
#else
    return static_cast<std::uint64_t>(r.ru_maxrss) * 1024;
#endif
#endif
}

class Pass {
public:
    Pass(const std::string& path, int block, Frame frames, double ratio, int semitones)
        : block_(block), ratio_(ratio), left(block), right(block) {
        sources.register_source("source", path);
        if (!sources.try_install_native_file("source", sr)) throw std::runtime_error("Native source unavailable");
        source_ = sources.get_shared("source");
        if (source_->channel_count() != 2 || source_->duration_frames() < std::ceil(frames * ratio) + sr)
            throw std::runtime_error("Source must be stereo with sufficient warp lookahead");
        Song song;
        song.id = "song"; song.end_frame = frames; song.bpm = 120;
        Region region;
        region.id = "region"; region.end_frame = frames;
        region.warp_enabled = true; region.warp_source_bpm = 120 / ratio;
        region.transpose_semitones = static_cast<Semitones>(semitones);
        song.regions.push_back(region);
        Track track;
        track.id = "track";
        track.transpose_behavior = TransposeBehavior::FollowsSongOrRegion;
        track.clips.push_back(Clip{"clip", "source", 0, 0, frames, 1.0f});
        song.tracks.push_back(track);
        session.sample_rate = sr;
        session.songs.push_back(song);
        ready(0);
        if (!voices.prepare(sr, 2, block * 4)) throw std::runtime_error("Bungee unavailable");
        voices.rebuild_for_session(session, sources, 0);
        if (voices.diagnostics().active_voice_count != 1) throw std::runtime_error("Expected one Bungee voice");
        renderer.prepare(block);
        if (sources.total_cache_miss_frames()) throw std::runtime_error("Starvation during priming");
    }
    void render(Frame frame) {
        ready(frame);
        std::fill(left.begin(), left.end(), 0.f);
        std::fill(right.begin(), right.end(), 0.f);
        float* out[] = {left.data(), right.data()};
        const auto& song = session.songs.front();
        renderer.render(song.tracks.front(), frame, block_, out, 2, sources, &voices, sr, 0, &song, false, 1.0f);
        if (sources.total_cache_miss_frames()) throw std::runtime_error("Offline render read uncached audio");
    }
    std::vector<float> left, right;
private:
    void ready(Frame timeline) {
        const Frame start = std::max<Frame>(0, static_cast<Frame>(timeline * ratio_) - sr);
        const Frame end = std::min<Frame>(source_->duration_frames(), static_cast<Frame>(std::ceil((timeline + block_) * ratio_)) + sr);
        const int length = static_cast<int>(end - start);
        sources.request_range("source", start, length, true);
        const auto deadline = Clock::now() + std::chrono::seconds(10);
        while (!source_->is_range_ready(start, length)) {
            if (Clock::now() > deadline) throw std::runtime_error("Offline prefetch timeout");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
    int block_;
    double ratio_;
    SourceManager sources;
    std::shared_ptr<const DecodedSource> source_;
    Session session;
    BungeeVoiceManager voices;
    TrackRenderer renderer;
};

static void le32(std::ostream& out, std::uint32_t value) {
    const char bytes[] = {char(value), char(value >> 8), char(value >> 16), char(value >> 24)};
    out.write(bytes, 4);
}
static double ms(Clock::time_point begin) { return std::chrono::duration<double, std::milli>(Clock::now()-begin).count(); }

int main(int argc, char** argv) try {
    if (argc != 8) throw std::runtime_error("Usage: bench_prepare_warp INPUT_DIR NEW_OUTPUT_DIR TRACKS BLOCK SECONDS RATIO SEMITONES");
    const int tracks=std::stoi(argv[3]), block=std::stoi(argv[4]), seconds=std::stoi(argv[5]), semitones=std::stoi(argv[7]);
    const double ratio=std::stod(argv[6]);
    const Frame frames=Frame(seconds)*sr;
    if (tracks<1 || tracks>64 || (block!=128 && block!=512) || seconds<1 || seconds>600
        || frames%block || !std::isfinite(ratio) || ratio<.5 || ratio>2 || semitones<-12 || semitones>12)
        throw std::runtime_error("Invalid preparation configuration");
    const std::filesystem::path output(argv[2]);
    if (!std::filesystem::create_directory(output)) throw std::runtime_error("Output directory must be new");
    double prepare_ms=0, verify_ms=0, energy=0;
    std::uint64_t samples_verified=0;
    for (int i=0;i<tracks;++i) {
        const auto name=std::to_string(i)+".wav";
        const auto input=(std::filesystem::path(argv[1])/name).string();
        const auto path=(output/name).string();
        auto began=Clock::now();
        {
            Pass pass(input,block,frames,ratio,semitones);
            std::ofstream wav(path,std::ios::binary);
            wav.write("RIFF",4); le32(wav,36+static_cast<std::uint32_t>(frames*8));
            wav.write("WAVEfmt ",8); le32(wav,16);
            le32(wav,0x00020003); // IEEE float, stereo (two little-endian uint16s).
            le32(wav,sr); le32(wav,sr*8); le32(wav,0x00200008); // block align 8, bits 32.
            wav.write("data",4); le32(wav,static_cast<std::uint32_t>(frames*8));
            std::vector<char> bytes(static_cast<std::size_t>(block)*8);
            for (Frame f=0;f<frames;f+=block) {
                pass.render(f);
                for (int k=0;k<block;++k) for(int ch=0;ch<2;++ch) {
                    const float v=ch ? pass.right[k] : pass.left[k];
                    if (!std::isfinite(v)) throw std::runtime_error("Non-finite prepared audio");
                    energy+=double(v)*v;
                    const auto bits=std::bit_cast<std::uint32_t>(v);
                    const auto offset=static_cast<std::size_t>(k*2+ch)*4;
                    for(int b=0;b<4;++b) bytes[offset+b]=static_cast<char>(bits>>(b*8));
                }
                wav.write(bytes.data(),bytes.size());
            }
            wav.close();
            if (!wav) throw std::runtime_error("Prepared WAV write failed");
        }
        prepare_ms+=ms(began);
        began=Clock::now();
        {
            // A fresh voice pass verifies sample identity after disk roundtrip.
            Pass reference(input,block,frames,ratio,semitones);
            auto decoder=make_decoder(path);
            if (!decoder || decoder->open(path).is_err() || decoder->info().duration_frames!=frames)
                throw std::runtime_error("Prepared file cannot be decoded at expected length");
            std::vector<float> samples(block*2);
            for(Frame f=0;f<frames;f+=block) {
                reference.render(f);
                if(decoder->read_frames(samples.data(),block)!=block) throw std::runtime_error("Prepared file truncated");
                for(int k=0;k<block;++k) for(int ch=0;ch<2;++ch) {
                    const float expected=ch ? reference.right[k] : reference.left[k];
                    if(std::bit_cast<std::uint32_t>(expected)!=std::bit_cast<std::uint32_t>(samples[k*2+ch]))
                        throw std::runtime_error("Prepared audio differs from fresh continuous DSP");
                    ++samples_verified;
                }
            }
        }
        verify_ms+=ms(began);
        std::cout << "prepared_and_verified=" << i+1 << '\n';
    }
    if(energy<=0) throw std::runtime_error("Prepared audio is silent");
    std::ofstream stats(output/"preparation.json");
    stats << "{\"tracks\":" << tracks << ",\"block\":" << block << ",\"seconds\":" << seconds
          << ",\"ratio\":" << ratio << ",\"semitones\":" << semitones
          << ",\"prepare_ms\":" << prepare_ms << ",\"verify_ms\":" << verify_ms
          << ",\"peak_rss_bytes\":" << peak_rss()
          << ",\"output_bytes\":" << tracks*(44+frames*8)
          << ",\"samples_verified\":" << samples_verified << ",\"energy\":" << energy << "}\n";
    stats.close();
    if(!stats) throw std::runtime_error("Stats write failed");
    return 0;
} catch(const std::exception& e) { std::cerr << e.what() << '\n'; return 2; }
