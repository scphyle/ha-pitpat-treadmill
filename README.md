# PitPat Treadmill (BA04) for Home Assistant

A fork of [sirfergy/HomeAssistantWalkingPad](https://github.com/sirfergy/HomeAssistantWalkingPad)
adding support for the "Superun BA04" protocol variant used by some PitPat
treadmills (confirmed against a **PitPat-T01**), alongside the original
variant it already supported.

Controls the treadmill over Bluetooth Low Energy, routed through Home
Assistant's own `bluetooth` integration -- including through an ESPHome
Bluetooth proxy in active mode, so no dedicated bridge hardware is needed.

## Supported devices

| Variant | GATT service | Devices |
|---|---|---|
| FBA0 (original) | `0xFBA0` / `0xFBA1` / `0xFBA2` | Original WalkingPad-style devices |
| BA04 (this fork) | `0xFFFF` / `0xFF01` / `0xFF02` | PitPat-T01 and likely other "Superun BA04" devices |

The variant is auto-detected during Bluetooth discovery -- no manual
configuration needed.

This fork uses its own integration domain (`pitpat_ba04`, folder
`custom_components/pitpat_ba04/`) so it can never collide with the upstream
`sirfergy/HomeAssistantWalkingPad` integration (domain `walkingpad`) even if
both happen to be installed at once. That said, since this fork is a
superset -- it handles both FBA0 and BA04 devices -- there's no reason to
keep the original installed alongside it; having both will just register
the same treadmill twice under two different integrations.

## Installation

### Via HACS (custom repository)

1. HACS → the three-dot menu (top right) → **Custom repositories**
2. Add `https://github.com/scphyle/ha-pitpat-treadmill`, category **Integration**
3. Install "PitPat Treadmill (BA04)" from HACS, then restart Home Assistant
4. The treadmill should be auto-discovered once it's powered on and in range
   (of Home Assistant's own adapter or an active Bluetooth proxy); otherwise
   add it manually via **Settings → Devices & Services → Add Integration**

### Manual

Copy `custom_components/pitpat_ba04/` into your Home Assistant `config/custom_components/`
directory and restart Home Assistant.

## What you get

- Sensors: speed, distance, duration, calories, steps, max speed, firmware version
- A speed slider (also starts/retargets the belt)
- Start / Pause / Stop buttons
- A companion Lovelace card (see below) with a live speed readout, slider,
  start/pause/stop controls, and a workout stats grid

## The Lovelace card

The integration auto-registers three companion cards as a frontend resource
-- no manual resource setup needed. Add whichever size fits to a dashboard
as a manual card:

| `type:` | What it shows |
|---|---|
| `custom:pitpat-treadmill-card` | Full -- animated walker, speed, stats |
| `custom:pitpat-treadmill-controls-card` | Controls only -- speed + start/pause/stop, no animation |
| `custom:pitpat-treadmill-mini-card` | Just Start/Stop |

Each one has a GUI editor (click "Edit" on the card, or add it via the card
picker's visual editor) with a device picker and, for the full/controls
cards, name/logo fields -- no YAML needed for the common case. All three
also accept the same YAML config shown below if you prefer hand-editing it
(the smaller ones just ignore options that don't apply to them -- the mini
card has no header, so `name`/`logo` are no-ops there):

```yaml
type: custom:pitpat-treadmill-card
# device_id: <id>   # pick which treadmill if you have more than one -- if
                     # omitted, one is picked arbitrarily, so only leave this
                     # out when you have exactly one treadmill
# name: My Treadmill   # optional; defaults to the device's own name, so
                        # renaming it under Settings -> Devices is usually
                        # enough on its own
# logo: /local/your-logo.png   # optional, replaces the default icon -- left
                                # unset by default so installing this card
                                # doesn't brand your dashboard with anything
```

Entities are matched to the device automatically, so it keeps working even if
you rename entities' friendly names. If auto-detection ever picks the wrong
entity, any of these can be pinned explicitly: `state_entity`,
`speed_sensor_entity`, `speed_entity` (the number), `distance_entity`,
`duration_entity`, `calories_entity`, `steps_entity`, `start_entity`,
`pause_entity`, `stop_entity`.

## Notes on the BA04 variant

Reverse-engineered through direct BLE capture against a real PitPat-T01
(packet framing, checksum, and command bytes), cross-checked against two
independent open-source references
([cagnulein/qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift)'s
`deerruntreadmill.cpp`, and
[azmke/pitpat-treadmill-control](https://github.com/azmke/pitpat-treadmill-control)),
and validated live against the official PitPat phone app's own BLE traffic
(captured via Android's HCI snoop log).

A few things worth knowing:

- This firmware drops the BLE connection on its own every ~10-20 seconds,
  regardless of client -- confirmed true even of the official phone app
  (which papers over it with a near-instant reconnect). This integration
  handles that by reconnecting immediately through Home Assistant's
  Bluetooth stack; it's expected behavior, not a bug.
- No BA04 "init handshake" is sent on connect. qdomyos-zwift's reference
  implementation sends one, but testing found it made disconnects happen
  *faster*, not slower -- its own issue tracker has open, unresolved reports
  of this exact symptom against this device family.
- Commands are tagged to match the treadmill's own live panel unit setting
  (metric/imperial); getting this wrong was found to produce incorrect
  speeds (e.g. a commanded 1.0 mph start landing at ~0.7 mph).
- **Unverified assumption:** distance is assumed to need the same unit
  conversion as speed when the panel is in imperial mode, by analogy with
  the speed behavior above -- this specific case wasn't independently
  confirmed against a live device.

## Credits

- [sirfergy/HomeAssistantWalkingPad](https://github.com/sirfergy/HomeAssistantWalkingPad) -- the integration this is forked from (coordinator, entities, config flow, FBA0 protocol support)
- [cagnulein/qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) -- BA04 init sequence reference (and its issue tracker, which confirmed this device family's disconnect behavior is a known, unresolved quirk)
- [azmke/pitpat-treadmill-control](https://github.com/azmke/pitpat-treadmill-control) -- BA04 status-field byte offsets and command encoding reference

## License

GPLv3, same as upstream -- see [LICENSE](LICENSE).
