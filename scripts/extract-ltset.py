#!/usr/bin/env python3
"""Unpack a .ltset into a session folder, the way the app's import does.

    extract-ltset.py <file.ltset> <parent-dir>

Prints the path of the .ltsession it wrote. The folder is named after the
manifest's sessionTitle, and the document after the folder, exactly as
`extract_session_package_inner` (crates/libretracks-project/src/
session_package.rs) lays it out:

    song.ltsession          -> <Folder>/<Folder>.ltsession
    sidecars/<name>         -> <Folder>/<name>
    audio/<path>            -> <Folder>/audio/<path>
    video/<path>            -> <Folder>/video/<path>
    cache/waveforms/<name>  -> <Folder>/cache/waveforms/<name>

Exists for the iOS simulator shots: the simulator has no file picker that a
script can drive, but the app opens a .ltsession passed as a launch argument
(commands/open_with.rs), so the set is unpacked here and handed over that way.
If the mapping in the Rust import changes, change it here too.
"""

import json
import re
import shutil
import sys
import zipfile
from pathlib import Path, PurePosixPath

PREFIXES = {
    "sidecars/": "",
    "audio/": "audio/",
    "video/": "video/",
    "cache/waveforms/": "cache/waveforms/",
}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    package, parent = Path(sys.argv[1]), Path(sys.argv[2])

    with zipfile.ZipFile(package) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        title = re.sub(r'[\\/:*?"<>|]', "-", manifest.get("sessionTitle") or "").strip()
        folder = parent / (title or "Session")
        session_file = folder / f"{folder.name}.ltsession"

        for entry in archive.infolist():
            name = entry.filename
            if entry.is_dir() or name == "manifest.json":
                continue
            relative = PurePosixPath(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit(f"unsafe entry in package: {name}")

            if name == "song.ltsession":
                destination = session_file
            else:
                prefix = next((p for p in PREFIXES if name.startswith(p)), None)
                if prefix is None:
                    continue  # unknown top-level entry: the app ignores it too
                destination = folder / (PREFIXES[prefix] + name[len(prefix):])

            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, open(destination, "wb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)

    if not session_file.exists():
        raise SystemExit("the package holds no song.ltsession")
    print(session_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
