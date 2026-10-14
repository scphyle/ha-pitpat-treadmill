"""Connect to the PitPat-T01 treadmill with NO init handshake -- just
connect, subscribe, and answer every notification with the plain poll
packet (notify-gated: each write waits up to 300ms for the next
notification before sending the next one). This matches
azmke/pitpat-treadmill-control, the only other working reference against
this exact device (FF01/FF02); qdomyos-zwift's 3-packet BA04 init sequence
was dropped after research showed that handshake is unmaintained/broken
per qdomyos's own issue tracker, and our own A/B test showed sessions
without it survived far longer (45-55s) than sessions with it (5-7s).

Usage:
    .venv/bin/python ble_capture.py [--address MAC] [--log FILE]

Ctrl+C to stop. Appends JSON-lines to the log file (default capture_log.jsonl)
with a timestamp, direction (notify/write), and raw hex for later analysis.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time

from bleak import BleakClient

from protocol import build_poll, parse_outer

NOTIFY_WAIT_TIMEOUT_S = 0.3  # matches qdomyos-zwift's writeCharacteristic() 300ms wait

SERVICE_UUID = "0000ffff-0000-1000-8000-00805f9b34fb"
WRITE_CHAR_UUID = "0000ff01-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR_UUID = "0000ff02-0000-1000-8000-00805f9b34fb"

DEFAULT_ADDRESS = "9C:9E:6E:1A:0D:AE"


def log_line(log_file, direction: str, data: bytes) -> None:
    entry = {
        "t": time.time(),
        "dir": direction,
        "hex": data.hex(),
        "parsed": parse_outer(data),
    }
    line = json.dumps(entry)
    print(f"[{direction}] {data.hex()}  parsed={entry['parsed']}")
    log_file.write(line + "\n")
    log_file.flush()


async def run(address: str, log_path: str) -> None:
    notify_event = asyncio.Event()

    with open(log_path, "a") as log_file:
        async with BleakClient(address) as client:
            print(f"Connected to {address}")

            def handle_notify(_char, data: bytearray) -> None:
                raw = bytes(data)
                log_line(log_file, "notify", raw)
                notify_event.set()

            async def write_and_wait(pkt: bytes, name: str) -> None:
                notify_event.clear()
                await client.write_gatt_char(WRITE_CHAR_UUID, pkt, response=True)
                log_line(log_file, name, pkt)
                try:
                    await asyncio.wait_for(notify_event.wait(), timeout=NOTIFY_WAIT_TIMEOUT_S)
                except asyncio.TimeoutError:
                    pass

            await client.start_notify(NOTIFY_CHAR_UUID, handle_notify)
            print("Subscribed. Waiting for the treadmill's first unsolicited packet...")
            await asyncio.wait_for(notify_event.wait(), timeout=10)

            counter = 0
            print("No init sequence sent. Polling, each write gated on the next notification (Ctrl+C to stop)...")

            try:
                while client.is_connected:
                    await write_and_wait(build_poll(counter), "write")
                    counter = (counter + 1) & 0xFF
            except asyncio.CancelledError:
                pass
            finally:
                if client.is_connected:
                    await client.stop_notify(NOTIFY_CHAR_UUID)
                print("Disconnected.")


async def run_forever(address: str, log_path: str) -> None:
    # The treadmill drops the link on its own every so often (confirmed via
    # HCI capture: "Remote User Terminated Connection", 0x13 -- happens even
    # to the official app). The official app reconnects in ~130ms by keeping
    # the device on a BLE accept list; we can't easily replicate that via
    # bleak, but reconnecting immediately (no artificial delay) keeps the
    # disconnected window short enough to avoid a sustained alert beep.
    while True:
        try:
            await run(address, log_path)
        except Exception as exc:  # noqa: BLE001
            print(f"session error: {exc}")
        print("Reconnecting immediately...")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", default=DEFAULT_ADDRESS, help="Treadmill BLE MAC address")
    parser.add_argument("--log", default="capture_log.jsonl", help="Path to append JSON-lines log")
    parser.add_argument("--once", action="store_true", help="Don't auto-reconnect after a drop")
    args = parser.parse_args()

    try:
        if args.once:
            asyncio.run(run(args.address, args.log))
        else:
            asyncio.run(run_forever(args.address, args.log))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
