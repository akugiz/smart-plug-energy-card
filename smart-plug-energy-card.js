/*
 * Smart Plug Energy Calendar Card for Home Assistant
 * Version 1.0.6
 *
 * A dependency-free Lovelace card that discovers the energy sensors belonging
 * to a selected smart plug and renders a Tapo-style monthly usage calendar.
 */

const SPEC_VERSION = "1.0.6";

const DEFAULTS = Object.freeze({
  title: "",
  currency: "EUR",
  day_rate: 0.365,
  night_rate: 0.18,
  nightboost_rate: 0.1056,
  vat_percent: 9,
  discount_percent: 5.5,
  rate_change_date: "2026-07-01",
  previous_day_rate: 0.3334,
  previous_night_rate: 0.1644,
  previous_nightboost_rate: 0.0965,
  day_start_time: "08:00:00",
  day_end_time: "23:00:00",
  night_start_time: "23:00:00",
  night_end_time: "08:00:00",
  nightboost_start_time: "02:00:00",
  nightboost_end_time: "04:00:00",
  // Backwards-compatible fallbacks for older YAML configurations.
  day_start_hour: 8,
  day_end_hour: 23,
  night_start_hour: 23,
  night_end_hour: 8,
  nightboost_start_hour: 2,
  nightboost_end_hour: 4,
  week_start: "sunday",
  blue_limit: 1,
  amber_limit: 2,
  initial_view: "kwh",
  show_switch: true,
  show_live_values: true,
  show_calendar: true,
  show_year_totals: true,
  show_tariff_summary: true,
});

const HOUR_MS = 3600000;
const QUARTER_HOUR_MS = 900000;

function numberOr(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dateFromValue(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  return new Date(value);
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function timeToMinutes(value, fallbackHour) {
  if (typeof value === "number" && Number.isFinite(value)) return value * 60;
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return numberOr(fallbackHour, 0) * 60;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  const second = Math.min(59, Math.max(0, Number(match[3] || 0)));
  return hour * 60 + minute + second / 60;
}

function timeInRange(value, start, end) {
  if (start === end) return false;
  if (start < end) return value >= start && value < end;
  return value >= start || value < end;
}

function shortTime(value, fallbackHour) {
  const minutes = timeToMinutes(value, fallbackHour);
  return `${pad2(Math.floor(minutes / 60))}:${pad2(Math.floor(minutes % 60))}`;
}

class SmartPlugEnergyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._view = "kwh";
    this._displayYear = null;
    this._displayMonth = null;
    this._selectedDay = null;
    this._entityRegistry = new Map();
    this._registryRequested = false;
    this._discovered = {};
    this._cache = new Map();
    this._loadingKey = null;
    this._data = null;
    this._error = "";
    this._yearCache = new Map();
    this._yearLoadingKey = null;
    this._yearData = null;
    this._yearError = "";
  }

  static getConfigForm() {
    const rateSelector = {
      number: { min: 0, max: 5, step: 0.0001, mode: "box" },
    };
    const percentSelector = {
      number: { min: 0, max: 100, step: 0.1, mode: "box" },
    };

    return {
      schema: [
        {
          name: "entity",
          required: true,
          selector: { entity: { filter: [{ domain: "switch" }] } },
        },
        { name: "title", selector: { text: {} } },
        {
          type: "expandable",
          name: "sensor_settings",
          title: "Sensor discovery (optional overrides)",
          flatten: true,
          schema: [
            {
              name: "energy_entity",
              selector: {
                entity: { filter: [{ domain: "sensor", device_class: "energy" }] },
              },
            },
            {
              name: "power_entity",
              selector: {
                entity: { filter: [{ domain: "sensor", device_class: "power" }] },
              },
            },
            {
              name: "voltage_entity",
              selector: {
                entity: { filter: [{ domain: "sensor", device_class: "voltage" }] },
              },
            },
            {
              name: "current_entity",
              selector: {
                entity: { filter: [{ domain: "sensor", device_class: "current" }] },
              },
            },
          ],
        },
        {
          type: "expandable",
          name: "tariff_times",
          title: "Tariff times",
          flatten: true,
          schema: [
            { name: "day_start_time", selector: { time: {} } },
            { name: "day_end_time", selector: { time: {} } },
            { name: "night_start_time", selector: { time: {} } },
            { name: "night_end_time", selector: { time: {} } },
            { name: "nightboost_start_time", selector: { time: {} } },
            { name: "nightboost_end_time", selector: { time: {} } },
          ],
        },
        {
          type: "expandable",
          name: "current_prices",
          title: "Current electricity prices (before VAT)",
          flatten: true,
          schema: [
            { name: "day_rate", selector: rateSelector },
            { name: "night_rate", selector: rateSelector },
            { name: "nightboost_rate", selector: rateSelector },
            { name: "currency", selector: { text: {} } },
            { name: "discount_percent", selector: percentSelector },
            { name: "vat_percent", selector: percentSelector },
          ],
        },
        {
          type: "expandable",
          name: "previous_prices",
          title: "Previous prices (for older history)",
          flatten: true,
          schema: [
            { name: "rate_change_date", selector: { date: {} } },
            { name: "previous_day_rate", selector: rateSelector },
            { name: "previous_night_rate", selector: rateSelector },
            { name: "previous_nightboost_rate", selector: rateSelector },
          ],
        },
        {
          type: "expandable",
          name: "display_settings",
          title: "Display settings",
          flatten: true,
          schema: [
            {
              name: "week_start",
              selector: {
                select: {
                  options: [
                    { value: "sunday", label: "Sunday" },
                    { value: "monday", label: "Monday" },
                  ],
                  mode: "dropdown",
                },
              },
            },
            {
              name: "initial_view",
              selector: {
                select: {
                  options: [
                    { value: "kwh", label: "kWh" },
                    { value: "cost", label: "Cost" },
                  ],
                  mode: "dropdown",
                },
              },
            },
            { name: "blue_limit", selector: rateSelector },
            { name: "amber_limit", selector: rateSelector },
            { name: "show_switch", selector: { boolean: {} } },
            { name: "show_live_values", selector: { boolean: {} } },
            { name: "show_calendar", selector: { boolean: {} } },
            { name: "show_year_totals", selector: { boolean: {} } },
            { name: "show_tariff_summary", selector: { boolean: {} } },
          ],
        },
      ],
      computeLabel: (schema) => {
        const labels = {
          entity: "Smart plug",
          title: "Card title",
          energy_entity: "Energy sensor",
          power_entity: "Power sensor",
          voltage_entity: "Voltage sensor",
          current_entity: "Current sensor",
          day_rate: "Day rate (EUR/kWh)",
          night_rate: "Night rate (EUR/kWh)",
          nightboost_rate: "Nightboost rate (EUR/kWh)",
          currency: "Currency code",
          discount_percent: "Discount (%)",
          vat_percent: "VAT (%)",
          rate_change_date: "Current rates started",
          previous_day_rate: "Previous day rate",
          previous_night_rate: "Previous night rate",
          previous_nightboost_rate: "Previous Nightboost rate",
          day_start_time: "Day price starts",
          day_end_time: "Day price ends",
          night_start_time: "Night price starts",
          night_end_time: "Night price ends",
          nightboost_start_time: "Nightboost price starts",
          nightboost_end_time: "Nightboost price ends",
          week_start: "First day of week",
          initial_view: "Default calendar value",
          blue_limit: "Blue up to (kWh)",
          amber_limit: "Amber up to (kWh)",
          show_switch: "Show plug switch",
          show_live_values: "Show live power details",
          show_calendar: "Show monthly calendar",
          show_year_totals: "Show yearly totals",
          show_tariff_summary: "Show tariff information",
        };
        return labels[schema.name];
      },
      computeHelper: (schema) => {
        if (schema.name === "entity") {
          return "Select the plug switch. Its energy sensors are discovered automatically.";
        }
        if (schema.name === "energy_entity") {
          return "Leave empty unless automatic discovery selects the wrong sensor.";
        }
        if (schema.name === "currency") {
          return "Use an ISO currency code such as EUR, GBP or USD.";
        }
        return undefined;
      },
    };
  }

  static getStubConfig(hass) {
    const switches = Object.keys(hass?.states || {}).filter((id) => id.startsWith("switch."));
    const likelyPlug = switches.find((id) => /plug|socket|outlet/i.test(id)) || switches[0];
    return { ...DEFAULTS, entity: likelyPlug || "switch.example_smart_plug" };
  }

  setConfig(config) {
    if (!config?.entity) {
      throw new Error("Select a smart plug switch entity");
    }

    const previousIdentity = `${this._config?.entity || ""}|${this._config?.energy_entity || ""}`;
    this._config = { ...DEFAULTS, ...config };
    if (!this._config.show_calendar) this._selectedDay = null;
    this._view = this._config.initial_view === "cost" ? "cost" : "kwh";
    const nextIdentity = `${this._config.entity}|${this._config.energy_entity || ""}`;
    if (previousIdentity !== nextIdentity) {
      this._discovered = {};
      this._cache.clear();
      this._data = null;
    } else {
      this._cache.clear();
    }
    this._yearCache.clear();
    this._yearData = null;
    this._error = "";
    this._yearError = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._initializeMonth();
    this._requestRegistry();

    const beforeEnergy = this._discovered.energy;
    this._discovered = this._discoverEntities();
    if (beforeEnergy && this._discovered.energy && beforeEnergy !== this._discovered.energy) {
      this._cache.clear();
      this._data = null;
      this._yearCache.clear();
      this._yearData = null;
    }

    this._render();
    this._ensureData();
    this._ensureYearData();
  }

  getCardSize() {
    return 9;
  }

  getGridOptions() {
    return {
      rows: 8,
      columns: 12,
      min_rows: 6,
      min_columns: 6,
    };
  }

  _initializeMonth() {
    if (this._displayYear !== null) return;
    const parts = this._timeParts(new Date());
    this._displayYear = parts.year;
    this._displayMonth = parts.month;
  }

  async _requestRegistry() {
    if (this._registryRequested || !this._hass?.callWS) return;
    this._registryRequested = true;
    try {
      const entries = await this._hass.callWS({ type: "config/entity_registry/list" });
      this._entityRegistry = new Map(
        (entries || []).map((entry) => [entry.entity_id, entry]),
      );
      this._discovered = this._discoverEntities();
      this._render();
      this._ensureData();
      this._ensureYearData();
    } catch (error) {
      // Discovery can still use entity names and state attributes.
      console.debug("Smart Plug Energy Card: registry discovery unavailable", error);
    }
  }

  _registryEntry(entityId) {
    return this._entityRegistry.get(entityId) || this._hass?.entities?.[entityId] || null;
  }

  _discoverEntities() {
    if (!this._hass || !this._config) return {};
    const selected = this._config.entity;
    const base = selected.split(".")[1] || selected;
    const selectedDevice = this._registryEntry(selected)?.device_id;

    const pick = (deviceClass, configured, keywords = []) => {
      if (configured && this._hass.states[configured]) return configured;
      const candidates = [];
      for (const [entityId, stateObj] of Object.entries(this._hass.states)) {
        if (!entityId.startsWith("sensor.")) continue;
        const attrs = stateObj.attributes || {};
        if (attrs.device_class !== deviceClass) continue;
        const registry = this._registryEntry(entityId);
        const sameDevice = Boolean(selectedDevice && registry?.device_id === selectedDevice);
        const sameName = entityId.includes(base);
        if (!sameDevice && !sameName) continue;

        let score = sameDevice ? 1000 : 200;
        if (sameName) score += 100;
        const lowered = entityId.toLowerCase();
        keywords.forEach((word, index) => {
          if (lowered.includes(word)) score += 80 - index * 5;
        });
        if (attrs.state_class === "total_increasing") score += 60;
        if (attrs.state_class === "total") score += 30;
        if (attrs.unit_of_measurement === "kWh") score += 20;
        if (stateObj.state === "unavailable" || stateObj.state === "unknown") score -= 20;
        candidates.push({ entityId, score });
      }
      candidates.sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
      return candidates[0]?.entityId || "";
    };

    return {
      energy: pick("energy", this._config.energy_entity, [
        "summation_delivered",
        "total_energy",
        "energy_total",
        "consumption",
        "energy",
      ]),
      power: pick("power", this._config.power_entity, ["active_power", "power"]),
      voltage: pick("voltage", this._config.voltage_entity, ["voltage"]),
      current: pick("current", this._config.current_entity, ["current"]),
    };
  }

  _timeZone() {
    return this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  _locale() {
    return this._hass?.locale?.language || navigator.language || "en";
  }

  _timeParts(date) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: this._timeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const values = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour,
      minute: values.minute,
      second: values.second,
    };
  }

  _zonedDate(year, month, day, hour = 0) {
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
    let guess = new Date(desiredAsUtc);
    for (let i = 0; i < 3; i += 1) {
      const parts = this._timeParts(guess);
      const actualAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      guess = new Date(guess.getTime() + desiredAsUtc - actualAsUtc);
    }
    return guess;
  }

  _dateKey(parts) {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  _monthKey() {
    return `${this._displayYear}-${pad2(this._displayMonth)}`;
  }

  _cacheKey() {
    return `${this._discovered.energy || "none"}|${this._monthKey()}`;
  }

  _yearCacheKey() {
    return `${this._discovered.energy || "none"}|${this._displayYear}`;
  }

  _monthBounds() {
    const start = this._zonedDate(this._displayYear, this._displayMonth, 1, 0);
    const nextMonth = this._displayMonth === 12 ? 1 : this._displayMonth + 1;
    const nextYear = this._displayMonth === 12 ? this._displayYear + 1 : this._displayYear;
    const end = this._zonedDate(nextYear, nextMonth, 1, 0);
    return { start, end };
  }

  _yearBounds() {
    return {
      start: this._zonedDate(this._displayYear, 1, 1, 0),
      end: this._zonedDate(this._displayYear + 1, 1, 1, 0),
    };
  }

  async _ensureData(force = false) {
    const energyEntity = this._discovered.energy;
    if (!this._hass || !energyEntity || this._displayYear === null) return;
    const key = this._cacheKey();
    if (!force && this._cache.has(key)) {
      const cached = this._cache.get(key);
      const currentCacheExpired =
        this._isCurrentMonth() &&
        Date.now() - (cached.loadedAt?.getTime?.() || 0) > 5 * 60 * 1000;
      if (!currentCacheExpired) {
        this._data = cached;
        this._render();
        return;
      }
    }
    if (this._loadingKey === key) return;

    this._loadingKey = key;
    this._error = "";
    this._render();

    try {
      const data = await this._loadMonth(energyEntity);
      this._cache.set(key, data);
      if (key === this._cacheKey()) this._data = data;
    } catch (error) {
      console.error("Smart Plug Energy Card: unable to load history", error);
      if (key === this._cacheKey()) {
        this._error = error?.message || "Could not load energy history";
      }
    } finally {
      if (this._loadingKey === key) this._loadingKey = null;
      this._render();
    }
  }

  async _ensureYearData(force = false) {
    if (!this._config?.show_year_totals) return;
    const energyEntity = this._discovered.energy;
    if (!this._hass || !energyEntity || this._displayYear === null) return;
    const key = this._yearCacheKey();
    if (!force && this._yearCache.has(key)) {
      const cached = this._yearCache.get(key);
      const currentYear = this._timeParts(new Date()).year === this._displayYear;
      const currentCacheExpired =
        currentYear && Date.now() - (cached.loadedAt?.getTime?.() || 0) > 5 * 60 * 1000;
      if (!currentCacheExpired) {
        this._yearData = cached;
        this._render();
        return;
      }
    }
    if (this._yearLoadingKey === key) return;

    this._yearLoadingKey = key;
    this._yearError = "";
    this._render();

    try {
      const data = await this._loadYear(energyEntity);
      this._yearCache.set(key, data);
      if (key === this._yearCacheKey()) this._yearData = data;
    } catch (error) {
      console.error("Smart Plug Energy Card: unable to load yearly history", error);
      if (key === this._yearCacheKey()) {
        this._yearError = error?.message || "Could not load yearly energy history";
      }
    } finally {
      if (this._yearLoadingKey === key) this._yearLoadingKey = null;
      this._render();
    }
  }

  async _loadMonth(entityId) {
    const { start, end } = this._monthBounds();
    return this._loadPeriod(entityId, start, end, true);
  }

  async _loadYear(entityId) {
    const { start, end } = this._yearBounds();
    return this._loadPeriod(entityId, start, end, false);
  }

  async _loadPeriod(entityId, start, end, allowRawHistory) {
    const now = new Date();
    const queryEnd = new Date(Math.min(end.getTime() + HOUR_MS, now.getTime()));
    const queryStart = new Date(start.getTime() - 2 * HOUR_MS);
    const stateObj = this._hass.states[entityId];
    const unit = stateObj?.attributes?.unit_of_measurement || "kWh";

    let rows = [];
    try {
      const result = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: queryStart.toISOString(),
        end_time: queryEnd.toISOString(),
        statistic_ids: [entityId],
        period: "hour",
        types: ["sum", "state"],
      });
      rows = result?.[entityId] || [];
    } catch (error) {
      console.debug("Smart Plug Energy Card: statistics query failed", error);
    }

    if (rows.length >= 2) {
      return this._aggregateStatistics(rows, stateObj, unit, start, end);
    }
    if (!allowRawHistory) {
      throw new Error("Year totals require long-term energy statistics");
    }
    return this._loadRawHistory(entityId, unit, queryStart, queryEnd, start, end);
  }

  _statTime(row) {
    if (row.end !== undefined && row.end !== null) return dateFromValue(row.end);
    const start = dateFromValue(row.start);
    return validDate(start) ? new Date(start.getTime() + HOUR_MS) : start;
  }

  _aggregateStatistics(rows, currentState, unit, monthStart, monthEnd) {
    const samples = rows
      .map((row) => ({
        time: this._statTime(row),
        sum: row.sum === null || row.sum === undefined ? null : this._toKwh(row.sum, unit),
        state:
          row.state === null || row.state === undefined
            ? null
            : this._toKwh(row.state, unit),
      }))
      .filter((row) => validDate(row.time))
      .sort((a, b) => a.time - b.time);

    const daily = new Map();
    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1];
      const current = samples[i];
      let delta = null;
      if (Number.isFinite(previous.sum) && Number.isFinite(current.sum)) {
        delta = current.sum - previous.sum;
      } else if (Number.isFinite(previous.state) && Number.isFinite(current.state)) {
        delta = current.state - previous.state;
        if (delta < 0) delta = current.state;
      }
      if (!Number.isFinite(delta) || delta < -0.000001) continue;
      this._allocateInterval(previous.time, current.time, Math.max(0, delta), daily, monthStart, monthEnd);
    }

    const last = samples.at(-1);
    const liveValue = this._toKwh(currentState?.state, unit);
    const now = new Date();
    if (
      last &&
      Number.isFinite(last.state) &&
      Number.isFinite(liveValue) &&
      monthStart <= now &&
      now < monthEnd &&
      last.time < now
    ) {
      let delta = liveValue - last.state;
      if (delta < 0) delta = liveValue;
      if (delta >= 0 && delta < 100000) {
        this._allocateInterval(last.time, now, delta, daily, monthStart, monthEnd);
      }
    }

    return this._finalizeData(daily, "statistics", samples, monthStart, monthEnd);
  }

  async _loadRawHistory(entityId, unit, queryStart, queryEnd, monthStart, monthEnd) {
    const result = await this._hass.callWS({
      type: "history/history_during_period",
      start_time: queryStart.toISOString(),
      end_time: queryEnd.toISOString(),
      entity_ids: [entityId],
      include_start_time_state: true,
      significant_changes_only: false,
      minimal_response: true,
      no_attributes: true,
    });

    let raw = [];
    if (Array.isArray(result) && Array.isArray(result[0])) raw = result[0];
    else if (Array.isArray(result)) raw = result;
    else raw = result?.[entityId] || [];

    const samples = raw
      .map((row) => ({
        time: dateFromValue(row.lu ?? row.lc ?? row.last_updated ?? row.last_changed),
        state: this._toKwh(row.s ?? row.state, unit),
      }))
      .filter((row) => validDate(row.time) && Number.isFinite(row.state))
      .sort((a, b) => a.time - b.time);

    const daily = new Map();
    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1];
      const current = samples[i];
      let delta = current.state - previous.state;
      if (delta < 0) delta = current.state;
      if (delta >= 0 && delta < 100000) {
        this._allocateInterval(previous.time, current.time, delta, daily, monthStart, monthEnd);
      }
    }

    return this._finalizeData(daily, "history", samples, monthStart, monthEnd);
  }

  _allocateInterval(intervalStart, intervalEnd, kwh, daily, monthStart, monthEnd) {
    const startMs = Math.max(intervalStart.getTime(), monthStart.getTime());
    const endMs = Math.min(intervalEnd.getTime(), monthEnd.getTime(), Date.now());
    const originalDuration = intervalEnd.getTime() - intervalStart.getTime();
    if (endMs <= startMs || originalDuration <= 0 || kwh < 0) return;

    let cursor = startMs;
    while (cursor < endMs) {
      const next = Math.min(cursor + QUARTER_HOUR_MS, endMs);
      const midpoint = new Date((cursor + next) / 2);
      const parts = this._timeParts(midpoint);
      const key = this._dateKey(parts);
      const segmentKwh = kwh * ((next - cursor) / originalDuration);
      const { rate, band } = this._rateFor(parts);
      const factor =
        (1 - numberOr(this._config.discount_percent, 0) / 100) *
        (1 + numberOr(this._config.vat_percent, 0) / 100);
      const segmentCost = segmentKwh * rate * factor;

      if (!daily.has(key)) {
        daily.set(key, {
          kwh: 0,
          cost: 0,
          day: 0,
          night: 0,
          nightboost: 0,
        });
      }
      const item = daily.get(key);
      item.kwh += segmentKwh;
      item.cost += segmentCost;
      item[band] += segmentKwh;
      cursor = next;
    }
  }

  _rateFor(parts) {
    const dateKey = this._dateKey(parts);
    const usePrevious =
      Boolean(this._config.rate_change_date) && dateKey < this._config.rate_change_date;
    const prefix = usePrevious ? "previous_" : "";
    const time = parts.hour * 60 + numberOr(parts.minute, 0) + numberOr(parts.second, 0) / 60;
    const boostStart = timeToMinutes(
      this._config.nightboost_start_time,
      this._config.nightboost_start_hour,
    );
    const boostEnd = timeToMinutes(
      this._config.nightboost_end_time,
      this._config.nightboost_end_hour,
    );
    const dayStart = timeToMinutes(this._config.day_start_time, this._config.day_start_hour);
    const dayEnd = timeToMinutes(this._config.day_end_time, this._config.day_end_hour);
    const nightStart = timeToMinutes(
      this._config.night_start_time,
      this._config.night_start_hour,
    );
    const nightEnd = timeToMinutes(this._config.night_end_time, this._config.night_end_hour);

    if (timeInRange(time, boostStart, boostEnd)) {
      return {
        band: "nightboost",
        rate: numberOr(this._config[`${prefix}nightboost_rate`], this._config.nightboost_rate),
      };
    }
    if (timeInRange(time, dayStart, dayEnd)) {
      return {
        band: "day",
        rate: numberOr(this._config[`${prefix}day_rate`], this._config.day_rate),
      };
    }
    if (timeInRange(time, nightStart, nightEnd)) {
      return {
        band: "night",
        rate: numberOr(this._config[`${prefix}night_rate`], this._config.night_rate),
      };
    }
    // A safe Night fallback prevents any unpriced gaps if custom ranges do not
    // cover the full day. Nightboost and Day always take priority above it.
    return {
      band: "night",
      rate: numberOr(this._config[`${prefix}night_rate`], this._config.night_rate),
    };
  }

  _toKwh(value, unit) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return NaN;
    const normalized = String(unit || "kWh").toLowerCase();
    if (normalized === "wh") return numeric / 1000;
    if (normalized === "mwh") return numeric * 1000;
    if (normalized === "j") return numeric / 3600000;
    if (normalized === "kj") return numeric / 3600;
    if (normalized === "mj") return numeric / 3.6;
    return numeric;
  }

  _finalizeData(daily, source, samples, monthStart, monthEnd) {
    let totalKwh = 0;
    let totalCost = 0;
    for (const item of daily.values()) {
      totalKwh += item.kwh;
      totalCost += item.cost;
    }
    const expectedEnd = Math.min(monthEnd.getTime(), Date.now());
    const firstTime = samples[0]?.time?.getTime?.() ?? Infinity;
    const lastTime = samples.at(-1)?.time?.getTime?.() ?? -Infinity;
    return {
      daily,
      totalKwh,
      totalCost,
      source,
      partial:
        firstTime > monthStart.getTime() + 3 * HOUR_MS ||
        lastTime < expectedEnd - 3 * HOUR_MS,
      loadedAt: new Date(),
    };
  }

  _isCurrentMonth() {
    const now = this._timeParts(new Date());
    return this._displayYear === now.year && this._displayMonth === now.month;
  }

  _changeMonth(delta) {
    let month = this._displayMonth + delta;
    let year = this._displayYear;
    if (month < 1) {
      month = 12;
      year -= 1;
    } else if (month > 12) {
      month = 1;
      year += 1;
    }

    const now = this._timeParts(new Date());
    if (year > now.year || (year === now.year && month > now.month)) return;
    this._displayYear = year;
    this._displayMonth = month;
    this._selectedDay = null;
    this._data = this._cache.get(this._cacheKey()) || null;
    this._yearData = this._yearCache.get(this._yearCacheKey()) || null;
    this._error = "";
    this._yearError = "";
    this._render();
    this._ensureData();
    this._ensureYearData();
  }

  _formatKwh(value, digits = 3) {
    return `${numberOr(value).toLocaleString(this._locale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} kWh`;
  }

  _formatCurrency(value) {
    try {
      return new Intl.NumberFormat(this._locale(), {
        style: "currency",
        currency: this._config.currency || "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(numberOr(value));
    } catch (_error) {
      return `${this._config.currency || "EUR"} ${numberOr(value).toFixed(2)}`;
    }
  }

  _formatEntity(entityId, digits = 1) {
    const state = this._hass?.states?.[entityId];
    if (!state || !Number.isFinite(Number(state.state))) return null;
    const unit = state.attributes.unit_of_measurement || "";
    return `${Number(state.state).toLocaleString(this._locale(), {
      maximumFractionDigits: digits,
    })} ${unit}`.trim();
  }

  _monthLabel() {
    const anchor = this._zonedDate(this._displayYear, this._displayMonth, 15, 12);
    return new Intl.DateTimeFormat(this._locale(), {
      timeZone: this._timeZone(),
      month: "long",
      year: "numeric",
    }).format(anchor);
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!this._config) {
      this.shadowRoot.innerHTML = "";
      return;
    }
    if (!this._hass || this._displayYear === null) {
      this.shadowRoot.innerHTML = `<ha-card><div style="padding:20px;color:var(--secondary-text-color)">Loading Smart Plug Energy Calendar…</div></ha-card>`;
      return;
    }

    const switchState = this._hass?.states?.[this._config.entity];
    const isOn = switchState?.state === "on";
    const title =
      this._config.title || switchState?.attributes?.friendly_name || "Smart Plug Energy";
    const data = this._data;
    const loading = Boolean(this._loadingKey === this._cacheKey());

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="card-content">
          <header class="topbar">
            <div class="identity">
              ${
                this._config.show_switch
                  ? `<button class="power-button ${isOn ? "on" : ""}" data-action="toggle" title="Turn plug ${
                      isOn ? "off" : "on"
                    }">
                       <ha-icon icon="mdi:power-plug${isOn ? "" : "-off"}"></ha-icon>
                     </button>`
                  : ""
              }
              <div>
                <h2>${escapeHtml(title)}</h2>
                <div class="subline">
                  <span class="status-dot ${isOn ? "on" : ""}"></span>
                  ${escapeHtml(switchState?.state || "unavailable")}
                  ${
                    this._discovered.energy
                      ? `<span class="sensor-ok">• Energy sensor connected</span>`
                      : ""
                  }
                </div>
              </div>
            </div>
            ${
              this._config.show_calendar
                ? `<div class="view-toggle" role="group" aria-label="Calendar values">
                    <button data-view="kwh" class="${
                      this._view === "kwh" ? "active" : ""
                    }">kWh</button>
                    <button data-view="cost" class="${
                      this._view === "cost" ? "active" : ""
                    }">${escapeHtml(this._config.currency)}</button>
                  </div>`
                : ""
            }
          </header>

          ${this._renderLiveValues()}

          <section class="month-heading">
            <button class="nav-button" data-month="-1" aria-label="Previous month">
              <ha-icon icon="mdi:chevron-left"></ha-icon>
            </button>
            <div class="month-title">
              <h3>${escapeHtml(this._monthLabel())}</h3>
              <span>${data?.partial ? "Partial recorded history" : "Recorded energy history"}</span>
            </div>
            <button class="nav-button" data-month="1" aria-label="Next month" ${
              this._isCurrentMonth() ? "disabled" : ""
            }>
              <ha-icon icon="mdi:chevron-right"></ha-icon>
            </button>
          </section>

          <section class="totals">
            <div class="total-block">
              <span>Cost</span>
              <strong>${data ? this._formatCurrency(data.totalCost) : "—"}</strong>
            </div>
            <div class="total-block right">
              <span>Used</span>
              <strong>${data ? this._formatKwh(data.totalKwh, 3) : "—"}</strong>
            </div>
          </section>

          ${
            this._config.show_calendar
              ? `<div class="legend">
                  <span><i class="blue"></i>≤ ${numberOr(this._config.blue_limit, 1)} kWh</span>
                  <span><i class="amber"></i>${numberOr(
                    this._config.blue_limit,
                    1,
                  )}–${numberOr(this._config.amber_limit, 2)} kWh</span>
                  <span><i class="red"></i>&gt; ${numberOr(
                    this._config.amber_limit,
                    2,
                  )} kWh</span>
                  <span><i class="empty"></i>No data</span>
                </div>`
              : ""
          }

          ${this._config.show_calendar ? this._renderBody(loading) : ""}
          ${this._config.show_calendar ? this._renderSelectedDay() : ""}
          ${this._renderYearTotals()}

          ${
            this._config.show_tariff_summary
              ? `<footer>
                  <span>Day ${shortTime(
                    this._config.day_start_time,
                    this._config.day_start_hour,
                  )}–${shortTime(
                    this._config.day_end_time,
                    this._config.day_end_hour,
                  )} · ${numberOr(this._config.day_rate).toFixed(4)}</span>
                  <span>Nightboost ${shortTime(
                    this._config.nightboost_start_time,
                    this._config.nightboost_start_hour,
                  )}–${shortTime(
                    this._config.nightboost_end_time,
                    this._config.nightboost_end_hour,
                  )} · ${numberOr(this._config.nightboost_rate).toFixed(4)}</span>
                  <span>Night ${shortTime(
                    this._config.night_start_time,
                    this._config.night_start_hour,
                  )}–${shortTime(
                    this._config.night_end_time,
                    this._config.night_end_hour,
                  )} · ${numberOr(this._config.night_rate).toFixed(4)}</span>
                  <span>VAT ${numberOr(this._config.vat_percent)}%</span>
                </footer>`
              : ""
          }
        </div>
      </ha-card>
    `;
    this._attachEvents();
  }

  _renderLiveValues() {
    if (!this._config.show_live_values) return "";
    const values = [
      ["mdi:flash", "Power", this._formatEntity(this._discovered.power, 1)],
      ["mdi:sine-wave", "Voltage", this._formatEntity(this._discovered.voltage, 1)],
      ["mdi:current-ac", "Current", this._formatEntity(this._discovered.current, 2)],
    ].filter((item) => item[2]);
    if (!values.length) return "";
    return `<section class="live-values">
      ${values
        .map(
          ([icon, label, value]) => `<div class="live-chip">
            <ha-icon icon="${icon}"></ha-icon>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>`,
        )
        .join("")}
    </section>`;
  }

  _renderYearTotals() {
    if (!this._config.show_year_totals || !this._discovered.energy) return "";
    const loading = this._yearLoadingKey === this._yearCacheKey();
    const data = this._yearData;
    return `<section class="year-totals">
      <div class="year-total-heading">
        <div>
          <ha-icon icon="mdi:calendar-range"></ha-icon>
          <strong>${this._displayYear} year total</strong>
        </div>
        <span>${data?.partial ? "Recorded history" : "Recorded energy history"}</span>
      </div>
      <div class="year-total-values">
        <div class="year-total-item">
          <ha-icon icon="mdi:cash"></ha-icon>
          <span>Total ${escapeHtml(this._config.currency || "EUR")}</span>
          <strong>${data ? this._formatCurrency(data.totalCost) : "—"}</strong>
        </div>
        <div class="year-total-item">
          <ha-icon icon="mdi:lightning-bolt"></ha-icon>
          <span>Total kWh</span>
          <strong>${data ? this._formatKwh(data.totalKwh, 3) : "—"}</strong>
        </div>
      </div>
      ${
        this._yearError
          ? `<div class="year-total-error">
              <span>${escapeHtml(this._yearError)}</span>
              <button data-action="retry-year">Retry</button>
            </div>`
          : loading && !data
            ? `<div class="year-total-loading"><ha-icon icon="mdi:loading" class="spin"></ha-icon> Loading yearly total…</div>`
            : ""
      }
    </section>`;
  }

  _renderBody(loading) {
    if (!this._discovered.energy) {
      return `<div class="message error">
        <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
        <div><strong>Energy sensor not found</strong><br>
        Select an Energy sensor in this card's settings.</div>
      </div>`;
    }
    if (this._error) {
      return `<div class="message error">
        <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
        <div><strong>History could not be loaded</strong><br>${escapeHtml(this._error)}</div>
        <button data-action="retry">Retry</button>
      </div>`;
    }
    if (loading && !this._data) {
      return `<div class="message loading">
        <ha-icon icon="mdi:loading" class="spin"></ha-icon>
        Loading electricity history…
      </div>${this._renderCalendar(true)}`;
    }
    return this._renderCalendar(false);
  }

  _renderCalendar(skeleton) {
    const sundayFirst = this._config.week_start !== "monday";
    const labels = sundayFirst
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const firstWeekday = new Date(
      Date.UTC(this._displayYear, this._displayMonth - 1, 1),
    ).getUTCDay();
    const offset = sundayFirst ? firstWeekday : (firstWeekday + 6) % 7;
    const daysInMonth = new Date(
      Date.UTC(this._displayYear, this._displayMonth, 0),
    ).getUTCDate();
    const cells = [];
    for (let i = 0; i < offset; i += 1) cells.push(`<div class="day-cell spacer"></div>`);

    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${this._displayYear}-${pad2(this._displayMonth)}-${pad2(day)}`;
      const item = this._data?.daily?.get(key);
      const level = !item
        ? "no-data"
        : item.kwh <= numberOr(this._config.blue_limit, 1)
          ? "blue"
          : item.kwh <= numberOr(this._config.amber_limit, 2)
            ? "amber"
            : "red";
      const value = skeleton
        ? ""
        : !item
          ? "—"
          : this._view === "cost"
            ? this._formatCurrency(item.cost)
            : numberOr(item.kwh).toLocaleString(this._locale(), {
                minimumFractionDigits: 3,
                maximumFractionDigits: 3,
              });
      cells.push(`<button class="day-cell ${skeleton ? "skeleton" : level} ${
        this._selectedDay === key ? "selected" : ""
      }" data-day="${key}" ${!item || skeleton ? "disabled" : ""}>
        <span class="day-number">${day}</span>
        <strong>${escapeHtml(value)}</strong>
        ${item && this._view === "cost" ? "" : item ? "<small>kWh</small>" : ""}
      </button>`);
    }

    return `<section class="calendar">
      <div class="weekdays">${labels.map((label) => `<span>${label}</span>`).join("")}</div>
      <div class="calendar-grid">${cells.join("")}</div>
    </section>`;
  }

  _renderSelectedDay() {
    if (!this._selectedDay || !this._data?.daily?.has(this._selectedDay)) return "";
    const item = this._data.daily.get(this._selectedDay);
    const date = this._zonedDate(
      Number(this._selectedDay.slice(0, 4)),
      Number(this._selectedDay.slice(5, 7)),
      Number(this._selectedDay.slice(8, 10)),
      12,
    );
    const label = new Intl.DateTimeFormat(this._locale(), {
      timeZone: this._timeZone(),
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(date);
    return `<section class="day-detail">
      <div class="detail-title">
        <strong>${escapeHtml(label)}</strong>
        <button data-action="close-detail" aria-label="Close"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      <div class="detail-total">
        <span>${this._formatKwh(item.kwh, 3)}</span>
        <strong>${this._formatCurrency(item.cost)}</strong>
      </div>
      <div class="detail-bands">
        <span><i class="day"></i>Day ${this._formatKwh(item.day, 3)}</span>
        <span><i class="night"></i>Night ${this._formatKwh(item.night, 3)}</span>
        <span><i class="boost"></i>Nightboost ${this._formatKwh(item.nightboost, 3)}</span>
      </div>
    </section>`;
  }

  _attachEvents() {
    this.shadowRoot.querySelector("[data-action='toggle']")?.addEventListener("click", () => {
      this._hass?.callService("homeassistant", "toggle", { entity_id: this._config.entity });
    });
    this.shadowRoot.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        this._view = button.dataset.view;
        this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-month]").forEach((button) => {
      button.addEventListener("click", () => this._changeMonth(Number(button.dataset.month)));
    });
    this.shadowRoot.querySelectorAll("[data-day]").forEach((button) => {
      button.addEventListener("click", () => {
        this._selectedDay = button.dataset.day;
        this._render();
      });
    });
    this.shadowRoot.querySelector("[data-action='close-detail']")?.addEventListener("click", () => {
      this._selectedDay = null;
      this._render();
    });
    this.shadowRoot.querySelector("[data-action='retry']")?.addEventListener("click", () => {
      this._error = "";
      this._cache.delete(this._cacheKey());
      this._ensureData(true);
    });
    this.shadowRoot.querySelector("[data-action='retry-year']")?.addEventListener("click", () => {
      this._yearError = "";
      this._yearCache.delete(this._yearCacheKey());
      this._ensureYearData(true);
    });
  }

  _styles() {
    return `
      :host {
        display: block;
        --calendar-blue: #2f8ee5;
        --calendar-amber: #f5a623;
        --calendar-red: #d93654;
        --calendar-empty: color-mix(in srgb, var(--secondary-background-color, #20252b) 86%, transparent);
      }
      * { box-sizing: border-box; }
      ha-card {
        overflow: hidden;
        background: var(--ha-card-background, var(--card-background-color));
      }
      .card-content { padding: 20px; }
      button { font: inherit; }
      .topbar, .identity, .month-heading, .totals, .detail-title, .detail-total {
        display: flex;
        align-items: center;
      }
      .topbar { justify-content: space-between; gap: 16px; }
      .identity { gap: 12px; min-width: 0; }
      .identity h2 {
        margin: 0;
        font-size: 22px;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .subline {
        margin-top: 5px;
        color: var(--secondary-text-color);
        font-size: 12px;
        text-transform: capitalize;
      }
      .sensor-ok { text-transform: none; }
      .status-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--disabled-text-color);
        margin-right: 5px;
      }
      .status-dot.on { background: #37c976; box-shadow: 0 0 8px #37c97688; }
      .power-button, .nav-button, .day-detail button {
        border: 0;
        color: var(--primary-text-color);
        background: var(--secondary-background-color);
        cursor: pointer;
      }
      .power-button {
        width: 44px;
        height: 44px;
        border-radius: 14px;
        display: grid;
        place-items: center;
      }
      .power-button.on { background: color-mix(in srgb, #37c976 22%, var(--secondary-background-color)); color: #37c976; }
      .view-toggle {
        display: flex;
        padding: 3px;
        border-radius: 10px;
        background: var(--secondary-background-color);
      }
      .view-toggle button {
        min-width: 52px;
        padding: 7px 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--secondary-text-color);
        cursor: pointer;
      }
      .view-toggle button.active {
        background: var(--primary-color);
        color: var(--text-primary-color, white);
        font-weight: 700;
      }
      .live-values {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 16px;
      }
      .live-chip {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        column-gap: 7px;
        padding: 10px;
        border-radius: 12px;
        background: var(--secondary-background-color);
      }
      .live-chip ha-icon { color: var(--primary-color); grid-row: 1 / span 2; --mdc-icon-size: 20px; }
      .live-chip span { color: var(--secondary-text-color); font-size: 11px; }
      .live-chip strong { font-size: 13px; }
      .month-heading {
        justify-content: space-between;
        margin-top: 22px;
        border-top: 1px solid var(--divider-color);
        padding-top: 18px;
      }
      .month-title { text-align: center; }
      .month-title h3 { margin: 0; font-size: 23px; text-transform: capitalize; }
      .month-title span { color: var(--secondary-text-color); font-size: 11px; }
      .nav-button {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        display: grid;
        place-items: center;
      }
      .nav-button:disabled { opacity: .28; cursor: default; }
      .totals { justify-content: space-between; padding: 18px 2px 13px; }
      .total-block { display: flex; flex-direction: column; gap: 3px; }
      .total-block.right { align-items: flex-end; }
      .total-block span { color: var(--secondary-text-color); font-size: 13px; }
      .total-block strong { color: var(--primary-color); font-size: 22px; }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        color: var(--secondary-text-color);
        font-size: 11px;
        padding-bottom: 14px;
      }
      .legend span { display: flex; align-items: center; gap: 5px; }
      .legend i { width: 9px; height: 9px; border-radius: 50%; }
      .legend .blue { background: var(--calendar-blue); }
      .legend .amber { background: var(--calendar-amber); }
      .legend .red { background: var(--calendar-red); }
      .legend .empty { background: var(--calendar-empty); border: 1px solid var(--divider-color); }
      .weekdays, .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
      .weekdays { margin-bottom: 7px; }
      .weekdays span { text-align: center; color: var(--secondary-text-color); font-size: 11px; }
      .day-cell {
        position: relative;
        min-width: 0;
        min-height: 68px;
        border: 0;
        border-radius: 11px;
        color: white;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        transition: transform .12s ease, filter .12s ease;
      }
      .day-cell:not(:disabled):hover { transform: translateY(-2px); filter: brightness(1.08); }
      .day-cell.blue { background: var(--calendar-blue); }
      .day-cell.amber { background: var(--calendar-amber); }
      .day-cell.red { background: var(--calendar-red); }
      .day-cell.no-data {
        background: var(--calendar-empty);
        color: var(--disabled-text-color);
      }
      .day-cell.spacer { background: transparent; pointer-events: none; }
      .day-cell.selected { outline: 3px solid var(--primary-text-color); outline-offset: 2px; }
      .day-number { position: absolute; top: 6px; left: 8px; font-size: 10px; opacity: .82; }
      .day-cell strong { font-size: clamp(10px, 2.2vw, 14px); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
      .day-cell small { font-size: 9px; opacity: .8; margin-top: 1px; }
      .skeleton { background: var(--calendar-empty); overflow: hidden; }
      .skeleton::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(100deg, transparent 30%, #ffffff18 50%, transparent 70%);
        animation: shimmer 1.2s infinite;
      }
      @keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
      .message {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        min-height: 58px;
        border-radius: 12px;
        margin-bottom: 12px;
        color: var(--secondary-text-color);
        background: var(--secondary-background-color);
      }
      .message.error { justify-content: flex-start; padding: 12px; color: var(--error-color); }
      .message button { margin-left: auto; border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; }
      .spin { animation: spin .9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .day-detail {
        margin-top: 14px;
        padding: 14px;
        background: var(--secondary-background-color);
        border-radius: 14px;
      }
      .detail-title, .detail-total { justify-content: space-between; }
      .detail-title button { background: transparent; width: 30px; height: 30px; }
      .detail-total { padding: 10px 0; font-size: 17px; }
      .detail-total strong { color: var(--primary-color); font-size: 20px; }
      .detail-bands { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--secondary-text-color); font-size: 11px; }
      .detail-bands span { display: flex; align-items: center; gap: 5px; }
      .detail-bands i { width: 7px; height: 7px; border-radius: 50%; }
      .detail-bands .day { background: #ffcf4a; }
      .detail-bands .night { background: #6484ff; }
      .detail-bands .boost { background: #7ed8ff; }
      .year-totals {
        margin-top: 15px;
        padding: 14px;
        border-radius: 14px;
        background: var(--secondary-background-color);
      }
      .year-total-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 11px;
      }
      .year-total-heading > div { display: flex; align-items: center; gap: 7px; }
      .year-total-heading ha-icon { color: var(--primary-color); --mdc-icon-size: 19px; }
      .year-total-heading span { color: var(--secondary-text-color); font-size: 10px; }
      .year-total-values { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
      .year-total-item {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        column-gap: 8px;
        padding: 10px;
        border-radius: 11px;
        background: var(--card-background-color, var(--ha-card-background));
      }
      .year-total-item ha-icon { color: var(--primary-color); grid-row: 1 / span 2; --mdc-icon-size: 20px; }
      .year-total-item span { color: var(--secondary-text-color); font-size: 11px; }
      .year-total-item strong { color: var(--primary-color); font-size: 16px; }
      .year-total-loading, .year-total-error {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 9px;
        color: var(--secondary-text-color);
        font-size: 10px;
      }
      .year-total-loading ha-icon { --mdc-icon-size: 15px; }
      .year-total-error { color: var(--error-color); }
      .year-total-error button {
        margin-left: auto;
        border: 0;
        border-radius: 7px;
        padding: 5px 9px;
        cursor: pointer;
      }
      footer {
        display: flex;
        flex-wrap: wrap;
        gap: 5px 12px;
        margin-top: 15px;
        padding-top: 12px;
        border-top: 1px solid var(--divider-color);
        color: var(--secondary-text-color);
        font-size: 10px;
      }
      @media (max-width: 520px) {
        .card-content { padding: 14px; }
        .identity h2 { font-size: 18px; }
        .sensor-ok { display: none; }
        .live-values { grid-template-columns: 1fr 1fr; }
        .live-chip:last-child:nth-child(odd) { grid-column: 1 / -1; }
        .weekdays, .calendar-grid { gap: 5px; }
        .day-cell { min-height: 56px; border-radius: 8px; }
        .day-number { top: 4px; left: 6px; }
        .day-cell strong { font-size: 10px; }
        .total-block strong { font-size: 18px; }
      }
    `;
  }
}

if (!customElements.get("smart-plug-energy-card")) {
  customElements.define("smart-plug-energy-card", SmartPlugEnergyCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "smart-plug-energy-card")) {
  window.customCards.push({
    type: "smart-plug-energy-card",
    name: "Smart Plug Energy Calendar",
    description: "Tapo-style monthly electricity usage and cost calendar for smart plugs",
    preview: true,
    getEntitySuggestion: (hass, entityId) => {
      if (!entityId?.startsWith("switch.")) return null;
      const state = hass?.states?.[entityId];
      const text = `${entityId} ${state?.attributes?.friendly_name || ""}`;
      if (!/plug|socket|outlet|energy/i.test(text)) return null;
      return {
        config: { type: "custom:smart-plug-energy-card", ...DEFAULTS, entity: entityId },
      };
    },
  });
}

console.info(
  `%c SMART-PLUG-ENERGY-CARD %c v${SPEC_VERSION} `,
  "color: white; background: #2f8ee5; font-weight: 700; padding: 2px 5px; border-radius: 4px 0 0 4px;",
  "color: #2f8ee5; background: #e8f3fd; font-weight: 700; padding: 2px 5px; border-radius: 0 4px 4px 0;",
);
