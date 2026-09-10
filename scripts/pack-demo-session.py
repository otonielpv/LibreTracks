#!/usr/bin/env python3
"""Package the recorded demo stems into the session LibreTracks ships.

The app opens to an empty timeline otherwise, which is a poor first run and
leaves an App Store reviewer with nothing to evaluate — a 2.1 rejection rather
than a bad review. Two songs rather than one because a LibreTracks session is a
setlist: each region carries its own key and tempo, so the demo shows what the
app is for instead of just making noise.

The demo also arrives *mixed*, not with every fader at unity: a folder holding
the two guitars, tracks panned across the stereo field and trimmed to sit
together. A demo where nothing has been touched teaches nobody that any of it
can be touched.

The audio is rendered in Reaper and lives outside the repo; this script is the
reproducible half. It converts the stems to MP3 and writes `song.ltsession`
with the regions, tempo map and section markers derived from the tables below,
so the markers can never drift from the tempo the way hand-typed seconds do.

    python scripts/pack-demo-session.py "<carpeta con las canciones>" [out_dir]

The source folder holds one directory per song, each with the stem WAVs named
as Reaper exported them (see TRACKS).

IMPORTANT: `bpm` here must match the tempo the audio was actually *rendered*
at, not the tempo it was written for. Getting this wrong does not sound wrong
on its own — the stems still play — but the grid, the metronome and every
marker drift away from the music, by several seconds come the end of a song.
That mistake has already happened once, which is why check_song() exists.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import wave


def gain(db: float) -> float:
    """dB -> the linear gain the session stores. Faders read in dB in the UI,
    but `volume` on the wire has always been linear, so the conversion belongs
    here rather than in someone's head."""
    return round(10.0 ** (db / 20.0), 4)


# Reaper stem file (None for a folder, which has no audio of its own), track id,
# display name, colour, kind, parent, fader in dB, pan in -1 (L) .. +1 (R).
#
# The mix is a real one, not decoration: drums and bass hold the centre, the
# piano leans left, and the two guitars are spread wide from inside a folder
# whose own fader trims both at once. The engine multiplies gain and sums pan up
# the parent chain, so that folder fader is audible, not cosmetic.
TRACKS = [
    ("Drums",     "bateria",   "Batería",   "#e0625f", "audio",  None,         0.0,  0.00),
    ("Bass",      "bajo",      "Bajo",      "#e8a33d", "audio",  None,         0.0,  0.00),
    ("Piano",     "piano",     "Piano",     "#4c9f70", "audio",  None,        -2.0, -0.35),
    (None,        "guitarras", "Guitarras", "#8a7fd0", "folder", None,        -1.0,  0.00),
    ("A. Guitar", "acustica",  "Acústica",  "#5a8fd6", "audio",  "guitarras", -3.0, -0.60),
    ("E. Guitar", "electrica", "Eléctrica", "#b07bd4", "audio",  "guitarras", -2.0,  0.60),
]

# Sections are given as BAR NUMBERS, one-based, exactly as they read on a score
# — converting them to seconds is this script's job precisely so nobody has to
# do that arithmetic by hand twice. The last field is the quick-jump digit;
# digits must be unique across the whole session or saving rejects the document
# ("marker digit is duplicated"), so the turnarounds deliberately have none.
SONGS = [
    {
        "folder": "Costa-Norte",
        "slug": "costa-norte",
        "title": "Costa Norte",
        # Re mayor, aunque arranca en su relativo menor (Bm): el primer acorde
        # no es la tonica. `key` is the song's key, not its first chord.
        "key": "D",
        "bpm": 110.0,
        "beats_per_bar": 4,
        "signature": "4/4",
        "bars": 21,
        "sections": [
            ("intro", "Intro", 1, 1),
            ("verse", "Estrofa", 5, 2),
            ("chorus", "Estribillo", 13, 3),
            ("ending", "Acorde final", 21, 4),
        ],
    },
    {
        "folder": "Callejon Blues",
        "slug": "callejon-blues",
        "title": "Callejón Blues",
        # La mayor blues: los tres acordes son de septima de dominante.
        "key": "A",
        "bpm": 90.0,
        "beats_per_bar": 4,
        "signature": "4/4",
        "bars": 25,
        "sections": [
            # Two 12-bar choruses: the electric plays the head over the first
            # and solos over the second, which is why they get different kinds.
            # The turnaround closing each one is in the marker vocabulary too,
            # and marking it is exactly what a player would do.
            ("verse", "Vuelta 1", 1, 5),
            ("turnaround", "Turnaround", 12, None),
            ("solo", "Vuelta 2", 13, 6),
            ("turnaround", "Turnaround", 24, None),
            ("ending", "Golpe final", 25, 7),
        ],
    },
]

GAP_SECONDS = 2.0
# VBR ~165 kbps. This is the app's shop window and the stems are real playing;
# the couple of megabytes CBR 128 would save are not worth the smearing.
MP3_QUALITY = "4"

STEM_TRACKS = [row for row in TRACKS if row[0] is not None]


def wav_frames(path: pathlib.Path) -> tuple[int, int]:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes(), handle.getframerate()


def check_song(song, folder) -> tuple[float, str | None]:
    """Return (seconds, error). Both checks have caught a real mistake."""
    lengths = {wav_frames(folder / f"{stem}.wav") for stem, *_ in STEM_TRACKS}
    if len(lengths) != 1:
        return 0.0, (f"los stems no tienen la misma duracion ({sorted(lengths)}). "
                     f"Reexporta con el rango del proyecto completo, no recortado "
                     f"al contenido.")
    frames, rate = lengths.pop()
    seconds = frames / rate
    musical = song["bars"] * song["beats_per_bar"] * 60.0 / song["bpm"]
    if seconds + 0.05 < musical:
        return seconds, (f"el audio dura {seconds:.2f}s pero {song['bars']} compases "
                         f"a {song['bpm']:.0f} BPM son {musical:.2f}s. O el tempo o "
                         f"el numero de compases esta mal.")
    return seconds, None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = pathlib.Path(sys.argv[1])
    demo_dir = pathlib.Path(sys.argv[2] if len(sys.argv) > 2
                            else "apps/desktop/src-tauri/resources/demo")
    audio_dir = demo_dir / "audio"

    missing = [f"{song['folder']}/{stem}.wav"
               for song in SONGS
               for stem, *_ in STEM_TRACKS
               if not (source / song["folder"] / f"{stem}.wav").is_file()]
    if missing:
        print("Faltan stems de origen:", file=sys.stderr)
        for name in missing:
            print(f"  {name}", file=sys.stderr)
        return 1

    audio_dir.mkdir(parents=True, exist_ok=True)
    regions, clips, markers, tempo_markers = [], [], [], []
    expected = set()
    timeline = 0.0

    for song in SONGS:
        folder = source / song["folder"]
        seconds, error = check_song(song, folder)
        if error:
            print(f"{song['folder']}: {error}", file=sys.stderr)
            return 1

        bar = song["beats_per_bar"] * 60.0 / song["bpm"]
        song_dir = audio_dir / song["slug"]
        song_dir.mkdir(parents=True, exist_ok=True)

        for stem, track_id, *_rest in STEM_TRACKS:
            mp3 = song_dir / f"{track_id}.mp3"
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-i", str(folder / f"{stem}.wav"),
                 "-codec:a", "libmp3lame", "-q:a", MP3_QUALITY, str(mp3)],
                check=True,
            )
            expected.add(mp3.relative_to(audio_dir).as_posix())
            clips.append({
                "id": f"clip-{song['slug']}-{track_id}",
                "trackId": f"track-{track_id}",
                # Relative to the session folder, so the demo survives being
                # copied under whatever name the user's new session gets.
                "filePath": f"audio/{song['slug']}/{track_id}.mp3",
                "timelineStartSeconds": round(timeline, 3),
                "sourceStartSeconds": 0.0,
                "durationSeconds": round(seconds, 3),
                "gain": 1.0,
                "fadeInSeconds": None,
                "fadeOutSeconds": None,
            })

        # The region spans the whole file, not just the bars: the last chord
        # rings on past the final barline and ending the region there would
        # chop it off.
        regions.append({
            "id": f"region-{song['slug']}",
            "name": song["title"],
            "startSeconds": round(timeline, 3),
            "endSeconds": round(timeline + seconds, 3),
            "transposeSemitones": 0,
            "key": song["key"],
            "warpEnabled": False,
            "warpSourceBpm": None,
            "master": {"gain": 1.0},
        })
        tempo_markers.append({
            "id": f"tempo-{song['slug']}",
            "startSeconds": round(timeline, 3),
            "bpm": song["bpm"],
        })
        for kind, label, bar_number, digit in song["sections"]:
            markers.append({
                # The bar goes in the id: a song can hold two turnarounds, and
                # kind alone would collide.
                "id": f"marker-{song['slug']}-{kind}-{bar_number}",
                "name": label,
                "startSeconds": round(timeline + (bar_number - 1) * bar, 3),
                "digit": digit,
                "kind": kind,
            })

        print(f"{song['title']:16s} {song['key']:2s} {song['bpm']:5.0f} BPM  "
              f"{song['bars']:2d} compases  {seconds:5.2f}s  "
              f"{len(song['sections'])} marcas")
        timeline += seconds + GAP_SECONDS

    # Stems dropped from the arrangement used to linger here. Nothing notices —
    # they are not in the session document, so no test fails — they just ride
    # into the App Store and Google Play builds as dead weight.
    for stale in sorted(audio_dir.rglob("*"), reverse=True):
        relative = stale.relative_to(audio_dir).as_posix()
        if stale.is_file() and relative not in expected:
            stale.unlink()
            print(f"  eliminado obsoleto: {relative}")
        elif stale.is_dir() and not any(stale.iterdir()):
            stale.rmdir()

    digits = [marker["digit"] for marker in markers if marker["digit"] is not None]
    if len(digits) != len(set(digits)):
        print(f"Digitos de salto duplicados: {sorted(digits)}", file=sys.stderr)
        return 1

    total = timeline - GAP_SECONDS
    document = {
        "version": 7,
        "id": "song_demo",
        "title": "Demo de LibreTracks",
        "artist": "LibreTracks",
        "key": SONGS[0]["key"],
        "bpm": SONGS[0]["bpm"],
        "timeSignature": SONGS[0]["signature"],
        "durationSeconds": round(total, 3),
        "tempoMarkers": tempo_markers,
        # One marker: both songs are in 4/4, and declaring a change that does
        # not happen would put a wrong number in front of the user.
        "timeSignatureMarkers": [{
            "id": "signature-demo",
            "startSeconds": 0.0,
            "signature": SONGS[0]["signature"],
        }],
        "regions": regions,
        "tracks": [{
            "id": f"track-{track_id}",
            "name": label,
            "kind": kind,
            "parentTrackId": f"track-{parent}" if parent else None,
            "volume": gain(db),
            "pan": pan,
            "muted": False,
            "solo": False,
            "transposeEnabled": True,
            # Children inherit the folder's route. At present that resolves to
            # master too, but keeping the relationship explicit means changing
            # the folder output later moves both guitars together in the UI and
            # in the engine.
            "audioTo": "inherit" if parent else "master",
            "color": colour,
            "autoCreated": False,
            "collapsed": False,
        } for _stem, track_id, label, colour, kind, parent, db, pan in TRACKS],
        "clips": clips,
        "midiClips": [],
        "sectionMarkers": markers,
    }
    (demo_dir / "song.ltsession").write_text(
        json.dumps(document, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    megabytes = sum(p.stat().st_size for p in audio_dir.rglob("*.mp3")) / 1024 / 1024
    print(f"\n{len(SONGS)} canciones | {len(TRACKS)} pistas "
          f"({sum(1 for row in TRACKS if row[4] == 'folder')} carpeta) | "
          f"{len(clips)} clips | {len(markers)} marcas | {total:.1f}s | "
          f"audio {megabytes:.1f} MiB")
    for _stem, _id, label, _c, kind, parent, db, pan in TRACKS:
        side = "C" if abs(pan) < 0.01 else (f"I{abs(pan)*100:.0f}" if pan < 0
                                            else f"D{pan*100:.0f}")
        print(f"  {'  ' if parent else ''}{label:12s} {kind:6s} "
              f"{db:+5.1f} dB  pan {side}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
