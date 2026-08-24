---
title: Live View
description: "LibreTracks Live View: the song's markers as large buttons, the setlist always in sight, jump and vamp settings one tap away, on PC, tablet and phone."
---

**Live View** is the third projection of the same project, made for the moment you play. It edits nothing: it shows, in large type, the only things that matter on stage — where you can jump, what is playing now, and what comes next.

![Live View on the desktop](/screenshots/Live-View.png)

Switch views with the three buttons on the bar (`view_timeline` for the DAW view, `view_module` for Compact View and `stadium` for Live View), or cycle through them with `Tab`; `Shift+Tab` cycles the other way.

## Areas Of The Live View

### Header

Shows the song that is playing with its elapsed time, its effective BPM and its key, at a size you can read from a distance.

### Performance settings

The three settings you change on the fly are always visible, with no menus:

- `Marker jump`: `Immediate`, `After bars` (with its count) or `Next marker`.
- `Song jump`: `Immediate`, `Song end`, `After bars` or `Next marker`, with the transition set to `Clean` or `Fade`.
- `Vamp type`: repeat the current `Section` or a number of `Bars`, with the `VAMP` button next to it to enter and leave the loop.

These are the same settings as [Live Control Flow](/docs/live-control-flow/): changing them here changes them everywhere in the app.

### Live markers

Every marker in the selected song is a large numbered button, in the colour you gave it on the timeline, with its time from the start of the song. Tapping it schedules the jump using the configured mode. On top of that:

- The marker currently playing is highlighted as `Now` and carries its own progress bar.
- The next one shows a `Next in m:ss` countdown.
- A jump already scheduled is marked `Queued`, and `Cancel jump` calls it off as long as it hasn't fired.
- Cue markers appear as `Warning` next to the section they fall in, so you read the instruction without hunting for it.
- With the vamp active, the marker being repeated carries its own `VAMP` badge.
- The list scrolls itself to keep the playing marker in view.

### Setlist

The setlist column shows the current song with its progress and the time remaining, and below it the rest of the songs in the session with their play button. Selecting a song shows its markers without jumping to it, so you can line up the next number while the current one plays.

## On Phone And Tablet

Live View adapts to the screen: on desktop and tablet the markers spread across three columns with the setlist beside them, and on a phone they fall back to two columns with the setlist along the bottom, always within reach.

![Live View on a phone](/screenshots/Live-View-Phone.png)
