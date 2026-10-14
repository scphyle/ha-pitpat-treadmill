"""Number platform (speed control) for the WalkingPad treadmill."""

from __future__ import annotations

from homeassistant.components.number import NumberDeviceClass, NumberEntity, NumberMode
from homeassistant.const import UnitOfSpeed
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util.unit_system import US_CUSTOMARY_SYSTEM

from . import WalkingPadConfigEntry
from .const import MAX_SPEED_KMH, STOP_THRESHOLD_KMH
from .entity import WalkingPadEntity
from .protocol import KMH_PER_MPH, Status

# The command wire format always carries speed in thousandths of km/h.
MAX_SPEED_MILLI_KMH = int(MAX_SPEED_KMH * 1000)
STOP_THRESHOLD_MILLI_KMH = int(STOP_THRESHOLD_KMH * 1000)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: WalkingPadConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the speed number entity."""
    async_add_entities([WalkingPadSpeedNumber(entry.runtime_data.coordinator)])


class WalkingPadSpeedNumber(WalkingPadEntity, NumberEntity):
    """Target speed slider. Setting it (re)starts the belt; 0 stops it.

    The slider is *optimistic*: it holds the speed you set instead of mirroring
    the treadmill's live (gradually ramping) target, so it doesn't creep. The
    actual belt speed is available on the separate Speed sensor. The held
    setpoint is cleared once the treadmill reports it has stopped.

    Number entities don't auto-convert the ``speed`` device class, so the slider
    picks its unit to match the user's Home Assistant unit system (the Speed
    sensors follow the same system automatically). The treadmill's wire protocol
    always expects km/h, so input is converted back to km/h before sending.
    """

    _attr_translation_key = "speed"
    _attr_device_class = NumberDeviceClass.SPEED
    _attr_mode = NumberMode.SLIDER
    _attr_assumed_state = True

    def __init__(self, coordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.address}_speed"
        self._setpoint: float | None = None

        if coordinator.hass.config.units is US_CUSTOMARY_SYSTEM:
            self._native_to_kmh = KMH_PER_MPH
            self._attr_native_unit_of_measurement = UnitOfSpeed.MILES_PER_HOUR
        else:
            self._native_to_kmh = 1.0
            self._attr_native_unit_of_measurement = UnitOfSpeed.KILOMETERS_PER_HOUR

        self._attr_native_min_value = 0.0
        self._attr_native_max_value = round(MAX_SPEED_KMH / self._native_to_kmh, 1)
        # 0.1 in the *displayed* unit, intentionally matching the treadmill
        # panel's own 0.1-mph / 0.1-km/h resolution (the km/h command itself is
        # finer-grained, so there is no fixed protocol step to preserve).
        self._attr_native_step = 0.1

    @callback
    def _handle_coordinator_update(self) -> None:
        # Once the belt is no longer running, stop holding the setpoint so the
        # slider reflects the treadmill's actual target again.
        if self.data.status in (Status.STOPPED, Status.DISCONNECTED):
            self._setpoint = None
        super()._handle_coordinator_update()

    @property
    def native_value(self) -> float:
        if self._setpoint is not None:
            return self._setpoint
        # Telemetry is normalized to km/h; express it in the slider's unit.
        return round(self.data.speed_cmd / self._native_to_kmh, 2)

    async def async_set_native_value(self, value: float) -> None:
        milli_kmh = int(round(value * self._native_to_kmh * 1000))
        milli_kmh = max(0, min(milli_kmh, MAX_SPEED_MILLI_KMH))
        if milli_kmh <= STOP_THRESHOLD_MILLI_KMH:
            self._setpoint = 0.0
            await self.coordinator.treadmill.async_stop()
            self.async_write_ha_state()
            return
        self._setpoint = round(value, 2)
        await self.coordinator.treadmill.async_set_speed(milli_kmh)
        self.async_write_ha_state()


