import assert from "node:assert/strict";

const registry = new Map();

globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = {
      innerHTML: "",
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return this.shadowRoot;
  }
};

globalThis.customElements = {
  define(name, implementation) {
    registry.set(name, implementation);
  },
  get(name) {
    return registry.get(name);
  },
};

globalThis.window = { customCards: [] };

await import("../smart-plug-energy-card.js");

const Card = customElements.get("smart-plug-energy-card");
assert.ok(Card, "card custom element is registered");

const card = new Card();
card.setConfig({ entity: "switch.example_smart_plug" });
card._hass = {
  config: { time_zone: "Europe/Dublin" },
  locale: { language: "en-IE" },
  states: {},
};

assert.equal(card._toKwh(1250, "Wh"), 1.25);
assert.equal(card._toKwh(2, "MWh"), 2000);
assert.equal(card._toKwh(3600000, "J"), 1);

assert.deepEqual(
  card._rateFor({ year: 2026, month: 7, day: 10, hour: 2 }),
  { band: "nightboost", rate: 0 },
);
assert.deepEqual(
  card._rateFor({ year: 2026, month: 7, day: 10, hour: 8 }),
  { band: "day", rate: 0.25 },
);
assert.deepEqual(
  card._rateFor({ year: 2026, month: 7, day: 10, hour: 23 }),
  { band: "night", rate: 0 },
);
assert.deepEqual(
  card._rateFor({ year: 2026, month: 6, day: 30, hour: 12 }),
  { band: "day", rate: 0 },
);

card.setConfig({
  entity: "switch.example_smart_plug",
  day_start_time: "09:30:00",
  day_end_time: "22:15:00",
  night_start_time: "22:15:00",
  night_end_time: "09:30:00",
  nightboost_start_time: "01:30:00",
  nightboost_end_time: "03:45:00",
});
assert.equal(
  card._rateFor({ year: 2026, month: 7, day: 10, hour: 9, minute: 29 }).band,
  "night",
);
assert.equal(
  card._rateFor({ year: 2026, month: 7, day: 10, hour: 9, minute: 30 }).band,
  "day",
);
assert.equal(
  card._rateFor({ year: 2026, month: 7, day: 10, hour: 2, minute: 15 }).band,
  "nightboost",
);
card.setConfig({ entity: "switch.example_smart_plug" });

const start = card._zonedDate(2026, 7, 10, 0);
const end = card._zonedDate(2026, 7, 11, 0);
const daily = new Map();
card._allocateInterval(start, end, 24, daily, start, end);
const day = daily.get("2026-07-10");

assert.ok(day, "a daily aggregate is created");
assert.ok(Math.abs(day.kwh - 24) < 1e-9, "all energy is retained");
assert.ok(Math.abs(day.day - 15) < 1e-9, "15 hours use the day tariff");
assert.ok(Math.abs(day.nightboost - 2) < 1e-9, "2 hours use Nightboost");
assert.ok(Math.abs(day.night - 7) < 1e-9, "7 hours use the night tariff");

const rawCost = 15 * 0.25;
const payableCost = rawCost;
assert.ok(Math.abs(day.cost - payableCost) < 1e-9, "discount and VAT are applied");

card._entityRegistry = new Map([
  ["switch.example_smart_plug", { entity_id: "switch.example_smart_plug", device_id: "device-1" }],
  [
    "sensor.example_smart_plug_energy",
    { entity_id: "sensor.example_smart_plug_energy", device_id: "device-1" },
  ],
  ["sensor.example_smart_plug_power", { entity_id: "sensor.example_smart_plug_power", device_id: "device-1" }],
]);
card._hass.states = {
  "switch.example_smart_plug": { state: "on", attributes: {} },
  "sensor.example_smart_plug_energy": {
    state: "171.31",
    attributes: {
      device_class: "energy",
      state_class: "total_increasing",
      unit_of_measurement: "kWh",
    },
  },
  "sensor.example_smart_plug_power": {
    state: "58.3",
    attributes: { device_class: "power", unit_of_measurement: "W" },
  },
  "sensor.some_other_energy": {
    state: "999",
    attributes: {
      device_class: "energy",
      state_class: "total_increasing",
      unit_of_measurement: "kWh",
    },
  },
};

const discovered = card._discoverEntities();
assert.equal(discovered.energy, "sensor.example_smart_plug_energy");
assert.equal(discovered.power, "sensor.example_smart_plug_power");

card._discovered = discovered;
card._displayYear = 2026;
card._displayMonth = 7;
card._data = {
  daily: new Map([
    [
      "2026-07-10",
      { kwh: 1.4, cost: 0.41, day: 0.9, night: 0.4, nightboost: 0.1 },
    ],
  ]),
  totalKwh: 1.4,
  totalCost: 0.41,
  partial: false,
};
card._yearData = {
  daily: new Map(),
  totalKwh: 22.75,
  totalCost: 6.83,
  partial: true,
};
card._render();
assert.match(card.shadowRoot.innerHTML, /July 2026/);
assert.match(card.shadowRoot.innerHTML, /1\.400 kWh/);
assert.match(card.shadowRoot.innerHTML, /data-day="2026-07-10"/);
assert.match(card.shadowRoot.innerHTML, /Energy sensor connected/);
assert.match(card.shadowRoot.innerHTML, /Total EUR/);
assert.match(card.shadowRoot.innerHTML, /Total kWh/);
assert.match(card.shadowRoot.innerHTML, /2026 year total/);
assert.match(card.shadowRoot.innerHTML, /22\.750 kWh/);
assert.doesNotMatch(card.shadowRoot.innerHTML, /month-total/);

const configForm = Card.getConfigForm();
assert.ok(
  configForm.schema
    .flatMap((item) => item.schema || [item])
    .some((item) => item.name === "show_year_totals"),
  "visual editor includes the yearly totals toggle",
);
assert.ok(
  configForm.schema
    .flatMap((item) => item.schema || [item])
    .some((item) => item.name === "show_calendar"),
  "visual editor includes the monthly calendar toggle",
);
assert.ok(
  configForm.schema
    .flatMap((item) => item.schema || [item])
    .some((item) => item.name === "show_tariff_summary"),
  "visual editor includes the tariff information toggle",
);
card._config.show_year_totals = false;
card._render();
assert.doesNotMatch(card.shadowRoot.innerHTML, /2026 year total/);
card._config.show_year_totals = true;
card._config.show_calendar = false;
card._render();
assert.doesNotMatch(card.shadowRoot.innerHTML, /class="calendar-grid"/);
assert.doesNotMatch(card.shadowRoot.innerHTML, /class="legend"/);
assert.doesNotMatch(card.shadowRoot.innerHTML, /class="view-toggle"/);
assert.match(card.shadowRoot.innerHTML, /2026 year total/);
card._config.show_calendar = true;
card._config.show_tariff_summary = false;
card._render();
assert.doesNotMatch(card.shadowRoot.innerHTML, /<footer>/);
card._config.show_tariff_summary = true;

let yearlyStatisticsRequest;
card._hass.callWS = async (request) => {
  yearlyStatisticsRequest = request;
  return {
    "sensor.example_smart_plug_energy": [
      { end: "2026-01-01T01:00:00.000Z", sum: 10 },
      { end: "2026-01-01T02:00:00.000Z", sum: 11 },
    ],
  };
};
const loadedYear = await card._loadYear("sensor.example_smart_plug_energy");
assert.equal(yearlyStatisticsRequest.type, "recorder/statistics_during_period");
assert.equal(yearlyStatisticsRequest.period, "hour");
assert.ok(Math.abs(loadedYear.totalKwh - 1) < 1e-9, "year total uses hourly statistics");
assert.equal(loadedYear.totalCost, 0, "year total applies zero previous prices");

assert.equal(window.customCards[0].type, "smart-plug-energy-card");

console.log("All Smart Plug Energy Calendar tests passed.");
