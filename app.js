(() => {
  'use strict';

  const CATS = [
    { key: 'mobo', label: 'Motherboard', major: true },
    { key: 'cpu', label: 'CPU', major: true },
    { key: 'gpu', label: 'GPU' },
    { key: 'ram', label: 'RAM' },
    { key: 'ssd', label: 'SSD' },
    { key: 'psu', label: 'PSU' },
  ];
  const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
  // ───────────────────────── catalogue (lazy) ─────────────────────────
  // catalog.json names one compact, content-hashed file per category. A category is fetched only
  // when needed: parts used by the open list at start-up, a category when its picker opens, and the
  // rest in the background once the page is idle. Hashed files are cached forever by the browser.
  const PARTS = {};      // id → part (from loaded categories, or the saved snapshot below)
  const CATALOG = {};    // cat → [part, …] once loaded
  const SNAP_KEY = 'rig.parts.v1';
  let MANIFEST = null;
  const loading = {};
  let manifestReady = null;
  const getManifest = () => manifestReady || (manifestReady = fetch('catalog.json')
    .then((r) => { if (!r.ok) throw new Error(`catalog.json: HTTP ${r.status}`); return r.json(); })
    .then((m) => (MANIFEST = m))
    .catch((e) => { manifestReady = null; throw e; }));
  function loadCat(cat) {
    if (CATALOG[cat]) return Promise.resolve(CATALOG[cat]);
    return loading[cat] || (loading[cat] = getManifest()
      .then((m) => fetch(m.files[cat]))
      .then((r) => { if (!r.ok) throw new Error(`${cat}: HTTP ${r.status}`); return r.json(); })
      .then(({ fields, rows }) => {
        const list = rows.map((row) => {
          const p = { cat };
          for (let i = 0; i < row.length; i++) if (row[i] !== null) p[fields[i]] = row[i];
          return p;
        });
        for (const p of list) PARTS[p.id] = p;
        CATALOG[cat] = list;
        return list;
      })
      .catch((e) => { delete loading[cat]; throw e; }));
  }
  // Snapshot of the parts used in saved lists, so a returning visitor's build renders instantly.
  try { Object.assign(PARTS, JSON.parse(localStorage.getItem(SNAP_KEY)) || {}); } catch (_) { /* ignore */ }
  const STORE_KEY = 'rig.lists.v1';
  const THEME_KEY = 'rig.theme';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Catalog prices are INR = US street price × USD_INR × INDIA_FACTOR (see scripts/build-catalog.mjs).
  // Other currencies undo the Indian premium and convert the US street price at a fixed approx. rate.
  const CURRENCY_KEY = 'rig.currency';
  const CURRENCIES = {
    INR: { locale: 'en-IN', perUsd: 1 },
    USD: { locale: 'en-US', perUsd: 1 },
    EUR: { locale: 'de-DE', perUsd: 0.87 },
    GBP: { locale: 'en-GB', perUsd: 0.76 },
    CAD: { locale: 'en-CA', perUsd: 1.39 },
    AUD: { locale: 'en-AU', perUsd: 1.53 },
    AED: { locale: 'en-AE', perUsd: 3.67 },
    SGD: { locale: 'en-SG', perUsd: 1.30 },
    JPY: { locale: 'ja-JP', perUsd: 152 },
  };
  let fx = { usdInr: 88, indiaFactor: 1.18 };
  let currency = 'INR';
  try { const c = localStorage.getItem(CURRENCY_KEY); if (CURRENCIES[c]) currency = c; } catch (_) { /* ignore */ }
  const fmtCache = {};
  const money = (n) => {
    const cur = CURRENCIES[currency];
    const v = currency === 'INR' ? n : (n / fx.usdInr / fx.indiaFactor) * cur.perUsd;
    const f = fmtCache[currency] || (fmtCache[currency] = new Intl.NumberFormat(cur.locale, { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }));
    return f.format(Math.round(v));
  };
  const uid = () => Math.random().toString(36).slice(2, 9);

  // ───────────────────────── state ─────────────────────────
  const emptyItems = () => Object.fromEntries(CATS.map((c) => [c.key, null]));
  const newList = (n) => ({ id: uid(), name: `Build ${n}`, items: emptyItems(), excluded: {} });

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.lists) && s.lists.length) {
        s.lists.forEach((l) => {
          l.items = Object.fromEntries(CATS.map((c) => [c.key, (l.items || {})[c.key] || null]));
          l.excluded = Object.fromEntries(CATS.filter((c) => l.excluded && l.excluded[c.key]).map((c) => [c.key, true]));
        });
        if (!s.lists.some((l) => l.id === s.activeId)) s.activeId = s.lists[0].id;
        return s;
      }
    } catch (_) { /* ignore */ }
    const l = newList(1);
    return { lists: [l], activeId: l.id };
  }
  const state = load();
  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      const snap = {};
      for (const l of state.lists) for (const id of Object.values(l.items)) if (id && PARTS[id]) snap[id] = PARTS[id];
      localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
    } catch (_) { /* ignore */ }
  };
  const active = () => state.lists.find((l) => l.id === state.activeId);
  const resolve = (items) => Object.fromEntries(Object.entries(items).map(([k, id]) => [k, id ? PARTS[id] || null : null]));

  // ───────────────────── power ─────────────────────
  const PSU_BRANDS = /^(corsair|seasonic|be quiet|msi|cooler master|thermaltake|nzxt|lian li|asus|super flower|fsp|antec|fractal|evga|gigabyte|deepcool|montech|xpg|adata|silverstone|phanteks)/i;
  // Rough peak draw: CPU package power (~1.35× TDP for boost) + GPU board power + 75 W for the rest.
  const drawOf = (b) => (b.cpu || b.gpu) ? Math.round((b.cpu ? b.cpu.tdp * 1.35 : 65) + (b.gpu ? b.gpu.tdp : 0) + 75) : 0;
  const recPsu = (draw) => Math.max(450, Math.ceil((draw * 1.4) / 50) * 50);

  // ───────────────────── compatibility engine ─────────────────────
  // Returns issues: { level: 'error' | 'warn', parts: [cat…], msg }
  function analyze(b) {
    const out = [];
    const err = (parts, msg) => out.push({ level: 'error', parts, msg });
    const warn = (parts, msg) => out.push({ level: 'warn', parts, msg });
    const { mobo, cpu, gpu, ram, ssd } = b;

    if (cpu && mobo) {
      if (cpu.socket !== mobo.socket) err(['cpu', 'mobo'], `${cpu.name} (${cpu.socket}) won't fit a ${mobo.socket} motherboard.`);
      else if (cpu.tier - mobo.tier >= 3) warn(['cpu', 'mobo'], `${mobo.chipset} board's power delivery will throttle ${cpu.name}.`);
    }
    if (ram && mobo && ram.type !== mobo.mem) err(['ram', 'mobo'], `${mobo.name} takes ${mobo.mem}, not ${ram.type}.`);
    else if (ram && cpu && !mobo && cpu.mem && cpu.mem.length && !cpu.mem.includes(ram.type)) err(['ram', 'cpu'], `${cpu.name} doesn't support ${ram.type}.`);
    if (ram && mobo && ram.capacity > mobo.maxRam) err(['ram', 'mobo'], `Board supports up to ${mobo.maxRam} GB.`);
    if (cpu && gpu) {
      const d = gpu.tier - cpu.tier;
      if (d >= 2) warn(['cpu', 'gpu'], `CPU bottleneck: ${cpu.name} will hold back the ${gpu.name}.`);
      else if (d <= -2) warn(['cpu', 'gpu'], `GPU bottleneck: ${gpu.name} is weak for a ${cpu.name}.`);
    }
    if (ssd && mobo && ssd.gen > mobo.m2Gen) warn(['ssd', 'mobo'], `${ssd.name} will run at Gen${mobo.m2Gen} speed on this board.`);
    const psu = b.psu;
    if (psu && (cpu || gpu)) {
      const draw = drawOf(b);
      const parts = ['psu', ...(cpu ? ['cpu'] : []), ...(gpu ? ['gpu'] : [])];
      if (psu.watt < draw) err(parts, `${psu.watt} W PSU can't power this build (~${draw} W peak).`);
      else if (psu.watt < draw * 1.25) warn(['psu'], `${psu.watt} W leaves little headroom for ~${draw} W peak — ${recPsu(draw)} W recommended.`);
    }
    if (ram && gpu && ram.capacity < 32 && gpu.tier >= 4) warn(['ram', 'gpu'], `${ram.capacity} GB RAM is tight for a ${gpu.name} build — 32 GB recommended.`);
    if (ram && cpu && ram.type === 'DDR4' && cpu.tier >= 4) warn(['ram', 'cpu'], `DDR4 limits ${cpu.name} — DDR5 recommended.`);
    return out;
  }

  // ───────────────────── utilization ─────────────────────
  // Estimates how much of each major part the rest of the build can use. Heuristic, tier-based:
  // tiers 1–5 come from the catalogue (entry → flagship).
  const RES = ['', '1080p (low)', '1080p', '1440p', '1440p high / 4K', '4K'];
  const VRAM_USE = [0, 6, 8, 10, 12, 16]; // GB a game typically fills at that class of settings
  const shortName = (p) => p.name.replace(/\s+(\d+GB|GDDR\d\w*|Black|White|OC Edition|OC)\b.*$/i, '').slice(0, 32);
  const ramSweetSpot = (b) => {
    const { mobo, cpu, ram } = b;
    const socket = (mobo || cpu || {}).socket;
    if (ram.type === 'DDR4') return 3600;
    if (socket === 'AM5') return 6400;
    if (socket === 'LGA1700' || socket === 'LGA1851') return mobo && /^Z/.test(mobo.chipset) ? 7200 : 6400;
    return 6400;
  };

  // RAM a build of this class actually uses: 16 GB for entry builds, 32 GB from mainstream up.
  const ramNeed = (b) => (Math.max(b.cpu ? b.cpu.tier : 0, b.gpu ? b.gpu.tier : 0) >= 3 ? 32 : 16);

  function utilization(b) {
    const { mobo, cpu, gpu, ram, ssd } = b;
    const pct = (v) => Math.max(5, Math.min(100, Math.round(v)));
    const out = [];
    const load = gameLoad(b); // null until both CPU and GPU are picked

    if (gpu) {
      let u = 100; const notes = []; let sub = null;
      if (load) {
        u = load.gpu;
        if (u < 95) notes.push(`${shortName(cpu)} can't feed it fully — the GPU is busy ~${Math.round(u)}% of the time at ${load.res}, expect CPU-limited frame rates.`);
      }
      if (ram && ram.capacity < 16) { u -= 8; notes.push(`${ram.capacity} GB system RAM causes stutter that idles the GPU.`); }
      const cls = cpu ? Math.min(gpu.tier, cpu.tier) : gpu.tier;
      const vramUsed = Math.min(gpu.vram, VRAM_USE[cls]);
      sub = { label: 'VRAM', used: vramUsed, total: gpu.vram, unit: 'GB' };
      if (gpu.vram > VRAM_USE[cls]) notes.push(`~${VRAM_USE[cls]} of ${gpu.vram} GB VRAM used at the ${RES[cls]} settings this ${cpu ? 'build' : 'card'} targets.`);
      else if (gpu.vram < VRAM_USE[gpu.tier]) notes.push(`${gpu.vram} GB VRAM may run short at ${RES[gpu.tier]} — lower texture settings.`);
      if (!cpu) notes.push('Pick a CPU for a full estimate.');
      if (!notes.length) notes.push(ram ? `Well used — the CPU and memory keep up with this card at ${load ? load.res : 'its target resolution'}.` : 'Well used — the CPU keeps up with this card. Add RAM to complete the check.');
      out.push({ key: 'gpu', part: gpu, pct: pct(u), sub, notes });
    }

    if (cpu) {
      let u = 100; const notes = [];
      if (load) {
        u = load.cpu;
        if (u < 90) notes.push(`At ${load.res} the ${gpu.chip} is the limit — the CPU is busy ~${Math.round(u)}% of the time and often waits.`);
      }
      if (cpu.cores >= 16 && (!gpu || gpu.tier <= 4)) { u -= 10; notes.push(`${cpu.cores} cores mostly idle in games; they pay off in rendering and compiling.`); }
      if (mobo && (cpu.tier - mobo.tier >= 3 || (cpu.tdp >= 125 && mobo.tier <= 2))) { u -= Math.max(1, cpu.tier - mobo.tier - 1) * 10; notes.push(`${mobo.chipset} board's power delivery may cap boost clocks.`); }
      if (ram) {
        if (ram.modules === 1) { u -= 12; notes.push('Single RAM stick runs single-channel — up to ~15% slower. Use two sticks.'); }
        if (ram.type === 'DDR4' && cpu.tier >= 4) { u -= 6; notes.push('DDR4 limits this CPU — DDR5 would let it stretch.'); }
        else if (ram.type === 'DDR5' && ram.speed < 5600 && cpu.socket === 'AM5') { u -= 5; notes.push(`DDR5-${ram.speed} is below the AM5 sweet spot (6000).`); }
      }
      if (!gpu) notes.push('Pick a GPU to estimate gaming load.');
      else if (load && load.gpu < 90 && !notes.length) notes.push('Nearly fully used — it is the limiting part in this build.');
      if (!notes.length) notes.push(gpu && mobo && ram ? 'Well matched — the GPU, board and memory let it run at full tilt.' : 'No limits found from the parts picked so far.');
      out.push({ key: 'cpu', part: cpu, pct: pct(u), notes });
    }

    if (mobo) {
      let u = 100; const notes = [];
      if (cpu) {
        const gap = mobo.tier - cpu.tier;
        if (gap >= 2) { u -= (gap - 1) * 15; notes.push(`Premium ${mobo.chipset} VRM and features are more than a ${shortName(cpu)} needs.`); }
        if (cpu.brand === 'Intel' && /^Z/.test(mobo.chipset) && !/\d+K/i.test(cpu.name)) { u -= 20; notes.push(`Z-series overclocking unused — ${shortName(cpu)} is locked.`); }
        if (cpu.brand === 'AMD' && /^X/.test(mobo.chipset) && cpu.tier <= 3) { u -= 10; notes.push('X-chipset extras (more lanes, OC headroom) go unused with this CPU.'); }
      } else notes.push('Pick a CPU for a full estimate.');
      if (ssd && mobo.m2Gen >= 5 && ssd.gen < 5) notes.push(`Gen5 M.2 slot free for a faster drive later (no gaming difference today).`);
      if (ram && mobo.memSlots > ram.modules) notes.push(`${mobo.memSlots - ram.modules} of ${mobo.memSlots} RAM slots free for upgrades.`);
      if (!notes.length) notes.push('Right-sized for this CPU — little paid-for capability left unused.');
      out.push({ key: 'mobo', part: mobo, pct: pct(u), notes });
    }

    if (ram) {
      let u = 100; const notes = [];
      const need = ramNeed(b);
      const usedGB = Math.min(ram.capacity, need);
      if (ram.capacity > need) { u = (need / ram.capacity) * 100; notes.push(`~${need} GB used by games and typical apps; the rest only helps heavy multitasking, video editing or VMs.`); }
      else if (ram.capacity < need) notes.push(`${ram.capacity} GB may run short — ${need} GB suits this build.`);
      if (mobo || cpu) {
        const cap = ramSweetSpot(b);
        if (ram.speed > cap) { u -= Math.min(20, ((ram.speed - cap) / cap) * 100); notes.push(`DDR${ram.type.slice(-1)}-${ram.speed} is past this platform's sweet spot (~${cap}); the extra speed rarely holds.`); }
      }
      if (!cpu && !gpu) notes.push('Pick a CPU or GPU for a full estimate.');
      if (!notes.length) notes.push('Capacity and speed match what this build can use.');
      out.push({ key: 'ram', part: ram, pct: pct(u), sub: { label: 'Capacity', used: usedGB, total: ram.capacity, unit: 'GB' }, notes });
    }

    const order = ['cpu', 'mobo', 'ram', 'gpu'];
    return out.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  }

  // ───────────────────── games / FPS estimates ─────────────────────
  // Relative GPU raster performance, RTX 4060 = 100 (approximate, from public review averages).
  const GPU_PERF = [
    [/rtx 5090/, 400], [/rtx 5080/, 275], [/rtx 5070 ti/, 240], [/rtx 5070/, 195], [/rtx 5060 ti/, 140], [/rtx 5060/, 120], [/rtx 5050/, 85],
    [/rtx 4090/, 320], [/rtx 4080/, 248], [/rtx 4070 ti super/, 210], [/rtx 4070 ti/, 195], [/rtx 4070 super/, 180], [/rtx 4070/, 155], [/rtx 4060 ti/, 120], [/rtx 4060/, 100],
    [/rtx 3090 ti/, 195], [/rtx 3090/, 180], [/rtx 3080 ti/, 175], [/rtx 3080/, 160], [/rtx 3070 ti/, 132], [/rtx 3070/, 125], [/rtx 3060 ti/, 108], [/rtx 3060/, 85], [/rtx 3050/, 60],
    [/rtx 2080 ti/, 125], [/rtx 2080/, 102], [/rtx 2070 super/, 95], [/rtx 2070/, 85], [/rtx 2060/, 72], [/gtx 16\d0/, 52],
    [/rx 9070 xt/, 250], [/rx 9070/, 225], [/rx 9060 xt/, 140], [/rx 7900 xtx/, 260], [/rx 7900 xt\b/, 225], [/rx 7900 gre/, 195], [/rx 7800 xt/, 175], [/rx 7700 xt/, 150],
    [/rx 7600/, 105], [/rx 6950 xt/, 205], [/rx 6900 xt/, 195], [/rx 6800 xt/, 185], [/rx 6800/, 160], [/rx 6750 xt/, 138], [/rx 6700 xt/, 130], [/rx 6650 xt/, 110],
    [/rx 6600 xt/, 105], [/rx 6600/, 90], [/rx 6500 xt/, 45], [/rx 6400/, 38], [/rx 5700/, 92], [/rx 5600/, 75],
    [/arc b580/, 120], [/arc b570/, 105], [/arc a770/, 105], [/arc a750/, 95], [/arc a580/, 85], [/arc a380/, 40],
  ];
  const gpuPerf = (g) => { const n = g.chip.toLowerCase(); const hit = GPU_PERF.find(([re]) => re.test(n)); return hit ? hit[1] : [0, 55, 95, 140, 200, 280][g.tier]; };
  // Relative CPU gaming performance, Ryzen 7 9800X3D = 100.
  const CPU_PERF = {
    '9800X3D': 100, '9950X3D': 98, '9900X3D': 92, '7800X3D': 88, '7950X3D': 89, '7900X3D': 84, '7600X3D': 80, '5800X3D': 68, '5700X3D': 64, '5600X3D': 62,
    '9950X': 84, '9900X': 82, '9700X': 80, '9600X': 77, '9600': 74, '7950X': 80, '7900X': 78, '7900': 76, '7700X': 76, '7700': 74, '7600X': 73, '7600': 71,
    '8700G': 62, '8700F': 66, '8600G': 58, '8500G': 50, '8400F': 60, '5950X': 62, '5900X': 61, '5900XT': 61, '5800X': 60, '5800XT': 60, '5700X': 58, '5700': 52,
    '5600X': 56, '5600XT': 56, '5600T': 55, '5600': 54, '5600G': 48, '5600GT': 48, '5700G': 50, '5500': 47, '5500GT': 45, '4500': 38, '4100': 34,
    '14900KS': 92, '14900K': 90, '14900KF': 90, '14900': 85, '14900F': 85, '13900KS': 90, '13900K': 88, '13900KF': 88, '13900': 83, '13900F': 83,
    '14700K': 86, '14700KF': 86, '14700': 82, '14700F': 82, '13700K': 83, '13700KF': 83, '13700': 79, '13700F': 79, '14600K': 80, '14600KF': 80,
    '13600K': 78, '13600KF': 78, '14500': 72, '13500': 70, '14400': 66, '14400F': 66, '13400': 63, '13400F': 63, '12900KS': 78, '12900K': 76, '12900KF': 76,
    '12900': 73, '12900F': 73, '12700K': 72, '12700KF': 72, '12700': 70, '12700F': 70, '12600K': 68, '12600KF': 68, '12600': 64, '12500': 62, '12400': 58,
    '12400F': 58, '14100': 54, '14100F': 54, '13100': 52, '13100F': 52, '12100': 50, '12100F': 50,
    '285K': 86, '285': 82, '265K': 82, '265KF': 82, '265F': 79, '265': 79, '245K': 76, '245KF': 76, '235': 70, '225': 66, '225F': 66,
  };
  const cpuPerf = (c) => { const m = c.name.match(/(\d{3,5}[A-Z0-9]*)\s*$/); return (m && CPU_PERF[m[1].toUpperCase()]) || [0, 42, 54, 66, 78, 90][c.tier]; };
  // [title, avg fps at 1080p High on RTX 4060, CPU-bound fps on a 9800X3D, VRAM GB needed at 1080p/1440p/4K, engine frame cap]
  const GAMES = [
    ['Cyberpunk 2077', 78, 190, [7, 8, 11]],
    ['Black Myth: Wukong', 55, 160, [7, 8, 10]],
    ['Red Dead Redemption 2', 80, 170, [6, 7, 9]],
    ['Elden Ring', 95, 200, [6, 7, 9], 60],
    ['Hogwarts Legacy', 68, 140, [8, 10, 12]],
    ['Call of Duty: Black Ops 6', 115, 280, [7, 9, 11]],
    ['Forza Horizon 5', 115, 260, [6, 7, 9]],
    ["Baldur's Gate 3", 92, 150, [6, 7, 9]],
    ['Starfield', 52, 115, [7, 8, 10]],
    ['Alan Wake 2', 45, 150, [8, 9, 12]],
    ["Assassin's Creed Shadows", 48, 120, [8, 10, 12]],
    ['Monster Hunter Wilds', 45, 105, [8, 10, 13]],
    ['Kingdom Come: Deliverance II', 72, 150, [7, 8, 10]],
    ['Ghost of Tsushima', 85, 200, [7, 8, 10]],
    ["Marvel's Spider-Man 2", 62, 140, [8, 10, 12]],
  ];
  const RESOLUTIONS = [['1080p', 1], ['1440p', 0.72], ['4K', 0.43]];

  function gameFps(b) {
    const { cpu, gpu, ram } = b;
    if (!cpu || !gpu) return null;
    const gp = gpuPerf(gpu) / 100;
    let cp = cpuPerf(cpu) / 100;
    if (ram && ram.modules === 1) cp *= 0.88;
    if (ram && ram.type === 'DDR4' && cpu.tier >= 4) cp *= 0.95;
    const ramFactor = ram && ram.capacity < 16 ? 0.85 : 1;
    return RESOLUTIONS.map(([res, scale], ri) => {
      const games = GAMES.map(([name, base, cpuCap, vram, cap]) => {
        let g = base * gp * scale;
        const vramShort = gpu.vram < vram[ri];
        if (vramShort) g *= 0.7;
        const c = cpuCap * cp;
        let fps = 1 / Math.cbrt(1 / g ** 3 + 1 / c ** 3); // soft minimum of GPU- and CPU-bound rates
        fps *= ramFactor;
        const capped = cap && fps >= cap;
        if (cap) fps = Math.min(fps, cap);
        fps = fps >= 30 ? Math.round(fps / 5) * 5 : Math.round(fps);
        return { name, fps, capped, vramShort, cpuBound: c < g, g, c, cap };
      }).sort((x, y) => y.fps - x.fps);
      const ok60 = games.filter((x) => x.fps >= 60).length;
      return { res, games, ok60 };
    });
  }
  let gamesRes = null; // user-chosen resolution tab; null = auto
  // Highest resolution where at least 70% of titles hold 60 fps: the resolution this build is made for.
  const bestRes = (data) => { let auto = 0; data.forEach((d, i) => { if (d.ok60 >= GAMES.length * 0.7) auto = i; }); return auto; };
  // How busy the GPU and CPU are across the game list at the build's best-fit resolution.
  // Each game runs at the slower of the GPU-bound and CPU-bound frame rate (and any engine cap),
  // so the faster part waits for the slower one: busy = delivered rate / that part's own rate.
  function gameLoad(b) {
    const data = gameFps(b);
    if (!data) return null;
    const d = data[bestRes(data)];
    let gpu = 0, cpu = 0;
    for (const x of d.games) {
      const fps = Math.min(x.g, x.c, x.cap || Infinity);
      gpu += fps / x.g; cpu += fps / x.c;
    }
    return { res: d.res, gpu: (gpu / d.games.length) * 100, cpu: (cpu / d.games.length) * 100 };
  }

  function renderGames(b) {
    const data = gameFps(b);
    const tabs = $('#resTabs'), list = $('#gamesList'), sum = $('#gamesSummary');
    if (!data) {
      tabs.innerHTML = '';
      sum.textContent = 'Pick a CPU and a GPU to see which games this build runs, and how fast.';
      list.innerHTML = '';
      return;
    }
    // auto: highest resolution where at least 70% of titles hold 60 fps
    const auto = bestRes(data);
    const sel = gamesRes != null ? gamesRes : auto;
    tabs.innerHTML = data.map((d, i) => `<button class="res-tab${i === sel ? ' is-active' : ''}" data-res="${i}" aria-pressed="${i === sel}">${d.res}${i === auto ? ' <span class="res-rec">best fit</span>' : ''}</button>`).join('');
    const d = data[sel];
    const playable = d.games.filter((x) => x.fps >= 30).length;
    sum.innerHTML = `At <strong>${d.res} · High</strong>: <strong>${d.ok60}</strong> of ${GAMES.length} titles at 60+ fps, ${playable} playable (30+ fps).`;
    list.innerHTML = d.games.map((g) => {
      const cls = g.fps >= 60 ? 'g-ok' : g.fps >= 30 ? 'g-mid' : 'g-low';
      const tags = [g.capped ? 'capped' : '', g.vramShort ? 'VRAM-limited' : ''].filter(Boolean).join(', ');
      return `<span class="game ${cls}"><span class="game-name">${esc(g.name)}</span> <span class="game-fps">~${g.fps} fps${tags ? ` (${tags})` : ''}</span></span>`;
    }).join('<span class="game-sep">, </span>');
  }

  const isBottleneck = (i) => i.level === 'warn' && /bottleneck|hold back|throttle|limits/i.test(i.msg);

  function health(issues) {
    const e = issues.filter((i) => i.level === 'error').length;
    const w = issues.length - e;
    return Math.max(0, 100 - e * 34 - w * 14);
  }

  // Rank catalog items for a slot against the rest of the build.
  function rank(cat, list) {
    const b = resolve(list.items);
    const others = { ...b, [cat]: null };
    const anchor = others.cpu || others.mobo; // major item that drives suggestions
    const smart = Boolean(anchor);
    const anchorTier = others.cpu ? others.cpu.tier : others.mobo ? others.mobo.tier : null;

    const rows = (CATALOG[cat] || []).map((p, i) => {
      const trial = { ...others, [cat]: p };
      const iss = analyze(trial).filter((x) => x.parts.includes(cat));
      const E = iss.filter((x) => x.level === 'error').length;
      const W = iss.length - E;
      let score = 100 - E * 50 - W * 18;
      // Agree with the Utilization card: penalise picks that leave any part under-used.
      if (smart) for (const u of utilization(trial)) score -= (100 - u.pct) * 0.35;
      // Sensible defaults the compatibility rules don't cover.
      if (cat === 'ram') {
        const need = ramNeed(trial);
        if (p.capacity < need) score -= 25 * Math.log2(need / p.capacity);
        if (p.modules === 4) score -= 4;                                  // 4 sticks are harder to run at rated speed
        if (p.speed < (p.type === 'DDR5' ? 5200 : 3200)) score -= 8;      // JEDEC/server speeds
      }
      if (cat === 'ssd') { if (p.capacityGB < 1000) score -= p.capacityGB < 500 ? 25 : 12; if (!p.gen) score -= 6; if (/22(30|42)/.test(p.formFactor || '')) score -= 3; }
      if (cat === 'gpu' && p.vram < VRAM_USE[p.tier]) score -= 10;       // card too short on VRAM for its class
      if (cat === 'psu' && p.ff !== 'ATX') score -= 3;
      if (cat === 'psu') {
        const d = drawOf(others);
        if (d) score -= Math.abs(p.watt - recPsu(d)) / 50 * 4; // closest to recommended wattage
        if (/gold|platinum|titanium/i.test(p.eff || '')) score += 2;
        if (PSU_BRANDS.test(p.brand)) score += 3; // established PSU makers first
      } else if (anchorTier != null) score -= Math.abs(p.tier - anchorTier) * 6;
      if (p.priceSrc === 'listed') score += 1; // prefer parts with a real listed price on ties
      return { p, iss, E, W, score, i };
    });
    if (smart) rows.sort((a, b2) => b2.score - a.score || a.p.price - b2.p.price);
    let best = 0;
    rows.forEach((r) => { r.best = smart && r.E === 0 && r.W === 0 && best++ < 3; });
    return { rows, smart };
  }

  // ───────────────────── display helpers ─────────────────────
  function summary(p) {
    switch (p.cat) {
      case 'mobo': return `${p.socket} · ${p.chipset} · ${p.ff} · ${p.mem}`;
      case 'cpu': return `${p.socket} · ${p.cores}C/${p.threads}T · ${p.boost} GHz`;
      case 'gpu': return `${p.vram} GB ${p.memType || ''} · ${p.length} mm · ${p.tdp} W`;
      case 'ram': return `${p.type}-${p.speed}${p.cl ? ' · CL' + p.cl : ''} · ${p.modules || 2} sticks`;
      case 'ssd': return `${p.iface} · ${p.capacity}`;
      case 'psu': return `${p.watt} W · ${p.eff || 'Unrated'} · ${p.ff}`;
      default: return '';
    }
  }
  function details(p) {
    switch (p.cat) {
      case 'mobo': return [['Socket', p.socket], ['Chipset', p.chipset], ['Form factor', p.ff], ['Memory', `${p.mem}${p.memSlots ? ` · ${p.memSlots} slots` : ''}${p.maxRam ? ` · up to ${p.maxRam} GB` : ''}`], ['M.2', p.m2Slots ? `${p.m2Slots}× up to PCIe Gen${p.m2Gen}` : '—'], ['Wi-Fi', p.wifi || 'No']];
      case 'cpu': return [['Socket', p.socket], ['Cores / threads', `${p.cores} / ${p.threads}`], ['Clock', p.base ? `${p.base} – ${p.boost} GHz` : `${p.boost} GHz`], ['TDP', `${p.tdp} W`], ['Memory', (p.mem || []).join(', ') || '—'], ['Integrated GPU', p.igpu ? 'Yes' : 'No'], ['Cooler in box', p.cooler ? 'Yes' : 'No']];
      case 'gpu': return [['Chip', p.chip], ['VRAM', `${p.vram} GB ${p.memType || ''}`], ['Length', `${p.length} mm`], ['Thickness', p.slots ? `${p.slots} slots` : '—'], ['Board power', `${p.tdp} W`]];
      case 'ram': return [['Type', p.type], ['Speed', `${p.speed} MT/s`], ['Capacity', `${p.capacity} GB`], ['Kit', `${p.modules || 2} × ${p.capacity / (p.modules || 2)} GB`], ['Latency', p.cl ? `CL${p.cl}` : '—'], ['RGB', p.rgb ? 'Yes' : 'No']];
      case 'ssd': return [['Interface', p.iface], ['Capacity', p.capacity], ['Form factor', p.formFactor || '—']];
      case 'psu': return [['Wattage', `${p.watt} W`], ['Efficiency', p.eff || 'Unrated'], ['Form factor', p.ff], ['Modular', p.modular || '—'], ['Length', p.length ? `${p.length} mm` : '—']];
      default: return [];
    }
  }
  const tierLabel = (t) => ['', 'Entry', 'Value', 'Mainstream', 'Performance', 'Flagship'][t];

  // ───────────────────────── render ─────────────────────────
  function render() {
    $('#priceNote').textContent = currency === 'INR' ? 'Prices in INR, approx.' : `Prices in ${currency}, approx. (US street)`;
    renderTabs();
    renderSlots();
    renderAside();
  }

  function renderTabs() {
    $('#tabs').innerHTML = state.lists.map((l) => {
      const n = Object.values(l.items).filter(Boolean).length;
      return `<button class="tab${l.id === state.activeId ? ' is-active' : ''}" data-tab="${l.id}" role="tab" aria-selected="${l.id === state.activeId}">
        <span class="tab-name">${esc(l.name)}</span><span class="tab-count">${n}/${CATS.length}</span></button>`;
    }).join('') + `<button class="tab tab-add" id="addList" title="Add another list"><span class="plus-box" aria-hidden="true"></span>New list</button>`;
  }

  function renderSlots() {
    const l = active();
    $('#listName').value = l.name;
    const b = resolve(l.items);
    const issues = analyze(b);
    const noAnchor = !b.mobo && !b.cpu;

    const ex = l.excluded || {};
    const ownBox = (c) => `<label class="slot-own" title="I already have a compatible ${c.label} — leave it out of the total">
        <input type="checkbox" data-own="${c.key}"${ex[c.key] ? ' checked' : ''}> Don't include</label>`;
    $('#slots').innerHTML = CATS.map((c, i) => {
      const p = b[c.key];
      const num = String(i + 1).padStart(2, '0');
      if (!p) {
        const hint = c.major && noAnchor && !ex[c.key] ? '<span class="slot-hint">Start here</span>' : '';
        return `<div class="slot is-empty${ex[c.key] ? ' is-excluded' : ''}" data-slot="${c.key}" data-cat="${c.key}" tabindex="0" role="button" aria-label="Add ${c.label}">
          <span class="slot-top"><span class="slot-num">${num}</span><span class="slot-label">${c.label}</span>${hint}</span>
          <span class="plus-box lg" aria-hidden="true"></span>
          <span class="slot-cta">${ex[c.key] ? `Already have one — not included` : `Add ${c.label}`}</span>
          <span class="slot-foot">${ownBox(c)}</span>
        </div>`;
      }
      const mine = issues.filter((x) => x.parts.includes(c.key));
      const st = mine.some((x) => x.level === 'error') ? 'bad' : mine.length ? 'warn' : 'ok';
      return `<div class="slot is-filled st-${st}${ex[c.key] ? ' is-excluded' : ''}" data-slot="${c.key}" data-cat="${c.key}" data-tip="${p.id}" tabindex="0" role="button" aria-label="Change ${c.label}">
        <span class="slot-top"><span class="slot-num">${num}</span><span class="slot-label">${c.label}</span><span class="dot" title="${st === 'ok' ? 'Compatible' : st === 'warn' ? esc(mine[0].msg) : 'Incompatible: ' + esc(mine.find((x) => x.level === 'error').msg)}"></span></span>
        <span class="slot-brand">${esc(p.brand)}</span>
        <span class="slot-name">${esc(p.name)}</span>
        <span class="slot-spec">${esc(summary(p))}</span>
        <span class="slot-foot"><span class="slot-price">${money(p.price)}</span>${ex[c.key] ? '<span class="owned-tag">Owned</span>' : ''}<button class="slot-x" data-remove="${c.key}" aria-label="Remove ${c.label}">×</button></span>
        <span class="slot-foot slot-foot-own">${ownBox(c)}</span>
      </div>`;
    }).join('');
  }

  function renderAside() {
    const l = active();
    const b = resolve(l.items);
    const issues = analyze(b);
    const ex = l.excluded || {};
    const filled = CATS.filter((c) => b[c.key]).length;
    const done = CATS.filter((c) => b[c.key] || ex[c.key]).length; // owned-but-unlisted parts count as done
    const pct = Math.round((done / CATS.length) * 100);
    const h = health(issues);
    const errs = issues.filter((i) => i.level === 'error').length;

    let status;
    if (!filled) status = 'Awaiting parts';
    else if (errs) status = `${errs} conflict${errs > 1 ? 's' : ''} found`;
    else if (issues.length) status = issues.some(isBottleneck) ? 'Bottleneck risk' : `${issues.length} warning${issues.length > 1 ? 's' : ''} to review`;
    else if (done === CATS.length) status = 'Perfectly balanced';
    else status = 'All compatible so far';

    // hue 0 (red) → 135 (green)
    const hue = filled ? Math.round((h / 100) * 135) : 135;
    const meter = $('#meter');
    meter.style.setProperty('--hue', hue);
    $('#meterFill').style.width = pct + '%';
    $('#meterStatus').textContent = status;
    $('#meterScore').textContent = filled ? `${h}/100` : '—';
    $('#meterPct').textContent = `Setup ${pct}% complete`;
    meter.setAttribute('aria-valuenow', pct);
    meter.setAttribute('aria-valuetext', `Setup ${pct}% complete, ${status}`);

    $('#issues').innerHTML = issues.length
      ? issues.map((i) => `<li class="issue ${i.level}"><span class="issue-mark">${i.level === 'error' ? '✕' : '!'}</span><span>${esc(i.msg)}</span></li>`).join('')
      : filled ? '<li class="issue good"><span class="issue-mark">✓</span><span>No conflicts or bottlenecks detected.</span></li>' : '';

    const total = CATS.reduce((s, c) => s + (b[c.key] && !ex[c.key] ? b[c.key].price : 0), 0);
    const saved = CATS.reduce((s, c) => s + (b[c.key] && ex[c.key] ? b[c.key].price : 0), 0);
    $('#partsBody').innerHTML = CATS.map((c) => {
      const p = b[c.key];
      if (ex[c.key]) {
        return `<tr class="is-excluded" data-cat="${c.key}"${p ? ` data-tip="${p.id}"` : ''}><th scope="row">${c.label}</th><td class="t-name">${p ? esc(p.name) : 'Already have one'}</td><td class="t-price">${p ? `<s>${money(p.price)}</s> ` : ''}<span class="owned-tag">Owned</span></td></tr>`;
      }
      return p
        ? `<tr data-tip="${p.id}" data-cat="${c.key}"><th scope="row">${c.label}</th><td class="t-name">${esc(p.name)}</td><td class="t-price">${money(p.price)}</td></tr>`
        : `<tr class="is-empty" data-cat="${c.key}"><th scope="row">${c.label}</th><td class="t-name">—</td><td class="t-price">—</td></tr>`;
    }).join('');
    $('#partsSaved').textContent = saved ? `Not included (already owned): ${money(saved)}` : '';
    $('#partsTotal').textContent = money(total);

    renderGames(b);

    // utilization
    const util = utilization(b);
    const uhue = (v) => Math.round(Math.max(0, Math.min(1, (v - 40) / 60)) * 135);
    const avg = util.length ? Math.round(util.reduce((s2, x) => s2 + x.pct, 0) / util.length) : null;
    $('#utilScore').textContent = avg == null ? '—' : `${avg}% avg`;
    $('#mbarUtil').textContent = avg == null ? 'utilization —' : `utilization ${avg}% avg`;
    $('#util').innerHTML = util.length ? util.map((x) => `
      <li class="util-row" data-cat="${x.key}" data-tip="${x.part.id}">
        <div class="util-top"><span class="util-label">${CAT[x.key].label}</span><span class="util-name">${esc(shortName(x.part))}</span><span class="util-pct">${x.pct}%</span></div>
        <div class="util-bar" style="--hue:${uhue(x.pct)}"><span style="width:${x.pct}%"></span></div>
        ${x.sub ? `<div class="util-sub">${x.sub.label}: ~${x.sub.used} of ${x.sub.total} ${x.sub.unit} used</div>` : ''}
        <ul class="util-notes">${x.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </li>`).join('')
      : '<li class="util-empty">Add a CPU, motherboard, RAM or GPU to see how well each part is used.</li>';

    // compact sticky summary for small screens
    $('#mbarMeter').style.setProperty('--hue', hue);
    $('#mbarFill').style.width = pct + '%';
    $('#mbarPct').innerHTML = `<span class="mbar-word">Setup </span>${pct}% complete`;
    $('#mbarScore').innerHTML = filled ? `<span class="mbar-word">compatibility </span>${h}/100${errs ? ` · ${errs} conflict${errs > 1 ? 's' : ''}` : ''}` : 'no parts yet';
    $('#mbarTotal').textContent = money(total);
    $('#mbarPrices').innerHTML = CATS.map((c) => {
      const p = b[c.key];
      const price = ex[c.key] ? 'Owned' : p ? money(p.price) : '—';
      return `<div class="mbar-cell${p && !ex[c.key] ? '' : ' is-empty'}${ex[c.key] ? ' is-excluded' : ''}" data-cat="${c.key}"${p ? ` data-tip="${p.id}"` : ''}>
        <span class="mbar-cell-label">${c.label}</span><span class="mbar-cell-price">${price}</span></div>`;
    }).join('');

    const draw = drawOf(b);
    $('#power').textContent = draw
      ? `Est. peak draw ~${draw} W · ${b.psu ? `PSU ${b.psu.watt} W (${Math.round((draw / b.psu.watt) * 100)}% load)` : `suggested PSU ${recPsu(draw)} W`}`
      : '';
  }

  // ───────────────────────── picker ─────────────────────────
  let pickerCat = null;
  const PAGE = 60;

  function openPicker(cat) {
    pickerCat = cat;
    ranked = null;
    limit = PAGE;
    $('#pickerTitle').textContent = `Choose ${CAT[cat].label}`;
    $('#pickerSearch').value = '';
    const plural = cat === 'cpu' ? 'CPUs' : CAT[cat].label + 's';
    const n = MANIFEST ? MANIFEST.counts[cat].toLocaleString('en-IN') + ' ' : '';
    $('#pickerSearch').placeholder = `Search ${n}${plural} — e.g. brand, model, socket…`;
    $('#picker').hidden = false;
    document.body.classList.add('no-scroll');
    setTimeout(() => $('#pickerSearch').focus(), 20);
    if (CATALOG[cat]) { renderPicker(); return; }
    $('#pickerHint').textContent = '';
    $('#pickerList').innerHTML = `<p class="empty loading">Loading ${plural}…</p>`;
    loadCat(cat).then(() => {
      if (pickerCat !== cat) return;
      $('#pickerSearch').placeholder = `Search ${MANIFEST.counts[cat].toLocaleString('en-IN')} ${plural} — e.g. brand, model, socket…`;
      ranked = null;
      renderPicker();
    }).catch(() => {
      if (pickerCat !== cat) return;
      $('#pickerList').innerHTML = `<p class="empty">Couldn't load the ${plural}. Check your connection and <button class="more" data-retry="${cat}">try again</button>.</p>`;
    });
  }
  function closePicker() {
    $('#picker').hidden = true;
    document.body.classList.remove('no-scroll');
    hideTip();
    pickerCat = null;
  }

  let ranked = null;
  let limit = PAGE;
  function renderPicker(keepScroll) {
    const l = active();
    const q = $('#pickerSearch').value.trim().toLowerCase();
    if (!ranked) {
      ranked = rank(pickerCat, l);
      // words of brand, name, chip and specs; search terms must match the start of a word ("ti" ≠ "edi-ti-on")
      ranked.rows.forEach((r) => { r.hay = ' ' + `${r.p.brand} ${r.p.name} ${r.p.chip || ''} ${summary(r.p)}`.toLowerCase().replace(/[^a-z0-9.+]+/g, ' '); });
    }
    const { rows, smart } = ranked;
    const terms = q.replace(/[^a-z0-9.+]+/g, ' ').split(' ').filter(Boolean);
    const match = (r) => terms.every((t) => r.hay.includes(' ' + t));
    const current = l.items[pickerCat];

    const b = resolve(l.items);
    let hint;
    if (smart) {
      const a = pickerCat === 'cpu' ? b.mobo : pickerCat === 'mobo' ? b.cpu : b.cpu || b.mobo;
      hint = `Suggestions tuned to your <strong>${esc(a.name)}</strong>.`;
    } else {
      hint = CAT[pickerCat].major
        ? 'Pick this first — the rest of the list will suggest matching parts.'
        : 'Tip: choose a Motherboard or CPU first to get compatibility-ranked suggestions.';
    }
    $('#pickerHint').innerHTML = hint;

    const row = (r) => {
      let badge = '';
      if (r.E) badge = '<span class="badge bad">Incompatible</span>';
      else if (r.W) badge = `<span class="badge warn">${r.iss.some(isBottleneck) ? 'Bottleneck risk' : 'Warning'}</span>`;
      else if (r.best) badge = '<span class="badge best">Best match</span>';
      else if (smart) badge = '<span class="badge ok">Compatible</span>';
      const reason = r.iss.length ? `<span class="row-reason">${esc(r.iss[0].msg)}</span>` : '';
      return `<li><button class="row${r.p.id === current ? ' is-current' : ''}${r.E ? ' is-bad' : ''}" data-pick="${r.p.id}" data-tip="${r.p.id}" data-cat="${r.p.cat}">
        <span class="row-ava" aria-hidden="true">${esc(r.p.brand[0])}</span><span class="row-main"><span class="row-brand">${esc(r.p.brand)} · ${tierLabel(r.p.tier)}</span><span class="row-name">${esc(r.p.name)}</span><span class="row-spec">${esc(summary(r.p))}</span>${reason}</span>
        <span class="row-side">${badge}<span class="row-price">${money(r.p.price)}</span></span>
      </button></li>`;
    };

    const visible = rows.filter(match);
    const more = (n) => n > limit
      ? `<button class="more" data-more>Show more · ${Math.min(PAGE, n - limit)} of ${(n - limit).toLocaleString('en-IN')} remaining</button>` : '';
    let html = '';
    if (!visible.length) html = `<p class="empty">No ${esc(CAT[pickerCat].label)} matches “${esc(q)}”.</p>`;
    else if (smart && !q) {
      const best = visible.filter((r) => r.best);
      const rest = visible.filter((r) => !r.best);
      if (best.length) html += `<h3 class="group">Recommended for this build</h3><ul class="rows">${best.map(row).join('')}</ul>`;
      html += `<h3 class="group">All ${esc(CAT[pickerCat].label)} options · ${rest.length.toLocaleString('en-IN')}</h3><ul class="rows">${rest.slice(0, limit).map(row).join('')}</ul>${more(rest.length)}`;
    } else html = `<h3 class="group">${visible.length.toLocaleString('en-IN')} result${visible.length === 1 ? '' : 's'}</h3><ul class="rows">${visible.slice(0, limit).map(row).join('')}</ul>${more(visible.length)}`;
    const list = $('#pickerList');
    const top = list.scrollTop;
    list.innerHTML = html;
    list.scrollTop = keepScroll ? top : 0;
  }

  function pick(id) {
    const l = active();
    l.items[pickerCat] = id;
    save();
    closePicker();
    render();
  }

  // ───────────────────────── tooltip ─────────────────────────
  const tip = $('#tip');
  let tipFor = null;
  function showTip(id, x, y) {
    const p = PARTS[id];
    if (!p) return;
    if (tipFor !== id) {
      tipFor = id;
      tip.dataset.cat = p.cat;
      tip.innerHTML = `<div class="tip-head"><span class="tip-cat">${CAT[p.cat].label} · ${tierLabel(p.tier)}</span><span class="tip-brand">${esc(p.brand)}</span><strong class="tip-name">${esc(p.name)}</strong></div>
        <dl class="tip-specs">${details(p).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="tip-price"><span>${p.priceSrc === 'listed' ? 'Approx. price' : 'Est. price (similar parts)'}</span><strong>${money(p.price)}</strong></div>`;
    }
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 18, top = y + 18;
    if (left + r.width > innerWidth - 12) left = x - r.width - 18;
    if (top + r.height > innerHeight - 12) top = innerHeight - r.height - 12;
    tip.style.transform = `translate(${Math.max(12, left)}px, ${Math.max(12, top)}px)`;
  }
  function hideTip() { tip.hidden = true; tip.classList.remove('is-sheet'); tipFor = null; }

  // Touch: press and hold a part to see its details as a bottom sheet.
  let pressTimer = null, pressStart = null, suppressClick = false;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (!tip.hidden && !e.target.closest('#tip')) { hideTip(); }
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      showTip(el.dataset.tip, 0, 0);
      tip.classList.add('is-sheet');
      tip.style.transform = '';
      if (navigator.vibrate) navigator.vibrate(10);
    }, 450);
  });
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  document.addEventListener('pointermove', (e) => {
    if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  });
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-tip]') && e.pointerType !== 'mouse' && !canHoverNow()) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
  const canHoverNow = () => matchMedia('(hover: hover)').matches;


  const canHover = matchMedia('(hover: hover)').matches;
  document.addEventListener('mousemove', (e) => {
    if (!canHover) return;
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el.dataset.tip, e.clientX, e.clientY);
    else if (!tip.hidden) hideTip();
  });
  document.addEventListener('scroll', () => { if (!tip.classList.contains('is-sheet')) hideTip(); }, true);

  // ───────────────────────── theme ─────────────────────────
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $('#themeLabel').textContent = t === 'retro' ? 'Classic mode' : 'Retro mode';
    $('#themeBtn').setAttribute('aria-pressed', t === 'retro');
    try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* ignore */ }
  }
  let theme = 'classic';
  try { theme = localStorage.getItem(THEME_KEY) === 'retro' ? 'retro' : 'classic'; } catch (_) { /* ignore */ }

  // ───────────────────────── events ─────────────────────────
  document.addEventListener('change', (e) => {
    if (e.target.id === 'currencySel') {
      currency = e.target.value;
      try { localStorage.setItem(CURRENCY_KEY, currency); } catch (_) { /* ignore */ }
      render();
      if (!$('#picker').hidden) renderPicker(true);
      return;
    }
    const own = e.target.closest && e.target.closest('[data-own]');
    if (!own) return;
    const l = active();
    l.excluded = l.excluded || {};
    if (own.checked) l.excluded[own.dataset.own] = true; else delete l.excluded[own.dataset.own];
    save(); render();
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.slot-own')) return; // let the checkbox toggle without opening the picker
    const rm = t.closest('[data-remove]');
    if (rm) { active().items[rm.dataset.remove] = null; save(); render(); return; }
    const slot = t.closest('[data-slot]');
    if (slot) { openPicker(slot.dataset.slot); return; }
    const pk = t.closest('[data-pick]');
    if (pk) { pick(pk.dataset.pick); return; }
    const tab = t.closest('[data-tab]');
    if (tab) { state.activeId = tab.dataset.tab; save(); render(); return; }
    if (t.closest('#addList')) {
      let n = state.lists.length + 1;
      while (state.lists.some((l) => l.name === `Build ${n}`)) n++;
      const l = newList(n);
      state.lists.push(l);
      state.activeId = l.id;
      save(); render();
      return;
    }
    if (t.closest('#clearList')) {
      active().items = emptyItems(); active().excluded = {}; save(); render(); return;
    }
    if (t.closest('#deleteList')) {
      const l = active();
      if (!confirm(`Delete “${l.name}”? This can't be undone.`)) return;
      state.lists = state.lists.filter((x) => x.id !== l.id);
      if (!state.lists.length) state.lists.push(newList(1));
      state.activeId = state.lists[0].id;
      save(); render(); return;
    }
    if (t.closest('#themeBtn')) { setTheme(document.documentElement.dataset.theme === 'retro' ? 'classic' : 'retro'); return; }
    const rt = t.closest('[data-res]');
    if (rt) { gamesRes = Number(rt.dataset.res); renderAside(); return; }
    const retry = t.closest('[data-retry]');
    if (retry) { openPicker(retry.dataset.retry); return; }
    if (t.closest('[data-more]')) { limit += PAGE; renderPicker(true); return; }
    if (t.closest('[data-close]')) closePicker();
  });

  document.addEventListener('keydown', (e) => {
    if (!$('#picker').hidden) {
      if (e.key === 'Escape') closePicker();
      if (e.key === 'Enter' && e.target.id === 'pickerSearch') {
        const first = $('#pickerList [data-pick]:not(.is-bad)') || $('#pickerList [data-pick]');
        if (first) pick(first.dataset.pick);
      }
      return;
    }
    const slot = e.target.closest && e.target.closest('.slot');
    if (slot && e.target === slot && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPicker(slot.dataset.slot); }
  });

  $('#pickerSearch').addEventListener('input', () => { limit = PAGE; renderPicker(); });
  $('#listName').addEventListener('input', (e) => {
    active().name = e.target.value.trim() || 'Untitled build';
    save(); renderTabs();
  });

  setTheme(theme);
  $('#currencySel').value = currency;
  render(); // instant, from the saved snapshot

  // Then fetch what the open list needs, refresh with current data, and warm the rest when idle.
  getManifest().then((meta) => {
    if (meta.usdInr && meta.indiaFactor) { fx = { usdInr: meta.usdInr, indiaFactor: meta.indiaFactor }; render(); }
    $('#catalogInfo').textContent = `${meta.total.toLocaleString('en-IN')} parts · built ${meta.built} · ₹ = US$ × ${meta.usdInr} × ${meta.indiaFactor}.`;
    const needed = CATS.filter((c) => state.lists.some((l) => l.items[c.key])).map((c) => c.key);
    return Promise.all(needed.map(loadCat)).then(() => { render(); save(); });
  }).catch(() => { /* offline: the snapshot keeps the page usable; pickers show a retry */ })
    .finally(() => {
      const idle = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 1500 }) : (fn) => setTimeout(fn, 300);
      const order = ['cpu', 'mobo', 'gpu', 'ram', 'ssd', 'psu'];
      const next = () => { const c = order.find((k) => !CATALOG[k] && !loading[k]); if (c) loadCat(c).then(() => idle(next), () => {}); };
      idle(next);
    });
})();
