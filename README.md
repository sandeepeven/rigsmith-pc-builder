# Rigsmith — PC Builder

A static, no-build web app for planning a PC part list. Pick a motherboard, CPU, GPU, RAM, SSD and PSU and Rigsmith checks compatibility, estimates how well each part is used, and predicts game frame rates.

**Live:** https://rigsmith-pc-builder.netlify.app

## Features

- **Compatibility checks** — socket, memory type and capacity, M.2 generation, PSU wattage and headroom, CPU/GPU bottlenecks.
- **Smart suggestions** — once a CPU or motherboard is picked, every other slot ranks parts by compatibility and balance.
- **Utilization** — how busy the CPU and GPU stay in games at the build's best-fit resolution, plus how much of the board and RAM the build can actually use.
- **Game FPS estimates** — approximate High-preset FPS for 15 popular titles at 1080p, 1440p and 4K.
- **Multiple saved lists** — kept in the browser's `localStorage`; mark parts you already own to leave them out of the total.
- **Currency switcher** — INR by default; USD, EUR, GBP, CAD, AUD, AED, SGD and JPY at fixed approximate rates.
- **Two themes** — Classic (plain-HTML look) and Retro.

## Project layout

```
index.html                  page markup
styles.css                  styles for both themes
app.js                      all app logic (state, rules, utilization, FPS model, picker)
catalog.json                catalog manifest: metadata, counts, hashed data file names
data/<cat>.<hash>.json      one compact part list per category, loaded lazily
scripts/build-catalog.mjs   regenerates catalog.json and data/ from the source datasets
netlify.toml                Netlify publish and cache-header config
```

## Running locally

No dependencies or build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly from disk won't work because the catalog is fetched.)

## Rebuilding the catalog

Clone the two source datasets, then:

```sh
node scripts/build-catalog.mjs <buildcores-open-db>/open-db <pc-part-dataset>/data/json .
```

This rewrites `catalog.json` and `data/*.json`. Prices come from US listings and are converted as `INR = USD × 88 × 1.18` (FX rate × Indian retail premium); both constants live at the top of the script. Parts without an exact price match get the median price of equivalent parts and are marked as estimates.

## Deploying

The site is hosted on Netlify and publishes the repository root as-is:

```sh
netlify deploy --prod --dir .
```

## Data and licenses

- Specs: [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db) — CC BY-NC-SA 4.0
- Prices: [docyx/pc-part-dataset](https://github.com/docyx/pc-part-dataset) — MIT

Prices, utilization and FPS figures are estimates for planning, not quotes or benchmarks.
