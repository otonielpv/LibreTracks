---
title: Voice Guide
description: Spoken section announcements, dynamic cues, and beat count-in before markers and scheduled jumps.
---

The **Voice Guide** speaks the upcoming section and counts you in before each marker, the way the Playback iPad app cues a band. As the playhead approaches a typed marker — or when a scheduled jump is about to fire — a voice announces the section ("Chorus", "Verse 2", "Bridge") and counts the beats of the lead bar ("1, 2, 3, 4") so the band lands together on the downbeat. It can also call out **dynamic cues** — short spoken instructions like "Build", "All In", "Drums In" or "Key Change Up" — at the moments you place them.

It is a **monitoring** cue: like the metronome, the voice does not pass through the song's audio chain. Choose its own output in settings: the legacy monitor bus, the main output, or a specific hardware channel.

![Voice guide settings](/screenshots/Voice-Guide-Settings.png)

## Enabling The Voice Guide

Open `Settings` and select the `Voice guide` tab:

- **Voice guide** — master on/off.
- **Language** — `Español` or `English`. Switching reloads the matching voice bank.
- **Voice guide output** — where the spoken cue is routed. This can be different from the metronome output.
- **Lead-in bars** — how many bars before the marker the count is spoken (default `1`).
- **Count-in** — when on, the remaining beats are counted after the section name. Turn it off to hear only the section name.
- **Voice volume** — level of the spoken cue relative to the music.

The bundled voice pack ships in Spanish and English. Markers with no recording for their type (or set to *Custom*) simply play the count without a spoken name.

## Markers: Sections, Cues, and Custom

Every timeline marker is one of three kinds. When you create a marker (right‑click the timeline → `Create marker…`) you choose its kind up front, so it is born already typed and named:

- **Sections** — the structure of the song (Intro, Verse, Pre‑Chorus, Chorus, Bridge, Breakdown, Solo, Outro, and more). These are announced by name and counted in, and they are the targets you navigate and jump to.
- **Cues** (dynamic guide cues) — short spoken instructions that happen *inside* a section rather than marking one: "Build", "All In", "Drums In", "Break", "Hold", "Softly", "Last Time", "Big Ending", "Key Change Up/Down", and the per‑instrument calls ("Drums", "Bass", "Guitar", "Keys"). A cue is a one‑shot announcement — no count‑in — and it is **not** a navigation target.
- **Custom** — an untyped marker with no spoken name. It still works for navigation and jumps, just silent.

You can also change an existing marker's kind later: right‑click it and choose `Marker type…`, then pick from the **Sections ▸** or **Cues ▸** submenu. Cues live in their own lane just above the section lane, so a cue and a section that share the same position stay separate and both remain visible and editable.

Sections that have numbered recordings — **Verse**, **Chorus**, **Bridge**, **Pre‑Chorus** — open a further menu where you can choose the plain section or a numbered variant (Verse 1–6, Chorus 1–4, …). Only the variants that actually exist in the voice pack are offered, so you never see a "Verse 8" with no audio.

![Marker variant menu](/screenshots/Marker-Section-Variant.gif)

Markers are coloured by their kind on the timeline. **Custom** markers can be given a colour of your own: right‑click a Custom marker and choose `Color…` to pick a preset or a custom colour (sections and cues keep their kind colour).

## How The Cue Is Placed

The lead bar before a marker carries a **full spoken count** ("1, 2, 3, 4" in 4/4). The **section name is positioned to end exactly on the downbeat** of that count, so the name finishes right before the "1" and never talks over the count — no matter how long the name is. A short name starts later; a long one ("Verse two") starts earlier.

```
            [ Verse two ]  one  two  three  four
                          └──── count bar ────┘  → the Verse 2 lands here
```

The count follows the song's **time signature**, including meter changes mid‑song. In 3/4 the voice counts "1, 2, 3"; in 5/4, "1, 2, 3, 4, 5". (Compound meters such as 6/8 currently count each subdivision.)

## Dynamic Cues

A **cue** placed away from any section fires as a one‑shot at its own position — spoken right when you reach it, with no count‑in.

When a cue sits on (or just before) a section's downbeat, it is **chained into the announcement** between the section name and the count, so the band hears the section, then the instruction, then the count‑in landing on the beat:

```
            [ Chorus ] [ Build ]  one  two  three  four
                                  └──── count bar ────┘  → the Chorus lands here
```

Several cues on the same downbeat are spoken in order ("Last Time", "Big Ending", …). The count is never displaced — it always lands exactly on the section's downbeat.

## Scheduled Jumps

The voice guide also covers **scheduled marker jumps**. When you arm a jump to a section — at the end of the current region, after a number of bars, or at the next marker — the voice announces the **destination** section and counts you toward the moment the jump fires, then the jump executes on the downbeat. You hear where you are about to go before you get there.

Any **cues attached to the jump's destination** are announced too — jump to a "Solo" that has a "Guitar" cue on its downbeat and you hear "Solo, Guitar, 1, 2, 3, 4" before the jump fires. The cue is spoken once, in the lead‑in; it is **not** repeated when playback later reaches the cue's own position.

If a jump leaves very little lead time (for example, a jump only one bar away), the **count always plays** so you still get the rhythmic entry; the spoken name is added only when it fits in the remaining space.

See [Live Control Flow](/docs/live-control-flow/) for how to arm marker jumps and set their trigger mode.

## Tips

- Pair the voice guide with the [metronome](/docs/audio-routing-metronome/) on the same monitor bus, or split them to separate hardware outputs when your monitor mix needs independent control.
- Set lead-in to `2` bars at fast tempos if `1` bar feels rushed.
- Leave markers you don't want announced as *Custom* — they still work for navigation and jumps, just without a spoken name.
- Use **cues** for arrangement calls (build, drop the band out, key change) without cluttering your section markers — drop a cue right on a section's downbeat and it's spoken just before the count.
- On the **remote**, only sections appear: the jump list and the timeline strip show your song's structure, while cues stay out of the way (they're called by voice, not navigated to).
