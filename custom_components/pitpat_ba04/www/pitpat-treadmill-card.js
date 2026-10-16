/**
 * Lovelace card for the PitPat Treadmill (BA04) integration.
 *
 * Usage (YAML):
 *   type: custom:pitpat-treadmill-card
 *   # device_id: <id>        # optional; auto-detected if you only have one treadmill
 *   # name: My Treadmill      # optional title override
 *   # logo: /local/tazhome-logo.svg   # optional header image, replaces the default icon
 *
 * Entities are auto-matched to the chosen device by their translation key, so
 * the card works regardless of friendly-name overrides. Any entity can still
 * be pinned explicitly if auto-detection ever picks the wrong one:
 *   state_entity, speed_sensor_entity, speed_entity (the number), distance_entity,
 *   duration_entity, calories_entity, steps_entity, max_speed_entity,
 *   firmware_entity, start_entity, pause_entity, stop_entity
 */

const DOMAIN = "pitpat_ba04";

const STATE_META = {
  countdown: { label: "Countdown", color: "var(--info-color, #039be5)" },
  running: { label: "Running", color: "var(--success-color, #4caf50)" },
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

class PitpatTreadmillCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._entityIds = null;
    this._built = false;
    this._pendingSpeed = null;
    this._speedDebounce = null;
  }

  getCardSize() {
    return 5;
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
      max_speed: cfg.max_speed_entity || byKey("max_speed", "sensor"),
      firmware: cfg.firmware_entity || byKey("firmware", "sensor"),
      start: cfg.start_entity || byKey("start", "button"),
      pause:
        cfg.pause_entity ||
        byKey("pause", "button", ["pause", "pause_resume"]),
      stop: cfg.stop_entity || byKey("stop", "button"),
    };
  }

  _buildDom() {
    const card = document.createElement("ha-card");
    card.innerHTML = `
      <style>
        .pitpat-card { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
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
          color: #fff; white-space: nowrap;
        }
        .pitpat-speed-row { display: flex; align-items: baseline; justify-content: center; gap: 6px; }
        .pitpat-speed-value { font-size: 2.6em; font-weight: 600; line-height: 1; color: var(--primary-text-color); }
        .pitpat-speed-unit { font-size: 1em; color: var(--secondary-text-color); }
        .pitpat-slider-row { display: flex; align-items: center; gap: 10px; }
        .pitpat-slider-row span { font-size: 0.85em; color: var(--secondary-text-color); min-width: 2.5em; text-align: center; }
        .pitpat-slider { flex: 1; accent-color: var(--primary-color); height: 24px; }
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
        .pitpat-stats {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 12px;
          text-align: center;
        }
        .pitpat-stat-value { font-size: 1.1em; font-weight: 500; color: var(--primary-text-color); }
        .pitpat-stat-label { font-size: 0.7em; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.03em; }
        .pitpat-footer { font-size: 0.75em; color: var(--disabled-text-color); text-align: right; }
      </style>
      <div class="pitpat-card">
        <div class="pitpat-header">
          <div class="pitpat-logo-slot"></div>
          <div class="pitpat-title"></div>
          <div class="pitpat-chip"></div>
        </div>
        <div class="pitpat-speed-row">
          <span class="pitpat-speed-value">–</span>
          <span class="pitpat-speed-unit"></span>
        </div>
        <div class="pitpat-slider-row">
          <span class="pitpat-slider-min"></span>
          <input class="pitpat-slider" type="range" step="0.1" />
          <span class="pitpat-slider-max"></span>
        </div>
        <div class="pitpat-buttons">
          <button class="pitpat-btn-start"><ha-icon icon="mdi:play"></ha-icon>Start</button>
          <button class="pitpat-btn-pause"><ha-icon icon="mdi:pause"></ha-icon>Pause</button>
          <button class="pitpat-btn-stop"><ha-icon icon="mdi:stop"></ha-icon>Stop</button>
        </div>
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
        <div class="pitpat-footer"></div>
      </div>
    `;

    this._els = {
      logoSlot: card.querySelector(".pitpat-logo-slot"),
      title: card.querySelector(".pitpat-title"),
      chip: card.querySelector(".pitpat-chip"),
      speedValue: card.querySelector(".pitpat-speed-value"),
      speedUnit: card.querySelector(".pitpat-speed-unit"),
      slider: card.querySelector(".pitpat-slider"),
      sliderMin: card.querySelector(".pitpat-slider-min"),
      sliderMax: card.querySelector(".pitpat-slider-max"),
      btnStart: card.querySelector(".pitpat-btn-start"),
      btnPause: card.querySelector(".pitpat-btn-pause"),
      btnStop: card.querySelector(".pitpat-btn-stop"),
      statDistance: card.querySelector(".pitpat-stat-distance .pitpat-stat-value"),
      statDuration: card.querySelector(".pitpat-stat-duration .pitpat-stat-value"),
      statCalories: card.querySelector(".pitpat-stat-calories .pitpat-stat-value"),
      statSteps: card.querySelector(".pitpat-stat-steps .pitpat-stat-value"),
      stepsBlock: card.querySelector(".pitpat-stat-steps"),
      footer: card.querySelector(".pitpat-footer"),
    };

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

    this._els.btnStart.addEventListener("click", () => this._pressButton("start"));
    this._els.btnPause.addEventListener("click", () => this._pressButton("pause"));
    this._els.btnStop.addEventListener("click", () => this._pressButton("stop"));

    this.innerHTML = "";
    this.appendChild(card);
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

  _pressButton(which) {
    const entityId = this._entityIds[which];
    if (!this._hass || !entityId) return;
    this._hass.callService("button", "press", { entity_id: entityId });
  }

  _update() {
    const hass = this._hass;
    const ids = this._entityIds;
    const els = this._els;

    const stateEntity = ids.state ? hass.states[ids.state] : undefined;
    const stateKey = stateEntity ? stateEntity.state : "disconnected";
    const meta = STATE_META[stateKey] || STATE_META.disconnected;
    const disconnected = stateKey === "disconnected";

    els.title.textContent =
      this._config.name ||
      (stateEntity && stateEntity.attributes.friendly_name
        ? stateEntity.attributes.friendly_name.replace(/\s+State$/, "")
        : "Treadmill");
    els.chip.textContent = meta.label;
    els.chip.style.background = meta.color;
    if (els.logoFallback) {
      els.logoFallback.style.background = meta.color;
    }

    const speedEntity = ids.speed ? hass.states[ids.speed] : undefined;
    const speedNumberEntity = ids.speed_number
      ? hass.states[ids.speed_number]
      : undefined;

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
      if (this._pendingSpeed === null) {
        els.slider.value = speedNumberEntity.state;
      }
      els.sliderMin.textContent = fmtNumber(els.slider.min, 0);
      els.sliderMax.textContent = `${fmtNumber(els.slider.max, 0)} ${
        attrs.unit_of_measurement || ""
      }`;
    } else {
      els.slider.disabled = true;
    }

    const running = stateKey === "running";
    els.btnStart.disabled = disconnected || !ids.start;
    els.btnPause.disabled = disconnected || !ids.pause;
    els.btnStop.disabled = disconnected || !ids.stop;
    els.btnStart.classList.toggle("active", running);
    els.btnPause.classList.toggle("active", stateKey === "paused");
    const pauseIcon = els.btnPause.querySelector("ha-icon");
    if (pauseIcon) pauseIcon.setAttribute("icon", running ? "mdi:pause" : "mdi:play");
    els.btnPause.childNodes[1].textContent = running ? "Pause" : "Resume";

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

    const fw = ids.firmware && hass.states[ids.firmware] ? hass.states[ids.firmware].state : null;
    const maxSpeed = ids.max_speed && hass.states[ids.max_speed] ? hass.states[ids.max_speed] : null;
    const footerParts = [];
    if (maxSpeed) {
      footerParts.push(
        `Max ${fmtNumber(maxSpeed.state, 1)} ${maxSpeed.attributes.unit_of_measurement || ""}`
      );
    }
    if (fw) footerParts.push(`FW ${fw}`);
    els.footer.textContent = footerParts.join(" · ");
  }
}

customElements.define("pitpat-treadmill-card", PitpatTreadmillCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "pitpat-treadmill-card",
  name: "PitPat Treadmill Card",
  description: "Controls and live stats for a PitPat (BA04) treadmill.",
  preview: false,
});
