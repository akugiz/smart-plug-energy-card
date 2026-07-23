# Smart Plug Energy Calendar Card

A standalone Home Assistant dashboard card for smart plugs with energy monitoring. Select the plug switch and the card automatically finds the energy, power, voltage, and current sensors belonging to the same device.

It shows:

- a Tapo-style monthly calendar with a value inside every recorded day;
- blue, amber, and red days based on daily kWh;
- monthly electricity usage and cost;
- a kWh/cost display switch;
- Day, Night, and Nightboost tariff calculations;
- editable Day, Night, and Nightboost start/end times;
- VAT and bill-discount calculations;
- current power, voltage, and current when those sensors exist;
- optional yearly cost and energy totals below the calendar;
- an option to show or hide the coloured monthly calendar;
- an option to show or hide the tariff summary at the bottom;
- month navigation and a daily tariff breakdown;
- a button to turn the selected plug on or off.

No Utility Meter helper, Template helper, or tariff automation is required. The card reads the energy sensor's Home Assistant Recorder statistics and performs the display calculation locally.

## Default tariff

The included defaults match the electricity bill used to create the card.

Current prices from 1 July 2026, before VAT:

| Period | Hours | Rate |
| --- | --- | ---: |
| Nightboost | 02:00–04:00 | €0.1056/kWh |
| Day | 08:00–23:00 | €0.3650/kWh |
| Night | Remaining hours | €0.1800/kWh |

Previous prices before 1 July 2026:

| Period | Rate |
| --- | ---: |
| Nightboost | €0.0965/kWh |
| Day | €0.3334/kWh |
| Night | €0.1644/kWh |

The default bill adjustments are a 5.5% discount and 9% VAT. All values can be changed in the visual card editor.

Open **Tariff times** in the visual card editor to change the Day, Night, and Nightboost start/end times. Nightboost takes priority when it sits inside the Night period. Any gap outside the configured ranges safely uses the Night price.

## HACS installation

1. Open **HACS** in Home Assistant.
2. Select **Dashboard**.
3. Open the three-dot menu and choose **Custom repositories**.
4. Add:

   ```text
   https://github.com/akugiz/smart-plug-energy-card
   ```

5. Select **Dashboard** as the category.
6. Add the repository, then download **Smart Plug Energy Calendar**.
7. Refresh Home Assistant.

## Manual installation

1. Extract the downloaded ZIP file.
2. Open Home Assistant's File editor or Studio Code Server.
3. Copy `smart-plug-energy-card.js` to:

   ```text
   /config/www/smart-plug-energy-card.js
   ```

4. If the `www` folder did not already exist, restart Home Assistant.
5. Go to **Settings → Dashboards**.
6. Open the three-dot menu in the upper-right corner and select **Resources**.
7. Select **Add resource** and enter:

   ```text
   /local/smart-plug-energy-card.js?v=1.0.6
   ```

8. Select **JavaScript module** and save.
9. Refresh the browser or fully close and reopen the Home Assistant mobile app.

## Add the card

1. Edit a dashboard.
2. Select **Add card**.
3. Find **Smart Plug Energy Calendar**.
4. Select the smart plug, such as `switch.example_smart_plug`.
5. Save the card.

The minimum YAML configuration is:

```yaml
type: custom:smart-plug-energy-card
entity: switch.example_smart_plug
```

## Full example

```yaml
type: custom:smart-plug-energy-card
entity: switch.example_smart_plug
title: Example smart plug
currency: EUR

# Current prices from this date
rate_change_date: "2026-07-01"
day_rate: 0.3650
night_rate: 0.1800
nightboost_rate: 0.1056

# Prices before rate_change_date
previous_day_rate: 0.3334
previous_night_rate: 0.1644
previous_nightboost_rate: 0.0965

# Editable tariff times
day_start_time: "08:00:00"
day_end_time: "23:00:00"
night_start_time: "23:00:00"
night_end_time: "08:00:00"
nightboost_start_time: "02:00:00"
nightboost_end_time: "04:00:00"

discount_percent: 5.5
vat_percent: 9
week_start: sunday
initial_view: kwh
blue_limit: 1
amber_limit: 2
show_calendar: true
show_year_totals: true
show_tariff_summary: true
```

The yearly totals use the year currently visible in the calendar and include all
recorded energy history available for that year. Turn **Show yearly totals** on
or off in **Display settings**.

Turn **Show monthly calendar** off in **Display settings** to hide the coloured
legend, weekday labels, and daily boxes. Monthly and yearly totals remain visible.
The kWh/currency selector is also hidden automatically when the monthly calendar
is hidden. Turn **Show tariff information** off to hide the bottom tariff and VAT line.

## If automatic discovery selects the wrong sensor

Open the card's visual settings and expand **Sensor discovery**. Select the correct energy sensor manually. A typical energy entity could be:

```text
sensor.example_smart_plug_energy
```

The equivalent YAML override is:

```yaml
energy_entity: sensor.example_smart_plug_energy
```

The same optional override is available for power, voltage, and current.

## Historical data

The energy entity should have `device_class: energy` and a `state_class` of `total` or `total_increasing`. The card uses Home Assistant's long-term hourly statistics when available. If they are unavailable, it tries Recorder's raw history.

The displayed month can only include history that Home Assistant has recorded. Adding the card does not recreate periods that were never stored.

## Updating

Replace the JavaScript file with the new version and change the version at the end of the resource URL, for example:

```text
/local/smart-plug-energy-card.js?v=1.0.6
```

Then refresh Home Assistant.

## Privacy

The card makes no internet requests. It reads data directly from the Home Assistant instance where it is installed.
