#include <lt_engine/devices/audio_device_manager.h>

#ifdef LT_USE_JUCE

// JUCE headers — must come after lt_engine headers to avoid name collisions.
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>

#include <atomic>
#include <chrono>
#include <mutex>

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
            render_cb_->render(output_channels,
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

    // Last successfully opened device info.
    std::string  device_name;
    std::string  backend;
    int          sample_rate = 0;
    int          buffer_size = 0;
    std::string  last_error;
};

// ---------------------------------------------------------------------------
AudioDeviceManager::AudioDeviceManager() : impl_(std::make_unique<Impl>()) {
    // juce_manager initialises lazily on first open.
}

AudioDeviceManager::~AudioDeviceManager() {
    close_device();
}

std::vector<DeviceDescriptor> AudioDeviceManager::list_devices() const {
    std::vector<DeviceDescriptor> result;

    auto& mgr = impl_->juce_manager;
    for (auto* type : mgr.getAvailableDeviceTypes()) {
        const juce::String backend_name = type->getTypeName();
        type->scanForDevices();
        auto names = type->getDeviceNames(false); // false = output devices
        for (const auto& name : names) {
            DeviceDescriptor d;
            d.id      = name.toStdString();
            d.name    = name.toStdString();
            d.backend = backend_name.toStdString();
            result.push_back(std::move(d));
        }
    }
    return result;
}

Result<void> AudioDeviceManager::open_device(const DeviceOpenRequest& request,
                                               AudioRenderCallback* callback) {
    close_device();

    impl_->user_callback = callback;
    impl_->adaptor = std::make_unique<JuceCallbackAdaptor>(callback);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    if (!request.device_id.empty())
        setup.outputDeviceName = juce::String(request.device_id);
    if (request.sample_rate > 0)
        setup.sampleRate = request.sample_rate;
    if (request.buffer_size > 0)
        setup.bufferSize = request.buffer_size;

    juce::String err = impl_->juce_manager.setAudioDeviceSetup(setup, true);
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

    impl_->juce_manager.addAudioCallback(impl_->adaptor.get());
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
std::string AudioDeviceManager::actual_device_name() const { return impl_->device_name; }
std::string AudioDeviceManager::actual_backend()      const { return impl_->backend; }

DeviceInfo AudioDeviceManager::device_info() const {
    DeviceInfo info;
    info.device_name = impl_->device_name;
    info.backend     = impl_->backend;
    info.sample_rate = impl_->sample_rate;
    info.buffer_size = impl_->buffer_size;
    info.last_error  = impl_->last_error;
    if (impl_->adaptor && impl_->adaptor->has_error())
        info.last_error = impl_->adaptor->last_error();
    return info;
}

} // namespace lt

#else // LT_USE_JUCE not defined — stub implementation

namespace lt {

struct AudioDeviceManager::Impl {};

AudioDeviceManager::AudioDeviceManager()  : impl_(std::make_unique<Impl>()) {}
AudioDeviceManager::~AudioDeviceManager() = default;

std::vector<DeviceDescriptor> AudioDeviceManager::list_devices() const { return {}; }

Result<void> AudioDeviceManager::open_device(const DeviceOpenRequest&, AudioRenderCallback*) {
    return Result<void>::err("JUCE not enabled in this build (LT_ENGINE_USE_JUCE=OFF)");
}
Result<void> AudioDeviceManager::close_device() { return Result<void>::ok(); }
Result<void> AudioDeviceManager::start()        { return Result<void>::ok(); }
Result<void> AudioDeviceManager::stop()         { return Result<void>::ok(); }

int         AudioDeviceManager::actual_sample_rate()  const { return 0; }
int         AudioDeviceManager::actual_buffer_size()  const { return 0; }
std::string AudioDeviceManager::actual_device_name()  const { return ""; }
std::string AudioDeviceManager::actual_backend()      const { return "stub"; }
DeviceInfo  AudioDeviceManager::device_info()         const { return {}; }

} // namespace lt

#endif // LT_USE_JUCE
