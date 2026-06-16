#pragma once

namespace lt {

// ---------------------------------------------------------------------------
// Background-I/O throttle shared between the decode workers, the PCM cache
// writer, and the live block-fill thread.
//
// Decoding a compressed source (reading the whole file + writing the RF64 PCM
// cache to disk) is heavy disk I/O. When it runs WHILE the transport is
// playing, it competes with the live `fill_thread_` that streams blocks for the
// already-playing tracks — starving it produces audible dropouts. Since play no
// longer waits for every source to finish decoding (see audio_engine.rs::play),
// that overlap is now the common case.
//
// `set_playback_active` is flipped by the engine on transport state changes.
// The decode/cache paths call `decode_background_yield()` between chunks: it
// sleeps a little when idle (to keep the UI responsive on cold opens) and a lot
// more while playing, ceding disk bandwidth to the live stream so the playing
// tracks never glitch.
// ---------------------------------------------------------------------------

void set_playback_active(bool active) noexcept;
bool playback_active() noexcept;

// Cooperative yield for background decode/cache-write loops. Sleeps ~1ms when
// idle, ~6ms while playback is active so the live fill thread wins the disk.
void decode_background_yield() noexcept;

} // namespace lt
