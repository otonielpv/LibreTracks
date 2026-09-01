// ---------------------------------------------------------------------------
// AudioDeviceManager — CoreAudio (RemoteIO) backend for iOS.
//
// Mirrors the JUCE backend's contract exactly (see audio_device_manager.cpp):
// open_device() opens AND starts the stream; the engine only ever calls
// open_device()/close_device().
//
// Why this exists instead of letting JUCE do it: on iOS, JUCE contributed
// nothing but the RemoteIO plumbing. Everything that describes the hardware —
// route name, port type, channel names, the USB interface's real output width,
// route changes and interruptions — is already ours in ios_audio_session.mm,
// because iOS has no desktop-style list of independently openable devices to
// enumerate in the first place. Owning ~200 lines of AudioUnit setup drops a
// framework whose AGPLv3 licence is incompatible with App Store distribution.
//
// The render layer wants PLANAR float channels, which is exactly what RemoteIO
// delivers when its client format is non-interleaved: the callback hands the
// engine pointers straight into the AudioBufferList, with no intermediate copy
// (the Android/Oboe backend has to interleave; here we do not).
//
// The fallback pump and stall monitor below are deliberately a second copy of
// the JUCE backend's, not a shared extraction: that file is the desktop audio
// path in production, and pulling live code out from under it to serve iOS is
// not a trade worth making. The iOS copy is also simpler — no backend list, no
// channel-layout cache, no device ids.
// ---------------------------------------------------------------------------

#include <lt_engine/devices/audio_device_manager.h>

#if !LT_ENGINE_USE_JUCE && defined(LT_ENGINE_IOS_AUDIO_SESSION)

#include <lt_engine/debug/logging.h>
#include <lt_engine/devices/ios_audio_session.h>

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace lt {

namespace {

// What the UI shows as the backend name, and what device_info() reports.
constexpr const char* kBackend = "coreaudio-ios";

// Ceiling for the per-callback channel-pointer array. A USB interface with
// more outputs than this still plays; only the surplus channels are ignored,
// which beats allocating on the audio thread.
constexpr int kMaxOutputChannels = 32;

// RemoteIO asks for its own block size; this only bounds what we promise the
// unit we can handle in one slice.
constexpr UInt32 kMaxFramesPerSlice = 4096;

std::string osstatus_message(const char* what, OSStatus status) {
    char buffer[128]{};
    std::snprintf(buffer, sizeof(buffer), "%s failed (OSStatus %d)", what,
                  static_cast<int>(status));
    return buffer;
}

} // namespace

// ---------------------------------------------------------------------------
// Callback adaptor — bridges AudioRenderCallback to the RemoteIO render proc.
// Same diagnostics contract as JuceCallbackAdaptor: callback count for the
// stall monitor, EMA of callback duration, read-and-reset gap/work maxima.
// ---------------------------------------------------------------------------
class IosCallbackAdaptor {
public:
    explicit IosCallbackAdaptor(AudioRenderCallback* cb) : render_cb_(cb) {}

    void set_sample_rate(double sr) {
        sample_rate_.store(sr, std::memory_order_relaxed);
    }

    // ── Realtime rules: no alloc, no lock, no I/O ──────────────────────────
    OSStatus render(UInt32 num_frames, AudioBufferList* io_data) noexcept {
        auto t0 = std::chrono::steady_clock::now();

        // Gap between the END of the previous callback and the START of this
        // one. Large gap + small work means the OS is under-feeding the audio
        // thread, not that our render is slow.
        if (last_callback_end_.time_since_epoch().count() != 0) {
            const double gap_ms =
                std::chrono::duration<double, std::milli>(t0 - last_callback_end_).count();
            double gmax = gap_max_ms_.load(std::memory_order_relaxed);
            while (gap_ms > gmax
                   && !gap_max_ms_.compare_exchange_weak(gmax, gap_ms, std::memory_order_relaxed)) {}
        }

        const int buffers =
            std::min<int>(static_cast<int>(io_data->mNumberBuffers), kMaxOutputChannels);

        // Clear first so stale data never reaches the hardware, whatever the
        // render below does — including the case where it does nothing.
        for (int ch = 0; ch < static_cast<int>(io_data->mNumberBuffers); ++ch) {
            std::memset(io_data->mBuffers[ch].mData, 0,
                        io_data->mBuffers[ch].mDataByteSize);
        }
        for (int ch = 0; ch < buffers; ++ch)
            channel_ptrs_[ch] = static_cast<float*>(io_data->mBuffers[ch].mData);

        if (render_cb_ && buffers > 0) {
            render_cb_->render(channel_ptrs_, buffers, static_cast<int>(num_frames),
                               sample_rate_.load(std::memory_order_relaxed));
        }

        // Field-only signal-path probe. One atomic peak; the monitor thread
        // does the logging, never this thread.
        if (diag_enabled_) {
            float peak = 0.0f;
            for (int ch = 0; ch < buffers; ++ch)
                for (UInt32 frame = 0; frame < num_frames; ++frame)
                    peak = std::max(peak, std::fabs(channel_ptrs_[ch][frame]));
            output_peak_.store(peak, std::memory_order_relaxed);
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
        // NEVER log from this thread: lt_debug_log does blocking file I/O under
        // a global mutex, which is precisely what stalls an audio callback.
        return noErr;
    }

    double take_gap_max_ms()  { return gap_max_ms_.exchange(0.0, std::memory_order_relaxed); }
    double take_work_max_ms() { return work_max_ms_.exchange(0.0, std::memory_order_relaxed); }

    int         callback_count() const { return callback_count_.load(std::memory_order_relaxed); }
    float       output_peak()    const { return output_peak_.load(std::memory_order_relaxed); }
    bool        has_error()      const { return error_flag_.load(std::memory_order_relaxed); }
    std::string last_error()     const { return last_error_; }

    void set_error(std::string message) {
        last_error_ = std::move(message);
        error_flag_.store(true, std::memory_order_relaxed);
    }

private:
    AudioRenderCallback* render_cb_;
    float*               channel_ptrs_[kMaxOutputChannels]{};
    std::atomic<double>  sample_rate_{48000.0};
    std::atomic<double>  callback_duration_ms_{0.0};
    std::atomic<int>     callback_count_{0};
    std::atomic<float>   output_peak_{0.0f};
    std::atomic<bool>    error_flag_{false};
    std::string          last_error_;
    std::chrono::steady_clock::time_point last_callback_end_{};
    std::atomic<double>  gap_max_ms_{0.0};
    std::atomic<double>  work_max_ms_{0.0};
    const bool           diag_enabled_ = lt_env_flag_enabled("LIBRETRACKS_AUDIO_DIAG");
};

namespace {

OSStatus remote_io_render_trampoline(void*                       ref_con,
                                     AudioUnitRenderActionFlags* /*flags*/,
                                     const AudioTimeStamp*       /*timestamp*/,
                                     UInt32                      /*bus*/,
                                     UInt32                      num_frames,
                                     AudioBufferList*            io_data) {
    if (ref_con == nullptr || io_data == nullptr)
        return noErr;
    return static_cast<IosCallbackAdaptor*>(ref_con)->render(num_frames, io_data);
}

} // namespace

// ---------------------------------------------------------------------------
// AudioDeviceManager::Impl
// ---------------------------------------------------------------------------
struct AudioDeviceManager::Impl {
    AudioUnit                          unit = nullptr;
    std::unique_ptr<IosCallbackAdaptor> adaptor;
    AudioRenderCallback*               user_callback = nullptr;

    std::string device_name;
    int         sample_rate = 0;
    int         buffer_size = 0;
    int         output_latency_samples = 0;
    int         output_channel_count = 2;
    std::vector<std::string> output_channel_names;
    std::vector<int> supported_sample_rates;
    std::string last_error;

    // stream_mtx serializes every open/close of the RemoteIO unit and of the
    // pump, across the command thread and the monitor thread. The monitor only
    // try_locks: a busy mutex means an open is in flight, where a callback
    // pause is expected and must not be read as a dead device.
    mutable std::mutex         stream_mtx;
    std::atomic<bool>          fallback_active{false};
    std::atomic<std::uint64_t> open_generation{0};
    std::chrono::steady_clock::time_point last_open_time{};

    std::thread       pump_thread;
    std::atomic<bool> pump_run{false};

    std::thread       monitor_thread;
    std::atomic<bool> monitor_stop{false};

    void close_stream_locked();
    void start_pump_locked();
    void stop_pump_locked();
    void ensure_monitor_started_locked();
    void monitor_main();
};

// Tear down the RemoteIO unit (if any). Never touches the pump: open_device
// keeps it running through a reopen attempt so the engine clock stays smooth
// while the route is being negotiated.
void AudioDeviceManager::Impl::close_stream_locked() {
    if (unit != nullptr) {
        AudioOutputUnitStop(unit);
        AudioUnitUninitialize(unit);
        AudioComponentInstanceDispose(unit);
        unit = nullptr;
    }
    // Only after the unit is gone: the render proc points at this adaptor.
    adaptor.reset();
    // user_callback is deliberately kept — the pump and the next open both
    // still need it. Only close_device() clears it.
}

// The internal fallback pump: a plain thread that drives the same render
// callback at the last-known rate and discards the audio. It is what keeps the
// transport clock (advanced inside Mixer::render) running when there is no
// working hardware stream — including the whole length of a phone call, where
// iOS simply stops calling us.
void AudioDeviceManager::Impl::start_pump_locked() {
    if (pump_run.load(std::memory_order_relaxed) || user_callback == nullptr)
        return;
    if (pump_thread.joinable())
        pump_thread.join();
    const int sr = sample_rate > 0 ? sample_rate : 48000;
    const int bs = buffer_size > 0 ? buffer_size : 512;
    const int ch = std::clamp(output_channel_count, 2, kMaxOutputChannels);
    AudioRenderCallback* cb = user_callback;
    pump_run.store(true, std::memory_order_relaxed);
    fallback_active.store(true, std::memory_order_relaxed);
    fprintf(stderr,
            "[LT_AUDIO] fallback clock started (sr=%d bs=%d ch=%d) — transport "
            "keeps running silently while the output device is retried\n",
            sr, bs, ch);
    pump_thread = std::thread([this, cb, sr, bs, ch] {
        std::vector<std::vector<float>> buffers(
            static_cast<std::size_t>(ch), std::vector<float>(static_cast<std::size_t>(bs), 0.f));
        std::vector<float*> channels(static_cast<std::size_t>(ch));
        for (int i = 0; i < ch; ++i)
            channels[static_cast<std::size_t>(i)] = buffers[static_cast<std::size_t>(i)].data();
        const auto block = std::chrono::nanoseconds(
            1'000'000'000LL * static_cast<std::int64_t>(bs) / sr);
        auto next = std::chrono::steady_clock::now() + block;
        while (pump_run.load(std::memory_order_relaxed)) {
            for (auto& b : buffers)
                std::fill(b.begin(), b.end(), 0.f);
            cb->render(channels.data(), ch, bs, static_cast<double>(sr));
            std::this_thread::sleep_until(next);
            next += block;
            // Fell behind (suspend, load spike): resync to now rather than
            // bursting blocks to catch up, which would race the transport
            // ahead audibly once the device returns.
            const auto now = std::chrono::steady_clock::now();
            if (next < now)
                next = now + block;
        }
    });
}

void AudioDeviceManager::Impl::stop_pump_locked() {
    pump_run.store(false, std::memory_order_relaxed);
    if (pump_thread.joinable())
        pump_thread.join();
    fallback_active.store(false, std::memory_order_relaxed);
}

void AudioDeviceManager::Impl::ensure_monitor_started_locked() {
    if (monitor_thread.joinable())
        return;
    monitor_thread = std::thread([this] { monitor_main(); });
}

// Stall monitor + route watcher. Two different failures land here:
//
//   * Callbacks frozen. An open RemoteIO unit keeps calling us forever (the
//     mixer renders silence while stopped), so a frozen count is a reliable
//     death signal — the interruption case, where iOS stopped the unit and
//     never restarted it.
//   * Route generation changed. Plugging an interface in is INVISIBLE to the
//     stall check: iOS migrates the route seamlessly, the callbacks never
//     pause, and the unit stays open at the channel count it negotiated before
//     the interface existed. Without this, a four- or eight-output interface
//     would keep behaving as stereo until the app restarted.
//
// Both take the same path: tear the stream down, hand the render callback to
// the pump, and let the control layer reopen against the route that is there
// now (it polls fallback_active() and retries open_device()).
void AudioDeviceManager::Impl::monitor_main() {
    constexpr int kMonitorPeriodMs  = 500;
    constexpr int kStallThresholdMs = 1500;
    constexpr int kFreshOpenGraceMs = 3000;
    std::uint64_t last_gen   = 0;
    int           last_count = -1;
    int           diagnostic_ticks = 0;
    auto          last_change = std::chrono::steady_clock::now();
    const auto ms_between = [](auto a, auto b) {
        return std::chrono::duration<double, std::milli>(b - a).count();
    };
    // Seeded from the current value, not from zero: whatever happened before
    // the monitor started is already reflected in the device that is open.
    unsigned last_route_generation = ios_audio_route_generation();

    while (!monitor_stop.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(kMonitorPeriodMs));
        if (monitor_stop.load(std::memory_order_relaxed))
            break;
        std::unique_lock<std::mutex> lk(stream_mtx, std::try_to_lock);
        if (!lk.owns_lock()) {
            last_count = -1;
            continue;
        }
        if (pump_run.load(std::memory_order_relaxed) || !adaptor) {
            last_count = -1;
            // Already on the fallback clock: the control layer is reopening
            // anyway and will pick up whatever route is current. Absorbing the
            // event here keeps that recovery from being followed by a second,
            // pointless tear-down.
            last_route_generation = ios_audio_route_generation();
            continue;
        }
        const auto now = std::chrono::steady_clock::now();

        const unsigned route_generation = ios_audio_route_generation();
        if (route_generation != last_route_generation) {
            last_route_generation = route_generation;
            lt_debug_log(
                "[LT_IOS_AUDIO] route/interruption event — reopening \"%s\"\n",
                device_name.c_str());
            last_error = "iOS audio route changed";
            close_stream_locked();
            start_pump_locked();
            last_count = -1;
            continue;
        }

        const std::uint64_t gen = open_generation.load(std::memory_order_relaxed);
        const int  count     = adaptor->callback_count();
        const bool dev_error = adaptor->has_error();
        if (++diagnostic_ticks >= 4) {
            diagnostic_ticks = 0;
            if (lt_env_flag_enabled("LIBRETRACKS_AUDIO_DIAG")) {
                lt_debug_log(
                    "[LT_IOS_AUDIO] hardware_callback device=\"%s\" backend=\"%s\" "
                    "callbacks=%d final_peak=%.6f sr=%d buffer=%d channels=%d\n",
                    device_name.c_str(), kBackend, count,
                    static_cast<double>(adaptor->output_peak()), sample_rate,
                    buffer_size, output_channel_count);
            }
        }
        if (gen != last_gen || last_count < 0) {
            last_gen = gen;
            last_count = count;
            last_change = now;
            if (!dev_error) continue;
        } else if (count != last_count) {
            last_count = count;
            last_change = now;
            if (!dev_error) continue;
        }
        const double stalled_ms    = ms_between(last_change, now);
        const double since_open_ms = ms_between(last_open_time, now);
        if (!dev_error
            && (stalled_ms < kStallThresholdMs || since_open_ms < kFreshOpenGraceMs))
            continue;
        const std::string reason = dev_error
            ? adaptor->last_error()
            : std::string("output device stopped delivering audio callbacks "
                          "(interruption or route loss?)");
        fprintf(stderr,
                "[LT_AUDIO] output device \"%s\" declared dead (%s; callbacks "
                "frozen %.0f ms) — switching to the internal fallback clock\n",
                device_name.c_str(), reason.c_str(), stalled_ms);
        last_error = reason;
        close_stream_locked();
        start_pump_locked();
        last_count = -1;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

AudioDeviceManager::AudioDeviceManager() : impl_(std::make_unique<Impl>()) {}

AudioDeviceManager::~AudioDeviceManager() {
    impl_->monitor_stop.store(true, std::memory_order_relaxed);
    if (impl_->monitor_thread.joinable())
        impl_->monitor_thread.join();
    close_device();
}

std::vector<DeviceDescriptor> AudioDeviceManager::list_devices(bool /*force_rescan*/) const {
    // iOS publishes the ACTIVE ROUTE, not a list of independently openable
    // endpoints: AVAudioSession decides where audio goes (speaker, headset,
    // USB, Bluetooth, AirPlay) and an app cannot open an arbitrary one. So
    // there is exactly one descriptor, with an EMPTY id, matching the desktop
    // contract where an empty device_id means "the current default endpoint".
    const auto route = current_ios_output_route();

    DeviceDescriptor descriptor;
    descriptor.id = "";
    descriptor.name = route.display_name;
    descriptor.backend = kBackend;
    descriptor.output_channel_names = route.channel_names;
    descriptor.output_channel_count = route.channel_names.empty()
        ? current_ios_output_channel_count()
        : static_cast<int>(route.channel_names.size());
    descriptor.supported_sample_rates = {44100, 48000};
    descriptor.supported_buffer_sizes = {128, 256, 512, 1024};
    return {descriptor};
}

Result<void> AudioDeviceManager::open_device(const DeviceOpenRequest& request,
                                             AudioRenderCallback* callback) {
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    // Tear down only the hardware stream. If the pump is running it keeps
    // driving the engine clock through this whole attempt, so the transport
    // never hiccups while the route is negotiated; it is stopped just before
    // the new stream goes live.
    impl_->close_stream_locked();
    impl_->user_callback = callback;

    // On any failure: never leave the engine clockless. The pump takes over so
    // the transport keeps running (silently) and the control layer keeps
    // retrying via fallback_active().
    auto fail = [&](std::string message) {
        impl_->last_error = message;
        impl_->start_pump_locked();
        return Result<void>::err(std::move(message));
    };

    // The session owns the policy (category, sample rate, output width) and
    // must be active before the unit is created; otherwise iOS leaves the app
    // in an ambient, silent or high-latency category inherited from the
    // WebView host.
    //
    // NOTE for the CI guard: this literal is what ios-smoke.yml greps for to
    // prove the real engine (not the silent stub) is linked into the IPA.
    std::string audio_session_error;
    if (!configure_ios_playback_session(&audio_session_error,
                                        static_cast<double>(request.sample_rate))) {
        return fail("Could not activate the iOS audio session: " + audio_session_error);
    }

    AVAudioSession* session = AVAudioSession.sharedInstance;
    const double negotiated_rate = session.sampleRate > 0 ? session.sampleRate : 48000.0;
    const int channels = std::clamp(current_ios_output_channel_count(), 1, kMaxOutputChannels);

    AudioComponentDescription description{};
    description.componentType = kAudioUnitType_Output;
    description.componentSubType = kAudioUnitSubType_RemoteIO;
    description.componentManufacturer = kAudioUnitManufacturer_Apple;

    AudioComponent component = AudioComponentFindNext(nullptr, &description);
    if (component == nullptr)
        return fail("No RemoteIO audio component available");

    AudioUnit unit = nullptr;
    OSStatus status = AudioComponentInstanceNew(component, &unit);
    if (status != noErr || unit == nullptr)
        return fail(osstatus_message("AudioComponentInstanceNew", status));

    // Everything from here on must dispose the half-built unit before
    // returning, or the next open leaks a RemoteIO instance.
    const auto abort_with = [&](std::string message) {
        AudioComponentInstanceDispose(unit);
        return fail(std::move(message));
    };

    UInt32 enable_output = 1;
    status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Output, 0,
                                  &enable_output, sizeof(enable_output));
    if (status != noErr)
        return abort_with(osstatus_message("EnableIO(output)", status));

    // Non-interleaved float32: one AudioBuffer per channel, which is the
    // layout the engine's render() already wants. mBytesPerFrame is per
    // channel precisely because the buffers are separate.
    AudioStreamBasicDescription format{};
    format.mSampleRate       = negotiated_rate;
    format.mFormatID         = kAudioFormatLinearPCM;
    format.mFormatFlags      = kAudioFormatFlagIsFloat
                             | kAudioFormatFlagIsPacked
                             | kAudioFormatFlagIsNonInterleaved;
    format.mFramesPerPacket  = 1;
    format.mChannelsPerFrame = static_cast<UInt32>(channels);
    format.mBitsPerChannel   = 32;
    format.mBytesPerFrame    = sizeof(float);
    format.mBytesPerPacket   = sizeof(float);
    status = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Input, 0,
                                  &format, sizeof(format));
    if (status != noErr)
        return abort_with(osstatus_message("SetStreamFormat", status));

    UInt32 max_frames = kMaxFramesPerSlice;
    status = AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice,
                                  kAudioUnitScope_Global, 0,
                                  &max_frames, sizeof(max_frames));
    if (status != noErr)
        return abort_with(osstatus_message("SetMaximumFramesPerSlice", status));

    impl_->adaptor = std::make_unique<IosCallbackAdaptor>(callback);
    impl_->adaptor->set_sample_rate(negotiated_rate);

    AURenderCallbackStruct render_callback{};
    render_callback.inputProc = &remote_io_render_trampoline;
    render_callback.inputProcRefCon = impl_->adaptor.get();
    status = AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback,
                                  kAudioUnitScope_Input, 0,
                                  &render_callback, sizeof(render_callback));
    if (status != noErr) {
        impl_->adaptor.reset();
        return abort_with(osstatus_message("SetRenderCallback", status));
    }

    status = AudioUnitInitialize(unit);
    if (status != noErr) {
        impl_->adaptor.reset();
        return abort_with(osstatus_message("AudioUnitInitialize", status));
    }

    // Publish the physical channel indices before the first callback can fire.
    // iOS hands us a dense 0..N-1 route, so the mapping is the identity — but
    // the render layer still needs it to translate explicit routes (ext:3-4).
    if (callback != nullptr) {
        std::vector<int> physical_channels(static_cast<std::size_t>(channels));
        for (int i = 0; i < channels; ++i)
            physical_channels[static_cast<std::size_t>(i)] = i;
        callback->set_active_output_channels(physical_channels);
    }

    const auto route = current_ios_output_route();
    impl_->device_name = route.display_name;
    impl_->sample_rate = static_cast<int>(std::lround(negotiated_rate));
    impl_->buffer_size = std::max(
        1, static_cast<int>(std::lround(session.IOBufferDuration * negotiated_rate)));
    // What the listener actually waits through: the frames already handed to
    // the hardware keep playing before anything new is heard. This is the
    // floor on how instant a jump can feel, and the engine compensates the UI
    // playhead with it.
    impl_->output_latency_samples =
        static_cast<int>(std::lround(session.outputLatency * negotiated_rate));
    impl_->output_channel_count = channels;
    impl_->output_channel_names = route.channel_names;
    if (static_cast<int>(impl_->output_channel_names.size()) != channels) {
        impl_->output_channel_names.clear();
        impl_->output_channel_names.reserve(static_cast<std::size_t>(channels));
        for (int i = 0; i < channels; ++i)
            impl_->output_channel_names.push_back("Out " + std::to_string(i + 1));
    }
    // iOS resamples anything it is handed, and the session honours a preferred
    // rate when the route can take it, so both are safe to advertise. The
    // engine uses this to decide whether to align itself with a session's audio
    // instead of decoding and resampling every file.
    impl_->supported_sample_rates = {44100, 48000};

    // The hardware stream is about to go live: retire the pump first so the
    // render callback never has two drivers at once.
    impl_->stop_pump_locked();

    status = AudioOutputUnitStart(unit);
    if (status != noErr) {
        AudioUnitUninitialize(unit);
        impl_->adaptor.reset();
        return abort_with(osstatus_message("AudioOutputUnitStart", status));
    }

    impl_->unit = unit;
    impl_->last_error.clear();
    impl_->open_generation.fetch_add(1, std::memory_order_relaxed);
    impl_->last_open_time = std::chrono::steady_clock::now();
    impl_->ensure_monitor_started_locked();

    lt_debug_log("[LT_IOS_AUDIO] session %s\n",
                 describe_ios_playback_session().c_str());
    lt_debug_log("[LT_IOS_AUDIO] opened name=\"%s\" backend=%s sr=%d buffer=%d "
                 "(%.1f ms) output_latency=%d samples (%.1f ms) channels=%d\n",
                 impl_->device_name.c_str(), kBackend, impl_->sample_rate,
                 impl_->buffer_size,
                 1000.0 * impl_->buffer_size / negotiated_rate,
                 impl_->output_latency_samples,
                 1000.0 * impl_->output_latency_samples / negotiated_rate,
                 impl_->output_channel_count);
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::close_device() {
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    impl_->close_stream_locked();
    impl_->stop_pump_locked();
    impl_->user_callback = nullptr;
    impl_->device_name.clear();
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::start() {
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    if (impl_->unit != nullptr) {
        const OSStatus status = AudioOutputUnitStart(impl_->unit);
        if (status != noErr)
            return Result<void>::err(osstatus_message("AudioOutputUnitStart", status));
    }
    return Result<void>::ok();
}

// Nothing in the engine calls start()/stop() — it only opens and closes — but
// keep them honest. Stopping the unit freezes the callbacks, which the stall
// monitor reads as a dead device and answers by handing the clock to the pump;
// that is the correct outcome, not a hang.
Result<void> AudioDeviceManager::stop() {
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    if (impl_->unit != nullptr) {
        const OSStatus status = AudioOutputUnitStop(impl_->unit);
        if (status != noErr)
            return Result<void>::err(osstatus_message("AudioOutputUnitStop", status));
    }
    return Result<void>::ok();
}

int AudioDeviceManager::actual_sample_rate() const { return impl_->sample_rate; }
int AudioDeviceManager::actual_buffer_size() const { return impl_->buffer_size; }
int AudioDeviceManager::actual_output_latency_samples() const {
    return impl_->output_latency_samples;
}
std::string AudioDeviceManager::actual_device_name() const { return impl_->device_name; }
std::string AudioDeviceManager::actual_backend() const { return kBackend; }

DeviceInfo AudioDeviceManager::device_info() const {
    // stream_mtx: the monitor thread can reset the adaptor and rewrite
    // last_error concurrently with this snapshot read.
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    DeviceInfo info;
    // Empty id = "the system route", which is the only thing iOS offers and
    // what the control layer compares its saved selection against.
    info.device_id   = "";
    info.device_name = impl_->device_name;
    info.backend     = kBackend;
    info.sample_rate = impl_->sample_rate;
    info.buffer_size = impl_->buffer_size;
    info.output_channel_count = impl_->output_channel_count;
    info.output_channel_names = impl_->output_channel_names;
    info.supported_sample_rates = impl_->supported_sample_rates;
    info.last_error  = impl_->last_error;
    if (impl_->adaptor && impl_->adaptor->has_error())
        info.last_error = impl_->adaptor->last_error();
    info.fallback_active = impl_->fallback_active.load(std::memory_order_relaxed);
    return info;
}

bool AudioDeviceManager::fallback_active() const {
    return impl_->fallback_active.load(std::memory_order_relaxed);
}

double AudioDeviceManager::take_callback_gap_max_ms() {
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    return impl_->adaptor ? impl_->adaptor->take_gap_max_ms() : 0.0;
}

double AudioDeviceManager::take_callback_work_max_ms() {
    std::lock_guard<std::mutex> stream_lk(impl_->stream_mtx);
    return impl_->adaptor ? impl_->adaptor->take_work_max_ms() : 0.0;
}

} // namespace lt

#endif // !LT_ENGINE_USE_JUCE && LT_ENGINE_IOS_AUDIO_SESSION
