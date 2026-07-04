// ---------------------------------------------------------------------------
// AudioDeviceManager — Oboe (AAudio) backend for Android.
//
// Mirrors the JUCE backend's contract exactly (see audio_device_manager.cpp):
// open_device() opens AND starts the stream; the engine only ever calls
// open_device()/close_device(). Android has no user-facing device list — the
// OS routes the default output (speaker/headphones/BT) itself — so
// list_devices() reports a single virtual "system output" descriptor.
//
// The render layer expects PLANAR float channels; Oboe delivers an
// INTERLEAVED buffer. The adaptor renders into pre-allocated planar buffers
// (sized at construction — never on the audio thread) and interleaves into
// the stream buffer, chunking if the device ever asks for more frames than
// the planar capacity.
// ---------------------------------------------------------------------------

#include <lt_engine/devices/audio_device_manager.h>

#if LT_ENGINE_USE_OBOE

#include <oboe/Oboe.h>

#include <lt_engine/debug/logging.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <exception>
#include <memory>
#include <string>
#include <vector>

namespace lt {

namespace {

constexpr int kOutputChannels = 2;

// Soft clip at the device boundary. Windows' shared-mode audio engine runs a
// limiter after the app, so hot master sums (two full-scale tracks at 100%)
// never reach the DAC above full scale on desktop — but AAudio has no such
// stage and hard-clips anything past ±1.0, which is exactly the harsh
// crackle reported on peaks. Transparent below the knee (-3 dBFS); above it,
// a tanh bend that never exceeds ±1. Audio-thread safe (pure math).
inline float soft_clip(float sample) noexcept {
    constexpr float kKnee = 0.7f;
    const float magnitude = std::fabs(sample);
    if (magnitude <= kKnee)
        return sample;
    const float bent =
        kKnee + (1.0f - kKnee) * std::tanh((magnitude - kKnee) / (1.0f - kKnee));
    return sample < 0.0f ? -bent : bent;
}
// Planar scratch capacity per channel. AAudio bursts are typically 96-1920
// frames; anything larger is handled by chunking the render loop.
constexpr int kMaxRenderChunkFrames = 8192;

constexpr const char* kDeviceName = "Salida de audio del sistema (AAudio)";
constexpr const char* kBackend    = "oboe";

} // namespace

// ---------------------------------------------------------------------------
// Callback adaptor — bridges AudioRenderCallback to oboe's data callback.
// Same diagnostics contract as JuceCallbackAdaptor: EMA of callback duration,
// read-and-reset gap/work maxima, error flag from the stream error callback.
// ---------------------------------------------------------------------------
class OboeCallbackAdaptor : public oboe::AudioStreamDataCallback,
                            public oboe::AudioStreamErrorCallback {
public:
    explicit OboeCallbackAdaptor(AudioRenderCallback* cb) : render_cb_(cb) {
        for (auto& channel : planar_)
            channel.assign(static_cast<size_t>(kMaxRenderChunkFrames), 0.f);
        channel_ptrs_[0] = planar_[0].data();
        channel_ptrs_[1] = planar_[1].data();
    }

    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream,
                                          void*              audio_data,
                                          int32_t            num_frames) override {
        // ── Realtime rules: no alloc, no lock, no I/O ──────────────────
        auto t0 = std::chrono::steady_clock::now();

        if (last_callback_end_.time_since_epoch().count() != 0) {
            const double gap_ms =
                std::chrono::duration<double, std::milli>(t0 - last_callback_end_).count();
            double gmax = gap_max_ms_.load(std::memory_order_relaxed);
            while (gap_ms > gmax
                   && !gap_max_ms_.compare_exchange_weak(gmax, gap_ms, std::memory_order_relaxed)) {}
        }

        float*       out      = static_cast<float*>(audio_data);
        const int    channels = stream->getChannelCount();
        const double sr       = static_cast<double>(stream->getSampleRate());

        // Clear the interleaved output first so stale data never reaches the
        // hardware, whatever the render below does.
        std::fill(out, out + static_cast<size_t>(num_frames) * channels, 0.f);

        int offset = 0;
        while (offset < num_frames) {
            const int chunk =
                std::min<int>(num_frames - offset, kMaxRenderChunkFrames);
            std::fill(planar_[0].begin(), planar_[0].begin() + chunk, 0.f);
            std::fill(planar_[1].begin(), planar_[1].begin() + chunk, 0.f);
            if (render_cb_) {
                render_cb_->render(channel_ptrs_, kOutputChannels, chunk, sr);
            }
            for (int frame = 0; frame < chunk; ++frame) {
                const size_t base =
                    static_cast<size_t>(offset + frame) * channels;
                out[base] = soft_clip(planar_[0][frame]);
                if (channels > 1)
                    out[base + 1] = soft_clip(planar_[1][frame]);
            }
            offset += chunk;
        }

        auto t1 = std::chrono::steady_clock::now();
        last_callback_end_ = t1;
        const double dur_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        double wmax = work_max_ms_.load(std::memory_order_relaxed);
        while (dur_ms > wmax
               && !work_max_ms_.compare_exchange_weak(wmax, dur_ms, std::memory_order_relaxed)) {}

        callback_count_.fetch_add(1, std::memory_order_relaxed);
        const double prev = callback_duration_ms_.load(std::memory_order_relaxed);
        callback_duration_ms_.store(0.9 * prev + 0.1 * dur_ms, std::memory_order_relaxed);
        // Never log from this thread (see the JUCE adaptor's note).
        return oboe::DataCallbackResult::Continue;
    }

    // Fired after AAudio closed the stream underneath us — typically a route
    // change (headphones unplugged, BT device off). The engine sees the error
    // via device_info().last_error; recovery is a fresh open_device() from
    // the control layer. TODO(milestone 4): auto-reopen on route change.
    void onErrorAfterClose(oboe::AudioStream* /*stream*/, oboe::Result error) override {
        last_error_ = std::string("oboe stream closed: ") + oboe::convertToText(error);
        error_flag_.store(true, std::memory_order_relaxed);
    }

    double take_gap_max_ms()  { return gap_max_ms_.exchange(0.0, std::memory_order_relaxed); }
    double take_work_max_ms() { return work_max_ms_.exchange(0.0, std::memory_order_relaxed); }

    bool        has_error()  const { return error_flag_.load(std::memory_order_relaxed); }
    std::string last_error() const { return last_error_; }

private:
    AudioRenderCallback* render_cb_;
    std::vector<float>   planar_[kOutputChannels];
    float*               channel_ptrs_[kOutputChannels] = {nullptr, nullptr};
    std::atomic<double>  callback_duration_ms_{0.0};
    std::atomic<int>     callback_count_{0};
    std::atomic<bool>    error_flag_{false};
    std::string          last_error_;
    std::chrono::steady_clock::time_point last_callback_end_{};
    std::atomic<double>  gap_max_ms_{0.0};
    std::atomic<double>  work_max_ms_{0.0};
};

// ---------------------------------------------------------------------------
// AudioDeviceManager::Impl
// ---------------------------------------------------------------------------
struct AudioDeviceManager::Impl {
    std::shared_ptr<oboe::AudioStream>   stream;
    std::unique_ptr<OboeCallbackAdaptor> adaptor;

    int         sample_rate = 0;
    int         buffer_size = 0;
    int         output_latency_samples = 0;
    std::string last_error;
    // The device_id the currently-open stream was requested with (empty =
    // system default). Reported back through device_info() so the control
    // layer can tell which endpoint is actually live.
    std::string open_device_id;
};

AudioDeviceManager::AudioDeviceManager() : impl_(std::make_unique<Impl>()) {}

AudioDeviceManager::~AudioDeviceManager() {
    close_device();
}

std::vector<DeviceDescriptor> AudioDeviceManager::list_devices() const {
    // The native backend only knows the AAudio *default* route. The concrete
    // hardware endpoints (speaker / wired / USB interface / Bluetooth) are
    // enumerated on the Rust side via AudioManager.getDevices() and appended to
    // this list (see engine_v2_list_devices + android_audio_devices.rs).
    //
    // This one entry is the "system default": an EMPTY id, matching the
    // desktop contract where an empty device_id means "let the OS pick the
    // current default endpoint". The Settings UI renders the empty-id option as
    // "System default", so this must not carry a concrete id or there would be
    // no default entry to fall back to.
    DeviceDescriptor descriptor;
    descriptor.id = "";
    descriptor.name = kDeviceName;
    descriptor.backend = kBackend;
    descriptor.output_channel_count = kOutputChannels;
    descriptor.output_channel_names = {"Out 1", "Out 2"};
    descriptor.supported_sample_rates = {44100, 48000};
    descriptor.supported_buffer_sizes = {128, 256, 512, 1024};
    return {descriptor};
}

Result<void> AudioDeviceManager::open_device(const DeviceOpenRequest& request,
                                             AudioRenderCallback* callback) {
    close_device();

    impl_->adaptor = std::make_unique<OboeCallbackAdaptor>(callback);

    oboe::AudioStreamBuilder builder;

    // Route to an explicit endpoint when the caller named one. The device_id
    // is the Android AudioDeviceInfo.getId() integer (see the Rust JNI
    // enumeration in android_audio_devices.rs) rendered as a string. Empty (or
    // unparseable) means "system default": leave the id kUnspecified so AAudio
    // picks the current default route (speaker / headset / BT), exactly as
    // before this feature existed. AAudio honours setDeviceId; if the device
    // is gone by open time, openStream() fails and the caller falls back to
    // default — the same path a disappeared desktop device takes.
    int32_t requested_device_id = oboe::kUnspecified;
    if (!request.device_id.empty()) {
        try {
            requested_device_id = std::stoi(request.device_id);
        } catch (const std::exception&) {
            requested_device_id = oboe::kUnspecified;
        }
    }

    // PerformanceMode::None (deep buffer) is the safe default: LowLatency
    // streams get small internal buffer capacities that stuttered on a low-end
    // phone (Oppo A5) the moment anything else breathed, and the app is a
    // playback tool where jumps still feel instant next to Bungee's ~100 ms
    // pitch latency. The user opts into LowLatency (Settings → "Baja latencia")
    // when they have hardware that can take it — e.g. a USB interface.
    const oboe::PerformanceMode performance_mode = request.low_latency
        ? oboe::PerformanceMode::LowLatency
        : oboe::PerformanceMode::None;

    builder.setDirection(oboe::Direction::Output)
        ->setDeviceId(requested_device_id)
        ->setPerformanceMode(performance_mode)
        // Capacity must be requested BEFORE opening: the default came out as
        // just 2 bursts (~40 ms) on the Oppo A5 test device, so the buffer
        // enlargement below was silently clamped and playback underran
        // whenever the CPU breathed. ~170 ms of capacity costs 64 KB.
        ->setBufferCapacityInFrames(8192)
        ->setSharingMode(oboe::SharingMode::Shared)
        ->setFormat(oboe::AudioFormat::Float)
        ->setFormatConversionAllowed(true)
        ->setChannelCount(kOutputChannels)
        ->setUsage(oboe::Usage::Media)
        ->setContentType(oboe::ContentType::Music)
        ->setDataCallback(impl_->adaptor.get())
        ->setErrorCallback(impl_->adaptor.get());

    // Honor an explicit sample-rate request (the engine re-parses the session
    // to the actual rate afterwards either way); otherwise take the device's
    // native rate, which avoids the OS resampler entirely.
    if (request.sample_rate > 0) {
        builder.setSampleRate(request.sample_rate);
        builder.setSampleRateConversionQuality(
            oboe::SampleRateConversionQuality::Medium);
    }

    const oboe::Result open_result = builder.openStream(impl_->stream);
    if (open_result != oboe::Result::OK) {
        impl_->adaptor.reset();
        impl_->last_error =
            std::string("oboe openStream failed: ") + oboe::convertToText(open_result);
        return Result<void>::err(impl_->last_error);
    }

    // Buffer target over the burst size. In the safe default (deep buffer)
    // mode, generous headroom kills the underruns that tight buffers invite on
    // busy low-end devices ("petardeo" reported on an Oppo A5 at burst*2). When
    // the user opts into low latency, tighten to burst*2 so the mode actually
    // lowers latency instead of being clamped back up — they've accepted the
    // underrun risk. Oboe clamps to the stream's capacity either way.
    const int burst = impl_->stream->getFramesPerBurst();
    if (burst > 0)
        impl_->stream->setBufferSizeInFrames(burst * (request.low_latency ? 2 : 4));

    impl_->sample_rate = impl_->stream->getSampleRate();
    impl_->buffer_size = burst > 0
        ? burst
        : impl_->stream->getBufferSizeInFrames();

    // Prefer the live latency measurement (AAudio timestamps); fall back to
    // the buffer length before the stream has run long enough to measure.
    const auto latency_ms = impl_->stream->calculateLatencyMillis();
    if (latency_ms) {
        impl_->output_latency_samples = static_cast<int>(
            latency_ms.value() * impl_->sample_rate / 1000.0);
    } else {
        impl_->output_latency_samples = impl_->stream->getBufferSizeInFrames();
    }

    const oboe::Result start_result = impl_->stream->requestStart();
    if (start_result != oboe::Result::OK) {
        impl_->last_error =
            std::string("oboe requestStart failed: ") + oboe::convertToText(start_result);
        impl_->stream->close();
        impl_->stream.reset();
        impl_->adaptor.reset();
        return Result<void>::err(impl_->last_error);
    }

    // Remember which endpoint we opened so device_info() reports it (empty =
    // system default). Cleared in close_device().
    impl_->open_device_id = request.device_id;

    // Log both the requested id and the id AAudio actually bound: on an
    // explicit selection they should match, and a mismatch (e.g. the endpoint
    // vanished and AAudio fell back to default) is exactly what we want visible
    // when validating device switching without the hardware in hand.
    lt_debug_log("[LT_AUDIO_DIAG] oboe stream open sr=%d burst=%d buffer=%d "
                 "capacity=%d latency_samples=%d api=%s requested_device_id=%d "
                 "actual_device_id=%d low_latency=%d mode=%s\n",
                 impl_->sample_rate, burst,
                 impl_->stream->getBufferSizeInFrames(),
                 impl_->stream->getBufferCapacityInFrames(),
                 impl_->output_latency_samples,
                 impl_->stream->getAudioApi() == oboe::AudioApi::AAudio
                     ? "AAudio" : "OpenSLES",
                 requested_device_id,
                 impl_->stream->getDeviceId(),
                 request.low_latency ? 1 : 0,
                 impl_->stream->getPerformanceMode() == oboe::PerformanceMode::LowLatency
                     ? "LowLatency" : "None");
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::close_device() {
    if (impl_->stream) {
        impl_->stream->stop();
        impl_->stream->close();
        impl_->stream.reset();
    }
    // The stream is fully torn down before the adaptor it points at dies.
    impl_->adaptor.reset();
    impl_->open_device_id.clear();
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::start() {
    if (impl_->stream)
        impl_->stream->requestStart();
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::stop() {
    if (impl_->stream)
        impl_->stream->requestPause();
    return Result<void>::ok();
}

int AudioDeviceManager::actual_sample_rate() const { return impl_->sample_rate; }
int AudioDeviceManager::actual_buffer_size() const { return impl_->buffer_size; }
int AudioDeviceManager::actual_output_latency_samples() const {
    return impl_->output_latency_samples;
}
std::string AudioDeviceManager::actual_device_name() const {
    return impl_->stream ? kDeviceName : std::string{};
}
std::string AudioDeviceManager::actual_backend() const { return kBackend; }

DeviceInfo AudioDeviceManager::device_info() const {
    DeviceInfo info;
    // Report the endpoint that's actually open (empty = system default), not a
    // constant — the control layer compares this against the saved selection.
    info.device_id   = impl_->stream ? impl_->open_device_id : std::string{};
    info.device_name = actual_device_name();
    info.backend     = kBackend;
    info.sample_rate = impl_->sample_rate;
    info.buffer_size = impl_->buffer_size;
    info.output_channel_count = kOutputChannels;
    info.output_channel_names = {"Out 1", "Out 2"};
    info.last_error  = impl_->last_error;
    if (impl_->adaptor && impl_->adaptor->has_error())
        info.last_error = impl_->adaptor->last_error();
    return info;
}

double AudioDeviceManager::take_callback_gap_max_ms() {
    return impl_->adaptor ? impl_->adaptor->take_gap_max_ms() : 0.0;
}

double AudioDeviceManager::take_callback_work_max_ms() {
    return impl_->adaptor ? impl_->adaptor->take_work_max_ms() : 0.0;
}

} // namespace lt

#endif // LT_ENGINE_USE_OBOE
