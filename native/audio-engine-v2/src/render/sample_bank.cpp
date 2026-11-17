#include <lt_engine/render/sample_bank.h>
#include <lt_engine/sources/audio_decoder.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <unordered_map>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

namespace lt {

namespace {

std::atomic<int> g_destroyed_versions{0};
std::atomic<std::thread::id> g_last_destroy_thread{};

std::string format_megabytes(std::size_t bytes) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.1f MB", static_cast<double>(bytes) / (1024.0 * 1024.0));
    return buf;
}

} // namespace

SampleBankVersion::~SampleBankVersion() {
    g_destroyed_versions.fetch_add(1, std::memory_order_acq_rel);
    g_last_destroy_thread.store(std::this_thread::get_id(), std::memory_order_release);
}

int SampleBankVersion::debug_destroyed_count() noexcept {
    return g_destroyed_versions.load(std::memory_order_acquire);
}

std::thread::id SampleBankVersion::debug_last_destroy_thread() noexcept {
    return g_last_destroy_thread.load(std::memory_order_acquire);
}

bool sample_load_request_from_json(const std::string& text, SampleLoadRequest& out,
                                   std::string* error) {
    try {
        const auto j = nlohmann::json::parse(text);
        out = SampleLoadRequest{};
        if (j.contains("maxBytes") && j["maxBytes"].is_number())
            out.max_bytes = j["maxBytes"].get<std::size_t>();
        if (j.contains("sampleRate") && j["sampleRate"].is_number())
            out.sample_rate = j["sampleRate"].get<int>();
        if (j.contains("samples") && j["samples"].is_array()) {
            for (const auto& item : j["samples"]) {
                SampleLoadEntry entry;
                entry.slot = item.value("slot", -1);
                entry.path = item.value("path", std::string{});
                out.entries.push_back(std::move(entry));
            }
        }
        return true;
    } catch (const std::exception& e) {
        if (error) *error = e.what();
        return false;
    }
}

std::string sample_load_result_to_json(const SampleLoadResult& result) {
    nlohmann::json j;
    j["ok"] = result.ok;
    if (!result.error.empty()) j["error"] = result.error;
    j["totalBytes"] = result.total_bytes;
    j["sampleRate"] = result.sample_rate;
    auto entries = nlohmann::json::array();
    for (const auto& e : result.entries) {
        nlohmann::json item;
        item["slot"] = e.slot;
        item["ok"] = e.ok;
        if (!e.error.empty()) item["error"] = e.error;
        item["channels"] = e.channels;
        item["frames"] = e.frames;
        entries.push_back(std::move(item));
    }
    j["entries"] = std::move(entries);
    return j.dump();
}

std::size_t default_sample_bank_max_bytes() noexcept {
#if defined(__ANDROID__) || (defined(__APPLE__) && TARGET_OS_IPHONE)
    return std::size_t{48} * 1024 * 1024;
#else
    return std::size_t{96} * 1024 * 1024;
#endif
}

SampleBank::SampleBank() : max_bytes_(default_sample_bank_max_bytes()) {}

SampleBank::~SampleBank() {
    // Al destruir el banco ya no hay render en marcha.
    delete current_.exchange(nullptr, std::memory_order_acq_rel);
}

void SampleBank::set_max_bytes(std::size_t bytes) noexcept {
    max_bytes_.store(bytes, std::memory_order_relaxed);
}

std::size_t SampleBank::max_bytes() const noexcept {
    return max_bytes_.load(std::memory_order_relaxed);
}

std::shared_ptr<Sample> SampleBank::decode_sample(const std::string& path,
                                                  int sample_rate,
                                                  std::string* error) {
    int channels = 0;
    Frame duration = 0;
    auto decoded = decode_file_to_float32(path, sample_rate, &channels, &duration);
    if (!decoded.is_ok() || channels <= 0) {
        if (error) *error = decoded.is_ok() ? std::string("no audio channels") : decoded.error();
        return nullptr;
    }
    auto sample = std::make_shared<Sample>();
    sample->sample_rate = sample_rate;
    if (channels <= 2) {
        sample->channels = channels;
        sample->data = decoded.take();
    } else {
        const std::vector<float>& in = decoded.unwrap();
        // Más de dos canales: mezcla a estéreo (pares a la izquierda, impares
        // a la derecha), como los pads.
        const std::size_t frames = in.size() / static_cast<std::size_t>(channels);
        sample->channels = 2;
        sample->data.assign(frames * 2, 0.0f);
        const int left_count = (channels + 1) / 2;
        const int right_count = channels / 2;
        for (std::size_t f = 0; f < frames; ++f) {
            float l = 0.0f, r = 0.0f;
            for (int c = 0; c < channels; ++c) {
                const float s = in[f * static_cast<std::size_t>(channels) + static_cast<std::size_t>(c)];
                if (c % 2 == 0) l += s; else r += s;
            }
            sample->data[f * 2] = l / static_cast<float>(left_count);
            sample->data[f * 2 + 1] = r / static_cast<float>(right_count);
        }
    }
    sample->frames = static_cast<Frame>(sample->data.size() / static_cast<std::size_t>(sample->channels));
    if (sample->frames <= 0) {
        if (error) *error = "empty audio";
        return nullptr;
    }
    return sample;
}

SampleLoadResult SampleBank::load(const std::vector<SampleLoadEntry>& entries, int sample_rate) {
    SampleLoadResult result;
    result.sample_rate = sample_rate;
    if (sample_rate <= 0) {
        result.error = "invalid sample rate";
        return result;
    }

    // Muestras ya cargadas a esta SR que se pueden reutilizar sin decodificar.
    // Se copian los shared_ptr bajo el mutex: la versión actual no se puede
    // liberar mientras tanto porque solo se libera con el mutex tomado.
    std::unordered_map<std::string, std::shared_ptr<const Sample>> reusable;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const SampleBankVersion* current = current_.load(std::memory_order_acquire);
        if (current && current->sample_rate == sample_rate) {
            for (std::size_t i = 0; i < current->slots.size(); ++i) {
                if (current->slots[i] && i < current->paths.size())
                    reusable.emplace(current->paths[i], current->slots[i]);
            }
        }
    }

    // La parte lenta, sin mutex: decodificar no frena a quien recolecta.
    auto next = std::make_unique<SampleBankVersion>();
    next->sample_rate = sample_rate;
    std::unordered_map<std::string, std::shared_ptr<const Sample>> decoded_now;
    std::unordered_map<const Sample*, bool> counted;
    for (const auto& entry : entries) {
        SampleLoadEntryResult item;
        item.slot = entry.slot;
        if (entry.slot < 0 || entry.slot > 4095) {
            item.error = "invalid slot";
            result.entries.push_back(std::move(item));
            continue;
        }
        std::shared_ptr<const Sample> sample;
        if (auto it = decoded_now.find(entry.path); it != decoded_now.end()) {
            sample = it->second;
        } else if (auto reuse = reusable.find(entry.path); reuse != reusable.end()) {
            sample = reuse->second;
        } else {
            std::string error;
            sample = decode_sample(entry.path, sample_rate, &error);
            if (!sample) {
                item.error = error.empty() ? std::string("decode failed") : error;
                result.entries.push_back(std::move(item));
                continue;
            }
        }
        decoded_now[entry.path] = sample;
        const std::size_t slot = static_cast<std::size_t>(entry.slot);
        if (next->slots.size() <= slot) {
            next->slots.resize(slot + 1);
            next->paths.resize(slot + 1);
        }
        next->slots[slot] = sample;
        next->paths[slot] = entry.path;
        if (!counted[sample.get()]) {
            counted[sample.get()] = true;
            next->total_bytes += sample->bytes();
        }
        item.ok = true;
        item.channels = sample->channels;
        item.frames = sample->frames;
        result.entries.push_back(std::move(item));
    }
    result.total_bytes = next->total_bytes;

    const std::size_t cap = max_bytes();
    if (next->total_bytes > cap) {
        result.error = "sample bank over memory limit: " + format_megabytes(next->total_bytes)
                     + " > " + format_megabytes(cap);
        return result;  // el banco publicado no cambia
    }

    publish(std::move(next));
    result.ok = true;
    return result;
}

SampleLoadResult SampleBank::reload_for_sample_rate(int sample_rate) {
    std::vector<SampleLoadEntry> entries;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const SampleBankVersion* current = current_.load(std::memory_order_acquire);
        if (!current || current->sample_rate == sample_rate) {
            SampleLoadResult unchanged;
            unchanged.ok = true;
            unchanged.sample_rate = current ? current->sample_rate : sample_rate;
            unchanged.total_bytes = current ? current->total_bytes : 0;
            return unchanged;
        }
        for (std::size_t i = 0; i < current->paths.size(); ++i) {
            if (current->slots[i]) entries.push_back({static_cast<int>(i), current->paths[i]});
        }
    }
    return load(entries, sample_rate);
}

void SampleBank::publish(std::unique_ptr<SampleBankVersion> next) {
    std::lock_guard<std::mutex> lock(mutex_);
    SampleBankVersion* old = current_.exchange(next.release(), std::memory_order_seq_cst);
    if (old) retired_.emplace_back(old);
    // collect_retired toma el mutex: se recolecta aquí mismo sin volver a
    // tomarlo.
    auto in_use = [this](const SampleBankVersion* v) {
        return hazard_.load(std::memory_order_seq_cst) == v
            || v->active_voices.load(std::memory_order_seq_cst) > 0;
    };
    retired_.erase(std::remove_if(retired_.begin(), retired_.end(),
                                  [&](const std::unique_ptr<SampleBankVersion>& v) {
                                      return !in_use(v.get());
                                  }),
                   retired_.end());
}

void SampleBank::collect_retired() {
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return;  // otra publicación en curso: la próxima vez
    // Primero el puntero de peligro y luego las voces: el hilo de audio
    // incrementa las voces ANTES de soltar el puntero, así que si ya no lo
    // señala, el contador está al día (orden seq_cst en los dos lados).
    retired_.erase(std::remove_if(retired_.begin(), retired_.end(),
                                  [this](const std::unique_ptr<SampleBankVersion>& v) {
                                      return hazard_.load(std::memory_order_seq_cst) != v.get()
                                          && v->active_voices.load(std::memory_order_seq_cst) == 0;
                                  }),
                   retired_.end());
}

std::size_t SampleBank::retired_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return retired_.size();
}

const SampleBankVersion* SampleBank::current_for_diagnostics() const noexcept {
    return current_.load(std::memory_order_acquire);
}

const SampleBankVersion* SampleBank::acquire() noexcept {
    // Puntero de peligro clásico: publicar y validar. Solo repite si una
    // publicación cae justo entre las dos lecturas.
    SampleBankVersion* p = current_.load(std::memory_order_seq_cst);
    for (;;) {
        hazard_.store(p, std::memory_order_seq_cst);
        SampleBankVersion* q = current_.load(std::memory_order_seq_cst);
        if (q == p) return p;
        p = q;
    }
}

void SampleBank::end_block() noexcept {
    hazard_.store(nullptr, std::memory_order_seq_cst);
}

void SampleBank::retain(const SampleBankVersion* version) noexcept {
    if (version) version->active_voices.fetch_add(1, std::memory_order_seq_cst);
}

void SampleBank::release(const SampleBankVersion* version) noexcept {
    if (version) version->active_voices.fetch_sub(1, std::memory_order_seq_cst);
}

} // namespace lt
