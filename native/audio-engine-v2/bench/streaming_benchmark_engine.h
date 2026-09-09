#pragma once
#include <lt_engine/engine_impl.h>
#include <stdexcept>

namespace lt {
// Benchmark-only wiring. Never initialize/open a hardware device. Commands
// execute the existing EngineImpl visitor, including its source gate, voice
// preparation, prefetch and crossfade. Render is paced by the benchmark.
class StreamingBenchmarkEngine {
public:
    StreamingBenchmarkEngine() {
        engine_.source_manager_ = std::make_unique<SourceManager>();
    }
    SourceManager& sources() { return *engine_.source_manager_; }
    TransportClock& clock() { return *engine_.clock_; }
    Mixer& mixer() { return *engine_.mixer_; }
    BungeeVoiceManagerDiagnostics voice_diagnostics() const { return engine_.bungee_voices_->diagnostics(); }
    void prepare(std::shared_ptr<const Session> session, int block) {
        // Unopened JUCE device reports 0; fallback reports 512. Both produce
        // the production 4096-frame live gate for the 128/512 cases measured.
        const int device_block = engine_.device_manager_->actual_buffer_size();
        if (block > 512 || device_block > 512)
            throw std::runtime_error("Headless command bench supports buffers up to 512 only");
        engine_.session_ = std::move(session);
        engine_.clock_ = std::make_unique<TransportClock>(48000);
        engine_.scheduler_ = std::make_unique<JumpScheduler>();
        engine_.bungee_voices_ = std::make_unique<BungeeVoiceManager>();
        if (!engine_.bungee_voices_->prepare(48000, 2, block * 4))
            throw std::runtime_error("Command benchmark requires Bungee");
        engine_.bungee_voices_->rebuild_for_session(*engine_.session_, sources(), 0);
        engine_.mixer_ = std::make_unique<Mixer>(engine_.session_, &sources(),
            engine_.clock_.get(), engine_.scheduler_.get());
        mixer().set_bungee_voice_manager(engine_.bungee_voices_.get());
        mixer().prepare_render_resources(block);
        engine_.state_ = EngineImpl::State::Initialized;
    }
    void seek(Frame target) { command(CmdSeekAbsolute{target}); }
    // Play/Pause are pure clock transitions in EngineImpl, so a bench can use
    // the real handlers without a device. The application always sends
    // SeekAbsolute(position) before Play; benches that model start or resume
    // must do the same or they exercise a path the app never takes.
    void play() { command(CmdPlay{}); }
    void pause() { command(CmdPause{}); }
    Frame position() const { return engine_.clock_->position().frame; }
    void command(const EngineCommand& cmd) {
        const auto result = engine_.dispatch_command(cmd);
        if (result.is_err()) throw std::runtime_error(result.error());
    }
private:
    EngineImpl engine_;
};
} // namespace lt
