"""Constants for the WalkingPad treadmill integration."""

from __future__ import annotations

DOMAIN = "walkingpad"

# GATT layout of the PitPat/Superun treadmill -- "FBA0" variant.
SERVICE_PAD_UUID = "0000fba0-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_WRITE_UUID = "0000fba1-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_NOTIFY_STATE_UUID = "0000fba2-0000-1000-8000-00805f9b34fb"

# GATT layout of the sibling "Superun BA04" variant (e.g. PitPat-T01). Same
# inner command/state packet layout as FBA0, but wrapped in an extra 4-byte
# `4D [dir] [counter] [len]` outer frame, and requires a continuous
# notify-triggered heartbeat or the treadmill drops the link after ~10-20s.
SERVICE_BA04_UUID = "0000ffff-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_WRITE_BA04_UUID = "0000ff01-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_NOTIFY_BA04_UUID = "0000ff02-0000-1000-8000-00805f9b34fb"

CONF_VARIANT = "variant"
VARIANT_FBA0 = "fba0"
VARIANT_BA04 = "ba04"

# Advertised name prefix used for Bluetooth discovery.
DEVICE_NAME_PREFIX = "PitPat"

DEFAULT_NAME = "WalkingPad Treadmill"
MANUFACTURER = "PitPat"
MODEL = "Treadmill (BLE)"

# Speed slider bounds, in km/h (the treadmill tops out at 6 km/h).
MIN_SPEED_KMH = 0.0
MAX_SPEED_KMH = 6.0
SPEED_STEP_KMH = 0.1

# Speeds at or below this (in km/h) are treated as a stop request: the treadmill
# stops the belt for any commanded speed <= 100 (0.1 km/h).
STOP_THRESHOLD_KMH = 0.1
