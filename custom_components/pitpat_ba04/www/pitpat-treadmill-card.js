/**
 * Lovelace cards for the PitPat Treadmill (BA04) integration. Three sizes,
 * all registered from this one file, each with a GUI config editor (the
 * "Visual editor" tab in the card picker -- device/name/logo pickers, no
 * YAML required for the common case):
 *   - custom:pitpat-treadmill-card           full (animated walker + stats)
 *   - custom:pitpat-treadmill-controls-card  controls only, no animation
 *   - custom:pitpat-treadmill-mini-card      just Start/Stop
 *
 * YAML config shape (same for all three; the mini card's editor only shows
 * device_id since it has no header to put a name/logo on, but all three
 * accept the same keys if you hand-edit YAML regardless):
 *   type: custom:pitpat-treadmill-card
 *   # device_id: <id>   # pick which treadmill if you have more than one;
 *                        # auto-detected (arbitrarily!) if omitted and only
 *                        # safe to omit when you have exactly one
 *   # name: My Treadmill # optional title override; defaults to the device's
 *                        # own name (Settings -> Devices -> rename there to
 *                        # change it without touching card config at all)
 *                        # -- ignored by the mini card, which has no title
 *   # logo: /local/your-logo.svg   # optional header image, replaces the
 *                                  # default icon -- left unset by default
 *                                  # so installing this doesn't brand
 *                                  # everyone's dashboard with someone else's
 *                                  # logo -- ignored by the mini card
 *
 * Entities are auto-matched to the chosen device by their translation key, so
 * the card works regardless of friendly-name overrides. Any entity can still
 * be pinned explicitly if auto-detection ever picks the wrong one (YAML only,
 * no GUI field for these -- they're an escape hatch, not the common case):
 *   state_entity, speed_sensor_entity, speed_entity (the number), distance_entity,
 *   duration_entity, calories_entity, steps_entity, start_entity, pause_entity,
 *   stop_entity
 */

const DOMAIN = "pitpat_ba04";

const STATE_META = {
  countdown: { label: "Countdown", color: "var(--info-color, #039be5)" },
  running: { label: "Walking", color: "var(--success-color, #4caf50)" },
  paused: { label: "Paused", color: "var(--warning-color, #ff9800)" },
  stopped: { label: "Stopped", color: "var(--disabled-text-color, #9e9e9e)" },
  disconnected: { label: "Disconnected", color: "var(--error-color, #db4437)" },
};

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function fmtNumber(value, digits) {
  const n = Number(value);
  if (Number.isNaN(n)) return "–";
  return n.toFixed(digits);
}

// Shared CSS, reused verbatim inside each card's own shadow root. Each card
// attaches its own Shadow DOM (see PitpatCardBase._buildDom convention
// below), so these rules are already scoped per-instance and can't leak into
// or collide with any other card on the dashboard -- sharing the literal
// string is just to avoid keeping three copies of each rule in sync, not to
// guard against cross-card collisions (Shadow DOM already rules those out).
const BASE_STYLES = `
  :host { display: block; }
  .pitpat-card { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .pitpat-buttons { display: flex; gap: 8px; }
  .pitpat-buttons button {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 10px 4px; border: none; border-radius: var(--ha-card-border-radius, 12px);
    background: var(--secondary-background-color); color: var(--primary-text-color);
    font-size: 0.75em; cursor: pointer;
  }
  .pitpat-buttons button:disabled { opacity: 0.4; cursor: default; }
  .pitpat-buttons button.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .pitpat-buttons ha-icon { --mdc-icon-size: 22px; }
`;

const HEADER_AND_SPEED_STYLES = `
  .pitpat-header { display: flex; align-items: center; gap: 12px; }
  .pitpat-logo { width: 32px; height: 32px; flex-shrink: 0; object-fit: contain; }
  .pitpat-logo-fallback {
    width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--state-icon-color, var(--primary-color));
    color: var(--text-primary-color, #fff);
  }
  .pitpat-title { font-size: 1.1em; font-weight: 500; color: var(--primary-text-color); flex: 1; }
  .pitpat-chip {
    font-size: 0.8em; font-weight: 500; padding: 4px 10px; border-radius: 12px;
    color: #fff; white-space: nowrap; transition: background-color 0.3s ease;
  }
  .pitpat-speed-row { display: flex; align-items: baseline; justify-content: center; gap: 6px; }
  .pitpat-speed-value { font-size: 2.6em; font-weight: 600; line-height: 1; color: var(--primary-text-color); }
  .pitpat-speed-unit { font-size: 1em; color: var(--secondary-text-color); }
  .pitpat-slider-row { display: flex; align-items: center; gap: 8px; }
  .pitpat-slider-row span { font-size: 0.85em; color: var(--secondary-text-color); min-width: 2.5em; text-align: center; }
  .pitpat-speed-btn {
    flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; border: none; padding: 0;
    background: var(--secondary-background-color); color: var(--primary-text-color);
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .pitpat-speed-btn:disabled { opacity: 0.4; cursor: default; }
  .pitpat-speed-btn ha-icon { --mdc-icon-size: 18px; }
  .pitpat-slider { flex: 1; min-width: 0; accent-color: var(--primary-color); height: 24px; }
`;

const HERO_AND_STATS_STYLES = `
  .pitpat-hero {
    background: var(--secondary-background-color);
    border-radius: calc(var(--ha-card-border-radius, 12px) - 4px);
    padding: 4px 8px;
  }
  .pitpat-hero-svg { display: block; width: 100%; height: 72px; }
  .pitpat-deck { fill: var(--card-background-color); stroke: var(--divider-color); stroke-width: 1.5; }
  .pitpat-foot, .pitpat-console-mast { fill: var(--divider-color); }
  .pitpat-console-screen { fill: var(--primary-color); opacity: 0.18; stroke: var(--primary-color); stroke-width: 1.5; }
  .pitpat-belt-dash {
    stroke: var(--disabled-text-color); stroke-width: 2; stroke-linecap: round;
    stroke-dasharray: 6 6;
    transition: stroke-dashoffset 0.35s ease-out;
  }
  .pitpat-head { fill: none; stroke: var(--primary-text-color); stroke-width: 3; }
  .pitpat-torso { stroke: var(--primary-text-color); stroke-width: 3; stroke-linecap: round; }
  .pitpat-leg, .pitpat-arm {
    stroke: var(--primary-text-color); stroke-width: 3; stroke-linecap: round;
    transform-box: fill-box; transform-origin: 50% 0%;
    transition: transform 0.4s ease-in-out;
  }
  /* Knee/elbow joints, nested inside their leg/arm. At rest (no pose
     gives them their own transform) they add zero extra rotation, so
     the limb still reads as one straight line -- exactly the old
     single-segment look -- for every pose except seated. */
  .pitpat-shin, .pitpat-forearm {
    transform-box: fill-box; transform-origin: 50% 0%;
    transition: transform 0.4s ease-in-out;
  }
  .pitpat-walker {
    transform-box: fill-box; transform-origin: 50% 100%;
    transition: transform 0.4s ease-in-out;
  }
  .pitpat-book {
    fill: var(--card-background-color); stroke: var(--primary-text-color);
    stroke-width: 1.5; opacity: 0; transition: opacity 0.3s ease;
  }
  .pitpat-book-spine { stroke: var(--primary-text-color); stroke-width: 1; }
  @keyframes pitpat-stride {
    0%, 100% { transform: rotate(-22deg); }
    50% { transform: rotate(22deg); }
  }
  @keyframes pitpat-belt-move { to { stroke-dashoffset: 24; } }
  @keyframes pitpat-bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-1.5px); }
  }
  /* One-shot walk from the treadmill over to the chair: linear travel
     across the floor with a bob baked in every 10%, approximating the
     gait's up-down bounce while translating. Distance (152px) matches
     the gap between the walker's resting centerline (x=98) and the
     chair's (x=250) in the SVG's own coordinate space. The deck's
     right edge (x=160) is crossed 62 of those 152px in (~40%), which
     is where the +8px floor-drop lands -- a step down off the raised
     deck -- and it holds through the rest of the walk and into the
     seated pose, whose own translateY (8px) matches exactly so there's
     no jump at the transit->seated handoff. */
  @keyframes pitpat-walk-transit {
    0% { transform: translate(0, 0); }
    10% { transform: translate(15.2px, -1.5px); }
    20% { transform: translate(30.4px, 0); }
    30% { transform: translate(45.6px, -1.5px); }
    40% { transform: translate(60.8px, 8px); }
    50% { transform: translate(76px, 6.5px); }
    60% { transform: translate(91.2px, 8px); }
    70% { transform: translate(106.4px, 6.5px); }
    80% { transform: translate(121.6px, 8px); }
    90% { transform: translate(136.8px, 6.5px); }
    100% { transform: translate(152px, 8px); }
  }
  /* Mirrored walk back to the treadmill. Starts at the seated pose's
     own (152px, 8px) for a seamless handoff, and steps back UP onto
     the deck at the same edge -- now 59.2% of the way into this
     (reversed) walk, since it's measured from the chair end instead. */
  @keyframes pitpat-walk-return {
    0% { transform: translate(152px, 8px); }
    10% { transform: translate(136.8px, 6.5px); }
    20% { transform: translate(121.6px, 8px); }
    30% { transform: translate(106.4px, 6.5px); }
    40% { transform: translate(91.2px, 8px); }
    50% { transform: translate(76px, 6.5px); }
    60% { transform: translate(60.8px, 0); }
    70% { transform: translate(45.6px, -1.5px); }
    80% { transform: translate(30.4px, 0); }
    90% { transform: translate(15.2px, -1.5px); }
    100% { transform: translate(0, 0); }
  }

  /* Walking: the only pose that's actually animated/looping. */
  .pitpat-hero.pitpat-pose-walking .pitpat-leg,
  .pitpat-hero.pitpat-pose-walking .pitpat-arm {
    animation: pitpat-stride var(--pitpat-stride-dur, 1.2s) ease-in-out infinite;
  }
  .pitpat-hero.pitpat-pose-walking .pitpat-leg-b,
  .pitpat-hero.pitpat-pose-walking .pitpat-arm-a {
    animation-delay: calc(var(--pitpat-stride-dur, 1.2s) / -2);
  }
  .pitpat-hero.pitpat-pose-walking .pitpat-walker {
    animation: pitpat-bob calc(var(--pitpat-stride-dur, 1.2s) / 2) ease-in-out infinite;
  }
  .pitpat-hero.pitpat-pose-walking .pitpat-belt-dash {
    animation: pitpat-belt-move var(--pitpat-stride-dur, 1.2s) linear infinite;
  }

  /* Paused: stand normally but fold the arms across the chest.
     Resting (unrotated) points straight down, so swinging ~100deg from
     vertical brings the hand to roughly horizontal, across the body --
     not up over the head (a much larger angle would do that instead). */
  .pitpat-hero.pitpat-pose-paused .pitpat-arm-a { transform: rotate(-100deg); }
  .pitpat-hero.pitpat-pose-paused .pitpat-arm-b { transform: rotate(100deg); }

  /* Stopped: he steps off and walks over to the chair (one-shot, not
     looping) before settling into the seated pose below. Legs/arms
     keep swinging at a fixed, ordinary walking cadence during the
     crossing -- not tied to the treadmill's own (now irrelevant) speed. */
  .pitpat-hero.pitpat-pose-transit .pitpat-walker {
    animation: pitpat-walk-transit 1.8s linear 1 forwards;
  }
  .pitpat-hero.pitpat-pose-transit .pitpat-leg,
  .pitpat-hero.pitpat-pose-transit .pitpat-arm {
    animation: pitpat-stride 0.6s ease-in-out infinite;
  }
  .pitpat-hero.pitpat-pose-transit .pitpat-leg-b,
  .pitpat-hero.pitpat-pose-transit .pitpat-arm-a {
    animation-delay: -0.3s;
  }

  /* Seated: arrived at the chair. The walker group just translates
     (98,50)->(250,58) -- no body rotation needed, sitting upright --
     and each thigh/upper-arm gets a rigid swing with its shin/forearm
     counter-rotating by the same amount, so the lower limb still reads
     as vertical (foot on the floor, forearm up holding the book)
     instead of the whole leg/arm swinging as one straight stick. */
  .pitpat-hero.pitpat-pose-seated .pitpat-walker { transform: translate(152px, 8px); }
  .pitpat-hero.pitpat-pose-seated .pitpat-leg-a { transform: rotate(90deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-shin-a { transform: rotate(-90deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-leg-b { transform: rotate(-90deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-shin-b { transform: rotate(90deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-arm-a { transform: rotate(40deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-forearm-a { transform: rotate(-90deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-arm-b { transform: rotate(-40deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-forearm-b { transform: rotate(90deg); }
  .pitpat-hero.pitpat-pose-seated .pitpat-book { opacity: 1; }

  /* Hitting Start/Resume from the chair walks him back rather than
     cutting straight to standing -- mirrors the transit pose above. */
  .pitpat-hero.pitpat-pose-return .pitpat-walker {
    animation: pitpat-walk-return 1.8s linear 1 forwards;
  }
  .pitpat-hero.pitpat-pose-return .pitpat-leg,
  .pitpat-hero.pitpat-pose-return .pitpat-arm {
    animation: pitpat-stride 0.6s ease-in-out infinite;
  }
  .pitpat-hero.pitpat-pose-return .pitpat-leg-b,
  .pitpat-hero.pitpat-pose-return .pitpat-arm-a {
    animation-delay: -0.3s;
  }

  .pitpat-hero.pitpat-disconnected { opacity: 0.4; filter: grayscale(1); }
  .pitpat-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 12px;
    text-align: center;
  }
  .pitpat-stat-value { font-size: 1.1em; font-weight: 500; color: var(--primary-text-color); }
  .pitpat-stat-label { font-size: 0.7em; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.03em; }
`;

function headerMarkup() {
  return `
    <div class="pitpat-header">
      <div class="pitpat-logo-slot"></div>
      <div class="pitpat-title"></div>
      <div class="pitpat-chip"></div>
    </div>
  `;
}

function speedMarkup() {
  return `
    <div class="pitpat-speed-row">
      <span class="pitpat-speed-value">–</span>
      <span class="pitpat-speed-unit"></span>
    </div>
    <div class="pitpat-slider-row">
      <button class="pitpat-speed-btn pitpat-speed-down" aria-label="Decrease speed"><ha-icon icon="mdi:minus"></ha-icon></button>
      <span class="pitpat-slider-min"></span>
      <input class="pitpat-slider" type="range" step="0.1" />
      <span class="pitpat-slider-max"></span>
      <button class="pitpat-speed-btn pitpat-speed-up" aria-label="Increase speed"><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>
  `;
}

function buttonsMarkup({ includePause }) {
  return `
    <div class="pitpat-buttons">
      <button class="pitpat-btn-start"><ha-icon icon="mdi:play"></ha-icon>Start</button>
      ${includePause ? '<button class="pitpat-btn-pause"><ha-icon icon="mdi:pause"></ha-icon>Pause</button>' : ""}
      <button class="pitpat-btn-stop"><ha-icon icon="mdi:stop"></ha-icon>Stop</button>
    </div>
  `;
}

/** Shared plumbing for all three card sizes: entity resolution, the speed
 * slider/nudge-button service calls, button presses, and Shadow DOM setup.
 * Each subclass supplies its own _buildDom()/_update() for whatever subset
 * of markup it actually renders, building into this.shadowRoot. */
class PitpatCardBase extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._entityIds = null;
    this._built = false;
    this._pendingSpeed = null;
    this._speedDebounce = null;
  }

  static getStubConfig() {
    return {};
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._entityIds) {
      this._entityIds = this._resolveEntities(hass);
    }
    if (!this._built) {
      this._buildDom();
      this._built = true;
    }
    this._update();
  }

  disconnectedCallback() {
    clearTimeout(this._speedDebounce);
  }

  _shadow() {
    return this.shadowRoot || this.attachShadow({ mode: "open" });
  }

  _resolveEntities(hass) {
    const cfg = this._config || {};
    const registry = hass.entities || {};
    const mineAll = Object.values(registry).filter(
      (e) => e.platform === DOMAIN
    );

    let deviceId = cfg.device_id;
    if (!deviceId) {
      const ids = new Set(mineAll.map((e) => e.device_id).filter(Boolean));
      if (ids.size) deviceId = ids.values().next().value;
    }
    const mine = deviceId
      ? mineAll.filter((e) => e.device_id === deviceId)
      : mineAll;

    const byKey = (key, domain, altSuffixes) => {
      let found = mine.find(
        (e) =>
          e.translation_key === key && e.entity_id.startsWith(domain + ".")
      );
      if (!found && altSuffixes) {
        found = mine.find(
          (e) =>
            e.entity_id.startsWith(domain + ".") &&
            altSuffixes.some((s) => e.entity_id.endsWith("_" + s))
        );
      }
      return found ? found.entity_id : undefined;
    };

    return {
      device_id: deviceId,
      state: cfg.state_entity || byKey("state", "sensor"),
      speed: cfg.speed_sensor_entity || byKey("speed_feedback", "sensor"),
      speed_number: cfg.speed_entity || byKey("speed", "number"),
      distance: cfg.distance_entity || byKey("distance", "sensor"),
      duration: cfg.duration_entity || byKey("duration", "sensor"),
      calories: cfg.calories_entity || byKey("calories", "sensor"),
      steps: cfg.steps_entity || byKey("steps", "sensor"),
      start: cfg.start_entity || byKey("start", "button"),
      pause:
        cfg.pause_entity ||
        byKey("pause", "button", ["pause", "pause_resume"]),
      stop: cfg.stop_entity || byKey("stop", "button"),
    };
  }

  _wireLogo() {
    const logoUrl = this._config.logo;
    if (logoUrl) {
      const img = document.createElement("img");
      img.className = "pitpat-logo";
      img.src = logoUrl;
      this._els.logoSlot.appendChild(img);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "pitpat-logo-fallback";
      fallback.innerHTML = '<ha-icon icon="mdi:run"></ha-icon>';
      this._els.logoSlot.appendChild(fallback);
      this._els.logoFallback = fallback;
    }
  }

  _wireSpeedControls() {
    this._els.slider.addEventListener("input", (ev) => {
      this._pendingSpeed = parseFloat(ev.target.value);
      this._els.speedValue.textContent = fmtNumber(this._pendingSpeed, 1);
      clearTimeout(this._speedDebounce);
      this._speedDebounce = setTimeout(() => this._commitSpeed(), 400);
    });
    this._els.slider.addEventListener("change", () => {
      clearTimeout(this._speedDebounce);
      this._commitSpeed();
    });
    this._els.btnSpeedDown.addEventListener("click", () => this._nudgeSpeed(-1));
    this._els.btnSpeedUp.addEventListener("click", () => this._nudgeSpeed(1));
  }

  _wireButtons({ includePause }) {
    this._els.btnStart.addEventListener("click", () => this._pressButton("start"));
    if (includePause) {
      this._els.btnPause.addEventListener("click", () => this._pressButton("pause"));
    }
    this._els.btnStop.addEventListener("click", () => this._pressButton("stop"));
  }

  _commitSpeed() {
    const ids = this._entityIds;
    if (!this._hass || !ids.speed_number || this._pendingSpeed === null) return;
    this._hass.callService("number", "set_value", {
      entity_id: ids.speed_number,
      value: this._pendingSpeed,
    });
    this._pendingSpeed = null;
  }

  _nudgeSpeed(direction) {
    const ids = this._entityIds;
    const stateObj = this._hass && ids.speed_number ? this._hass.states[ids.speed_number] : undefined;
    if (!stateObj) return;
    const attrs = stateObj.attributes;
    const min = Number(attrs.min ?? 0);
    const max = Number(attrs.max ?? 6);
    const step = Number(attrs.step ?? 0.1);
    const current = this._pendingSpeed !== null ? this._pendingSpeed : Number(stateObj.state);
    let next = Math.min(max, Math.max(min, current + direction * step));
    next = Math.round(next * 100) / 100;

    this._pendingSpeed = next;
    this._els.slider.value = next;
    this._els.speedValue.textContent = fmtNumber(next, 1);
    clearTimeout(this._speedDebounce);
    this._speedDebounce = setTimeout(() => this._commitSpeed(), 250);
  }

  _pressButton(which) {
    const entityId = this._entityIds[which];
    if (!this._hass || !entityId) return;
    this._hass.callService("button", "press", { entity_id: entityId });
  }

  _readState() {
    const hass = this._hass;
    const ids = this._entityIds;
    const stateEntity = ids.state ? hass.states[ids.state] : undefined;
    const stateKey = stateEntity ? stateEntity.state : "disconnected";
    const meta = STATE_META[stateKey] || STATE_META.disconnected;
    const disconnected = stateKey === "disconnected";
    return { stateEntity, stateKey, meta, disconnected };
  }

  _readSpeed() {
    const hass = this._hass;
    const ids = this._entityIds;
    const speedEntity = ids.speed ? hass.states[ids.speed] : undefined;
    const speedNumberEntity = ids.speed_number
      ? hass.states[ids.speed_number]
      : undefined;
    return { speedEntity, speedNumberEntity };
  }

  _updateHeader(stateEntity, meta) {
    const hass = this._hass;
    const ids = this._entityIds;
    const els = this._els;
    // Prefer the device's own registry name over the state sensor's
    // friendly_name: it's per-device (so two treadmills on one dashboard show
    // correctly instead of racing to pick one), reflects a rename made via
    // Settings -> Devices with no card config needed, and doesn't depend on
    // regex-stripping a translated string (which breaks in any locale where
    // the "state" sensor's name isn't literally the English word "State").
    const device = ids.device_id && hass.devices ? hass.devices[ids.device_id] : undefined;
    els.title.textContent =
      this._config.name ||
      (device && (device.name_by_user || device.name)) ||
      (stateEntity && stateEntity.attributes.friendly_name
        ? stateEntity.attributes.friendly_name.replace(/\s+State$/, "")
        : "Treadmill");
    els.chip.textContent = meta.label;
    els.chip.style.background = meta.color;
    if (els.logoFallback) {
      els.logoFallback.style.background = meta.color;
    }
  }

  _updateSpeedControls(disconnected, speedEntity, speedNumberEntity) {
    const els = this._els;
    if (speedEntity) {
      els.speedValue.textContent = fmtNumber(speedEntity.state, 1);
      els.speedUnit.textContent =
        speedEntity.attributes.unit_of_measurement || "";
    } else {
      els.speedValue.textContent = "–";
      els.speedUnit.textContent = "";
    }

    if (speedNumberEntity) {
      const attrs = speedNumberEntity.attributes;
      els.slider.min = attrs.min ?? 0;
      els.slider.max = attrs.max ?? 6;
      els.slider.step = attrs.step ?? 0.1;
      els.slider.disabled = disconnected;
      els.btnSpeedDown.disabled = disconnected;
      els.btnSpeedUp.disabled = disconnected;
      if (this._pendingSpeed === null) {
        els.slider.value = speedNumberEntity.state;
      }
      els.sliderMin.textContent = fmtNumber(els.slider.min, 0);
      els.sliderMax.textContent = `${fmtNumber(els.slider.max, 0)} ${
        attrs.unit_of_measurement || ""
      }`;
    } else {
      els.slider.disabled = true;
      els.btnSpeedDown.disabled = true;
      els.btnSpeedUp.disabled = true;
    }
  }

  _updateButtons(stateKey, disconnected, { includePause }) {
    const ids = this._entityIds;
    const els = this._els;
    const running = stateKey === "running";
    els.btnStart.disabled = disconnected || !ids.start;
    els.btnStop.disabled = disconnected || !ids.stop;
    els.btnStart.classList.toggle("active", running);
    if (includePause) {
      els.btnPause.disabled = disconnected || !ids.pause;
      els.btnPause.classList.toggle("active", stateKey === "paused");
      const pauseIcon = els.btnPause.querySelector("ha-icon");
      if (pauseIcon) pauseIcon.setAttribute("icon", running ? "mdi:pause" : "mdi:play");
      els.btnPause.childNodes[1].textContent = running ? "Pause" : "Resume";
    }
  }
}

/** Shared GUI config editor for all three card sizes, via <ha-form> (a
 * built-in HA frontend component -- no bundling/build step needed). Each
 * card's static getConfigElement() creates one of these and tags it with
 * .variant so the mini card's editor can skip the name/logo fields it has
 * no use for. */
class PitpatCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._ensureForm();
    this._form.data = this._config;
  }

  set hass(hass) {
    this._hass = hass;
    this._ensureForm();
    this._form.hass = hass;
  }

  _schema() {
    const schema = [
      { name: "device_id", selector: { device: { integration: DOMAIN } } },
    ];
    if (this.variant !== "mini") {
      schema.push(
        { name: "name", selector: { text: {} } },
        { name: "logo", selector: { text: {} } }
      );
    }
    return schema;
  }

  _labels() {
    return {
      device_id: "Treadmill",
      name: "Name",
      logo: "Logo image URL",
    };
  }

  _helpers() {
    return {
      device_id: "Pick which treadmill, if you have more than one.",
      name: "Defaults to the device's own name if left blank.",
      logo: "Replaces the default icon in the card header. Leave blank for no logo.",
    };
  }

  _ensureForm() {
    if (this._form) return;
    const form = document.createElement("ha-form");
    form.schema = this._schema();
    form.computeLabel = (schemaItem) => this._labels()[schemaItem.name] || schemaItem.name;
    form.computeHelper = (schemaItem) => this._helpers()[schemaItem.name] || "";
    form.addEventListener("value-changed", (ev) => {
      this._config = ev.detail.value;
      this._form.data = this._config;
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config: this._config },
          bubbles: true,
          composed: true,
        })
      );
    });
    this._form = form;
    this.appendChild(form);
    if (this._config) form.data = this._config;
    if (this._hass) form.hass = this._hass;
  }
}

/** Full card: animated walker + controls + stats. */
class PitpatTreadmillCard extends PitpatCardBase {
  setConfig(config) {
    super.setConfig(config);
    this._intent = null;
    this._pose = null;
    this._animCleanup = null;
  }

  getCardSize() {
    return 5;
  }

  static getConfigElement() {
    return document.createElement("pitpat-treadmill-card-editor");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._cancelPendingAnimation();
  }

  _buildDom() {
    const root = this._shadow();
    root.innerHTML = `
      <style>${BASE_STYLES}${HEADER_AND_SPEED_STYLES}${HERO_AND_STATS_STYLES}</style>
      <ha-card>
        <div class="pitpat-card">
          ${headerMarkup()}
          <div class="pitpat-hero">
            <svg viewBox="0 0 290 90" class="pitpat-hero-svg" aria-hidden="true" focusable="false">
              <rect class="pitpat-deck" x="20" y="60" width="140" height="10" rx="5"></rect>
              <line class="pitpat-belt-dash" x1="26" y1="65" x2="154" y2="65"></line>
              <rect class="pitpat-foot" x="30" y="70" width="4" height="9" rx="1"></rect>
              <rect class="pitpat-foot" x="146" y="70" width="4" height="9" rx="1"></rect>
              <rect class="pitpat-console-mast" x="156" y="16" width="7" height="46" rx="3"></rect>
              <rect class="pitpat-console-screen" x="146" y="10" width="26" height="14" rx="3"></rect>
              <rect class="pitpat-foot" x="240" y="65" width="3" height="7" rx="1"></rect>
              <rect class="pitpat-foot" x="257" y="65" width="3" height="7" rx="1"></rect>
              <rect class="pitpat-console-mast" x="241" y="28" width="18" height="30" rx="3"></rect>
              <rect class="pitpat-deck" x="235" y="58" width="30" height="7" rx="2"></rect>
              <g class="pitpat-walker">
                <g class="pitpat-arm pitpat-arm-a">
                  <line x1="94" y1="33" x2="91.5" y2="40"></line>
                  <g class="pitpat-forearm pitpat-forearm-a"><line x1="91.5" y1="40" x2="89" y2="47"></line></g>
                </g>
                <g class="pitpat-arm pitpat-arm-b">
                  <line x1="102" y1="33" x2="104.5" y2="40"></line>
                  <g class="pitpat-forearm pitpat-forearm-b"><line x1="104.5" y1="40" x2="107" y2="47"></line></g>
                </g>
                <circle class="pitpat-head" cx="98" cy="23" r="6"></circle>
                <line class="pitpat-torso" x1="98" y1="29" x2="98" y2="50"></line>
                <g class="pitpat-leg pitpat-leg-a">
                  <line x1="95" y1="50" x2="94.75" y2="54"></line>
                  <g class="pitpat-shin pitpat-shin-a"><line x1="94.75" y1="54" x2="94" y2="66"></line></g>
                </g>
                <g class="pitpat-leg pitpat-leg-b">
                  <line x1="101" y1="50" x2="101.25" y2="54"></line>
                  <g class="pitpat-shin pitpat-shin-b"><line x1="101.25" y1="54" x2="102" y2="66"></line></g>
                </g>
                <g class="pitpat-book">
                  <rect x="89" y="40" width="18" height="7" rx="1"></rect>
                  <line class="pitpat-book-spine" x1="98" y1="40" x2="98" y2="47"></line>
                </g>
              </g>
            </svg>
          </div>
          ${speedMarkup()}
          ${buttonsMarkup({ includePause: true })}
          <div class="pitpat-stats">
            <div class="pitpat-stat pitpat-stat-distance">
              <div class="pitpat-stat-value">–</div>
              <div class="pitpat-stat-label">Distance</div>
            </div>
            <div class="pitpat-stat pitpat-stat-duration">
              <div class="pitpat-stat-value">–</div>
              <div class="pitpat-stat-label">Duration</div>
            </div>
            <div class="pitpat-stat pitpat-stat-calories">
              <div class="pitpat-stat-value">–</div>
              <div class="pitpat-stat-label">Calories</div>
            </div>
            <div class="pitpat-stat pitpat-stat-steps">
              <div class="pitpat-stat-value">–</div>
              <div class="pitpat-stat-label">Steps</div>
            </div>
          </div>
        </div>
      </ha-card>
    `;

    this._els = {
      logoSlot: root.querySelector(".pitpat-logo-slot"),
      hero: root.querySelector(".pitpat-hero"),
      walker: root.querySelector(".pitpat-walker"),
      title: root.querySelector(".pitpat-title"),
      chip: root.querySelector(".pitpat-chip"),
      speedValue: root.querySelector(".pitpat-speed-value"),
      speedUnit: root.querySelector(".pitpat-speed-unit"),
      slider: root.querySelector(".pitpat-slider"),
      sliderMin: root.querySelector(".pitpat-slider-min"),
      sliderMax: root.querySelector(".pitpat-slider-max"),
      btnSpeedDown: root.querySelector(".pitpat-speed-down"),
      btnSpeedUp: root.querySelector(".pitpat-speed-up"),
      btnStart: root.querySelector(".pitpat-btn-start"),
      btnPause: root.querySelector(".pitpat-btn-pause"),
      btnStop: root.querySelector(".pitpat-btn-stop"),
      statDistance: root.querySelector(".pitpat-stat-distance .pitpat-stat-value"),
      statDuration: root.querySelector(".pitpat-stat-duration .pitpat-stat-value"),
      statCalories: root.querySelector(".pitpat-stat-calories .pitpat-stat-value"),
      statSteps: root.querySelector(".pitpat-stat-steps .pitpat-stat-value"),
      stepsBlock: root.querySelector(".pitpat-stat-steps"),
    };

    this._wireLogo();
    this._wireSpeedControls();
    this._wireButtons({ includePause: true });
  }

  _setPose(pose) {
    this._els.hero.classList.remove(
      "pitpat-pose-walking",
      "pitpat-pose-paused",
      "pitpat-pose-standing",
      "pitpat-pose-transit",
      "pitpat-pose-seated",
      "pitpat-pose-return"
    );
    this._els.hero.classList.add(`pitpat-pose-${pose}`);
    this._pose = pose;
  }

  _cancelPendingAnimation() {
    if (this._animCleanup) {
      this._animCleanup();
      this._animCleanup = null;
    }
  }

  _awaitWalkerAnimation(animationName, onDone) {
    const walker = this._els.walker;
    const onEnd = (ev) => {
      if (ev.target !== walker || ev.animationName !== animationName) return;
      this._animCleanup = null;
      onDone();
    };
    walker.addEventListener("animationend", onEnd);
    this._animCleanup = () => walker.removeEventListener("animationend", onEnd);
  }

  _startTransit() {
    this._setPose("transit");
    this._awaitWalkerAnimation("pitpat-walk-transit", () => this._setPose("seated"));
  }

  _startReturn() {
    this._setPose("return");
    this._awaitWalkerAnimation("pitpat-walk-return", () => {
      // Re-read the intent rather than assuming "standing": it may have
      // changed again (e.g. Start then Pause) while he was still walking back.
      if (this._intent === "stopped") {
        this._startTransit();
      } else {
        this._setPose(this._intent);
      }
    });
  }

  _update() {
    const hass = this._hass;
    const ids = this._entityIds;
    const els = this._els;

    const { stateEntity, stateKey, meta, disconnected } = this._readState();
    this._updateHeader(stateEntity, meta);

    const { speedEntity, speedNumberEntity } = this._readSpeed();
    this._updateSpeedControls(disconnected, speedEntity, speedNumberEntity);

    // Animated walking-pad hero: "stopped" and leaving "stopped" both walk
    // (transit / return) rather than cutting straight to a static pose; every
    // other intent change is a direct, fast pose swap since he's already
    // standing on the treadmill either way. Note: disconnected does NOT route
    // through "stopped" -- this hardware drops its BLE link every ~10-20s as
    // routine behavior (see README), so treating a reconnect blip as a
    // deliberate stop would replay the walk-and-sit animation constantly
    // during ordinary use. Disconnected just dims the current pose instead.
    const liveSpeed = speedEntity ? Number(speedEntity.state) : NaN;
    const maxSpeedForPace =
      speedNumberEntity && Number(speedNumberEntity.attributes.max) > 0
        ? Number(speedNumberEntity.attributes.max)
        : 6;
    let intent;
    if (stateKey === "running" && !Number.isNaN(liveSpeed) && liveSpeed > 0.05) {
      intent = "walking";
    } else if (stateKey === "paused") {
      intent = "paused";
    } else if (stateKey === "stopped") {
      intent = "stopped";
    } else {
      intent = "standing"; // countdown, disconnected, or running read at ~0 speed
    }
    if (intent !== this._intent) {
      const isFirstUpdate = this._intent === null;
      this._intent = intent;
      const atChairSide = this._pose === "seated" || this._pose === "transit";
      if (intent === "stopped") {
        if (!atChairSide) {
          this._cancelPendingAnimation();
          if (isFirstUpdate) {
            // Don't replay the walk-over on initial load if already stopped.
            this._setPose("seated");
          } else {
            this._startTransit();
          }
        }
        // else: already at/heading to the chair, nothing to do.
      } else if (atChairSide) {
        this._cancelPendingAnimation();
        this._startReturn();
      } else if (this._pose !== "return") {
        this._cancelPendingAnimation();
        this._setPose(intent);
      }
      // else: already walking back; _startReturn re-checks this._intent
      // itself once that animation finishes, so just let it play out.
    }
    els.hero.classList.toggle("pitpat-disconnected", disconnected);
    if (this._pose === "walking") {
      const t = Math.min(1, liveSpeed / maxSpeedForPace);
      const minDur = 0.45; // seconds per stride at/above max speed
      const maxDur = 1.7; // seconds per stride just above a standstill
      const duration = maxDur - (maxDur - minDur) * Math.sqrt(t);
      els.hero.style.setProperty("--pitpat-stride-dur", `${duration.toFixed(2)}s`);
    }

    this._updateButtons(stateKey, disconnected, { includePause: true });

    const readStat = (entityId, digits) => {
      if (!entityId || !hass.states[entityId]) return { value: "–", unit: "" };
      const st = hass.states[entityId];
      const num = Number(st.state);
      return {
        value: Number.isNaN(num) ? st.state : fmtNumber(num, digits),
        unit: st.attributes.unit_of_measurement || "",
      };
    };

    const dist = readStat(ids.distance, 2);
    els.statDistance.textContent = dist.value === "–" ? "–" : `${dist.value} ${dist.unit}`;

    if (ids.duration && hass.states[ids.duration]) {
      els.statDuration.textContent = fmtDuration(hass.states[ids.duration].state);
    } else {
      els.statDuration.textContent = "–";
    }

    const cal = readStat(ids.calories, 0);
    els.statCalories.textContent = cal.value === "–" ? "–" : `${cal.value} ${cal.unit}`;

    if (ids.steps && hass.states[ids.steps]) {
      els.stepsBlock.style.display = "";
      els.statSteps.textContent = hass.states[ids.steps].state;
    } else {
      els.stepsBlock.style.display = "none";
    }
  }
}

/** Controls-only card: header + speed + buttons, no animation, no stats. */
class PitpatTreadmillControlsCard extends PitpatCardBase {
  getCardSize() {
    return 3;
  }

  static getConfigElement() {
    return document.createElement("pitpat-treadmill-card-editor");
  }

  _buildDom() {
    const root = this._shadow();
    root.innerHTML = `
      <style>${BASE_STYLES}${HEADER_AND_SPEED_STYLES}</style>
      <ha-card>
        <div class="pitpat-card">
          ${headerMarkup()}
          ${speedMarkup()}
          ${buttonsMarkup({ includePause: true })}
        </div>
      </ha-card>
    `;

    this._els = {
      logoSlot: root.querySelector(".pitpat-logo-slot"),
      title: root.querySelector(".pitpat-title"),
      chip: root.querySelector(".pitpat-chip"),
      speedValue: root.querySelector(".pitpat-speed-value"),
      speedUnit: root.querySelector(".pitpat-speed-unit"),
      slider: root.querySelector(".pitpat-slider"),
      sliderMin: root.querySelector(".pitpat-slider-min"),
      sliderMax: root.querySelector(".pitpat-slider-max"),
      btnSpeedDown: root.querySelector(".pitpat-speed-down"),
      btnSpeedUp: root.querySelector(".pitpat-speed-up"),
      btnStart: root.querySelector(".pitpat-btn-start"),
      btnPause: root.querySelector(".pitpat-btn-pause"),
      btnStop: root.querySelector(".pitpat-btn-stop"),
    };

    this._wireLogo();
    this._wireSpeedControls();
    this._wireButtons({ includePause: true });
  }

  _update() {
    const { stateEntity, stateKey, meta, disconnected } = this._readState();
    this._updateHeader(stateEntity, meta);

    const { speedEntity, speedNumberEntity } = this._readSpeed();
    this._updateSpeedControls(disconnected, speedEntity, speedNumberEntity);

    this._updateButtons(stateKey, disconnected, { includePause: true });
  }
}

/** Mini card: just Start/Stop. */
class PitpatTreadmillMiniCard extends PitpatCardBase {
  getCardSize() {
    return 1;
  }

  static getConfigElement() {
    const el = document.createElement("pitpat-treadmill-card-editor");
    el.variant = "mini";
    return el;
  }

  _buildDom() {
    const root = this._shadow();
    root.innerHTML = `
      <style>${BASE_STYLES}</style>
      <ha-card>
        <div class="pitpat-card" style="padding: 12px;">
          ${buttonsMarkup({ includePause: false })}
        </div>
      </ha-card>
    `;

    this._els = {
      btnStart: root.querySelector(".pitpat-btn-start"),
      btnStop: root.querySelector(".pitpat-btn-stop"),
    };

    this._wireButtons({ includePause: false });
  }

  _update() {
    const { stateKey, disconnected } = this._readState();
    this._updateButtons(stateKey, disconnected, { includePause: false });
  }
}

customElements.define("pitpat-treadmill-card-editor", PitpatCardEditor);
customElements.define("pitpat-treadmill-card", PitpatTreadmillCard);
customElements.define("pitpat-treadmill-controls-card", PitpatTreadmillControlsCard);
customElements.define("pitpat-treadmill-mini-card", PitpatTreadmillMiniCard);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "pitpat-treadmill-card",
    name: "PitPat Treadmill Card",
    description: "Animated controls and live stats for a PitPat (BA04) treadmill.",
    preview: false,
  },
  {
    type: "pitpat-treadmill-controls-card",
    name: "PitPat Treadmill Controls",
    description: "Treadmill controls, no animation -- speed, start/pause/stop.",
    preview: false,
  },
  {
    type: "pitpat-treadmill-mini-card",
    name: "PitPat Treadmill Mini",
    description: "Just Start/Stop for a PitPat treadmill.",
    preview: false,
  }
);
