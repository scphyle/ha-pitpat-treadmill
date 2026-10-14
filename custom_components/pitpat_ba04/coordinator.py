"""Push-based coordinator for the WalkingPad treadmill."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import DOMAIN
from .walkingpad import WalkingPadTreadmill
from .protocol import TreadmillData

_LOGGER = logging.getLogger(__name__)


class WalkingPadCoordinator(DataUpdateCoordinator[TreadmillData]):
    """Bridges treadmill push notifications to Home Assistant entities.

    The treadmill streams telemetry over GATT notifications while connected, so
    there is no polling: every notification (and every connect/disconnect)
    pushes new data to the entities.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        treadmill: WalkingPadTreadmill,
        address: str,
    ) -> None:
        super().__init__(hass, _LOGGER, name=f"{DOMAIN}_{address}")
        self.entry = entry
        self.treadmill = treadmill
        self.address = address
        self._unregister = treadmill.register_callback(self._handle_update)

    @callback
    def _handle_update(self, data: TreadmillData) -> None:
        self.async_set_updated_data(data)

    @callback
    def async_unload(self) -> None:
        """Stop listening to the treadmill (called on entry unload)."""
        self._unregister()
