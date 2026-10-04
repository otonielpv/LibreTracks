# midir 0.9.1, patched for the App Store

Unmodified copy of `midir` 0.9.1 from crates.io except for one change in
`src/backend/coremidi/mod.rs` (look for `LIBRETRACKS PATCH`), wired in through
`[patch.crates-io]` in the root `Cargo.toml`.

**Why:** midir's CoreMIDI backend stamps every incoming message with
`AudioGetCurrentHostTime` / `AudioConvertHostTimeToNanos` from CoreAudio.
Those are public on macOS but private on iOS, and App Store Connect rejected
the upload of the first build with iOS MIDI (2026-10-04, `Validation failed
(409) The app references non-public symbols … _AudioConvertHostTimeToNanos,
_AudioGetCurrentHostTime`). On iOS the patch uses `mach_absolute_time` and
`mach_timebase_info`, which are the same clock and are public. macOS keeps the
original code.

midir 0.11.0 still has the same externs, so upgrading does not fix it. Drop
this copy once an upstream release stops using them on iOS.
