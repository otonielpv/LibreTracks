#pragma once

#include <lt_engine/core/types.h>
#include <lt_engine/core/snapshot.h>
#include <lt_engine/session/session.h>
#include <lt_engine/sources/source_manager.h>
#include <lt_engine/render/track_renderer.h>
#include <lt_engine/render/fade_processor.h>
#include <lt_engine/render/metronome_renderer.h>
#include <lt_engine/render/voice_guide_renderer.h>
#include <lt_engine/render/pad_renderer.h>
#include <lt_engine/render/render_thread_pool.h>
#include <lt_engine/devices/audio_device_manager.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <array>
#include <atomic>
#include <cstdlib>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace lt {

// ---------------------------------------------------------------------------
// Mixer — JUCE AudioRenderCallback implementation.
//
// Owns a TrackRenderer per track and mixes all tracks to stereo output.
// Realtime-safe: no allocations, no locks in render().
// ---------------------------------------------------------------------------
class Mixer : public AudioRenderCallback {
public:
    Mixer(const Session*       session,
          const SourceManager* sources,
          TransportClock*      clock,
          JumpScheduler*       scheduler);

    Mixer(std::shared_ptr<const Session> session,
          const SourceManager* sources,
          TransportClock* clock,
          JumpScheduler* scheduler);

    // Called by the JUCE audio thread.
    void set_active_output_channels(const std::vector<int>& channels) noexcept override;
    void render(float** output_channels,
                int     num_channels,
                int     num_frames,
                double  sample_rate) noexcept override;

    // Called from command thread to update track gain/mute/solo atomically.
    // Changes take effect at the next render block.
    void set_track_gain(const Id& track_id, Gain gain);
    void set_track_pan(const Id& track_id, float pan);
    void set_track_mute(const Id& track_id, bool mute);
    void set_track_solo(const Id& track_id, bool solo);
    void start_master_fade(float target_gain, double duration_seconds) noexcept;
    // preserve_realtime_state=true: keep existing gain/pan/mute/solo atomics for known tracks
    //   (used for session pointer swaps during transpose/region changes — slider state survives).
    // preserve_realtime_state=false: always load values from session
    //   (used after LoadSession — the session IS the source of truth for mixer values).
    void set_session(std::shared_ptr<const Session> session, bool preserve_realtime_state = true);
    // Atomic-only swap: replace the active session pointer without
    // rebuilding control slots or resizing renderer scratch. Use for
    // changes that only affect per-block reads (e.g. warp source BPM,
    // tempo edits) — anything that adds/removes tracks or changes their
    // identity needs the full set_session() path.
    void swap_session_atomic(std::shared_ptr<const Session> session) noexcept;
    void set_bungee_voice_manager(class BungeeVoiceManager* mgr) noexcept;
    void clear_session();
    void prepare_render_resources(int max_block_frames) noexcept;

    // Pool de render (paso 08). Solo desde la HEBRA DE CONTROL, nunca durante
    // un bloque. threads <= 1 deja el camino serie exacto de siempre.
    void set_render_thread_count(int threads);
    RenderThreadPoolDiagnostics render_pool_diagnostics() const noexcept;
    void trigger_crossfade() noexcept;
    void set_metronome_config(const MetronomeConfig& config);
    void set_metronome_enabled(bool enabled);
    void set_metronome_volume(float volume);
    MetronomeDiagnostics metronome_diagnostics() const;

    void set_voice_guide_config(const VoiceGuideConfig& config);
    void set_voice_guide_enabled(bool enabled);
    void set_voice_guide_clip_bank(std::shared_ptr<const VoiceGuideClipBank> bank) noexcept;
    VoiceGuideDiagnostics voice_guide_diagnostics() const;

    void set_pad_config(const PadConfig& config);
    void set_pad_enabled(bool enabled);
    void set_pad_transport_gate(bool open);
    void set_pad_volume(float volume);
    void set_pad_clip(std::shared_ptr<const PadClip> clip) noexcept;
    PadDiagnostics pad_diagnostics() const;
    // Build the voice-guide announce target from the next pending scheduled jump
    // (so the destination section is spoken before the jump fires). Empty target
    // when no announceable jump is pending.
    VoiceGuideTarget announceable_jump_target(const Session* session) const noexcept;

    // Meter read (from UI thread — relaxed atomic).
    MeterValues meters() const noexcept;

#if LT_ENGINE_ENABLE_E2E_CAPTURE
    // Compiled only into the WebDriver E2E binary.
    std::size_t capture_output_samples(std::vector<float>& out,
                                       int& sample_rate_out) const;
#endif
    std::vector<TrackMeterValues> track_meters() const;
    std::vector<RegionMeterValues> region_meters() const;

    // Diagnostic counters.
    int    callback_count()          const noexcept;
    double callback_duration_ms()    const noexcept;
    double callback_duration_max_ms() const noexcept;
    // Smoothed audio-thread load as a % of the per-buffer time budget
    // (Ableton's transport CPU meter; >100% means dropouts).
    double callback_load_percent()   const noexcept;
    // Read-and-reset the worst callback duration; lets a periodic diagnostic
    // report the peak per window instead of the stuck session-wide maximum.
    double take_callback_duration_max_ms() noexcept {
        return callback_duration_max_ms_.exchange(0.0, std::memory_order_relaxed);
    }
    std::uint64_t callback_over_budget_count() const noexcept;
    std::uint64_t rendered_track_count() const noexcept;
    std::uint64_t skipped_track_count() const noexcept;
    std::uint64_t scheduled_jump_executed_count() const noexcept;

    // Called from the control thread to check if a scheduled jump executed inside the audio
    // callback since the last call. Returns the target frame if one did, or -1 otherwise.
    // The control thread must then call prepare_for_transport_discontinuity for that frame.
    // This is the mechanism that ensures pitch streams are primed before a scheduled jump
    // becomes audible — the jump fires in the audio callback (atomic clock seek + crossfade),
    // and the control thread repairs pitch alignment immediately after.
    Frame take_pending_scheduled_jump() noexcept;

    // Sentinel returned by take_pending_scheduled_jump() when no jump is pending.
    static constexpr Frame kNoJumpPending = -1;

#if defined(LT_ENGINE_TEST_HOOKS)
    // Test-only latch: exercise the render fallback used while rebuilding the
    // control table. Never enabled in shipped engine targets.
    void force_control_count_zero_for_test() noexcept;
    std::uint64_t take_control_index_lookup_count_for_test() noexcept {
        return control_index_lookup_count_.exchange(0, std::memory_order_relaxed);
    }
    void accumulate_folder_meter_for_test(int meter_index, float value) noexcept;
    float folder_meter_peak_for_test(int meter_index) const noexcept;
    static std::pair<int, int> route_channels_for_test(std::string_view route,
                                                       int available_channels,
                                                       const int* active_channels,
                                                       int active_count) noexcept;
#endif

private:
    // std::atomic<shared_ptr> (C++20) instead of the free atomic_load/store
    // helpers: on MSVC the free helpers share a GLOBAL spinlock pool that
    // priority-inverts the audio thread against the control thread's session
    // swaps during import. See microsoft/STL#86 and the matching note in
    // source_manager.h. The audio thread loads session_ every render block.
    // GCC 11/libstdc++ and Apple libc++ in CI reject std::atomic<shared_ptr>,
    // so non-MSVC builds use the standard shared_ptr atomic free functions via
    // the helpers below.
#if !defined(_MSC_VER)
    std::shared_ptr<const Session> session_;
#else
    std::atomic<std::shared_ptr<const Session>> session_;
#endif
    const SourceManager* sources_;
    TransportClock*      clock_;
    JumpScheduler*       scheduler_;
    class BungeeVoiceManager* bungee_voices_ = nullptr;

    // Physical device channel for each dense callback slot. JUCE/ASIO packs
    // enabled outputs, so {12,13,14,15} arrives at render() as four buffers.
    // The control side publishes atoms; the audio thread snapshots them once
    // per block without allocating or locking.
    static constexpr int kMaxOutputChannels = 64;
    std::array<std::atomic<int>, kMaxOutputChannels> active_output_channels_{};
    std::atomic<int> active_output_channel_count_{0};
    std::array<int, kMaxOutputChannels> render_output_channels_{};
    int render_output_channel_count_ = 0;

    // Per-track renderer pool (one per track). Grown on the CONTROL thread only
    // (prepare_render_resources, called from set_session and the constructor),
    // never in render(). The audio thread bounds its loops by renderer_count_,
    // which is published with release after the pool is fully grown+prepared, so
    // it never indexes a slot that doesn't exist or isn't scratch-allocated.
    //
    // This used to be a std::array<TrackRenderer, 64> and the render loops were
    // bounded by that 64. Sessions with more than 64 tracks in one song had
    // track 65+ silently skipped (no audio at all, while its mixer controls
    // still responded because those live in controls_, capped separately at
    // kMaxControlSlots). Track count is now limited only by memory/CPU.
    // Heap-boxed: TrackRenderer owns a BlockCache (mutex + atomics) so it is
    // neither copyable nor movable, and growing a vector of them by value would
    // have to relocate the live ones. With unique_ptr the growth only moves
    // pointers, so a renderer the audio thread is mid-render on never moves.
    static constexpr int kInitialTrackCapacity = 64;
    std::vector<std::unique_ptr<TrackRenderer>> renderers_;
    std::atomic<int> renderer_count_{0};

    // Per-track mix overrides (command thread writes, audio thread reads).
    struct TrackControlState {
        Id track_id;
        Id parent_track_id;
        int parent_control_index = -1;     // index into controls_[], -1 = no parent
        int route_left_channel = 0;
        int route_right_channel = -1;
        bool is_folder = false;
        std::atomic<float> gain{1.0f};
        std::atomic<float> pan{0.0f};
        std::atomic<bool>  mute{false};
        std::atomic<bool>  solo{false};
        float current_gain = 1.0f;
        float current_pan = 0.0f;
        float current_mute_gain = 1.0f;
        float current_solo_gain = 1.0f;
        bool initialized = false;
    };
    // Control slots cover every track of every song in the session, so a set of
    // songs with many tracks each used to exhaust the old fixed 256 and leave
    // the surplus tracks without gain/pan/mute/solo. Grown on the control thread
    // in rebuild_control_slots while control_count_ is 0 (audio thread is then
    // reading fallback_control_), so the growth never races a live scan.
    static constexpr int kInitialControlSlots = 256;
    static constexpr int kMaxFolderDepth  = 8;
    std::vector<std::unique_ptr<TrackControlState>> controls_;
    std::atomic<int> control_count_{0};
    TrackControlState fallback_control_;

    // Immutable lookup tables published with control_count_: flattened by
    // song, then track.  The audio thread uses these in the normal path;
    // string lookup remains only for the rebuild fallback window.
    std::vector<int> control_slot_for_renderer_;
    std::vector<std::array<int, kMaxFolderDepth>> ancestor_meter_indices_for_renderer_;
    std::vector<int> renderer_song_offsets_;

    // Compute effective (folder-chained) controls for a track slot.
    // Must only be called from the audio thread.
    struct EffectiveControls {
        float target_gain;
        float target_pan;
        bool  target_muted;
        float target_solo_gain;
    };
    EffectiveControls compute_effective_controls(int slot_index, bool solo_active) const noexcept;

    // Same computation for a track with no control slot, walking the parent
    // chain in the session instead of the slot table. Folder gain/pan/mute and
    // inherited solo eligibility must survive the fallback path.
    EffectiveControls effective_controls_from_session(const Song& song,
                                                      const Track& track,
                                                      bool solo_active) const noexcept;

    // Solo eligibility: true if track or any ancestor is soloed, or no solo is active at all.
    bool is_solo_eligible(int slot_index) const noexcept;

    // Stereo mix bus (reused each block, fixed size).
    static constexpr int kMaxBlockFrames = 4096;

    // ── Buses de mezcla POR PISTA ───────────────────────────────────────────
    //
    // Antes había un único bus (`mix_l_`/`mix_r_`) que se reutilizaba pista a
    // pista. Era *el* punto de serialización del render: dos pistas no pueden
    // calcularse a la vez si escriben en el mismo sitio.
    //
    // Con un bus por ranura, el bucle se parte en dos fases:
    //
    //   FASE A  por pista: limpiar su bus, renderizar dentro, medir sus picos.
    //           Independiente entre pistas. Es la que repartirá el paso 08.
    //   FASE B  reducción: ganancia, pan, routing, medidores de carpeta y
    //           acumulación en la salida. Se queda siempre en el director y
    //           recorre las ranuras EN ORDEN ASCENDENTE.
    //
    // El orden de la fase B no es un detalle de implementación, es el contrato
    // de bit-exactitud del plan (docs/plans/audio-thread-parallelism/
    // 07-buses-de-mezcla-por-pista.md): la suma de flotantes no es asociativa,
    // así que sumar en orden de ranura hace que la salida NO dependa de cuántos
    // hilos la calculen. Sin eso, el test de equivalencia serie-vs-paralelo del
    // paso 08 sería imposible de escribir y cada usuario oiría un audio
    // ligeramente distinto según su CPU.
    //
    // Coste: 2 canales x max_block_frames x 4 B por ranura. Es el mismo orden
    // que los scratch que TrackRenderer ya reserva por ranura (6x block), así
    // que no cambia la clase de consumo del render.
    struct TrackBusSlot {
        std::vector<float> left;
        std::vector<float> right;
    };
    std::vector<std::unique_ptr<TrackBusSlot>> track_buses_;

    // Lo que la fase A calcula y la fase B consume. Un valor por ranura.
    struct TrackBlockState {
        bool  rendered = false;   // false ⇒ la fase B se salta esta ranura
        float start_gain = 0.f, end_gain = 0.f;
        float start_pan = 0.f, end_pan = 0.f;
        float start_mute_gain = 0.f, end_mute_gain = 0.f;
        float start_solo_gain = 0.f, end_solo_gain = 0.f;
        float peak_l = 0.f, peak_r = 0.f;
        float rms_l = 0.f, rms_r = 0.f;
        int   left_channel = 0, right_channel = -1;
        const Track* track = nullptr;
        std::size_t  map_index = 0;
        bool         has_ancestor_map = false;
    };
    std::vector<TrackBlockState> track_block_state_;

    // Reparte la FASE A entre el director y sus trabajadores. La fase B no pasa
    // por aqui nunca: es la reduccion, y su orden es el contrato de
    // bit-exactitud del plan.
    RenderThreadPool render_pool_;

    // Meters (peak hold, updated each block).
    std::atomic<float> meter_l_{0.f};
    std::atomic<float> meter_r_{0.f};
    std::atomic<float> meter_l_rms_{0.f};
    std::atomic<float> meter_r_rms_{0.f};

#if LT_ENGINE_ENABLE_E2E_CAPTURE
    static constexpr std::size_t kCaptureFrames = 24000; // 0.5 s @ 48 kHz
    static constexpr std::size_t kCaptureSlots = kCaptureFrames * 2;
    std::array<float, kCaptureSlots> capture_ring_{};
    std::atomic<std::uint64_t> capture_write_frames_{0};
    std::atomic<int> capture_sample_rate_{0};
#endif

    struct TrackMeterSlot {
        std::atomic<float> left_peak{0.f};
        std::atomic<float> right_peak{0.f};
        std::atomic<float> left_rms{0.f};
        std::atomic<float> right_rms{0.f};
    };
    // Sized alongside renderers_ on the control thread. std::atomic is neither
    // copyable nor movable, so the slots are heap-boxed: growing the outer
    // vector then only moves pointers and never touches a slot the audio thread
    // may be storing into. track_meter_count_ still bounds audio-thread access.
    std::vector<std::unique_ptr<TrackMeterSlot>> track_meters_;
    std::atomic<int> track_meter_count_{0};

    // Per-region meters. Updated inside update_region_meters so the value
    // reflects the post-master signal of whichever region holds the playhead.
    // Inactive regions decay toward zero with a fixed release time so the bar
    // doesn't snap off when crossing region boundaries.
    static constexpr int kMaxRegions = 128;
    struct RegionMeterSlot {
        Id region_id;
        std::atomic<float> peak{0.f};
    };
    std::array<RegionMeterSlot, kMaxRegions> region_meters_;
    std::atomic<int> region_meter_count_{0};

    // Callback stats.
    std::atomic<int>    callback_count_{0};
    std::atomic<double> callback_duration_ms_{0.0};
    std::atomic<double> callback_duration_max_ms_{0.0};
    std::atomic<double> callback_load_percent_{0.0};

public:
    // Phase breakdown (LIBRETRACKS_AUDIO_DIAG) — worst µs spent in each phase of
    // render() since the last read. Pinpoints WHICH part of the callback blocks
    // when cbwork spikes. Read-and-reset from the snapshot poll thread.
    struct PhaseMaxUs { std::uint64_t load, sched, tracks, post; };
    PhaseMaxUs take_phase_max_us() noexcept {
        return { phase_load_us_.exchange(0, std::memory_order_relaxed),
                 phase_sched_us_.exchange(0, std::memory_order_relaxed),
                 phase_tracks_us_.exchange(0, std::memory_order_relaxed),
                 phase_post_us_.exchange(0, std::memory_order_relaxed) };
    }
private:
    std::atomic<std::uint64_t> phase_load_us_{0};
    std::atomic<std::uint64_t> phase_sched_us_{0};
    std::atomic<std::uint64_t> phase_tracks_us_{0};
    std::atomic<std::uint64_t> phase_post_us_{0};
    const bool diag_phases_ = [] {
        const char* v = std::getenv("LIBRETRACKS_AUDIO_DIAG");
        return v && *v && !(v[0] == '0' && v[1] == '\0');
    }();
    std::atomic<std::uint64_t> callback_over_budget_count_{0};
    std::atomic<std::uint64_t> rendered_track_count_{0};
    std::atomic<std::uint64_t> skipped_track_count_{0};
    std::atomic<std::uint64_t> scheduled_jump_executed_count_{0};

    std::atomic<std::uint64_t> master_fade_request_seq_{0};
    std::atomic<float> master_fade_target_gain_{1.0f};
    std::atomic<double> master_fade_duration_seconds_{0.0};
    std::uint64_t master_fade_applied_seq_ = 0;
    float master_gain_current_ = 1.0f;
    float master_gain_start_ = 1.0f;
    float master_gain_target_ = 1.0f;
    int master_fade_total_frames_ = 0;
    int master_fade_processed_frames_ = 0;

    // When a scheduled jump fires inside the audio callback, the target frame is written here
    // so the control thread can call prepare_for_transport_discontinuity() for pitch.
    // Sentinel: -1 means no pending jump. Written from audio thread, read from control thread.
    std::atomic<Frame> pending_scheduled_jump_frame_{kNoJumpPending};

    // Click-free crossfade around seeks/jumps.
    FadeProcessor fade_;
    MetronomeRenderer metronome_;
    VoiceGuideRenderer voice_guide_;
    PadRenderer pad_;

    // Check whether any track is soloed (scans control slots).
    bool any_solo_active_in_slots() const noexcept;
    void reset_track_meters() noexcept;
    void update_ancestor_folder_meters(const Song& song,
                                       const Track& track,
                                       float left_peak,
                                       float right_peak,
                                       float left_rms,
                                       float right_rms,
                                       const std::array<int, kMaxFolderDepth>* precomputed_ancestors = nullptr) noexcept;
    void render_timeline_span(float** output_channels,
                              int num_channels,
                              int num_frames,
                              int output_offset,
                              const std::shared_ptr<const Session>& session) noexcept;
    void apply_master_gain(float** output_channels, int num_channels, int num_frames) noexcept;
    // Multiplies the track bus by the master_gain of whichever region
    // contains `timeline_frame`. Called right after the track render loop and
    // BEFORE the metronome/voice-guide are mixed in, so the song master volume
    // only attenuates the song's tracks — the click and the guide voice stay at
    // their own level (a user can lower the song under them). No-op if no region
    // covers the playhead. `output_offset` shifts the write window for the
    // split-block jump path.
    void apply_region_master_gain_to_tracks(float** output_channels,
                                            int num_channels,
                                            int num_frames,
                                            int output_offset,
                                            const Session* session,
                                            Frame timeline_frame) noexcept;
    // master_gain of whichever region contains `timeline_frame` (1.0 if none).
    float region_master_gain_at(const Session* session, Frame timeline_frame) const noexcept;
    // Updates the per-region meters from the final output bus (post master
    // fade), so the bar reflects what the song actually sends to the device.
    void update_region_meters(float** output_channels,
                              int num_channels,
                              int num_frames,
                              const Session* session,
                              Frame timeline_frame) noexcept;
    TrackControlState* control_for_track(const Id& track_id) noexcept;
    const TrackControlState* control_for_track(const Id& track_id) const noexcept;
    int control_index_for_track(const Id& track_id) const noexcept;
    mutable std::atomic<std::uint64_t> control_index_lookup_count_{0};
    void rebuild_control_slots(std::shared_ptr<const Session> session, bool preserve_realtime_state);
    void recalculate_control_routing(const std::shared_ptr<const Session>& session,
                                     const int* active_output_channels,
                                     int active_output_channel_count,
                                     int control_count) noexcept;
    std::shared_ptr<const Session> load_session() const noexcept;
    void store_session(std::shared_ptr<const Session> session) noexcept;
};

} // namespace lt
