"""Sensor platform for the WalkingPad treadmill."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import (
    EntityCategory,
    UnitOfLength,
    UnitOfSpeed,
    UnitOfTime,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.typing import StateType

from . import WalkingPadConfigEntry
from .entity import WalkingPadEntity
from .protocol import STATUS_STR, TreadmillData

STATE_OPTIONS = [
    "countdown",
    "running",
    "paused",
    "stopped",
    "disconnected",
]


@dataclass(frozen=True, kw_only=True)
class WalkingPadSensorEntityDescription(SensorEntityDescription):
    """Describes a WalkingPad sensor."""

    value_fn: Callable[[TreadmillData], StateType]


SENSORS: tuple[WalkingPadSensorEntityDescription, ...] = (
    WalkingPadSensorEntityDescription(
        key="state",
        translation_key="state",
        device_class=SensorDeviceClass.ENUM,
        options=STATE_OPTIONS,
        value_fn=lambda data: STATUS_STR.get(data.status, "stopped"),
    ),
    WalkingPadSensorEntityDescription(
        key="speed_feedback",
        translation_key="speed_feedback",
        device_class=SensorDeviceClass.SPEED,
        native_unit_of_measurement=UnitOfSpeed.KILOMETERS_PER_HOUR,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda data: round(data.speed_feedback, 2),
    ),
    WalkingPadSensorEntityDescription(
        key="distance",
        translation_key="distance",
        device_class=SensorDeviceClass.DISTANCE,
        native_unit_of_measurement=UnitOfLength.KILOMETERS,
        state_class=SensorStateClass.TOTAL_INCREASING,
        suggested_display_precision=2,
        value_fn=lambda data: round(data.distance_km, 3),
    ),
    WalkingPadSensorEntityDescription(
        key="duration",
        translation_key="duration",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda data: data.duration_sec,
    ),
    WalkingPadSensorEntityDescription(
        key="calories",
        translation_key="calories",
        native_unit_of_measurement="kcal",
        state_class=SensorStateClass.TOTAL_INCREASING,
        icon="mdi:fire",
        value_fn=lambda data: data.calories,
    ),
    WalkingPadSensorEntityDescription(
        key="steps",
        translation_key="steps",
        native_unit_of_measurement="steps",
        state_class=SensorStateClass.TOTAL_INCREASING,
        icon="mdi:shoe-print",
        entity_registry_enabled_default=False,
        value_fn=lambda data: data.steps,
    ),
    WalkingPadSensorEntityDescription(
        key="max_speed",
        translation_key="max_speed",
        device_class=SensorDeviceClass.SPEED,
        native_unit_of_measurement=UnitOfSpeed.KILOMETERS_PER_HOUR,
        entity_category=EntityCategory.DIAGNOSTIC,
        suggested_display_precision=1,
        value_fn=lambda data: round(data.speed_max, 2),
    ),
    WalkingPadSensorEntityDescription(
        key="firmware",
        translation_key="firmware",
        entity_category=EntityCategory.DIAGNOSTIC,
        icon="mdi:chip",
        value_fn=lambda data: data.fw_version or None,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: WalkingPadConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up WalkingPad sensors."""
    coordinator = entry.runtime_data.coordinator
    async_add_entities(
        WalkingPadSensor(coordinator, description) for description in SENSORS
    )


class WalkingPadSensor(WalkingPadEntity, SensorEntity):
    """A WalkingPad telemetry sensor."""

    entity_description: WalkingPadSensorEntityDescription

    def __init__(self, coordinator, description) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{coordinator.address}_{description.key}"

    @property
    def available(self) -> bool:
        """The connection state sensor stays available even when disconnected."""
        if self.entity_description.key == "state":
            return self.coordinator.last_update_success
        return super().available

    @property
    def native_value(self) -> StateType:
        return self.entity_description.value_fn(self.data)
