"""JUCE/VST3 state helpers for driving Surge XT headless through pedalboard.

pedalboard can only load .vstpreset files, and its raw_state setter does not
actually apply state, so Surge factory .fxp patches are loaded by wrapping
their patch chunk in a synthesized .vstpreset:

  fxp chunk (sub3 patch) + JUCE state trailer -> Comp chunk of a .vstpreset
  with Surge XT's canonical JUCE class id -> plugin.load_preset()

The state trailer (16 zero bytes + b"JUCEPrivateData") is copied from the
plugin's own initial raw_state, which pedalboard encodes as
'VC2!' + int32 xml_len + <VST3PluginState><IComponent>juce-base64</IComponent>.
JUCE base64 is a custom "<size>.<chars>" format with its own alphabet.
"""
import re
import struct

# Canonical JUCE VST3 component class id: ABCDEF01-9182FAEB + 'VmbA' + 'SgXT'.
# pedalboard's preset loader wants this spelling, NOT the COM byte order the
# id is stored with inside the plugin binary.
SURGE_XT_CLASS_ID = "ABCDEF019182FAEB566D624153675854"

_TABLE = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/0123456789"
_LOOKUP = {c: i for i, c in enumerate(_TABLE)}


def juce_b64_decode(s: str) -> bytes:
    size_str, data = s.split(".", 1)
    size = int(size_str)
    out = bytearray(size)
    for i, ch in enumerate(data):
        val = _LOOKUP[ch]
        bitpos = i * 6
        byte, off = bitpos >> 3, bitpos & 7
        out[byte] |= (val << off) & 0xFF
        if off > 2 and byte + 1 < size:
            out[byte + 1] |= val >> (8 - off)
    return bytes(out)


def unpack_raw_state(st: bytes):
    """'VC2!' + int32 len + xml (+tail). Returns (xml_str, tail)."""
    assert st[:4] == b"VC2!", st[:4]
    (xml_len,) = struct.unpack("<i", st[4:8])
    return st[8 : 8 + xml_len].decode("utf-8"), st[8 + xml_len :]


def get_component_state(xml: str) -> bytes:
    m = re.search(r"<IComponent>([^<]*)</IComponent>", xml)
    return juce_b64_decode(m.group(1))


def read_fxp_chunk(path: str) -> bytes:
    """Extract the opaque patch chunk from a VST2 .fxp preset (FPCh layout)."""
    raw = open(path, "rb").read()
    magic, _, fmt = struct.unpack(">4si4s", raw[:12])
    assert magic == b"CcnK" and fmt == b"FPCh", (magic, fmt)
    (chunk_size,) = struct.unpack(">i", raw[56:60])
    return raw[60 : 60 + chunk_size]


def juce_state_trailer(plugin) -> bytes:
    """The bytes Surge's JUCE wrapper appends after the sub3 patch blob."""
    xml, _ = unpack_raw_state(bytes(plugin.raw_state))
    blob = get_component_state(xml)
    assert blob[:4] == b"sub3", "unexpected Surge component state"
    (patch_size,) = struct.unpack("<i", blob[4:8])
    return blob[32 + patch_size :]


def make_vstpreset(comp_data: bytes, class_id_hex: str = SURGE_XT_CLASS_ID) -> bytes:
    header_size = 48
    chunk_list_offset = header_size + len(comp_data)
    out = b"VST3"
    out += struct.pack("<i", 1)
    out += class_id_hex.encode("ascii")
    out += struct.pack("<q", chunk_list_offset)
    out += comp_data
    out += b"List" + struct.pack("<i", 1)
    out += b"Comp" + struct.pack("<qq", header_size, len(comp_data))
    return out
