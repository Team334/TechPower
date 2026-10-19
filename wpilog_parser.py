"""
WPILog parser — reads DogLog/Epilogue/Phoenix .wpilog binary format.
Format spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.md

Only entries accepted by `wanted(name)` have their records decoded; everything
else is skipped by header, which keeps large hoot logs fast to load.
"""
import struct
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

# Numeric scalar types decoded in bulk with numpy: type → (dtype, byte width)
_NUMERIC = {
    "double":  ("<f8", 8),
    "float":   ("<f4", 4),
    "int64":   ("<i8", 8),
    "boolean": ("u1", 1),
}

# WPILib structs made only of doubles, decoded to rows of this many float64s
# (Pose2d = x, y, heading rad; ChassisSpeeds = vx, vy, omega). "[]" variants decode to (n, k) arrays.
_STRUCT_DOUBLES = {
    "struct:Rotation2d":    1,
    "struct:Translation2d": 2,
    "struct:Pose2d":        3,
    "struct:ChassisSpeeds": 3,
}

# Header layout per bitfield byte: (entry id len, payload size len, timestamp len)
_HEADER = [((b & 3) + 1, ((b >> 2) & 3) + 1, ((b >> 4) & 7) + 1) for b in range(256)]

LFS_POINTER_PREFIX = b"version https://git-lfs"


@dataclass
class WPILogEntry:
    entry_id: int
    name: str
    type_str: str
    metadata: str
    times: np.ndarray = field(default_factory=lambda: np.empty(0))   # seconds
    values: Any = field(default_factory=lambda: np.empty(0))          # ndarray for numeric, list otherwise

    def __len__(self):
        return len(self.times)


def parse_wpilog(filepath: str, wanted: Callable[[str], bool] | None = None) -> dict[str, WPILogEntry]:
    """Return {entry name: WPILogEntry}. Records are decoded only for wanted entries."""
    with open(filepath, "rb") as f:
        data = f.read()

    if data.startswith(LFS_POINTER_PREFIX):
        raise ValueError(f"{filepath} is a Git LFS pointer, not a log. Run `git lfs pull`.")
    if data[:6] != b"WPILOG" or len(data) < 12:
        raise ValueError("Not a valid WPILog file")

    pos = 12 + int.from_bytes(data[8:12], "little")
    n = len(data)
    fb = int.from_bytes

    entries_by_id: dict[int, WPILogEntry] = {}
    entries_by_name: dict[str, WPILogEntry] = {}
    # entry name → ([timestamp_us], [payload offset], [payload size]) for wanted entries
    raw: dict[str, tuple[list, list, list]] = {}
    raw_by_id: dict[int, tuple[list, list, list]] = {}

    while pos < n:
        il, pl, tl = _HEADER[data[pos]]
        hdr_end = pos + 1 + il + pl + tl
        if hdr_end > n:
            break  # truncated header at end of file
        p = pos + 1
        entry_id = fb(data[p:p + il], "little"); p += il
        size = fb(data[p:p + pl], "little"); p += pl
        payload_end = hdr_end + size
        if payload_end > n:
            break  # truncated payload (log cut off mid-write)

        if entry_id == 0:
            if size and data[hdr_end] == 0:  # start record
                entry = _parse_start(data, hdr_end + 1)
                if entry is not None:
                    existing = entries_by_name.get(entry.name)
                    if existing is None:
                        entries_by_name[entry.name] = existing = entry
                    entries_by_id[entry.entry_id] = existing
                    if wanted is None or wanted(entry.name):
                        raw_by_id[entry.entry_id] = raw.setdefault(entry.name, ([], [], []))
                    else:
                        raw_by_id.pop(entry.entry_id, None)
        else:
            buf = raw_by_id.get(entry_id)
            if buf is not None:
                buf[0].append(fb(data[p:p + tl], "little"))
                buf[1].append(hdr_end)
                buf[2].append(size)
        pos = payload_end

    arr = np.frombuffer(data, dtype=np.uint8)
    for name, (ts, offs, sizes) in raw.items():
        entry = entries_by_name[name]
        entry.times, entry.values = _decode(arr, data, entry.type_str, ts, offs, sizes)

    return entries_by_name


def _parse_start(data: bytes, p: int) -> WPILogEntry | None:
    try:
        entry_id, name_len = struct.unpack_from("<II", data, p); p += 8
        name = data[p:p + name_len].decode("utf-8", "replace"); p += name_len
        type_len = struct.unpack_from("<I", data, p)[0]; p += 4
        type_str = data[p:p + type_len].decode("utf-8", "replace"); p += type_len
        meta_len = struct.unpack_from("<I", data, p)[0]; p += 4
        metadata = data[p:p + meta_len].decode("utf-8", "replace")
    except struct.error:
        return None
    return WPILogEntry(entry_id, name, type_str, metadata)


def _decode(arr: np.ndarray, data: bytes, type_str: str, ts: list, offs: list, sizes: list):
    times = np.asarray(ts, dtype=np.float64) / 1e6
    if not ts:
        return times, np.empty(0)

    num = _NUMERIC.get("int64" if type_str == "integer" else type_str)
    if num is not None:
        dtype, width = num
        offs_a = np.asarray(offs, dtype=np.int64)
        ok = np.asarray(sizes) >= width
        raw = arr[offs_a[ok, None] + np.arange(width)]
        values = raw.view(dtype).ravel().astype(np.float64)
        return times[ok], values

    k = _STRUCT_DOUBLES.get(type_str)
    if k is not None:
        offs_a = np.asarray(offs, dtype=np.int64)
        ok = np.asarray(sizes) >= 8 * k
        raw = arr[offs_a[ok, None] + np.arange(8 * k)]
        return times[ok], raw.view("<f8").reshape(-1, k).copy()

    k = _STRUCT_DOUBLES.get(type_str.removesuffix("[]"))
    if type_str.endswith("[]") and k is not None:
        values = [np.frombuffer(data, "<f8", s // (8 * k) * k, o).reshape(-1, k) for o, s in zip(offs, sizes)]
        return times, values

    values = []
    keep = []
    for i, (o, s) in enumerate(zip(offs, sizes)):
        v = _decode_value(data[o:o + s], type_str)
        if v is not None:
            values.append(v)
            keep.append(i)
    return times[keep], values


def _decode_value(payload: bytes, type_str: str) -> Any:
    if type_str == "string":
        return payload.decode("utf-8", errors="replace")
    if type_str == "double[]":
        return list(struct.unpack(f"<{len(payload) // 8}d", payload[:len(payload) // 8 * 8]))
    if type_str == "float[]":
        return list(struct.unpack(f"<{len(payload) // 4}f", payload[:len(payload) // 4 * 4]))
    if type_str in ("int64[]", "integer[]"):
        return list(struct.unpack(f"<{len(payload) // 8}q", payload[:len(payload) // 8 * 8]))
    if type_str == "boolean[]":
        return [bool(b) for b in payload]
    return None
