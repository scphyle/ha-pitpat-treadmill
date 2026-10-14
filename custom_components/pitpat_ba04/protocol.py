"""Pure protocol layer for the PitPat/Superun treadmill BLE interface.

This module implements the reverse-engineered command/state framing the
treadmill speaks over Bluetooth. It is intentionally free of any Home Assistant
or ``bleak`` imports so it can be unit tested in isolation and reused by the
connection manager.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import IntEnum

# --- Command packet framing ------------------------------------------------
START_BYTE = 0x6A
END_BYTE = 0x43
PACKET_LENGTH = 0x17  # 23 bytes, stored verbatim in byte[1]

# Every command embeds a fixed "user id" and default weight.
DEFAULT_USER_ID = 58965456623
DEFAULT_WEIGHT = 80

# A state notification is at least this many bytes before we trust it.
MIN_STATE_PACKET_LENGTH = 31

# Exact kilometers per mile. The treadmill itself reports metric over BLE; this
# is used by the speed slider to convert user input between mph and km/h.
KMH_PER_MPH = 1.609344


class Command(IntEnum):
    """Command byte values understood by the treadmill."""

    START_SET_SPEED = 4
    PAUSE = 2
    STOP = 0


class Status(IntEnum):
    """Decoded running state of the treadmill."""

    COUNTDOWN = 0
    RUNNING = 1
    PAUSED = 2
    STOPPED = 3
    # Internal-only: not sent by the treadmill, used when the link is down.
    DISCONNECTED = 100


STATUS_STR = {
    Status.COUNTDOWN: "countdown",
    Status.RUNNING: "running",
    Status.PAUSED: "paused",
    Status.STOPPED: "stopped",
    Status.DISCONNECTED: "disconnected",
}


@dataclass
class TreadmillData:
    """Snapshot of treadmill telemetry decoded from a state notification."""

    status: Status = Status.DISCONNECTED
    speed_cmd: float = 0.0  # target speed in km/h
    speed_feedback: float = 0.0  # current speed in km/h
    speed_max: float = 0.0  # max selectable speed in km/h
    distance_km: float = 0.0
    calories: int = 0
    steps: int = 0
    duration_sec: int = 0
    fw_version: int = 0
    imperial: bool = False


def _xor_checksum(packet: bytes, start: int, end_inclusive: int) -> int:
    """XOR every byte in ``packet[start..end_inclusive]`` (the device checksum)."""
    checksum = 0
    for i in range(start, end_inclusive + 1):
        checksum ^= packet[i]
    return checksum


def build_command(
    command: Command,
    speed: int = 0,
    *,
    incline: int = 0,
    weight: int = DEFAULT_WEIGHT,
    user_id: int = DEFAULT_USER_ID,
    imperial: bool = False,
    ramp: int | None = None,
) -> bytes:
    """Build a 23-byte command packet.

    ``speed`` is expressed in thousandths of the command's own unit (km/h
    normally; thousandths of mph when ``imperial=True`` -- see the BA04
    wrappers below, which are the only callers that ever pass ``imperial``).

    ``ramp`` overrides the acceleration-ramp byte. Left as ``None``, it
    defaults to 5 for a non-zero speed and 1 otherwise, matching the FBA0
    variant's only two call sites (``start_command()`` always passes
    speed=0; ``set_speed_command()`` always passes non-zero). The BA04
    variant needs to distinguish "starting the belt" from "changing speed
    while already running" independently of whether speed happens to be
    zero, so its wrappers pass this explicitly.
    """
    packet = bytearray(23)
    packet[0] = START_BYTE
    packet[1] = PACKET_LENGTH
    # bytes 2..5 are reserved (already zero)
    packet[6] = (speed >> 8) & 0xFF
    packet[7] = speed & 0xFF
    packet[8] = ramp if ramp is not None else (5 if speed != 0 else 1)
    packet[9] = incline & 0xFF
    packet[10] = weight & 0xFF
    packet[11] = 0
    # Command byte; bit 3 selects mph mode instead of kph.
    packet[12] = (int(command) | 0x08) if imperial else (int(command) & 0xF7)
    packet[13:21] = int(user_id).to_bytes(8, "big")
    packet[21] = _xor_checksum(packet, 1, 20)
    packet[22] = END_BYTE
    return bytes(packet)


def start_command() -> bytes:
    """Start the belt (set-speed command with speed 0)."""
    return build_command(Command.START_SET_SPEED, 0)


def set_speed_command(speed: int) -> bytes:
    """Set the target speed (in thousandths of km/h)."""
    return build_command(Command.START_SET_SPEED, speed)


def pause_command() -> bytes:
    """Pause the belt."""
    return build_command(Command.PAUSE, 0)


def stop_command() -> bytes:
    """Stop the belt."""
    return build_command(Command.STOP, 0)


def parse_state(payload: bytes | None) -> TreadmillData | None:
    """Decode a state notification into :class:`TreadmillData`.

    Returns ``None`` for missing packets or packets that are too short to be
    valid (anything shorter than 31 bytes is discarded).
    """
    if payload is None or len(payload) < MIN_STATE_PACKET_LENGTH:
        return None

    current_speed = int.from_bytes(payload[3:5], "big")
    target_speed = int.from_bytes(payload[5:7], "big")
    distance = int.from_bytes(payload[7:11], "big")
    steps = int.from_bytes(payload[14:18], "big")
    calories = int.from_bytes(payload[18:20], "big")
    duration_ms = int.from_bytes(payload[20:24], "big")
    fw_version = payload[25]
    flags = payload[26]
    max_speed = int.from_bytes(payload[27:29], "big")

    imperial = bool(flags & 0x80)
    state_bits = flags & 0x18
    status = {
        0x18: Status.COUNTDOWN,
        0x08: Status.RUNNING,
        0x10: Status.PAUSED,
    }.get(state_bits, Status.STOPPED)

    # The treadmill reports speed in km/h and distance in km over BLE, even when
    # its own panel is set to mph/miles (the imperial flag only describes the
    # panel display). Home Assistant converts these metric values to the user's
    # unit system for display, so the decoder must NOT rescale them here.
    return TreadmillData(
        status=status,
        speed_cmd=target_speed / 1000.0,
        speed_feedback=current_speed / 1000.0,
        speed_max=max_speed / 1000.0,
        distance_km=distance / 1000.0,
        calories=calories,
        steps=steps,
        duration_sec=duration_ms // 1000,
        fw_version=fw_version,
        imperial=imperial,
    )


# --- BA04 variant (e.g. PitPat-T01) -----------------------------------------
#
# Confirmed by direct BLE capture and live testing against a real PitPat-T01:
# the inner command/state packet is byte-for-byte identical to the FBA0
# layout above, but:
#   * every packet (both directions) is wrapped in an extra 4-byte outer
#     frame: `4D [dir=0x00 for writes/0x04 for status] [counter] [len]`;
#   * unlike the claim for FBA0 above, this firmware's speed/distance
#     telemetry (and the unit it expects commands in) actually follows the
#     panel's own display unit (mph when ``imperial``), not always km/h --
#     confirmed by a 0.7 mph vs. 1.0 mph discrepancy that only went away once
#     commands were tagged to match the panel's live unit. This wrapper
#     converts back to the canonical km/h contract so the rest of the
#     integration (entities, FBA0 code) never has to know the difference;
#   * the treadmill drops the connection on its own every ~10-20s unless
#     continuously answered -- see ``POLL_INNER_BA04`` and the heartbeat loop
#     in ``walkingpad.py``. No separate init handshake is sent; sending one
#     (as qdomyos-zwift's reference implementation does) was found to make
#     disconnects happen *faster*, not slower.
BA04_OUTER_MARKER = 0x4D
BA04_DIR_WRITE = 0x00
BA04_DIR_STATUS = 0x04
POLL_INNER_BA04 = bytes([0x6A, 0x05, 0xFD, 0xF8, 0x43])


def _wrap_ba04(inner: bytes, counter: int) -> bytes:
    """Prepend the BA04 outer frame to an already-built inner packet."""
    return bytes([BA04_OUTER_MARKER, BA04_DIR_WRITE, counter & 0xFF, len(inner)]) + inner


def poll_command_ba04(counter: int) -> bytes:
    """The bare heartbeat packet that must be sent after every notification."""
    return _wrap_ba04(POLL_INNER_BA04, counter)


def start_command_ba04(counter: int, *, imperial: bool = False) -> bytes:
    """Start the belt at a nominal 1.0 (km/h, or mph when ``imperial``) --
    confirmed by live testing. Unlike the FBA0 variant's ``start_command()``,
    this does NOT send speed=0; that was never tested on this firmware and
    may not mean "resume" the way it apparently does for FBA0. The raw wire
    value is 1000 directly in the panel's native unit (not run through the
    km/h<->mph conversion ``set_speed_command_ba04`` does), matching exactly
    what was captured working against a real device."""
    return _wrap_ba04(
        build_command(Command.START_SET_SPEED, 1000, imperial=imperial, ramp=1), counter
    )


def set_speed_command_ba04(speed_milli_kmh: int, counter: int, *, imperial: bool = False) -> bytes:
    """``speed_milli_kmh`` uses the same canonical km/h contract as everywhere
    else in this integration; it is converted to the panel's native unit
    (mph) here when needed, since that is what this firmware expects."""
    native_speed = (
        int(round(speed_milli_kmh / KMH_PER_MPH)) if imperial else speed_milli_kmh
    )
    return _wrap_ba04(
        build_command(Command.START_SET_SPEED, native_speed, imperial=imperial, ramp=5),
        counter,
    )


def pause_command_ba04(counter: int, *, imperial: bool = False) -> bytes:
    return _wrap_ba04(build_command(Command.PAUSE, 0, imperial=imperial), counter)


def stop_command_ba04(counter: int, *, imperial: bool = False) -> bytes:
    return _wrap_ba04(build_command(Command.STOP, 0, imperial=imperial), counter)


def parse_state_ba04(payload: bytes) -> TreadmillData | None:
    """Decode a BA04 state notification (outer-framed; panel-unit telemetry)."""
    if len(payload) < 4 or payload[0] != BA04_OUTER_MARKER:
        # Not a status frame -- e.g. the short unrelated 5-byte beacon this
        # firmware also sends. Still needs a heartbeat reply; just no data.
        return None
    data = parse_state(payload[4:])
    if data is None or not data.imperial:
        return data
    # Confirmed empirically: when the panel is in imperial mode, this
    # variant's speed/distance telemetry is already in mph/miles, not km/h --
    # convert to the canonical km/h contract the rest of the integration
    # expects. (Assumed, by analogy with the confirmed speed behavior, to
    # apply the same way to distance; not independently verified.)
    return replace(
        data,
        speed_cmd=data.speed_cmd * KMH_PER_MPH,
        speed_feedback=data.speed_feedback * KMH_PER_MPH,
        speed_max=data.speed_max * KMH_PER_MPH,
        distance_km=data.distance_km * KMH_PER_MPH,
    )
