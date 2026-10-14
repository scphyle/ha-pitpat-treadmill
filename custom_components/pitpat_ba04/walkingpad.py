"""BLE connection manager for the PitPat/Superun treadmill.

Wraps :mod:`bleak` (via ``bleak-retry-connector``) so the treadmill can be
driven through any Home Assistant Bluetooth adapter, including ESP32 Bluetooth
proxies running in active mode. The proxy handling is entirely transparent: as
long as ``async_ble_device_from_address`` returns a connectable device, the
connection is routed through whichever adapter can reach the treadmill.

Supports two protocol variants (see ``const.py`` and ``protocol.py``):

* ``fba0`` -- the original WalkingPad-style device. No heartbeat needed; the
  treadmill just streams notifications and accepts commands on demand.
* ``ba04`` -- e.g. the PitPat-T01. Requires a continuous notify-triggered
  heartbeat (confirmed by live testing: the treadmill drops the link on its
  own after ~10-20s of silence, and this is true even of the official phone
  app, which papers over it with an instant reconnect). No init handshake is
  sent for this variant -- see ``protocol.py`` for why.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import replace

from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData
from bleak.exc import BleakError
from bleak_retry_connector import (
    BleakClientWithServiceCache,
    BleakNotFoundError,
    establish_connection,
)

from .const import (
    CHARACTERISTIC_NOTIFY_BA04_UUID,
    CHARACTERISTIC_NOTIFY_STATE_UUID,
    CHARACTERISTIC_WRITE_BA04_UUID,
    CHARACTERISTIC_WRITE_UUID,
    VARIANT_BA04,
    VARIANT_FBA0,
)
from .protocol import (
    Status,
    TreadmillData,
    pause_command,
    pause_command_ba04,
    parse_state,
    parse_state_ba04,
    poll_command_ba04,
    set_speed_command,
    set_speed_command_ba04,
    start_command,
    start_command_ba04,
    stop_command,
    stop_command_ba04,
)

_LOGGER = logging.getLogger(__name__)

# Errors that simply mean "try again later" rather than a hard failure.
TRANSIENT_ERRORS = (BleakError, BleakNotFoundError, TimeoutError, EOFError)

TreadmillCallback = Callable[[TreadmillData], None]

# How long to wait for the BA04 treadmill's first unsolicited notification
# before giving up on a connection attempt.
BA04_FIRST_PACKET_TIMEOUT = 10.0
# How long to wait for the next notification before sending a heartbeat
# anyway (matches qdomyos-zwift's own 300ms wait_for_response timeout).
BA04_HEARTBEAT_WAIT_TIMEOUT = 0.3


class WalkingPadTreadmill:
    """Maintains a connection to a single treadmill and decodes its telemetry."""

    def __init__(
        self,
        ble_device: BLEDevice,
        advertisement_data: AdvertisementData | None = None,
        *,
        variant: str = VARIANT_FBA0,
    ) -> None:
        self._ble_device = ble_device
        self._advertisement_data = advertisement_data
        self._variant = variant
        self._write_uuid = (
            CHARACTERISTIC_WRITE_BA04_UUID
            if variant == VARIANT_BA04
            else CHARACTERISTIC_WRITE_UUID
        )
        self._notify_uuid = (
            CHARACTERISTIC_NOTIFY_BA04_UUID
            if variant == VARIANT_BA04
            else CHARACTERISTIC_NOTIFY_STATE_UUID
        )
        self._client: BleakClientWithServiceCache | None = None
        self._connect_lock = asyncio.Lock()
        self._operation_lock = asyncio.Lock()
        self._data = TreadmillData()
        self._callbacks: list[TreadmillCallback] = []
        self._expected_disconnect = False
        self._connected = False

        # BA04-only heartbeat state.
        self._heartbeat_counter = 0
        self._notify_event: asyncio.Event | None = None
        self._heartbeat_task: asyncio.Task | None = None

    @property
    def address(self) -> str:
        """Bluetooth address of the treadmill."""
        return self._ble_device.address

    @property
    def name(self) -> str:
        """Human readable name (falls back to the address)."""
        return self._ble_device.name or self._ble_device.address

    @property
    def data(self) -> TreadmillData:
        """Most recent decoded telemetry."""
        return self._data

    @property
    def connected(self) -> bool:
        """Whether an active GATT link is currently established."""
        return (
            self._connected
            and self._client is not None
            and self._client.is_connected
        )

    def set_ble_device_and_advertisement_data(
        self, ble_device: BLEDevice, advertisement_data: AdvertisementData
    ) -> None:
        """Update the cached device/advert, e.g. from a fresh proxy advertisement."""
        self._ble_device = ble_device
        self._advertisement_data = advertisement_data

    def register_callback(self, callback: TreadmillCallback) -> Callable[[], None]:
        """Register a listener invoked on every telemetry/connection change."""
        self._callbacks.append(callback)

        def _unregister() -> None:
            if callback in self._callbacks:
                self._callbacks.remove(callback)

        return _unregister

    def _fire_callbacks(self) -> None:
        for callback in list(self._callbacks):
            callback(self._data)

    def _notification_handler(self, _sender: int, payload: bytearray) -> None:
        if self._variant == VARIANT_BA04:
            data = parse_state_ba04(bytes(payload))
            # Every notification -- even the short unrelated beacon that
            # doesn't decode to telemetry -- must be answered to keep the
            # link alive, so wake the heartbeat loop regardless of `data`.
            if self._notify_event is not None:
                self._notify_event.set()
        else:
            data = parse_state(bytes(payload))

        if data is None:
            _LOGGER.debug(
                "%s: ignoring non-telemetry packet (%d bytes)", self.name, len(payload)
            )
            return
        self._data = data
        self._fire_callbacks()

    def _disconnected_callback(self, _client: BleakClientWithServiceCache) -> None:
        self._connected = False
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._expected_disconnect:
            _LOGGER.debug("%s: disconnected (expected)", self.name)
        else:
            _LOGGER.debug("%s: disconnected unexpectedly", self.name)
        self._data = replace(self._data, status=Status.DISCONNECTED)
        self._fire_callbacks()

    async def _ba04_heartbeat_loop(self) -> None:
        """Keep answering notifications with a poll packet. The BA04 treadmill
        tears down the link on its own if this ever stops for more than a
        few seconds, so this loop runs for the lifetime of the connection."""
        assert self._notify_event is not None
        try:
            while self.connected:
                try:
                    poll = poll_command_ba04(self._heartbeat_counter)
                    self._heartbeat_counter = (self._heartbeat_counter + 1) & 0xFF
                    # Shares _operation_lock with _async_send so a command
                    # write (start/stop/speed) can never interleave with a
                    # heartbeat write -- overlapping writes confused the
                    # treadmill badly enough to cause GATT errors in testing.
                    async with self._operation_lock:
                        await self._client.write_gatt_char(
                            self._write_uuid, poll, response=True
                        )
                except TRANSIENT_ERRORS as err:
                    _LOGGER.debug("%s: heartbeat write failed: %s", self.name, err)
                    return
                self._notify_event.clear()
                try:
                    await asyncio.wait_for(
                        self._notify_event.wait(), timeout=BA04_HEARTBEAT_WAIT_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            pass

    async def async_ensure_connected(self) -> None:
        """Connect and subscribe to notifications if not already connected."""
        if self.connected:
            return
        async with self._connect_lock:
            if self.connected:
                return
            _LOGGER.debug("%s: connecting", self.name)
            client = await establish_connection(
                BleakClientWithServiceCache,
                self._ble_device,
                self.name,
                self._disconnected_callback,
                ble_device_callback=lambda: self._ble_device,
            )
            try:
                if self._variant == VARIANT_BA04:
                    self._notify_event = asyncio.Event()
                    await client.start_notify(
                        self._notify_uuid, self._notification_handler
                    )
                    # The BA04 treadmill sends an unsolicited packet right
                    # after connecting; no commands (and critically, no init
                    # handshake) should be sent before it, or before the
                    # heartbeat loop is running to keep answering it.
                    await asyncio.wait_for(
                        self._notify_event.wait(), timeout=BA04_FIRST_PACKET_TIMEOUT
                    )
                    self._heartbeat_counter = 0
                else:
                    await client.start_notify(
                        self._notify_uuid, self._notification_handler
                    )
            except (BleakError, EOFError, asyncio.TimeoutError):
                await client.disconnect()
                raise
            self._client = client
            self._expected_disconnect = False
            self._connected = True
            if self._variant == VARIANT_BA04:
                self._heartbeat_task = asyncio.ensure_future(
                    self._ba04_heartbeat_loop()
                )
            _LOGGER.debug("%s: connected", self.name)
            self._fire_callbacks()

    async def async_ensure_connected_safe(self) -> None:
        """Best-effort reconnect that never raises (used for background retries)."""
        try:
            await self.async_ensure_connected()
        except TRANSIENT_ERRORS as err:
            _LOGGER.debug("%s: reconnect attempt failed: %s", self.name, err)

    async def _async_send(self, payload: bytes) -> None:
        async with self._operation_lock:
            await self.async_ensure_connected()
            assert self._client is not None
            _LOGGER.debug("%s: writing %s", self.name, payload.hex())
            await self._client.write_gatt_char(
                self._write_uuid, payload, response=True
            )

    def _next_counter(self) -> int:
        counter = self._heartbeat_counter
        self._heartbeat_counter = (self._heartbeat_counter + 1) & 0xFF
        return counter

    async def async_start(self) -> None:
        """Start the belt."""
        if self._variant == VARIANT_BA04:
            await self._async_send(
                start_command_ba04(self._next_counter(), imperial=self._data.imperial)
            )
        else:
            await self._async_send(start_command())

    async def async_set_speed(self, speed_milli_kmh: int) -> None:
        """Set the target speed (in thousandths of km/h)."""
        if self._variant == VARIANT_BA04:
            await self._async_send(
                set_speed_command_ba04(
                    speed_milli_kmh, self._next_counter(), imperial=self._data.imperial
                )
            )
        else:
            await self._async_send(set_speed_command(speed_milli_kmh))

    async def async_pause(self) -> None:
        """Pause the belt."""
        if self._variant == VARIANT_BA04:
            await self._async_send(
                pause_command_ba04(self._next_counter(), imperial=self._data.imperial)
            )
        else:
            await self._async_send(pause_command())

    async def async_stop(self) -> None:
        """Stop the belt."""
        if self._variant == VARIANT_BA04:
            await self._async_send(
                stop_command_ba04(self._next_counter(), imperial=self._data.imperial)
            )
        else:
            await self._async_send(stop_command())

    async def async_shutdown(self) -> None:
        """Tear down the connection (called when the entry unloads)."""
        self._expected_disconnect = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        client = self._client
        self._client = None
        self._connected = False
        if client is None or not client.is_connected:
            return
        try:
            await client.stop_notify(self._notify_uuid)
        except BleakError:
            pass
        try:
            await client.disconnect()
        except BleakError as err:
            _LOGGER.debug("%s: error during disconnect: %s", self.name, err)
