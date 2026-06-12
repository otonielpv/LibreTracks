#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/devices/device_channel_layout.h>

#if LT_ENGINE_USE_JUCE

// JUCE headers — must come after lt_engine headers to avoid name collisions.
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>

#include <lt_engine/debug/logging.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <mutex>
#include <unordered_map>

namespace lt {

// ---------------------------------------------------------------------------
// JUCE callback adaptor — bridges AudioRenderCallback to juce::AudioIODeviceCallback
// ---------------------------------------------------------------------------
class JuceCallbackAdaptor : public juce::AudioIODeviceCallback {
public:
    explicit JuceCallbackAdaptor(AudioRenderCallback* cb) : render_cb_(cb) {}

    void audioDeviceIOCallbackWithContext(
        const float* const*  /*input_channels*/,
        int                  /*num_input_channels*/,
        float* const*         output_channels,
        int                   num_output_channels,
        int                   num_sample_frames,
        const juce::AudioIODeviceCallbackContext& /*ctx*/) override
    {
        // ── Realtime rules: no alloc, no lock, no I/O ──────────────────
        auto t0 = std::chrono::steady_clock::now();

        // Clear outputs first so stale data never reaches the hardware.
        for (int ch = 0; ch < num_output_channels; ++ch)
            std::fill(output_channels[ch], output_channels[ch] + num_sample_frames, 0.f);

        if (render_cb_) {
            render_cb_->render(const_cast<float**>(output_channels),
                               num_output_channels,
                               num_sample_frames,
                               device_sample_rate_.load(std::memory_order_relaxed));
        }

        auto t1 = std::chrono::steady_clock::now();
        double dur_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

        callback_count_.fetch_add(1, std::memory_order_relaxed);
        // Simple exponential moving average for callback duration.
        double prev = callback_duration_ms_.load(std::memory_order_relaxed);
        callback_duration_ms_.store(0.9 * prev + 0.1 * dur_ms, std::memory_order_relaxed);
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
        device_sample_rate_.store(device->getCurrentSampleRate(), std::memory_order_relaxed);
    }

    void audioDeviceStopped() override {}

    void audioDeviceError(const juce::String& error_message) override {
        last_error_         = error_message.toStdString();
        error_flag_.store(true, std::memory_order_relaxed);
    }

    // Diagnostics — read from any thread (relaxed load is fine for display).
    double      callback_duration_ms()  const { return callback_duration_ms_.load(std::memory_order_relaxed); }
    int         callback_count()        const { return callback_count_.load(std::memory_order_relaxed); }
    bool        has_error()             const { return error_flag_.load(std::memory_order_relaxed); }
    std::string last_error()            const { return last_error_; }

private:
    AudioRenderCallback*      render_cb_;
    std::atomic<double>       device_sample_rate_{48000.0};
    std::atomic<double>       callback_duration_ms_{0.0};
    std::atomic<int>          callback_count_{0};
    std::atomic<bool>         error_flag_{false};
    std::string               last_error_;
};

// ---------------------------------------------------------------------------
// AudioDeviceManager::Impl
// ---------------------------------------------------------------------------
struct AudioDeviceManager::Impl {
    juce::AudioDeviceManager     juce_manager;
    std::unique_ptr<JuceCallbackAdaptor> adaptor;
    AudioRenderCallback*         user_callback = nullptr;
    bool                         initialized = false;

    // Last successfully opened device info.
    std::string  device_name;
    std::string  backend;
    int          sample_rate = 0;
    int          buffer_size = 0;
    int          output_latency_samples = 0;
    int          output_channel_count = 2;
    std::vector<std::string> output_channel_names;
    std::string  last_error;

    // Channel-layout cache for probed backends (ASIO/JACK/CoreAudio).
    // Key: device id "backend::name". Probing these via createDevice can
    // take seconds per device on some ASIO drivers, so we cache the result
    // for the lifetime of the AudioDeviceManager.
    struct CachedLayout {
        int count = 0;
        std::vector<std::string> names;
    };
    mutable std::mutex                                    cache_mtx;
    mutable std::unordered_map<std::string, CachedLayout> channel_layout_cache;
};

namespace {

constexpr const char* kDeviceIdSeparator = "::";
constexpr int kDefaultLowLatencyBufferSize = 512;

std::string make_device_id(const std::string& backend, const std::string& name) {
    return backend + kDeviceIdSeparator + name;
}

std::pair<std::string, std::string> split_device_id(const std::string& id) {
    auto pos = id.find(kDeviceIdSeparator);
    if (pos == std::string::npos)
        return { {}, id };
    return { id.substr(0, pos), id.substr(pos + 2) };
}

using device_layout::backend_needs_channel_probe;
using device_layout::lower_copy;

// Gated debug log: only emits when LIBRETRACKS_AUDIO_DEBUG is enabled in the
// environment. Keeps the device-enumeration / open timings available for
// support without polluting normal runs (or release logs).
bool device_debug_enabled() {
    static const bool on = lt_env_flag_enabled("LIBRETRACKS_AUDIO_DEBUG");
    return on;
}

template <typename... Args>
void device_debug_log(const char* fmt, Args&&... args) {
    if (!device_debug_enabled()) return;
    lt_debug_log(fmt, std::forward<Args>(args)...);
}

int preferred_type_score(const std::string& backend) {
    const auto name = lower_copy(backend);
    if (name.find("wasapi") != std::string::npos ||
        name.find("windows audio") != std::string::npos)
        return 0;
    if (name.find("coreaudio") != std::string::npos ||
        name.find("core audio") != std::string::npos)
        return 0;
    if (name.find("jack") != std::string::npos)
        return 1;
    if (name.find("alsa") != std::string::npos)
        return 2;
    if (name.find("asio") != std::string::npos)
        return 3;
    if (name.find("directsound") != std::string::npos)
        return 50;
    if (name.find("mme") != std::string::npos)
        return 60;
    return 20;
}

// True for backends whose reported sample rate cannot be trusted to match
// what the hardware actually runs at. The Windows DirectSound "primary sound
// driver" is the offender: it is a virtual endpoint routed through the OS
// shared mixer (KMixer), so when we ask for e.g. 48000 JUCE opens the primary
// buffer at 48000 and dutifully reports 48000 from getCurrentSampleRate(),
// while Windows silently resamples to the mixer rate (often 44100) underneath.
// Because the reported rate never changes, the engine's "did the SR change?"
// check fails to fire resample_sources_for_new_sample_rate(), and playback
// drifts ~9% slow/fast. WASAPI/ASIO/CoreAudio report honest rates.
bool backend_lies_about_sample_rate(const std::string& backend) {
    const auto name = lower_copy(backend);
    return name.find("directsound") != std::string::npos ||
           name.find("mme") != std::string::npos;
}

// For untrustworthy backends, only honor a requested sample rate if the device
// genuinely advertises it via getAvailableSampleRates(). Otherwise we leave the
// setup at the device default so JUCE opens — and truthfully reports — the rate
// the OS mixer is actually running, which lets the engine's SR-change detection
// re-decode sources at the correct rate. Returns true if `requested` is safe to
// force; false means "let JUCE pick the default".
bool requested_rate_is_supported(juce::AudioIODeviceType* type,
                                 const juce::String& device_name,
                                 int requested) {
    if (!type || requested <= 0)
        return false;
    std::unique_ptr<juce::AudioIODevice> probe(type->createDevice(device_name, {}));
    if (!probe)
        return false;
    for (double rate : probe->getAvailableSampleRates()) {
        if (static_cast<int>(rate) == requested)
            return true;
    }
    return false;
}

void select_preferred_default_device_type(juce::AudioDeviceManager& manager) {
    juce::AudioIODeviceType* best_type = nullptr;
    int best_score = std::numeric_limits<int>::max();
    for (auto* type : manager.getAvailableDeviceTypes()) {
        if (!type) continue;
        type->scanForDevices();
        if (type->getDeviceNames(false).isEmpty()) continue;
        const int score = preferred_type_score(type->getTypeName().toStdString());
        if (score < best_score) {
            best_type = type;
            best_score = score;
        }
    }
    if (best_type)
        manager.setCurrentAudioDeviceType(best_type->getTypeName(), true);
}

template <typename ImplT>
Result<void> ensure_initialized(ImplT& impl) {
    if (impl.initialized)
        return Result<void>::ok();

    // `initialise(in, out, savedState, selectDefaultDeviceOnFailure)`.
    // We pass `selectDefaultDeviceOnFailure = false` so JUCE only
    // enumerates the available backends without trying to open a
    // device. Opening happens later via open_device(), where we can
    // gracefully fall back when the saved device is gone.
    //
    // Previously this flag was `true`, which made initialise() try to
    // open the system default audio device immediately. On Windows
    // hosts where the default device had been unplugged (typical
    // headphone swap between sessions) JUCE would return
    // "Couldn't open the output device!" and refuse to mark itself as
    // initialised — and from that point list_devices() returned an
    // empty list, the settings dropdown only showed "System default",
    // and every subsequent device operation failed with the same
    // stale error.
    juce::String err = impl.juce_manager.initialise(0, 64, nullptr, false);
    if (err.isNotEmpty()) {
        // Even with selectDefaultDeviceOnFailure=false JUCE may still
        // report a soft error (e.g. driver enumeration warning). It's
        // recoverable for our purposes — backend types and device
        // names are still queryable. Stash the message so it shows up
        // under LIBRETRACKS_AUDIO_DEBUG without flooding normal runs.
        device_debug_log(
            "[LT_AUDIO_DEBUG] juce_manager.initialise soft-warned '%s' but continuing\n",
            err.toRawUTF8());
        impl.last_error = err.toStdString();
    }

    impl.initialized = true;
    return Result<void>::ok();
}

} // namespace

// ---------------------------------------------------------------------------
AudioDeviceManager::AudioDeviceManager() : impl_(std::make_unique<Impl>()) {
    // juce_manager initialises lazily on first device query/open.
}

AudioDeviceManager::~AudioDeviceManager() {
    close_device();
}

std::vector<DeviceDescriptor> AudioDeviceManager::list_devices() const {
    using clk = std::chrono::steady_clock;
    const auto t_start = clk::now();
    std::vector<DeviceDescriptor> result;

    auto init = ensure_initialized(*impl_);
    if (init.is_err()) {
        // Print unconditionally — when this fails the user sees an empty
        // device list with no explanation, which has been the source of
        // several confusing bug reports. The cause is almost always JUCE
        // failing to initialise on a Windows host whose default audio
        // device was unplugged/changed between sessions.
        fprintf(stderr,
                "[LT_AUDIO] list_devices ensure_initialized FAILED: %s\n",
                impl_->last_error.c_str());
        return result;
    }

    auto& mgr = impl_->juce_manager;
    // getAvailableDeviceTypes() returns a const OwnedArray& — must be
    // bound by reference because OwnedArray is non-copyable. Capturing
    // by `auto` produces a copy attempt and a hard compile error.
    const auto& backend_types = mgr.getAvailableDeviceTypes();
    // Empty backend list is the clear failure signal — log it always.
    // Populated lists go through the LT_AUDIO_DEBUG channel so production
    // runs aren't flooded with per-backend timings.
    if (backend_types.size() == 0) {
        fprintf(stderr,
                "[LT_AUDIO] list_devices: 0 backend type(s) available — "
                "JUCE failed to enumerate audio backends\n");
    }
    for (auto* type : backend_types) {
        const juce::String backend_name = type->getTypeName();
        const auto t_scan = clk::now();
        type->scanForDevices();
        const double scan_ms = std::chrono::duration<double, std::milli>(clk::now() - t_scan).count();
        auto names = type->getDeviceNames(false); // false = output devices
        const auto backend = backend_name.toStdString();
        const bool probe_channels = backend_needs_channel_probe(backend);
        device_debug_log("[LT_AUDIO_DEBUG] list_devices backend=%s scan_ms=%.1f device_count=%d probe=%d\n",
                     backend.c_str(), scan_ms, static_cast<int>(names.size()),
                     probe_channels ? 1 : 0);

        for (const auto& name : names) {
            auto device_name = name.toStdString();
            DeviceDescriptor d;
            d.id      = make_device_id(backend, device_name);
            d.name    = device_name;
            d.backend = backend;

            if (probe_channels) {
                // ASIO / JACK / CoreAudio: ask the driver for the real
                // channel layout. createDevice may take several seconds
                // on some ASIO drivers because it touches the hardware,
                // so we cache the result for the lifetime of this manager.
                Impl::CachedLayout layout;
                bool cache_hit = false;
                {
                    std::lock_guard<std::mutex> lk(impl_->cache_mtx);
                    auto it = impl_->channel_layout_cache.find(d.id);
                    if (it != impl_->channel_layout_cache.end()) {
                        layout = it->second;
                        cache_hit = true;
                    }
                }
                if (!cache_hit) {
                    const auto t_probe = clk::now();
                    std::unique_ptr<juce::AudioIODevice> probe(type->createDevice(name, {}));
                    if (probe != nullptr) {
                        auto ch_names = probe->getOutputChannelNames();
                        layout.names.reserve(static_cast<size_t>(ch_names.size()));
                        for (const auto& cn : ch_names)
                            layout.names.push_back(cn.toStdString());
                        layout.count = static_cast<int>(layout.names.size());
                    }
                    const double probe_ms = std::chrono::duration<double, std::milli>(clk::now() - t_probe).count();
                    device_debug_log("[LT_AUDIO_DEBUG] probe_device backend=%s name=\"%s\" probe_ms=%.1f channels=%d\n",
                                 backend.c_str(), device_name.c_str(), probe_ms, layout.count);
                    std::lock_guard<std::mutex> lk(impl_->cache_mtx);
                    impl_->channel_layout_cache[d.id] = layout;
                }
                d.output_channel_count = layout.count;
                d.output_channel_names = std::move(layout.names);
            }
            if (d.output_channel_count <= 0) {
                // WASAPI / DirectSound / MME report stereo via this code path
                // without paying the createDevice cost. The exact channel count
                // is recomputed from getOutputChannelNames() on open_device().
                auto resolved = device_layout::resolve_layout(
                    d.output_channel_count, std::move(d.output_channel_names));
                d.output_channel_count = resolved.count;
                d.output_channel_names = std::move(resolved.names);
            }
            result.push_back(std::move(d));
        }
    }
    const double total_ms = std::chrono::duration<double, std::milli>(clk::now() - t_start).count();
    device_debug_log("[LT_AUDIO_DEBUG] list_devices total_ms=%.1f total_devices=%d\n",
                 total_ms, static_cast<int>(result.size()));
    return result;
}

Result<void> AudioDeviceManager::open_device(const DeviceOpenRequest& request,
                                               AudioRenderCallback* callback) {
    using clk = std::chrono::steady_clock;
    const auto t_open = clk::now();
    device_debug_log("[LT_AUDIO_DEBUG] open_device begin device_id=\"%s\" sr=%d bs=%d active_channels=%zu\n",
                 request.device_id.c_str(), request.sample_rate, request.buffer_size,
                 request.active_output_channels.size());
    close_device();

    auto init = ensure_initialized(*impl_);
    if (init.is_err())
        return init;

    impl_->user_callback = callback;
    impl_->adaptor = std::make_unique<JuceCallbackAdaptor>(callback);

    if (!request.device_id.empty()) {
        auto [backend, device_name] = split_device_id(request.device_id);
        if (!backend.empty()) {
            // setCurrentAudioDeviceType(name, treatAsChosenDevice=false):
            // we pass `false` so JUCE only switches the backend without
            // also trying to open a device. The actual open happens
            // below through setAudioDeviceSetup with the explicit
            // outputDeviceName we want. Passing `true` here used to make
            // JUCE pick whatever device its internal heuristic decided
            // (often the previous backend's stale "primary" alias),
            // producing nonsensical errors like
            // "Error opening Controlador primario de sonido" when the
            // caller actually asked for Razer Kraken.
            impl_->juce_manager.setCurrentAudioDeviceType(juce::String(backend), false);
        }
    } else {
        select_preferred_default_device_type(impl_->juce_manager);
    }

    auto setup = impl_->juce_manager.getAudioDeviceSetup();
    if (!request.device_id.empty()) {
        auto [_backend, device_name] = split_device_id(request.device_id);
        setup.outputDeviceName = juce::String(device_name);
    } else {
        // "System default" path. The user asked for whatever Windows
        // currently treats as the default playback device.
        //
        // We can't just leave `outputDeviceName` empty here — JUCE
        // interprets the empty string as the literal device name
        // "" and refuses to open anything, which is exactly the
        // reported bug ("predeterminado no funciona, pero el Razer
        // concreto si").
        //
        // The correct way to ask JUCE for the OS default is to
        // resolve the current backend's default device NAME ourselves
        // (Windows updates this automatically when the user changes
        // the system default device — e.g. swaps to the Razer
        // headset), then set `outputDeviceName` to that string.
        // setAudioDeviceSetup then opens that specific device, which
        // is what "system default" means in practice.
        auto* current_type = impl_->juce_manager.getCurrentDeviceTypeObject();
        if (current_type) {
            // Make sure scanForDevices ran on the now-current type so
            // getDefaultDeviceIndex returns a meaningful position even
            // right after we switched backends.
            current_type->scanForDevices();
            const auto names = current_type->getDeviceNames(false);
            const int default_index =
                current_type->getDefaultDeviceIndex(false);
            if (default_index >= 0 && default_index < names.size()) {
                setup.outputDeviceName = names[default_index];
            } else if (names.size() > 0) {
                // No explicit default — fall back to the first device
                // the driver exposes.
                setup.outputDeviceName = names[0];
            } else {
                setup.outputDeviceName = juce::String();
            }
        } else {
            setup.outputDeviceName = juce::String();
        }
    }
    // Always reset input — we are an output-only app, but JUCE's
    // setAudioDeviceSetup will refuse the call if input config is
    // stale from the previous backend (e.g. a microphone name that
    // doesn't exist in the new backend). Clearing it up front means
    // the only constraint that has to be satisfiable is the output.
    setup.inputDeviceName = juce::String();
    setup.inputChannels.clear();
    setup.useDefaultInputChannels = false;
    setup.outputChannels.clear();
    if (request.active_output_channels.empty()) {
        for (int ch = 0; ch < 2; ++ch)
            setup.outputChannels.setBit(ch);
    } else {
        for (int ch : request.active_output_channels) {
            if (ch >= 0)
                setup.outputChannels.setBit(ch);
        }
    }
    setup.useDefaultOutputChannels = false;
    if (request.sample_rate > 0) {
        // For backends that misreport their rate (DirectSound primary / MME),
        // only force the requested SR if the device actually advertises it.
        // Otherwise leave setup.sampleRate at the device default so JUCE opens
        // — and reports — the real OS-mixer rate. This is what makes the
        // engine's SR-change detection fire and re-decode sources correctly;
        // without it, switching to the "Controlador primario de sonido" leaves
        // sources at the old rate and playback drifts slow/fast.
        const auto current_type = impl_->juce_manager.getCurrentAudioDeviceType().toStdString();
        if (backend_lies_about_sample_rate(current_type)) {
            if (requested_rate_is_supported(
                    impl_->juce_manager.getCurrentDeviceTypeObject(),
                    setup.outputDeviceName, request.sample_rate)) {
                setup.sampleRate = request.sample_rate;
            } else {
                device_debug_log(
                    "[LT_AUDIO_DEBUG] open_device: backend \"%s\" does not advertise "
                    "%d Hz; leaving SR at device default to avoid silent OS resample\n",
                    current_type.c_str(), request.sample_rate);
                // Leave setup.sampleRate untouched (device default).
            }
        } else {
            setup.sampleRate = request.sample_rate;
        }
    }
    setup.bufferSize = request.buffer_size > 0
        ? request.buffer_size
        : kDefaultLowLatencyBufferSize;

    if (device_debug_enabled()) {
        const auto current_type = impl_->juce_manager.getCurrentAudioDeviceType();
        fprintf(stderr,
                "[LT_AUDIO_DEBUG] open_device -> setAudioDeviceSetup with backend=\"%s\" "
                "outputDeviceName=\"%s\" sampleRate=%.0f bufferSize=%d "
                "outputChannels(bits)=%d\n",
                current_type.toRawUTF8(),
                setup.outputDeviceName.toRawUTF8(),
                setup.sampleRate, setup.bufferSize,
                setup.outputChannels.countNumberOfSetBits());
    }
    const auto t_setup = clk::now();
    juce::String err = impl_->juce_manager.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty() && device_debug_enabled()) {
        // Inspect what JUCE actually picked when our request was
        // rejected. Helps explain mismatches like "asked for device A,
        // got 'primary X' in the error message". The hard error itself
        // is surfaced from the SetOutputDevice command handler so the
        // user always sees it; only the post-failure diagnostic dump
        // is gated behind the debug flag.
        auto post = impl_->juce_manager.getAudioDeviceSetup();
        fprintf(stderr,
                "[LT_AUDIO_DEBUG] open_device setAudioDeviceSetup err=\"%s\" "
                "post.outputDeviceName=\"%s\" post.sampleRate=%.0f post.bufferSize=%d\n",
                err.toRawUTF8(), post.outputDeviceName.toRawUTF8(),
                post.sampleRate, post.bufferSize);
    }
    if (err.isNotEmpty() && request.buffer_size <= 0) {
        setup.bufferSize = 0;
        err = impl_->juce_manager.setAudioDeviceSetup(setup, true);
    }
    const double setup_ms = std::chrono::duration<double, std::milli>(clk::now() - t_setup).count();
    device_debug_log("[LT_AUDIO_DEBUG] open_device setAudioDeviceSetup_ms=%.1f err=\"%s\"\n",
                 setup_ms, err.isEmpty() ? "" : err.toRawUTF8());
    if (err.isNotEmpty()) {
        impl_->last_error = err.toStdString();
        return Result<void>::err(impl_->last_error);
    }

    auto* dev = impl_->juce_manager.getCurrentAudioDevice();
    if (!dev)
        return Result<void>::err("No audio device opened after setup");

    impl_->device_name  = dev->getName().toStdString();
    impl_->backend      = dev->getTypeName().toStdString();
    impl_->sample_rate  = static_cast<int>(dev->getCurrentSampleRate());
    impl_->buffer_size  = dev->getCurrentBufferSizeSamples();
    impl_->output_latency_samples = dev->getOutputLatencyInSamples();
    impl_->output_channel_names.clear();
    auto names = dev->getOutputChannelNames();
    for (const auto& name : names)
        impl_->output_channel_names.push_back(name.toStdString());
    impl_->output_channel_count = static_cast<int>(impl_->output_channel_names.size());
    if (impl_->output_channel_count <= 0) {
        auto resolved = device_layout::resolve_layout(
            impl_->output_channel_count, std::move(impl_->output_channel_names));
        impl_->output_channel_count = resolved.count;
        impl_->output_channel_names = std::move(resolved.names);
    }

    impl_->juce_manager.addAudioCallback(impl_->adaptor.get());
    const double total_ms = std::chrono::duration<double, std::milli>(clk::now() - t_open).count();
    device_debug_log("[LT_AUDIO_DEBUG] open_device done total_ms=%.1f device=\"%s\" backend=\"%s\" sr=%d bs=%d channels=%d\n",
                 total_ms, impl_->device_name.c_str(), impl_->backend.c_str(),
                 impl_->sample_rate, impl_->buffer_size, impl_->output_channel_count);
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::close_device() {
    if (impl_->adaptor) {
        impl_->juce_manager.removeAudioCallback(impl_->adaptor.get());
        impl_->adaptor.reset();
    }
    impl_->juce_manager.closeAudioDevice();
    impl_->user_callback = nullptr;
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::start() {
    // JUCE starts the callback as soon as the device is opened and the
    // callback is added.  This is a no-op for the JUCE backend.
    return Result<void>::ok();
}

Result<void> AudioDeviceManager::stop() {
    // Stopping without closing: remove callback, keep device open.
    if (impl_->adaptor)
        impl_->juce_manager.removeAudioCallback(impl_->adaptor.get());
    return Result<void>::ok();
}

int AudioDeviceManager::actual_sample_rate()  const { return impl_->sample_rate; }
int AudioDeviceManager::actual_buffer_size()  const { return impl_->buffer_size; }
int AudioDeviceManager::actual_output_latency_samples() const { return impl_->output_latency_samples; }
std::string AudioDeviceManager::actual_device_name() const { return impl_->device_name; }
std::string AudioDeviceManager::actual_backend()      const { return impl_->backend; }

DeviceInfo AudioDeviceManager::device_info() const {
    DeviceInfo info;
    info.device_id   = impl_->device_name.empty() ? std::string{} : make_device_id(impl_->backend, impl_->device_name);
    info.device_name = impl_->device_name;
    info.backend     = impl_->backend;
    info.sample_rate = impl_->sample_rate;
    info.buffer_size = impl_->buffer_size;
    info.output_channel_count = impl_->output_channel_count;
    info.output_channel_names = impl_->output_channel_names;
    info.last_error  = impl_->last_error;
    if (impl_->adaptor && impl_->adaptor->has_error())
        info.last_error = impl_->adaptor->last_error();
    return info;
}

} // namespace lt

#else // LT_ENGINE_USE_JUCE=0 - stub implementation

namespace lt {

struct AudioDeviceManager::Impl {
    DeviceOpenRequest request;
    bool open = false;
    int output_channel_count = 2;
};

AudioDeviceManager::AudioDeviceManager()  : impl_(std::make_unique<Impl>()) {}
AudioDeviceManager::~AudioDeviceManager() = default;

std::vector<DeviceDescriptor> AudioDeviceManager::list_devices() const {
    DeviceDescriptor descriptor;
    descriptor.id = "stub-default";
    descriptor.name = "C++ v2 stub output";
    descriptor.backend = "stub";
    descriptor.output_channel_count = 2;
    descriptor.output_channel_names = {"Out 1", "Out 2"};
    descriptor.supported_sample_rates = { 44100, 48000 };
    descriptor.supported_buffer_sizes = { 128, 256, 512, 1024 };
    return { descriptor };
}

Result<void> AudioDeviceManager::open_device(const DeviceOpenRequest& request, AudioRenderCallback*) {
    impl_->request = request;
    impl_->open = true;
    return Result<void>::ok();
}
Result<void> AudioDeviceManager::close_device() {
    impl_->open = false;
    return Result<void>::ok();
}
Result<void> AudioDeviceManager::start()        { return Result<void>::ok(); }
Result<void> AudioDeviceManager::stop()         { return Result<void>::ok(); }

int         AudioDeviceManager::actual_sample_rate()  const { return impl_->request.sample_rate > 0 ? impl_->request.sample_rate : 48000; }
int         AudioDeviceManager::actual_buffer_size()  const { return impl_->request.buffer_size > 0 ? impl_->request.buffer_size : 512; }
int         AudioDeviceManager::actual_output_latency_samples() const { return 0; }
std::string AudioDeviceManager::actual_device_name()  const { return impl_->request.device_id.empty() ? "C++ v2 stub output" : impl_->request.device_id; }
std::string AudioDeviceManager::actual_backend()      const { return "stub"; }
DeviceInfo AudioDeviceManager::device_info() const {
    DeviceInfo info;
    info.device_id = impl_->request.device_id.empty() ? "stub-default" : impl_->request.device_id;
    info.device_name = actual_device_name();
    info.backend = actual_backend();
    info.sample_rate = actual_sample_rate();
    info.buffer_size = actual_buffer_size();
    info.output_channel_count = 2;
    info.output_channel_names = {"Out 1", "Out 2"};
    return info;
}

} // namespace lt

#endif // LT_ENGINE_USE_JUCE
