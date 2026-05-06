"""
WPILog parser — reads DogLog/Epilogue .wpilog binary format.
Format spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.md
"""
import struct, math
from dataclasses import dataclass, field
from typing import Any

ENTRY_TYPES = {
    0x00: "raw",
    0x01: "boolean",
    0x02: "integer",
    0x03: "float",
    0x04: "double",
    0x05: "string",
    0x10: "boolean[]",
    0x11: "integer[]",
    0x12: "float[]",
    0x13: "double[]",
    0x14: "string[]",
}

@dataclass
class WPILogEntry:
    entry_id: int
    name: str
    type_str: str
    metadata: str
    records: list = field(default_factory=list)  # [(timestamp_us, value), ...]


def _read_leb128(buf, pos):
    result, shift = 0, 0
    while True:
        b = buf[pos]; pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def parse_wpilog(filepath: str) -> dict[str, WPILogEntry]:
    """Returns dict of entry_name -> WPILogEntry with all records."""
    with open(filepath, "rb") as f:
        data = f.read()

    if data[:6] != b"WPILOG":
        raise ValueError("Not a valid WPILog file")

    version = struct.unpack_from("<H", data, 6)[0]
    extra_header_len = struct.unpack_from("<I", data, 8)[0]
    pos = 12 + extra_header_len

    entries_by_id: dict[int, WPILogEntry] = {}
    entries_by_name: dict[str, WPILogEntry] = {}

    while pos < len(data):
        if pos + 4 > len(data):
            break
        # Record header: bitfield (1), entry_id (1-4), payload_size (1-4), timestamp (1-8)
        bitfield = data[pos]; pos += 1
        entry_id_len  = (bitfield & 0x03) + 1
        payload_len   = ((bitfield >> 2) & 0x03) + 1
        timestamp_len = ((bitfield >> 4) & 0x07) + 1

        entry_id  = int.from_bytes(data[pos:pos+entry_id_len],  "little"); pos += entry_id_len
        payload_size = int.from_bytes(data[pos:pos+payload_len], "little"); pos += payload_len
        timestamp_us = int.from_bytes(data[pos:pos+timestamp_len], "little"); pos += timestamp_len

        payload = data[pos:pos+payload_size]; pos += payload_size

        if entry_id == 0:
            # Control record
            ctrl_type = payload[0]
            if ctrl_type == 0:  # Start record
                rec_entry_id = struct.unpack_from("<I", payload, 1)[0]
                name_len = struct.unpack_from("<I", payload, 5)[0]
                name = payload[9:9+name_len].decode("utf-8", errors="replace")
                p2 = 9 + name_len
                type_len = struct.unpack_from("<I", payload, p2)[0]; p2 += 4
                type_str = payload[p2:p2+type_len].decode("utf-8", errors="replace"); p2 += type_len
                meta_len = struct.unpack_from("<I", payload, p2)[0]; p2 += 4
                metadata = payload[p2:p2+meta_len].decode("utf-8", errors="replace")
                entry = WPILogEntry(rec_entry_id, name, type_str, metadata)
                entries_by_id[rec_entry_id] = entry
                entries_by_name[name] = entry
        else:
            if entry_id not in entries_by_id:
                continue
            entry = entries_by_id[entry_id]
            value = _decode_value(payload, entry.type_str)
            if value is not None:
                entry.records.append((timestamp_us / 1_000_000.0, value))

    return entries_by_name


def _decode_value(payload: bytes, type_str: str) -> Any:
    try:
        if type_str == "boolean":
            return bool(payload[0])
        elif type_str == "double":
            return struct.unpack_from("<d", payload)[0]
        elif type_str == "float":
            return struct.unpack_from("<f", payload)[0]
        elif type_str == "integer" or type_str == "int64":
            return struct.unpack_from("<q", payload)[0]
        elif type_str == "string":
            return payload.decode("utf-8", errors="replace")
        elif type_str == "double[]":
            n = len(payload) // 8
            return list(struct.unpack_from(f"<{n}d", payload))
        elif type_str == "float[]":
            n = len(payload) // 4
            return list(struct.unpack_from(f"<{n}f", payload))
    except Exception:
        pass
    return None


def extract_battery_data(entries: dict, config: dict) -> dict:
    """Extract battery voltage, current, brownout, match mode from wpilog entries."""
    keys = config["log_sources"]["wpilog"]["keys"]
    alt = keys.get("alternate_keys", {})

    def find_key(primary, field_name):
        if primary in entries:
            return entries[primary].records
        for alt_key in alt.get(field_name, []):
            if alt_key in entries:
                return entries[alt_key].records
        # fuzzy search
        low = primary.lower().split("/")[-1]
        for name, entry in entries.items():
            if name.lower().endswith(low):
                return entry.records
        return []

    voltage_records = find_key(keys["battery_voltage"], "battery_voltage")
    current_records = find_key(keys["battery_current"], "battery_current")
    brownout_records = find_key(keys["brownout"], "brownout")
    enabled_records  = find_key(keys["enabled"], "enabled")
    auton_records    = find_key(keys["autonomous"], "autonomous")

    brownout_times = [t for t, v in brownout_records if v]

    return {
        "voltage": voltage_records,
        "current": current_records,
        "brownout_times": brownout_times,
        "enabled": enabled_records,
        "autonomous": auton_records,
    }


def build_match_segments(battery_data: dict) -> list[dict]:
    """Build auton/teleop/disabled segments for timeline coloring."""
    enabled = {t: v for t, v in battery_data["enabled"]}
    auton   = {t: v for t, v in battery_data["autonomous"]}
    if not enabled:
        return []

    times = sorted(set(list(enabled.keys()) + list(auton.keys())))
    if not times:
        return []

    segments = []
    prev_mode = None
    seg_start = times[0]

    def get_mode(t):
        e_times = [x for x in enabled if x <= t]
        a_times = [x for x in auton   if x <= t]
        is_enabled = enabled[max(e_times)] if e_times else False
        is_auton   = auton[max(a_times)]   if a_times else False
        if not is_enabled:
            return "disabled"
        return "auton" if is_auton else "teleop"

    for t in times:
        mode = get_mode(t)
        if mode != prev_mode:
            if prev_mode is not None:
                segments.append({"start": seg_start, "end": t, "mode": prev_mode})
            seg_start = t
            prev_mode = mode

    if prev_mode:
        segments.append({"start": seg_start, "end": times[-1], "mode": prev_mode})

    return segments