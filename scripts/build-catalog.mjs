#!/usr/bin/env node
// Builds data.js from two open datasets:
//   • Specs  — BuildCores OpenDB  (https://github.com/buildcores/buildcores-open-db, CC BY-NC-SA 4.0)
//   • Prices — docyx/pc-part-dataset (https://github.com/docyx/pc-part-dataset, MIT; PCPartPicker USD prices)
//
// Usage:
//   node scripts/build-catalog.mjs <opendb>/open-db <docyx>/data/json [siteRoot=.]
//
// Output (loaded lazily by app.js):
//   catalog.json            manifest: meta, per-category counts and hashed file names (never cached long)
//   data/<cat>.<hash>.json  one compact file per category: { fields: [...], rows: [[...], ...] } (cached forever)
//
// Prices are converted USD → INR with an Indian street-price factor (import duty + GST + retail margin).
// A price is "listed" when the exact product was matched in the price dataset, otherwise it is
// "est" — the median price of equivalent parts (same GPU chip, same chipset, same RAM spec, …).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , OPENDB, DOCYX, OUT = '.'] = process.argv; // OUT = site root; writes catalog.json + data/*.json
if (!OPENDB || !DOCYX) {
  console.error('usage: node scripts/build-catalog.mjs <opendb/open-db> <docyx/data/json> [out]');
  process.exit(1);
}

const USD_INR = 88;          // FX rate
const INDIA_FACTOR = 1.18;   // typical Indian retail premium over US street price
const toINR = (usd) => Math.round((usd * USD_INR * INDIA_FACTOR) / 100) * 100;
const MODERN_SOCKETS = new Set(['AM4', 'AM5', 'LGA 1700', 'LGA 1851']);

// ───────────────────────── helpers ─────────────────────────
const readDir = (cat) => {
  const dir = path.join(OPENDB, cat);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
};
const readDocyx = (f) => JSON.parse(fs.readFileSync(path.join(DOCYX, f), 'utf8')).filter((x) => x.price > 0);
const norm = (s) => String(s || '').toLowerCase().replace(/(\d)\s+(gb|tb)\b/g, '$1$2').replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => new Set(norm(s).split(' ').filter(Boolean));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const group = (arr, keyFn) => { const m = new Map(); for (const x of arr) { const k = keyFn(x); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const brandOf = (name) => norm(name).split(' ')[0];

// Containment match: fraction of the (short) price-dataset name's tokens present in the (long) spec name.
function bestByContainment(specName, candidates, min = 0.85) {
  const st = toks(specName);
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const ct = c._t || (c._t = toks(c.name));
    if (!ct.size) continue;
    let hit = 0; for (const t of ct) if (st.has(t)) hit++;
    const score = hit / ct.size + ct.size * 0.001; // prefer more specific names on ties
    if (hit / ct.size >= min && score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

let uidSeen = new Set();
const shortId = (uuid) => { let n = 8, id; do { id = uuid.replace(/-/g, '').slice(0, n++); } while (uidSeen.has(id)); uidSeen.add(id); return id; };

const stats = {};
const tally = (cat, src) => { stats[cat] ??= { listed: 0, est: 0, dropped: 0 }; stats[cat][src]++; };

// ───────────────────────── CPU ─────────────────────────
function cpuKey(name) {
  const n = norm(name);
  let m = n.match(/ryzen (\d) (?:pro )?(\d{4}\w*)/); if (m) return `r${m[1]}-${m[2]}`;
  m = n.match(/core ultra (\d) (\d{3}\w*)/); if (m) return `u${m[1]}-${m[2]}`;
  m = n.match(/core (i\d) (\d{4,5}\w*)/); if (m) return `${m[1]}-${m[2]}`;
  return null;
}
function cpuTier(key) {
  if (!key) return 2;
  const fam = Number(key[1]);
  let t = { 3: 1, 5: 2.5, 7: 3.5, 9: 4.5 }[fam] ?? 2;
  const num = key.split('-')[1];
  if (key[0] === 'r') {
    const gen = Number(num[0]);
    t += gen >= 9 ? 0.75 : gen >= 7 ? 0.5 : gen >= 5 ? 0 : -1;
    if (/x3d/.test(num)) t += 1;
    if (/g$|ge$/.test(num)) t -= 0.5;
  } else if (key[0] === 'u') {
    t += 0.5;
  } else {
    const gen = Number(num.slice(0, 2));
    t += gen >= 13 ? 0.5 : 0;
  }
  if (/t$/.test(num)) t -= 0.75;
  return clamp(Math.floor(t + 0.25), 1, 5);
}
function buildCPUs() {
  const prices = group(readDocyx('cpu.json'), (x) => cpuKey(x.name));
  const out = new Map();
  for (const c of readDir('CPU')) {
    if (!MODERN_SOCKETS.has(c.socket)) continue;
    const name = c.metadata?.name || '';
    const key = cpuKey(name);
    if (!key) continue;
    if (/^r\d-[123]\d{3}/.test(key)) continue; // Zen 1/+/2 — long discontinued
    const boxed = c.specifications?.packaging !== 'OEM/Tray';
    const prev = out.get(key);
    if (prev && (prev._boxed || !boxed)) continue; // keep one entry per model, prefer boxed
    const pr = prices.get(key);
    if (!pr) { tally('cpu', 'dropped'); continue; }
    const s = c.specifications || {};
    out.set(key, {
      _boxed: boxed,
      id: shortId(c.opendb_id), cat: 'cpu', brand: c.metadata.manufacturer,
      name: name.replace(/\s+(Boxed|OEM\/Tray|Box|Tray)$/i, '').replace(/\s+\d+(\.\d+)?\s*GHz.*$/i, '').replace(/^(AMD|Intel)\s+/, '').replace(/^Core (i\d) /, 'Core $1-'),
      socket: c.socket.replace('LGA ', 'LGA'),
      cores: c.cores?.total, threads: c.cores?.threads,
      base: c.clocks?.performance?.base, boost: c.clocks?.performance?.boost,
      tdp: s.tdp, mem: s.memory?.types?.filter((t) => /DDR[45]/.test(t)) ?? [],
      igpu: !/^(none)?$/i.test(s.integratedGraphics?.model ?? ''), // source writes the string 'None'
      cooler: Boolean(s.includesCooler),
      year: c.metadata?.releaseYear,
      tier: cpuTier(key), price: toINR(median(pr.map((x) => x.price))), priceSrc: 'listed',
    });
  }
  const list = [...out.values()].map(({ _boxed, ...r }) => r);
  list.forEach(() => tally('cpu', 'listed'));
  return list;
}

// ───────────────────────── Motherboard ─────────────────────────
const MB_TIER = { H610: 1, H810: 1, A520: 1, A620: 1, B840: 1, B450: 2, B550: 2, B660: 2, B760: 2, H670: 2, H770: 2, B860: 2, B650: 3, B850: 3, X570: 3, X670: 4, X870: 4, Z690: 4, B650E: 4, X670E: 5, X870E: 5, Z790: 5, Z890: 5 };
const FF = { 'Micro ATX': 'mATX', 'Mini-ITX': 'ITX', EATX: 'E-ATX', ATX: 'ATX' };
function buildMobos() {
  const docyx = readDocyx('motherboard.json');
  const bySocket = group(docyx, (x) => x.socket?.replace(/\s/g, ''));
  const chipOf = (s) => (norm(s).match(/\b([abhxz]\d{3}e?)\b/) || [])[1]?.toUpperCase();
  const byChip = group(docyx, (x) => chipOf(x.name));
  const list = [];
  for (const m of readDir('Motherboard')) {
    if (!MODERN_SOCKETS.has(m.socket) || !FF[m.form_factor]) continue;
    const ram = m.memory?.ram_type;
    if (ram !== 'DDR4' && ram !== 'DDR5') continue;
    const chipset = (m.chipset || '').replace(/^(AMD|Intel)\s+/, '');
    const socket = m.socket.replace('LGA ', 'LGA');
    const name = m.metadata?.name || '';
    const cands = (bySocket.get(socket) || []).filter((x) => brandOf(x.name) === brandOf(name));
    const hit = bestByContainment(name, cands, 0.9);
    let price, src = 'listed';
    if (hit) price = hit.price;
    else { price = median((byChip.get(chipset) || []).map((x) => x.price)); src = 'est'; }
    if (!price) { tally('mobo', 'dropped'); continue; }
    tally('mobo', src);
    const m2 = (m.m2_slots || []).filter((s) => /pcie/i.test(s.interface || ''));
    const m2Gen = Math.max(0, ...m2.map((s) => Number((s.interface.match(/PCIe (\d)/) || [])[1] || 0)));
    list.push({
      id: shortId(m.opendb_id), cat: 'mobo', brand: m.metadata.manufacturer,
      name: name.replace(new RegExp(`^${m.metadata.manufacturer}\\s+`, 'i'), ''),
      socket, chipset, ff: FF[m.form_factor], mem: ram,
      memSlots: m.memory?.slots, maxRam: m.memory?.max,
      m2Gen: m2Gen || 3, m2Slots: m2.length,
      wifi: Boolean(m.wireless_networking && !/none/i.test(m.wireless_networking)) ? String(m.wireless_networking).split(/\s+Bluetooth/)[0] : false,
      year: m.metadata?.releaseYear,
      tier: MB_TIER[chipset] ?? 2, price: toINR(price), priceSrc: src,
    });
  }
  return list;
}

// ───────────────────────── GPU ─────────────────────────
// [pattern on normalized chipset, tier, reference board power]
const GPU_TABLE = [
  [/rtx 5090/, 5, 575], [/rtx 5080/, 5, 360], [/rtx 4090/, 5, 450], [/rtx 4080/, 5, 320], [/rtx 5070 ti/, 5, 300], [/rx 7900 xtx/, 5, 355],
  [/rtx 5070\b/, 4, 250], [/rtx 4070 ti/, 4, 285], [/rtx 4070 super/, 4, 220], [/rx 9070 xt/, 4, 304], [/rx 9070\b/, 4, 220], [/rx 7900 xt\b/, 4, 315], [/rx 7900 gre/, 4, 260], [/rtx 3090/, 4, 350], [/rtx 3080/, 4, 320], [/rx 6950 xt/, 4, 335], [/rx 6900 xt/, 4, 300],
  [/rtx 4070\b/, 3, 200], [/rtx 5060 ti/, 3, 180], [/rtx 4060 ti/, 3, 165], [/rtx 3070/, 3, 220], [/rx 9060 xt/, 3, 160], [/rx 7800 xt/, 3, 263], [/rx 7700 xt/, 3, 245], [/rx 6800/, 3, 250], [/rx 6750 xt/, 3, 250], [/rx 6700 xt/, 3, 230], [/rtx 2080 ti/, 3, 250],
  [/rtx 5060\b/, 2, 145], [/rtx 4060\b/, 2, 115], [/rtx 3060 ti/, 2, 200], [/rtx 3060\b/, 2, 170], [/rx 7600/, 2, 165], [/rx 6650 xt/, 2, 180], [/rx 6600/, 2, 132], [/arc b580/, 2, 190], [/arc b570/, 2, 150], [/arc a770/, 2, 225], [/arc a750/, 2, 225], [/rtx 5050/, 2, 130], [/rtx 2080/, 2, 215], [/rtx 2070/, 2, 175],
  [/rtx 3050/, 1, 130], [/rtx 2060/, 1, 160], [/gtx 16\d0/, 1, 120], [/rx 6500 xt/, 1, 107], [/rx 6400/, 1, 53], [/arc a580/, 1, 185], [/arc a380/, 1, 75], [/rx 5700/, 1, 225], [/rx 5600/, 1, 150],
];
const gpuInfo = (chip) => { const n = norm(chip); return GPU_TABLE.find(([re]) => re.test(n)) || null; };
const gpuChipKey = (chip) => norm(chip).replace(/\s*\d+gb$/, (m) => m); // keep memory variants distinct
function buildGPUs() {
  const docyx = readDocyx('video-card.json');
  const byChip = group(docyx, (x) => gpuChipKey(x.chipset));
  const list = [];
  for (const g of readDir('GPU')) {
    const info = gpuInfo(g.chipset);
    if (!info || !g.length) continue;
    const name = g.metadata?.name || '';
    const pool = byChip.get(gpuChipKey(g.chipset)) || byChip.get(gpuChipKey(g.chipset).replace(/\s*\d+gb$/, '')) || [];
    const hit = bestByContainment(name, pool.filter((x) => brandOf(x.name) === brandOf(name)), 0.9);
    let price, src = 'listed';
    if (hit) price = hit.price; else { price = median(pool.map((x) => x.price)); src = 'est'; }
    if (!price) { tally('gpu', 'dropped'); continue; }
    tally('gpu', src);
    list.push({
      id: shortId(g.opendb_id), cat: 'gpu', brand: g.metadata.manufacturer,
      name: name.replace(new RegExp(`^${g.metadata.manufacturer}\\s+`, 'i'), '').replace(/\s*\([^)]*\)/g, '').replace(/\s+(Gaming\s+)?Graphics Card.*$/i, '').replace(/\s+(PCI Express|PCIe \d|Video Card).*$/i, '').trim(),
      chip: g.chipset, vram: g.memory, memType: g.memory_type,
      length: g.length, tdp: g.tdp || info[2], slots: g.total_slot_width,
      tier: info[1], price: toINR(price), priceSrc: src,
    });
  }
  return list;
}

// ───────────────────────── RAM ─────────────────────────
function ramTier(type, speed, cap, cl) {
  let t;
  if (type === 'DDR4') t = cap >= 32 ? (speed >= 3600 ? 3 : 2) : 1;
  else t = speed >= 6400 ? 4 : speed >= 6000 ? (cl && cl <= 30 ? 4 : 3) : 2;
  if (cap >= 64) t += 1;
  if (cap <= 16 && type === 'DDR5') t -= 1;
  return clamp(t, 1, 5);
}
function buildRAM() {
  const docyx = readDocyx('memory.json');
  const spec = (type, speed, qty, size, cl) => `${type}|${speed}|${qty}x${size}|${cl}`;
  const bySpec = group(docyx, (x) => spec(`DDR${x.speed?.[0]}`, x.speed?.[1], x.modules?.[0], x.modules?.[1], x.cas_latency));
  const byCap = group(docyx, (x) => `DDR${x.speed?.[0]}|${x.speed?.[1]}|${x.modules?.[0] * x.modules?.[1]}`);
  const seen = new Map();
  for (const r of readDir('RAM')) {
    if (!/DDR[45]/.test(r.ram_type) || r.form_factor !== '288-pin DIMM' || r.registered === 'Registered' || r.ecc === 'ECC') continue;
    if (/\b(Registered|RDIMM|LRDIMM|ECC|Server)\b/i.test(r.metadata?.name || '')) continue; // server modules mislabelled as unbuffered
    const qty = r.modules?.quantity, size = r.modules?.capacity_gb;
    if (![1, 2, 4].includes(qty) || !size || !r.speed) continue;
    const name = r.metadata?.name || '';
    const key = spec(r.ram_type, r.speed, qty, size, r.cas_latency);
    const pool = bySpec.get(key) || [];
    const hit = bestByContainment(name, pool.filter((x) => brandOf(x.name) === brandOf(name)), 0.75);
    let price, src = 'listed';
    if (hit) price = hit.price;
    else { price = median(pool.map((x) => x.price)) ?? median((byCap.get(`${r.ram_type}|${r.speed}|${qty * size}`) || []).map((x) => x.price)); src = 'est'; }
    if (!price) { tally('ram', 'dropped'); continue; }
    // one entry per brand + series + spec (colour variants collapse)
    const dk = `${r.metadata.manufacturer}|${r.metadata.series}|${key}`;
    const prev = seen.get(dk);
    if (prev && (prev.priceSrc === 'listed' || src === 'est')) continue;
    seen.set(dk, {
      id: shortId(r.opendb_id), cat: 'ram', brand: r.metadata.manufacturer,
      name: `${r.metadata.series || ''} ${qty * size}GB (${qty}×${size}GB) ${r.ram_type}-${r.speed}${r.cas_latency ? ' CL' + r.cas_latency : ''}`.trim(),
      type: r.ram_type, speed: r.speed, capacity: qty * size, modules: qty, cl: r.cas_latency, rgb: Boolean(r.rgb),
      tier: ramTier(r.ram_type, r.speed, qty * size, r.cas_latency), price: toINR(price), priceSrc: src,
    });
  }
  const list = [...seen.values()];
  list.forEach((x) => tally('ram', x.priceSrc));
  return list;
}

// ───────────────────────── Storage (SSD) ─────────────────────────
function buildSSDs() {
  const docyx = readDocyx('internal-hard-drive.json').filter((x) => x.type === 'SSD');
  const byCap = group(docyx, (x) => x.capacity);
  const genOf = (iface) => /SATA/i.test(iface) ? 0 : Number((iface.match(/PCIe (\d)/) || [])[1] || 3);
  const byGenCap = group(docyx, (x) => `${genOf(x.interface || '')}|${x.capacity}`);
  const list = [];
  for (const s of readDir('Storage')) {
    if (s.storage_type !== 'SSD') continue;
    const iface = s.interface || '';
    if (!/^(M\.2 PCIe [345]\.0 x4|SATA 6\.0 Gb\/s|M\.2 SATA)$/.test(iface) || !s.capacity || s.capacity < 250) continue;
    const gen = genOf(iface);
    const name = s.metadata?.name || '';
    const pool = (byCap.get(s.capacity) || []).filter((x) => brandOf(x.name) === brandOf(name));
    const hit = bestByContainment(name, pool, 1);
    let price, src = 'listed';
    if (hit) price = hit.price; else { price = median((byGenCap.get(`${gen}|${s.capacity}`) || []).map((x) => x.price)); src = 'est'; }
    if (!price) { tally('ssd', 'dropped'); continue; }
    tally('ssd', src);
    const capLabel = s.capacity >= 1000 ? `${+(s.capacity / 1000).toFixed(1)} TB` : `${s.capacity} GB`;
    list.push({
      id: shortId(s.opendb_id), cat: 'ssd', brand: s.metadata.manufacturer,
      name: name.replace(new RegExp(`^${s.metadata.manufacturer}\\s+`, 'i'), ''),
      iface: gen ? `NVMe Gen${gen}` : (/M\.2/.test(iface) ? 'M.2 SATA' : 'SATA III'), gen,
      formFactor: String(s.form_factor), capacity: capLabel, capacityGB: s.capacity,
      tier: gen === 5 ? (s.capacity >= 2000 ? 5 : 4) : gen === 4 ? (s.capacity >= 2000 ? 4 : 3) : gen === 3 ? 2 : 1,
      price: toINR(price), priceSrc: src,
    });
  }
  return list;
}

// ───────────────────────── PSU ─────────────────────────
function buildPSUs() {
  const docyx = readDocyx('power-supply.json');
  const byWatt = group(docyx, (x) => x.wattage);
  const effKey = (e) => norm(e).replace(/^80 /, '').replace(/^plus /, '') || 'none';
  const byWattEff = group(docyx, (x) => `${x.wattage}|${effKey(x.efficiency)}`);
  const PSU_FF = { ATX: 'ATX', SFX: 'SFX', 'SFX-L': 'SFX-L' };
  const list = [];
  for (const u of readDir('PSU')) {
    const ff = PSU_FF[u.form_factor];
    if (!ff || !u.wattage || u.wattage < 400) continue;
    const name = u.metadata?.name || '';
    const eff = u.efficiency_rating && u.efficiency_rating !== 'None' ? u.efficiency_rating.replace('80+ Standard', '80+').replace('80+ White', '80+') : null;
    const pool = (byWatt.get(u.wattage) || []).filter((x) => brandOf(x.name) === brandOf(name));
    const hit = bestByContainment(name, pool, 1);
    let price, src = 'listed';
    if (hit) price = hit.price;
    else { price = median((byWattEff.get(`${u.wattage}|${effKey(eff)}`) || byWatt.get(u.wattage) || []).map((x) => x.price)); src = 'est'; }
    if (!price) { tally('psu', 'dropped'); continue; }
    tally('psu', src);
    const w = u.wattage;
    list.push({
      id: shortId(u.opendb_id), cat: 'psu', brand: u.metadata.manufacturer,
      name: name.replace(new RegExp(`^${u.metadata.manufacturer}\\s+`, 'i'), ''),
      watt: w, eff, ff, modular: u.modular && u.modular !== 'None' ? u.modular : null, length: u.length || null,
      tier: w < 550 ? 1 : w < 700 ? 2 : w < 850 ? 3 : w < 1000 ? 4 : 5,
      price: toINR(price), priceSrc: src,
    });
  }
  // collapse colour variants
  const dedup = new Map();
  for (const x of list) {
    const k = `${x.brand}|${x.name.replace(/\b(black|white)\b/gi, '').replace(/\s+/g, ' ')}|${x.watt}`;
    const prev = dedup.get(k);
    if (!prev || (prev.priceSrc === 'est' && x.priceSrc === 'listed')) dedup.set(k, x);
  }
  return [...dedup.values()];
}

// ───────────────────────── write ─────────────────────────
let parts = [...buildMobos(), ...buildCPUs(), ...buildGPUs(), ...buildRAM(), ...buildSSDs(), ...buildPSUs()];

// Trim parts nobody will pick for a new build: pre-2020 GPUs, first-gen AM4 chipsets,
// and colour variants of the same GPU (same maker, model and chip — keep one, prefer a listed price).
const before = parts.length;
const LEGACY_GPU = /rtx 20\d0|gtx 16\d0|rx 5[67]00/i;
const LEGACY_MB = new Set(['A320', 'B350', 'X370', 'X470']);
parts = parts.filter((p) => !(p.cat === 'gpu' && LEGACY_GPU.test(p.chip)) && !(p.cat === 'mobo' && LEGACY_MB.has(p.chipset)));
const COLOUR = /\b(black|white|silver|grey|gray|pink|blue|red|green|gold|beige|wood|orange|purple|yellow|snow|frost)\b|\s*\/\s*/gi;
const gpuSeen = new Map();
parts = parts.filter((p) => {
  if (p.cat !== 'gpu') return true;
  const k = `${p.brand}|${norm(p.name.replace(COLOUR, ' '))}|${p.chip}|${p.vram}`;
  const prev = gpuSeen.get(k);
  if (!prev) { gpuSeen.set(k, p); return true; }
  if (prev.priceSrc === 'est' && p.priceSrc === 'listed') { prev._drop = true; gpuSeen.set(k, p); return true; }
  return false;
}).filter((p) => !p._drop);
console.log(`trimmed ${before - parts.length} legacy / duplicate parts`);

// Outlier pass: scalped / stale listings (e.g. a discontinued CPU at 3× MSRP) are replaced by the
// median of comparable parts and marked as estimates.
const peerKey = {
  cpu: (p) => `${p.socket}|${p.tier}`,
  mobo: (p) => p.chipset,
  gpu: (p) => norm(p.chip),
  ram: (p) => `${p.type}|${p.speed}|${p.capacity}`,
  ssd: (p) => `${p.gen}|${p.capacityGB}`,
  psu: (p) => `${p.watt}|${p.eff}`,
};
let fixed = 0;
for (const [cat, fn] of Object.entries(peerKey)) {
  const groups = group(parts.filter((p) => p.cat === cat), fn);
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const med = median(g.map((p) => p.price));
    for (const p of g) if (p.price > med * 2.2 || p.price < med * 0.4) { p.price = Math.round(med / 100) * 100; p.priceSrc = 'est'; fixed++; }
  }
}
console.log(`outlier prices replaced: ${fixed}`);
const order = ['mobo', 'cpu', 'gpu', 'ram', 'ssd', 'psu'];
parts.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.price - b.price);
for (const p of parts) {
  p.name = p.name.split(',')[0]
    .replace(/\s+(Motherboard|Internal Solid State Drive|Solid State Drive|Internal SSD)\b.*$/i, '')
    .replace(/\s+Intel LGA\d+ \(.*$/i, '')
    .replace(/(\b\w+\b)( \1\b)+/g, '$1')
    .replace(/\s+/g, ' ').trim();
  if (p.cat === 'mobo') p.name = p.name.replace(/\s*\(.*$/, '').replace(/\s+Supports\b.*$/i, '').trim();
  for (const k of Object.keys(p)) if (p[k] == null || p[k] === '') delete p[k];
}

const meta = {
  built: new Date().toISOString().slice(0, 10),
  usdInr: USD_INR, indiaFactor: INDIA_FACTOR,
  sources: [
    { name: 'BuildCores OpenDB', url: 'https://github.com/buildcores/buildcores-open-db', license: 'CC BY-NC-SA 4.0', use: 'specs' },
    { name: 'docyx/pc-part-dataset', url: 'https://github.com/docyx/pc-part-dataset', license: 'MIT', use: 'prices (USD, PCPartPicker)' },
  ],
};
// Compact per-category files: field names once, then one array per part.
const outDir = path.join(OUT, 'data');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^\w+\.[0-9a-f]{10}\.json$/.test(f)) fs.unlinkSync(path.join(outDir, f)); // drop stale hashed files
const files = {}, counts = {};
let totalBytes = 0;
for (const cat of order) {
  const list = parts.filter((p) => p.cat === cat);
  const fields = [...new Set(list.flatMap((p) => Object.keys(p)))].filter((k) => k !== 'cat');
  const rows = list.map((p) => {
    const row = fields.map((k) => (p[k] === undefined ? null : p[k]));
    while (row.length && row[row.length - 1] === null) row.pop(); // trailing nulls are implied
    return row;
  });
  const json = JSON.stringify({ cat, fields, rows });
  const hash = crypto.createHash('sha1').update(json).digest('hex').slice(0, 10);
  const name = `${cat}.${hash}.json`;
  fs.writeFileSync(path.join(outDir, name), json);
  files[cat] = `data/${name}`;
  counts[cat] = list.length;
  totalBytes += json.length;
  console.log(`  ${name.padEnd(28)} ${String(list.length).padStart(5)} parts ${(json.length / 1024).toFixed(0).padStart(5)} KB`);
}
fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify({ ...meta, total: parts.length, counts, files }, null, 1));
console.log(`wrote catalog.json + ${order.length} data files: ${parts.length} parts, ${(totalBytes / 1024).toFixed(0)} KB`);
console.table(stats);
