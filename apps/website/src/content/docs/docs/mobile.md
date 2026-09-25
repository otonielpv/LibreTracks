---
title: LibreTracks on Mobile
description: "What changes in LibreTracks for Android: choosing where sessions live (internal storage, SD card or USB OTG drive), importing audio without copying it, touch gestures, the back button and audio output."
---

LibreTracks for Android is the same app as the desktop version: the same audio
engine, the same session format and the same DAW, Compact and Live views. A
session built on your computer opens as-is on your phone, and the other way
round.

Some things work differently on a phone: storage, using your finger instead of a
mouse, and audio output. This page covers those differences. Hardware and
storage minimums are in
[System Requirements](/docs/system-requirements/#android).

## Home screen

When you open the app you see **Your sessions**, the list of sessions saved on
the device. From there you create a new session, open an existing one or import
an `.ltset` or `.ltpkg`. The trash icon deletes a session from the device, with
its audio and cache. You can't delete the session that is currently open.

The **Demo song** opens a four-track sample session that ships inside the app,
so you can try the transport, the mix and jumps without importing anything. It
always opens the same session, so tapping it again doesn't create copies.

## Where sessions are saved

If your phone has a **microSD card**, or you plug in a **USB stick or drive
(OTG)**, you can save sessions there instead of on internal storage. Choose it in
`Settings > General > Where to keep sessions`.

- The list shows each volume by the name Android gives it (for example
  "SanDisk SD card" or "USB drive") and how much free space it has left. If
  the phone only has internal storage, the setting doesn't appear.
- **It only affects new sessions.** The sessions you already have keep
  opening from where they are, and they all appear together in "Your
  sessions", whichever volume they're on.
- **The audio cache goes with your sessions.** The cache takes up the most
  space, so when you pick the card, it is saved there too and doesn't fill
  up internal storage.
- If you **remove the card or USB drive**, LibreTracks notices straight away:
  it shows a warning in Settings and saves new sessions to internal storage
  until you plug it back in. When you reconnect it, the volume list and "Your
  sessions" update on their own, without restarting the app.

LibreTracks saves sessions in the app's own folder on each volume, so it doesn't
ask for any storage permission.

:::caution[USB drives and cards]
Wait for a save to finish before you unplug a USB drive. If it is removed
halfway through, the session stays as it was at the last complete save and
isn't lost, but any changes that weren't saved yet are lost.
:::

## Importing audio without copying it

When you import audio into the library, Android normally copies it into the
session. With `Settings > General > Import without copying audio into the
session` turned on, the session **uses your original files** instead of
duplicating them, as it does on desktop. A multitrack then takes up only the
space of its own files.

- If you move or delete an original file, the track goes silent and the file
  shows up under **Missing files**, where you can link it again.
- Files that are in the cloud (Google Drive, or "Recent" in the file picker,
  for example) can't be read directly. Those are still copied, even with the
  setting turned on.
- Deleting a track or a session **never** deletes your original files. Only
  what is inside the session's folder is deleted.

When you import several audio files, each one appears in the library as soon as
it starts copying, with its progress, so you don't wait for the whole batch to
finish.

## Timeline gestures

On desktop you use the mouse and right-click. On a phone it works like this:

| Gesture | What it does |
| --- | --- |
| **One finger** | Scrolls in any direction: left and right move through time, up and down move through tracks. |
| **Two-finger pinch** | Zoom only. |
| **Tap** | Selects what's underneath: a clip, a marker, a track or a song. Tapping empty space clears the selection. |
| **Drag something already selected** | Moves it. Tap it first, then drag, so an accidental swipe doesn't move your audio. |
| **Long press** | Opens the context menu at the exact spot where you put your finger. |

There are no navigate and edit modes to switch between: it all depends on
whether what you drag was already selected.

### The action bar

On desktop, actions come from right-clicking. On a phone they appear in a
floating bar above the timeline. When you tap something, the bar shows what you
can do with it, and with nothing selected it offers to create a marker, a song or
a track. If there are more actions than fit, the dots button opens the full
list. Use the arrow to tuck the bar away when you want more timeline.

With **several tracks selected**, the bar has a mix button that changes the
volume, pan, output and transpose of all of them at once. Volume and pan move
relatively, so the balance between the tracks is kept.

### Tracks and folders

On a phone, dragging a track **only changes its order**. To put tracks into a
folder, select them and choose **Move to folder…** from their menu, to an
existing folder or a new one. To take them out, use **Remove From Folder**.
That way you don't have to land your finger in the middle of the folder's row.

## The back button

Android's back button **closes whatever is open first**, like a setting, a menu
or a panel, instead of leaving the app. If nothing is open and playback is
running, the first press shows a warning ("Playing. Press back again to exit.")
and you need a second press to leave, so you don't stop a rehearsal by
accident.

## Audio output

Choose the output in `Settings > Audio`. If you connect a **USB audio
interface**, it appears there with its channels and routes just like on desktop
(see [Audio Routing & Metronome](/docs/audio-routing-metronome/)). Android has
only one audio system, so there is no backend selector like ASIO or WASAPI.

- **By default**, LibreTracks uses Android's normal playback output. That
  means you hear the system sound settings, like Dolby Atmos, the equaliser or
  the surround effect, just as in any music player. If you don't want them,
  turn them off in Android's sound settings.
- **Low latency** uses Android's fast output. It reduces delay, especially with
  USB interfaces, but doesn't apply the system effects and can cause dropouts
  on modest phones. Turn it on if you play live over the tracks and notice the
  delay.

## Audio cache

Audio that isn't WAV (MP3, FLAC…) is decoded once and kept in the cache so it
loads instantly next time. On a phone you can't change the cache folder: it
always stays on the volume where you save your sessions (see above). In
`Settings` you can see how much space it uses, set a size limit and clear it.

## Moving sessions from your computer to your phone

The easiest way is to build the session on your computer and take it to your
phone:

- **Export the session as an `.ltset`** and open it from "Your sessions". On a
  modest phone, **Optimized** mode carries the audio already prepared, so the
  phone skips decoding when it opens. More in
  [System Requirements](/docs/system-requirements/#making-a-big-session-load-faster).
- **Through Google Drive**: when you export or import, LibreTracks asks whether
  to use the device or your Drive account. The files are stored in your own
  Drive, not on any LibreTracks server, and the app can only see the files it
  created itself.
