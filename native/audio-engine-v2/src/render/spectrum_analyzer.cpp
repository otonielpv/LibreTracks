#include <lt_engine/render/spectrum_analyzer.h>

#include <signalsmith-dsp/fft.h>

#include <algorithm>
#include <cmath>
#include <complex>

namespace lt {

void AnalyzerTap::write(const float* left, const float* right, std::size_t frames) noexcept {
    if (left == nullptr || right == nullptr || frames == 0)
        return;
    std::uint64_t index = written_.load(std::memory_order_relaxed);
    for (std::size_t i = 0; i < frames; ++i, ++index)
        samples_[index & (kCapacity - 1)].store(0.5f * (left[i] + right[i]), std::memory_order_relaxed);
    written_.store(index, std::memory_order_release);
}

bool AnalyzerTap::read_latest(float* out, std::size_t count, std::uint64_t* written) const noexcept {
    const std::uint64_t end = written_.load(std::memory_order_acquire);
    if (written) *written = end;
    if (count == 0 || count > kCapacity || end < count)
        return false;
    const std::uint64_t start = end - count;
    for (std::size_t i = 0; i < count; ++i)
        out[i] = samples_[(start + i) & (kCapacity - 1)].load(std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_acquire);
    // Si el productor avanzó tanto que pudo pisar la ventana, no vale.
    const std::uint64_t after = written_.load(std::memory_order_relaxed);
    return after - start <= kCapacity;
}

double spectrum_band_center_hz(std::size_t band, std::size_t band_count) {
    if (band_count <= 1)
        return 1000.0;
    const double t = static_cast<double>(band) / static_cast<double>(band_count - 1);
    return 20.0 * std::pow(1000.0, t);
}

struct SpectrumAnalyzer::Impl {
    signalsmith::fft::RealFFT<float> fft{ kFftSize };
    std::vector<float> window = std::vector<float>(kFftSize);
    std::vector<float> input = std::vector<float>(kFftSize);
    std::vector<std::complex<float>> spectrum = std::vector<std::complex<float>>(kFftSize / 2);
    std::vector<float> power = std::vector<float>(kFftSize / 2);
    std::array<float, kBands> bands{};
    bool primed = false;

    Impl() {
        constexpr double kPi = 3.14159265358979323846;
        for (std::size_t i = 0; i < kFftSize; ++i)
            window[i] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i)
                                                                 / static_cast<double>(kFftSize)));
        bands.fill(kFloorDb);
    }
};

SpectrumAnalyzer::SpectrumAnalyzer() : impl_(std::make_unique<Impl>()) {}
SpectrumAnalyzer::~SpectrumAnalyzer() = default;

void SpectrumAnalyzer::reset() {
    impl_->bands.fill(kFloorDb);
    impl_->primed = false;
}

std::size_t SpectrumAnalyzer::analyze(const AnalyzerTap& tap, double sample_rate,
                                      double elapsed_seconds, float* out, std::size_t capacity) {
    if (capacity == 0 || out == nullptr)
        return 0;
    Impl& s = *impl_;
    const double rate = sample_rate > 0.0 ? sample_rate : 48000.0;
    const float release = static_cast<float>(std::max(0.0, elapsed_seconds) * kReleaseDbPerSecond);

    std::array<float, kBands> fresh;
    fresh.fill(kFloorDb);
    if (tap.read_latest(s.input.data(), kFftSize, nullptr)) {
        for (std::size_t i = 0; i < kFftSize; ++i)
            s.input[i] *= s.window[i];
        s.fft.fft(s.input.data(), s.spectrum.data());
        // Seno de amplitud A con Hann: |X| ≈ A·N/4 → 0 dB a fondo de escala.
        const float scale = 4.0f / static_cast<float>(kFftSize);
        s.power[0] = 0.0f;   // el bin 0 empaqueta DC y Nyquist
        for (std::size_t k = 1; k < kFftSize / 2; ++k) {
            const float magnitude = std::abs(s.spectrum[k]) * scale;
            s.power[k] = magnitude * magnitude;
        }
        const double bin_hz = rate / static_cast<double>(kFftSize);
        const double half_band = std::pow(1000.0, 0.5 / static_cast<double>(kBands - 1));
        for (std::size_t b = 0; b < kBands; ++b) {
            const double center = spectrum_band_center_hz(b, kBands);
            const double lo = center / half_band;
            const double hi = center * half_band;
            const auto first = static_cast<std::size_t>(std::max(1.0, std::ceil(lo / bin_hz)));
            const auto last = static_cast<std::size_t>(std::min(static_cast<double>(kFftSize / 2 - 1),
                                                                std::floor(hi / bin_hz)));
            float peak = 0.0f;
            if (first <= last) {
                for (std::size_t k = first; k <= last; ++k)
                    peak = std::max(peak, s.power[k]);
            } else {
                // Banda más estrecha que un bin (graves): interpola en su centro.
                const double position = center / bin_hz;
                const auto k0 = static_cast<std::size_t>(std::clamp(std::floor(position), 1.0,
                                                                    static_cast<double>(kFftSize / 2 - 2)));
                const float frac = static_cast<float>(std::clamp(position - static_cast<double>(k0), 0.0, 1.0));
                peak = s.power[k0] + (s.power[k0 + 1] - s.power[k0]) * frac;
            }
            fresh[b] = peak > 0.0f ? std::max(kFloorDb, 10.0f * std::log10(peak)) : kFloorDb;
        }
    }

    for (std::size_t b = 0; b < kBands; ++b) {
        const float decayed = s.primed ? std::max(kFloorDb, s.bands[b] - release) : kFloorDb;
        s.bands[b] = std::max(fresh[b], decayed);
    }
    s.primed = true;
    const std::size_t count = std::min(capacity, kBands);
    std::copy_n(s.bands.begin(), count, out);
    return count;
}

} // namespace lt
