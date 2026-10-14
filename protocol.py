"""Packet framing for the Deer Run / PitPat-T01 (Superun BA04) BLE protocol.

Outer frame:  4D [dir] [counter] [len] | inner
Inner packet: [marker] [len] [payload...] [checksum] 43

len = 4 + len(payload)  (marker + len + checksum + terminator, plus payload)
checksum = XOR of (len byte, *payload bytes)

Verified against the known poll packet:
  4D 00 cnt 05 6A 05 FD F8 43
  -> marker=0x6A, payload=b'\xFD', checksum = 0x05 ^ 0xFD = 0xF8
"""
from __future__ import annotations

import functools
import operator

DIR_HOST = 0x00     # our writes
DIR_STATUS = 0x04   # treadmill status notifications

POLL_MARKER = 0x6A
POLL_PAYLOAD = bytes([0xFD])

# BA04 init handshake, transcribed verbatim from qdomyos-zwift's
# deerruntreadmill.cpp (superun_ba04 branch of btinit()). Sent once right
# after connecting, before the steady poll loop starts. init2 keeps
# counter=0 due to an upstream off-by-one (initData1[2] is set instead of
# initData2[2]) -- replicated here on purpose for fidelity with what the
# real app sends.
INIT1 = bytes([0x4D, 0x00, 0x00, 0x05, 0x6A, 0x05, 0xFD, 0xF8, 0x43])
INIT2 = bytes([0x4D, 0x00, 0x00, 0x05, 0x6A, 0x05, 0xFD, 0xF8, 0x43])
INIT3 = bytes([
    0x4D, 0x00, 0x02, 0x17, 0x6A, 0x17, 0x00, 0x00, 0x00, 0x00, 0x03, 0xE8,
    0x05, 0x00, 0x50, 0x00, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xB5,
    0x7C, 0x7C, 0x43,
])
POLL_INTERVAL_S = 0.2  # matches qdomyos-zwift's default_poll_device_time (200ms)


def xor_all(data: bytes) -> int:
    return functools.reduce(operator.xor, data, 0)


def build_packet(counter: int, marker: int, payload: bytes, dir_byte: int = DIR_HOST) -> bytes:
    inner_len = 4 + len(payload)
    checksum = xor_all(bytes([inner_len]) + payload)
    return bytes([0x4D, dir_byte, counter & 0xFF, inner_len, marker, inner_len]) + payload + bytes([checksum, 0x43])


def build_poll(counter: int) -> bytes:
    return build_packet(counter, POLL_MARKER, POLL_PAYLOAD)


def parse_outer(packet: bytes) -> dict:
    """Best-effort split of an incoming notification into outer/inner fields.

    Field meanings beyond framing are still unconfirmed for status (dir=04)
    packets -- this is for logging/inspection, not a trusted decoder yet.
    """
    if len(packet) < 4 or packet[0] != 0x4D:
        return {"raw": packet.hex(), "error": "no 0x4D start byte"}
    dir_byte, counter, outer_len = packet[1], packet[2], packet[3]
    inner = packet[4:]
    result = {
        "dir": dir_byte,
        "counter": counter,
        "outer_len": outer_len,
        "inner_len_actual": len(inner),
        "inner_hex": inner.hex(),
    }
    if inner:
        result["marker"] = inner[0]
        if len(inner) >= 2:
            result["inner_len_field"] = inner[1]
        if len(inner) >= 2 and inner[-1] == 0x43:
            payload = inner[2:-2]
            checksum_byte = inner[-2]
            computed = xor_all(bytes([inner[1]]) + payload)
            result["payload_hex"] = payload.hex()
            result["checksum_byte"] = checksum_byte
            result["checksum_computed"] = computed
            result["checksum_ok"] = checksum_byte == computed
    return result
