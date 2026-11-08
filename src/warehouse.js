// Warehouse slotting and order picking in a parallel-aisle pick area.
// Pure logic, no DOM. Every random draw comes from the seed, so a config always gives the same day.
//
// Coordinates are meters. x runs across the aisles, y runs along them, away from the depot.
// The front cross aisle is y = 0 and the depot sits on it. A picker walks the center line of an
// aisle and picks from both rack faces, so a pick location is (aisle, y).

// ---------------------------------------------------------------------------
// Constants

export const AISLE_W = 3.0; // m, picking aisle width
export const RACK_D = 1.1; // m, rack depth per side, racks stand back to back between aisles
export const PITCH = AISLE_W + 2 * RACK_D; // m between aisle center lines
export const BAY_W = 1.3; // m of aisle per bay
export const CROSS_W = 3.0; // m, cross aisle width
export const SETUP_SEC = 60; // per trip: take a cart, scan the pick list, drop totes at packing
export const SORT_SEC = 3; // per line when a cart carries several orders: put the item in the right tote
export const CONSOL_SEC = 30; // per order picked in more than one zone: merge the totes at packing
export const WAVE = 250; // orders released together; batches never mix waves
export const MAX_EXACT = 12; // distinct locations up to which the exact route is computed
export const NEIGHBORS = 30; // candidate partners per order for savings batching

// Pick levels from the floor up. Golden zone is waist to shoulder height.
export const LEVELS = [
  { name: "Floor", h: "0 to 0.5 m", ergo: 0.6, extra: 5, cap: 150 },
  { name: "Golden, low", h: "0.6 to 1.1 m", ergo: 1.0, extra: 0, cap: 60 },
  { name: "Golden, high", h: "1.1 to 1.6 m", ergo: 0.95, extra: 1, cap: 60 },
  { name: "High", h: "1.6 to 2.1 m", ergo: 0.55, extra: 6, cap: 60 },
  { name: "Top", h: "2.1 to 2.6 m", ergo: 0.35, extra: 9, cap: 60 },
];
export const SMALL_CAP = 60; // liters, every level above the floor
export const COVER_DAYS = 1; // pick faces hold a day of stock and are replenished overnight

export const SLOTTINGS = {
  random: { label: "Random", note: "each SKU in a random free slot that fits, the baseline many sites drift to" },
  abc: { label: "ABC by velocity", note: "A (top 20% by lines) in the closest slots and the golden zone, then B, then C" },
  coi: { label: "Cube per order index", note: "slot volume needed divided by lines per day, smallest first: small fast movers win" },
  affinity: { label: "Affinity", note: "SKUs often ordered together clustered from the co-order graph and placed side by side, densest clusters first" },
};

export const HEURISTICS = {
  sshape: { label: "S-shape", note: "every aisle with a pick is walked end to end" },
  return: { label: "Return", note: "enter each aisle from the front, turn at the farthest pick" },
  midpoint: { label: "Midpoint", note: "first and last aisle walked through, others entered from the nearer half" },
  lgap: { label: "Largest gap", note: "first and last aisle walked through, others entered from both ends, skipping the largest gap" },
  combined: { label: "Combined", note: "aisle by aisle, walk through or turn back, chosen by dynamic programming" },
};

export const BATCHING = {
  single: { label: "Single order", note: "one order per trip" },
  seed: { label: "Seed batching", note: "seed with the order that reaches deepest, then add the orders that need the fewest new aisles" },
  savings: { label: "Savings batching", note: "Clarke-Wright: merge the order pairs whose combined route saves the most" },
  zone: { label: "Zone picking", note: "each picker stays in a group of aisles, totes ride a conveyor to packing" },
};

export const DEFAULTS = {
  aisles: 16, bays: 26, levels: 4, cross: 0, depot: "left", skus: 3000, orders: 5000, aff: 40, seed: 7,
  slot: "abc", route: "lgap", batch: "single", n: 6, zones: 4, speed: 0.9, pickSec: 10,
};
const LIMITS = {
  aisles: [4, 30, 0], bays: [10, 40, 0], levels: [2, 5, 0], cross: [0, 1, 0], skus: [300, 5000, 0], orders: [500, 10000, 0],
  aff: [0, 80, 0], seed: [1, 99999, 0], n: [1, 12, 0], zones: [2, 6, 0], speed: [0.5, 1.5, 1], pickSec: [4, 30, 0],
};
export const DEPOTS = { left: "Front left", center: "Front center" };

// ---------------------------------------------------------------------------
// Randomness

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100; // cm, so positions compare exactly

// ---------------------------------------------------------------------------
// Config

export function clamp(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!DEPOTS[c.depot]) c.depot = DEFAULTS.depot;
  if (!SLOTTINGS[c.slot]) c.slot = DEFAULTS.slot;
  if (!HEURISTICS[c.route]) c.route = DEFAULTS.route;
  if (!BATCHING[c.batch]) c.batch = DEFAULTS.batch;
  for (const [k, [lo, hi, dp]] of Object.entries(LIMITS)) {
    let v = Number(c[k]);
    if (!Number.isFinite(v)) v = DEFAULTS[k];
    const f = 10 ** dp;
    c[k] = Math.round(Math.min(hi, Math.max(lo, v)) * f) / f;
  }
  for (const k of Object.keys(c)) if (!(k in DEFAULTS)) delete c[k];
  return c;
}

export function encodeConfig(cfg) {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) if (cfg[k] !== DEFAULTS[k]) p.set(k, String(cfg[k]));
  return p.toString();
}

export function decodeConfig(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const over = {};
  for (const k of Object.keys(DEFAULTS)) if (p.has(k)) over[k] = p.get(k);
  return clamp(over);
}

// ---------------------------------------------------------------------------
// Layout

export function makeLayout({ aisles = 16, bays = 26, levels = 4, cross = 0, depot = "left" } = {}) {
  const aisleX = Array.from({ length: aisles }, (_, a) => r2(PITCH / 2 + a * PITCH));
  const split = cross ? Math.ceil(bays / 2) : bays;
  const bayY = Array.from({ length: bays }, (_, b) => r2(CROSS_W / 2 + (b + 0.5) * BAY_W + (b >= split ? CROSS_W : 0)));
  const crossY = cross
    ? [0, r2(CROSS_W / 2 + split * BAY_W + CROSS_W / 2), r2(CROSS_W / 2 + bays * BAY_W + CROSS_W * 1.5)]
    : [0, r2(CROSS_W + bays * BAY_W)];
  const depotX = depot === "center" ? r2((aisleX[0] + aisleX[aisles - 1]) / 2) : aisleX[0];
  const nSlots = aisles * bays * 2 * levels;
  const L = {
    aisles, bays, levels, cross: !!cross, split, aisleX, bayY, crossY, depotX, nSlots,
    width: aisles * PITCH, depth: crossY[crossY.length - 1] + CROSS_W / 2,
    sA: new Int16Array(nSlots), sB: new Int16Array(nSlots), sSide: new Int8Array(nSlots), sL: new Int8Array(nSlots),
    sCap: new Float64Array(nSlots), sD0: new Float64Array(nSlots), floorSlots: aisles * bays * 2,
  };
  for (let a = 0; a < aisles; a++) for (let b = 0; b < bays; b++) for (let side = 0; side < 2; side++) for (let l = 0; l < levels; l++) {
    const s = slotIndex(L, a, b, side, l);
    L.sA[s] = a; L.sB[s] = b; L.sSide[s] = side; L.sL[s] = l;
    L.sCap[s] = LEVELS[l].cap;
    L.sD0[s] = Math.abs(depotX - aisleX[a]) + bayY[b];
  }
  return L;
}

export const slotIndex = (L, a, b, side, l) => ((a * L.bays + b) * 2 + side) * L.levels + l;

// The block (between two cross aisles) a y position belongs to.
export function blockOf(L, y) {
  for (let k = 0; k < L.crossY.length - 1; k++) if (y < L.crossY[k + 1]) return k;
  return L.crossY.length - 2;
}

// A point is { a, x, y }: a = aisle index, or -1 for a point on the front cross aisle (the depot).
export const depotPoint = (L, x = L.depotX) => ({ a: -1, x, y: 0 });
export const slotPoint = (L, s) => ({ a: L.sA[s], x: L.aisleX[L.sA[s]], y: L.bayY[L.sB[s]] });

// Shortest walking distance. In the same aisle, straight along it. Otherwise along an aisle to one
// cross aisle, across, and along the other aisle. Using two cross aisles is never shorter.
export function dist(L, p, q) {
  if (p.a === q.a && p.a >= 0) return Math.abs(p.y - q.y);
  let best = Infinity;
  for (const c of L.crossY) {
    const v = Math.abs(p.y - c) + Math.abs(q.y - c);
    if (v < best) best = v;
  }
  return Math.abs(p.x - q.x) + best;
}

// ---------------------------------------------------------------------------
// Demand

const ZIPF = 1.0; // line share falls as 1 / rank: about 20% of SKUs take 80% of lines
const FAMILY = 20; // SKUs per product family; co-ordered items come from the same family

function makeSampler(weights, ids) {
  const cum = new Float64Array(ids.length);
  let t = 0;
  for (let i = 0; i < ids.length; i++) { t += weights[ids[i]]; cum[i] = t; }
  return (u) => {
    const x = u * t;
    let lo = 0, hi = ids.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    return ids[lo];
  };
}

export function makeCatalog(n, seed) {
  const rng = mulberry32(seed * 1009 + 17);
  const fam = new Int32Array(n), w = new Float64Array(n), cube = new Float64Array(n);
  const famPerm = shuffle(Array.from({ length: n }, (_, i) => i), rng);
  famPerm.forEach((s, i) => { fam[s] = Math.floor(i / FAMILY); });
  const rankPerm = shuffle(Array.from({ length: n }, (_, i) => i), rng);
  rankPerm.forEach((s, r) => { w[s] = 1 / (r + 1) ** ZIPF; });
  for (let s = 0; s < n; s++) cube[s] = r1(Math.min(30, Math.max(0.05, Math.exp(gauss(rng) * 0.9)))); // liters per unit, median 1 L
  const nFam = Math.ceil(n / FAMILY);
  const members = Array.from({ length: nFam }, () => []);
  for (const s of famPerm) members[fam[s]].push(s);
  return { n, fam, w, cube, members, nFam };
}

// Orders: 45% single line, mean 2.2 lines. Line 1 from overall popularity; each later line with
// probability `aff` from the family of an earlier line, else from overall popularity.
export function makeOrders(cat, count, aff, rng) {
  const all = makeSampler(cat.w, Array.from({ length: cat.n }, (_, i) => i));
  const fams = cat.members.map((m) => makeSampler(cat.w, m));
  const orders = [];
  for (let o = 0; o < count; o++) {
    let k = 1;
    while (k < 15 && rng() < 0.55) k++;
    const lines = [], units = [];
    for (let j = 0; j < k; j++) {
      let s = -1;
      for (let tries = 0; tries < 12; tries++) {
        const c = j > 0 && rng() < aff ? fams[cat.fam[lines[Math.floor(rng() * lines.length)]]](rng()) : all(rng());
        if (!lines.includes(c)) { s = c; break; }
      }
      if (s < 0) break;
      lines.push(s);
      units.push(rng() < 0.75 ? 1 : 2 + Math.floor(rng() * 3));
    }
    orders.push({ lines: Int32Array.from(lines), units: Int32Array.from(units) });
  }
  return orders;
}

// Velocity and slot volume from history: two earlier days of the same demand.
export function profileSkus(cat, hist, days, L) {
  const n = cat.n;
  const lines = new Float64Array(n), units = new Float64Array(n);
  for (const o of hist) for (let j = 0; j < o.lines.length; j++) { lines[o.lines[j]] += 1; units[o.lines[j]] += o.units[j]; }
  for (let s = 0; s < n; s++) { lines[s] /= days; units[s] /= days; }
  // Pick face volume: COVER_DAYS of units, at least three units, at most a floor slot.
  const req = new Float64Array(n);
  for (let s = 0; s < n; s++) req[s] = r1(Math.min(LEVELS[0].cap, Math.max(cat.cube[s] * 3, cat.cube[s] * units[s] * COVER_DAYS)));
  // If more SKUs need a floor slot than there are floor slots, the smallest of them are replenished more often.
  const big = [...req.keys()].filter((s) => req[s] > SMALL_CAP).sort((a, b) => req[b] - req[a]);
  for (const s of big.slice(L.floorSlots)) req[s] = SMALL_CAP;
  const byVel = Array.from({ length: n }, (_, i) => i).sort((a, b) => lines[b] - lines[a] || a - b);
  const cls = new Int8Array(n); // 0 = A, 1 = B, 2 = C
  byVel.forEach((s, r) => { cls[s] = r < n * 0.2 ? 0 : r < n * 0.5 ? 1 : 2; });
  return { lines, units, req, cls, byVel };
}

// Co-order counts for SKU pairs.
export function coOccurrence(orders) {
  const m = new Map();
  for (const o of orders) {
    const l = o.lines;
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const a = Math.min(l[i], l[j]), b = Math.max(l[i], l[j]);
      const k = a * 65536 + b;
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}

export function makeProblem(cfgIn = {}) {
  const cfg = clamp(cfgIn);
  const L = makeLayout(cfg);
  const n = Math.min(cfg.skus, Math.floor(L.nSlots * 0.97));
  const cat = makeCatalog(n, cfg.seed);
  const hist = makeOrders(cat, cfg.orders * 2, cfg.aff / 100, mulberry32(cfg.seed * 1009 + 31));
  const orders = makeOrders(cat, cfg.orders, cfg.aff / 100, mulberry32(cfg.seed * 1009 + 53));
  const prof = profileSkus(cat, hist, 2, L);
  let lines = 0;
  for (const o of orders) lines += o.lines.length;
  return { cfg, L, cat, hist, orders, prof, n, lines, skusCut: n < cfg.skus };
}

// ---------------------------------------------------------------------------
// Slotting

// How a slot ranks for slotting: seconds per visit for a walk there and back from the depot, plus
// reaching or bending. Reach and bend seconds count ERGO_WEIGHT times, for fatigue and injury risk.
export const ERGO_WEIGHT = 3;
export function slotCost(L, speed) {
  const c = new Float64Array(L.nSlots);
  for (let s = 0; s < L.nSlots; s++) c[s] = (2 * L.sD0[s]) / speed + LEVELS[L.sL[s]].extra * ERGO_WEIGHT;
  return c;
}

// Slot assignment with capacity. SKUs come in priority order and each takes the first free slot in
// `pick`'s choice that holds its volume. Floor slots are kept for SKUs too big for the upper levels:
// a small SKU takes a floor slot only while more floor slots are free than big SKUs still waiting.
function assigner(L, req, order) {
  const slotOf = new Int32Array(req.length).fill(-1);
  const used = new Uint8Array(L.nSlots);
  let freeFloor = L.floorSlots, bigsLeft = 0;
  for (const s of order) if (req[s] > SMALL_CAP) bigsLeft++;
  const ok = (sl, s) => {
    if (used[sl] || L.sCap[sl] < req[s]) return false;
    if (L.sL[sl] === 0 && req[s] <= SMALL_CAP && freeFloor <= bigsLeft) return false;
    return true;
  };
  const place = (s, sl) => {
    slotOf[s] = sl; used[sl] = 1;
    if (L.sL[sl] === 0) freeFloor--;
    if (req[s] > SMALL_CAP) bigsLeft--;
  };
  return { slotOf, used, ok, place };
}

function assignRanked(L, req, order, rank) {
  const A = assigner(L, req, order);
  let start = 0;
  for (const s of order) {
    while (start < rank.length && A.used[rank[start]]) start++;
    for (let i = start; i < rank.length; i++) {
      if (A.ok(rank[i], s)) { A.place(s, rank[i]); break; }
    }
    if (A.slotOf[s] < 0) throw new Error(`no slot for SKU ${s}`);
  }
  return A.slotOf;
}

const rankSlots = (cost) => Array.from({ length: cost.length }, (_, i) => i).sort((a, b) => cost[a] - cost[b] || a - b);

export function slotRandom(L, prof, seed) {
  const rng = mulberry32(seed * 1009 + 71);
  const n = prof.req.length;
  const order = shuffle(Array.from({ length: n }, (_, i) => i), rng);
  const rank = shuffle(Array.from({ length: L.nSlots }, (_, i) => i), rng);
  return assignRanked(L, prof.req, order, rank);
}

// ABC is class based: inside a class the order is random, as when a site re-slots by class only.
export function slotABC(L, prof, speed, seed) {
  const rng = mulberry32(seed * 1009 + 73);
  const n = prof.req.length;
  const order = shuffle(Array.from({ length: n }, (_, i) => i), rng).sort((a, b) => prof.cls[a] - prof.cls[b]);
  return assignRanked(L, prof.req, order, rankSlots(slotCost(L, speed)));
}

export function slotCOI(L, prof, speed) {
  const n = prof.req.length;
  const coi = (s) => prof.req[s] / Math.max(prof.lines[s], 0.25);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => coi(a) - coi(b) || a - b);
  return assignRanked(L, prof.req, order, rankSlots(slotCost(L, speed)));
}

// Greedy clustering of the co-order graph: edges by weight, heaviest first, merge the two clusters
// if the result has at most `maxSize` SKUs. Pairs seen fewer than `minCount` times are noise.
export function clusterSkus(n, co, maxSize, minCount = 2) {
  const parent = Int32Array.from({ length: n }, (_, i) => i), size = new Int32Array(n).fill(1);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const edges = [];
  for (const [k, c] of co) if (c >= minCount) edges.push([Math.floor(k / 65536), k % 65536, c]);
  edges.sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  for (const [a, b] of edges) {
    const ra = find(a), rb = find(b);
    if (ra === rb || size[ra] + size[rb] > maxSize) continue;
    if (size[ra] < size[rb]) { parent[ra] = rb; size[rb] += size[ra]; } else { parent[rb] = ra; size[ra] += size[rb]; }
  }
  const groups = new Map();
  for (let s = 0; s < n; s++) { const r = find(s); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); }
  return [...groups.values()];
}

export function slotAffinity(L, prof, co, speed) {
  const n = prof.req.length;
  const maxSize = 2 * L.levels * 3; // one three-bay section, both faces
  const clusters = clusterSkus(n, co, maxSize);
  const dens = (c) => c.reduce((t, s) => t + prof.lines[s], 0) / c.length;
  clusters.sort((p, q) => dens(q) - dens(p) || p[0] - q[0]);
  for (const c of clusters) c.sort((a, b) => prof.lines[b] - prof.lines[a] || a - b);
  const order = clusters.flat();
  const A = assigner(L, prof.req, order);
  const rank = rankSlots(slotCost(L, speed));
  const pts = Array.from({ length: L.nSlots }, (_, s) => slotPoint(L, s));
  let start = 0;
  for (const c of clusters) {
    // The fastest member takes the best free slot; the others the free slots closest to it.
    const s0 = c[0];
    while (start < rank.length && A.used[rank[start]]) start++;
    for (let i = start; i < rank.length; i++) if (A.ok(rank[i], s0)) { A.place(s0, rank[i]); break; }
    const seedPt = pts[A.slotOf[s0]];
    for (let j = 1; j < c.length; j++) {
      const s = c[j];
      let best = -1, bv = Infinity;
      for (let sl = 0; sl < L.nSlots; sl++) {
        if (!A.ok(sl, s)) continue;
        const v = (2 * dist(L, seedPt, pts[sl])) / speed + LEVELS[L.sL[sl]].extra * ERGO_WEIGHT + L.sD0[sl] * 0.01;
        if (v < bv) { bv = v; best = sl; }
      }
      A.place(s, best);
    }
  }
  for (const s of order) if (A.slotOf[s] < 0) throw new Error(`no slot for SKU ${s}`);
  return A.slotOf;
}

export function slotting(P, key) {
  const { L, prof, cfg } = P;
  if (key === "random") return slotRandom(L, prof, cfg.seed);
  if (key === "abc") return slotABC(L, prof, cfg.speed, cfg.seed);
  if (key === "coi") return slotCOI(L, prof, cfg.speed);
  if (key === "affinity") return slotAffinity(L, prof, P.co || (P.co = coOccurrence(P.hist)), cfg.speed);
  throw new Error(`unknown slotting ${key}`);
}

// ---------------------------------------------------------------------------
// Routing

function walker(start) {
  const pts = [[start.x, start.y]];
  let x = start.x, y = start.y, len = 0;
  return {
    get x() { return x; },
    get y() { return y; },
    get len() { return len; },
    pts,
    to(nx, ny) {
      if (nx === x && ny === y) return;
      if (nx !== x && ny !== y) throw new Error("diagonal move");
      len += Math.abs(nx - x) + Math.abs(ny - y);
      x = nx; y = ny;
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      if (prev && ((prev[0] === last[0] && last[0] === x && (last[1] - prev[1]) * (y - last[1]) > 0) || (prev[1] === last[1] && last[1] === y && (last[0] - prev[0]) * (x - last[0]) > 0))) {
        last[0] = x; last[1] = y; // same direction, extend the segment
      } else pts.push([x, y]);
    },
  };
}

// Picks grouped by aisle, each with its sorted distinct y positions, aisles by x.
export function groupPicks(picks) {
  const m = new Map();
  for (const p of picks) {
    if (!m.has(p.a)) m.set(p.a, { a: p.a, x: p.x, ys: [] });
    const g = m.get(p.a);
    if (!g.ys.includes(p.y)) g.ys.push(p.y);
  }
  const groups = [...m.values()].sort((p, q) => p.x - q.x);
  for (const g of groups) g.ys.sort((p, q) => p - q);
  return groups;
}

// Aisles in sweep order, starting from the end nearer to x.
function sweepFrom(groups, x) {
  if (groups.length < 2) return groups.slice();
  const lo = groups[0], hi = groups[groups.length - 1];
  return Math.abs(lo.x - x) <= Math.abs(hi.x - x) ? groups.slice() : groups.slice().reverse();
}

function routeReturn(groups, depot, w) {
  for (const g of sweepFrom(groups, depot.x)) {
    w.to(g.x, 0);
    w.to(g.x, g.ys[g.ys.length - 1]);
    w.to(g.x, 0);
  }
}

// One block, entered at its back cross aisle, left at its front cross aisle.
function blockSShape(M, yf, yb, w) {
  const m = M.length;
  const nTrav = m % 2 === 1 ? m : m - 1;
  for (let i = 0; i < nTrav; i++) { w.to(M[i].x, w.y); w.to(M[i].x, w.y === yb ? yf : yb); }
  if (nTrav < m) {
    const g = M[m - 1];
    w.to(g.x, yf); w.to(g.x, g.ys[g.ys.length - 1]); w.to(g.x, yf);
  }
}

export function splitAisle(ys, yf, yb, how) {
  if (how === "midpoint") {
    const mid = (yf + yb) / 2;
    return { front: ys.filter((y) => y <= mid), back: ys.filter((y) => y > mid) };
  }
  // Largest gap: the stretch with no picks that is longest, counting from both cross aisles.
  const pts = [yf, ...ys, yb];
  let gi = 0, gv = -1;
  for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1] - pts[i] > gv + 1e-9) { gv = pts[i + 1] - pts[i]; gi = i; }
  return { front: ys.slice(0, gi), back: ys.slice(gi) };
}

function blockGap(M, yf, yb, w, how) {
  const m = M.length;
  const parts = M.map((g) => splitAisle(g.ys, yf, yb, how));
  for (let i = 0; i < m - 1; i++) if (parts[i].back.length) { w.to(M[i].x, yb); w.to(M[i].x, parts[i].back[0]); w.to(M[i].x, yb); }
  w.to(M[m - 1].x, yb); w.to(M[m - 1].x, yf);
  for (let i = m - 2; i >= 0; i--) if (parts[i].front.length) { const f = parts[i].front; w.to(M[i].x, yf); w.to(M[i].x, f[f.length - 1]); w.to(M[i].x, yf); }
}

// Each aisle in sweep order is walked through (switching side) or entered and left from the side the
// picker is on. Moves across are the same for every choice, so only the in-aisle meters are compared.
function blockCombined(M, yf, yb, w, startBack) {
  const m = M.length, len = yb - yf;
  let c = [startBack ? Infinity : 0, startBack ? 0 : Infinity]; // side 0 front, 1 back
  const ch = [];
  for (let i = 0; i < m; i++) {
    const g = M[i], depth = [g.ys[g.ys.length - 1] - yf, yb - g.ys[0]];
    const nc = [Infinity, Infinity], step = [null, null];
    for (const s of [0, 1]) {
      if (c[s] === Infinity) continue;
      const t = c[s] + len;
      if (t < nc[1 - s]) { nc[1 - s] = t; step[1 - s] = { from: s, act: "T" }; }
      const r = c[s] + 2 * depth[s];
      if (r < nc[s]) { nc[s] = r; step[s] = { from: s, act: "R" }; }
    }
    ch.push(step); c = nc;
  }
  let side = c[0] <= c[1] + len ? 0 : 1;
  const acts = [];
  for (let i = m - 1; i >= 0; i--) { const st = ch[i][side]; acts.unshift(st.act); side = st.from; }
  side = startBack ? 1 : 0;
  for (let i = 0; i < m; i++) {
    const g = M[i], ys = side ? yb : yf;
    w.to(g.x, ys);
    if (acts[i] === "T") { side = 1 - side; w.to(g.x, side ? yb : yf); } else { w.to(g.x, side ? g.ys[0] : g.ys[g.ys.length - 1]); w.to(g.x, ys); }
  }
  if (side === 1) w.to(w.x, yf);
}

// Multi-block frame (one block when there is no middle cross aisle): walk up the aisle nearest the
// depot end to the back of the farthest block with picks, then clear blocks from the back to the front.
function routeBlocks(L, groups, depot, w, heur) {
  const C = L.crossY;
  const order = sweepFrom(groups, depot.x);
  const f = order[0];
  let top = 0;
  for (const g of groups) top = Math.max(top, blockOf(L, g.ys[g.ys.length - 1]));
  if (top === 0 && heur === "combined") { blockCombined(order, 0, C[1], w, false); return; }
  w.to(f.x, 0);
  w.to(f.x, C[top + 1]);
  for (let b = top; b >= 0; b--) {
    const yf = C[b], yb = C[b + 1];
    const M = sweepFrom(order.slice(1).map((g) => ({ ...g, ys: g.ys.filter((y) => blockOf(L, y) === b) })).filter((g) => g.ys.length), w.x);
    if (!M.length) { w.to(w.x, yf); continue; }
    if (heur === "sshape") blockSShape(M, yf, yb, w);
    else if (heur === "combined") blockCombined(M, yf, yb, w, true);
    else blockGap(M, yf, yb, w, heur);
  }
}

// Held-Karp over distinct pick locations with shortest walking distances: the exact shortest tour.
export function optimalOrder(L, locs, depot) {
  const n = locs.length;
  if (n === 0) return { len: 0, seq: [] };
  const pts = [depot, ...locs];
  const D = pts.map((p) => pts.map((q) => dist(L, p, q)));
  const full = 1 << n;
  const dp = new Float64Array(full * n).fill(Infinity), par = new Int8Array(full * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = D[0][j + 1];
  for (let mask = 1; mask < full; mask++) {
    for (let j = 0; j < n; j++) {
      const v = dp[mask * n + j];
      if (v === Infinity || !(mask & (1 << j))) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k), nv = v + D[j + 1][k + 1];
        if (nv < dp[nm * n + k]) { dp[nm * n + k] = nv; par[nm * n + k] = j; }
      }
    }
  }
  let best = Infinity, last = -1;
  for (let j = 0; j < n; j++) { const v = dp[(full - 1) * n + j] + D[j + 1][0]; if (v < best) { best = v; last = j; } }
  const seq = [];
  let mask = full - 1;
  while (last >= 0) { seq.unshift(last); const p = par[mask * n + last]; mask &= ~(1 << last); last = p; }
  return { len: best, seq };
}

function walkShortest(L, w, p, q) {
  if (p.a === q.a && p.a >= 0) { w.to(q.x, q.y); return; }
  let bc = 0, bv = Infinity;
  for (const c of L.crossY) { const v = Math.abs(p.y - c) + Math.abs(q.y - c); if (v < bv) { bv = v; bc = c; } }
  w.to(p.x, bc); w.to(q.x, bc); w.to(q.x, q.y);
}

export function uniqueLocs(picks) {
  const seen = new Set(), out = [];
  for (const p of picks) { const k = p.a * 100000 + Math.round(p.y * 10); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}

// A route for a pick list: { len, pts }. Optimal returns null above MAX_EXACT distinct locations.
export function route(L, picks, heur, depotX = L.depotX) {
  const depot = depotPoint(L, depotX);
  const w = walker(depot);
  if (heur === "optimal") {
    const locs = uniqueLocs(picks);
    if (locs.length > MAX_EXACT) return null;
    const { seq } = optimalOrder(L, locs, depot);
    let at = depot;
    for (const j of seq) { walkShortest(L, w, at, locs[j]); at = locs[j]; }
    walkShortest(L, w, at, depot);
    return { len: w.len, pts: w.pts };
  }
  const groups = groupPicks(picks);
  if (groups.length) {
    if (heur === "return" || groups.length === 1) routeReturn(groups, depot, w);
    else if (heur === "combined" && !L.cross) blockCombined(sweepFrom(groups, depot.x), 0, L.crossY[1], w, false);
    else if (HEURISTICS[heur]) routeBlocks(L, groups, depot, w, heur);
    else throw new Error(`unknown heuristic ${heur}`);
    w.to(depot.x, 0);
  }
  return { len: w.len, pts: w.pts };
}

// Checks used by the tests: every move runs along an aisle or a cross aisle, and every pick is on the route.
export function validMoves(L, pts, depotX = L.depotX) {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x0 === x1) { if (!L.aisleX.includes(x0)) return false; } else if (y0 === y1) { if (!L.crossY.includes(y0)) return false; } else return false;
    if (x0 !== x1 && (Math.min(x0, x1) < Math.min(depotX, L.aisleX[0]) - 1e-9 || Math.max(x0, x1) > Math.max(depotX, L.aisleX[L.aisles - 1]) + 1e-9)) return false;
  }
  return true;
}

export function covers(pts, p) {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x0 === x1 && x0 === p.x && p.y >= Math.min(y0, y1) - 1e-9 && p.y <= Math.max(y0, y1) + 1e-9) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Picking a day

// Where each SKU is under a slotting: its pick point and level.
export function locate(P, slotOf) {
  const { L } = P;
  const pt = new Array(P.n), level = new Int8Array(P.n), aisle = new Int16Array(P.n);
  for (let s = 0; s < P.n; s++) { pt[s] = slotPoint(L, slotOf[s]); level[s] = L.sL[slotOf[s]]; aisle[s] = L.sA[slotOf[s]]; }
  return { slotOf, pt, level, aisle };
}

export const zoneOf = (L, zones, a) => Math.min(zones - 1, Math.floor((a * zones) / L.aisles));
export function zoneDepotX(L, zones, z) {
  const xs = L.aisleX.filter((_, a) => zoneOf(L, zones, a) === z);
  return r2((xs[0] + xs[xs.length - 1]) / 2);
}

// A trip is { orders: [order indices], zone: -1 or the zone }. Its lines are the orders' lines, or
// for zone picking the lines in that zone.
export function tripLines(P, loc, trip, zones) {
  const out = [];
  for (const o of trip.orders) {
    const ord = P.orders[o];
    for (let j = 0; j < ord.lines.length; j++) {
      const s = ord.lines[j];
      if (trip.zone >= 0 && zoneOf(P.L, zones, loc.aisle[s]) !== trip.zone) continue;
      out.push(s);
    }
  }
  return out;
}

export const tripDepotX = (P, trip, zones) => (trip.zone >= 0 ? zoneDepotX(P.L, zones, trip.zone) : P.L.depotX);

function routeLen(P, loc, skus, heur, depotX) {
  return route(P.L, skus.map((s) => loc.pt[s]), heur, depotX).len;
}

export function makeTrips(P, loc, mode, n, zones, heur) {
  const trips = [];
  const N = P.orders.length;
  for (let w0 = 0; w0 < N; w0 += WAVE) {
    const ids = Array.from({ length: Math.min(WAVE, N - w0) }, (_, i) => w0 + i);
    if (mode === "single" || n === 1 && mode !== "zone") { for (const o of ids) trips.push({ orders: [o], zone: -1 }); continue; }
    if (mode === "zone") {
      for (let z = 0; z < zones; z++) {
        const sub = ids.filter((o) => P.orders[o].lines.some((s) => zoneOf(P.L, zones, loc.aisle[s]) === z));
        for (let i = 0; i < sub.length; i += n) trips.push({ orders: sub.slice(i, i + n), zone: z });
      }
      continue;
    }
    if (mode === "seed") trips.push(...seedBatches(P, loc, ids, n));
    else if (mode === "savings") trips.push(...savingsBatches(P, loc, ids, n, heur));
    else throw new Error(`unknown batching ${mode}`);
  }
  return trips;
}

function seedBatches(P, loc, ids, n) {
  const aisles = new Map(), reach = new Map();
  for (const o of ids) {
    const l = P.orders[o].lines;
    aisles.set(o, new Set(Array.from(l, (s) => loc.aisle[s])));
    reach.set(o, Math.max(...Array.from(l, (s) => P.L.sD0[loc.slotOf[s]])));
  }
  const left = new Set(ids), out = [];
  while (left.size) {
    let seed = -1;
    for (const o of left) if (seed < 0 || reach.get(o) > reach.get(seed)) seed = o;
    left.delete(seed);
    const batch = [seed], set = new Set(aisles.get(seed));
    while (batch.length < n && left.size) {
      let best = -1, bv = Infinity;
      for (const o of left) {
        let add = 0;
        for (const a of aisles.get(o)) if (!set.has(a)) add++;
        const v = add * 1000 - reach.get(o) * 0.001;
        if (v < bv) { bv = v; best = o; }
      }
      left.delete(best); batch.push(best);
      for (const a of aisles.get(best)) set.add(a);
    }
    out.push({ orders: batch, zone: -1 });
  }
  return out;
}

function savingsBatches(P, loc, ids, n, heur) {
  const L = P.L, lines = (o) => Array.from(P.orders[o].lines);
  const single = new Map(ids.map((o) => [o, routeLen(P, loc, lines(o), heur, L.depotX)]));
  // Savings only for each order's NEIGHBORS nearest orders by pick centroid, as in granular local search.
  const cen = new Map(ids.map((o) => {
    const l = lines(o);
    return [o, [l.reduce((t, s) => t + loc.pt[s].x, 0) / l.length, l.reduce((t, s) => t + loc.pt[s].y, 0) / l.length]];
  }));
  const cand = new Set();
  for (const a of ids) {
    const [ax, ay] = cen.get(a);
    const near = ids.filter((b) => b !== a).map((b) => [Math.abs(cen.get(b)[0] - ax) + Math.abs(cen.get(b)[1] - ay), b]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [, b] of near.slice(0, NEIGHBORS)) cand.add(Math.min(a, b) * 65536 + Math.max(a, b));
  }
  const pairs = [];
  for (const k of [...cand].sort((p, q) => p - q)) {
    const a = Math.floor(k / 65536), b = k % 65536;
    const s = single.get(a) + single.get(b) - routeLen(P, loc, [...lines(a), ...lines(b)], heur, L.depotX);
    pairs.push([s, a, b]);
  }
  pairs.sort((p, q) => q[0] - p[0] || p[1] - q[1] || p[2] - q[2]);
  const of = new Map(), batches = new Map();
  let next = 0;
  for (const [, a, b] of pairs) {
    const ba = of.get(a), bb = of.get(b);
    if (ba === undefined && bb === undefined) { if (n >= 2) { batches.set(next, [a, b]); of.set(a, next); of.set(b, next); next++; } }
    else if (ba !== undefined && bb === undefined) { if (batches.get(ba).length < n) { batches.get(ba).push(b); of.set(b, ba); } }
    else if (ba === undefined && bb !== undefined) { if (batches.get(bb).length < n) { batches.get(bb).push(a); of.set(a, bb); } }
    else if (ba !== bb && batches.get(ba).length + batches.get(bb).length <= n) {
      for (const o of batches.get(bb)) { batches.get(ba).push(o); of.set(o, ba); }
      batches.delete(bb);
    }
  }
  const out = [...batches.values()].map((b) => ({ orders: b.sort((p, q) => p - q), zone: -1 }));
  for (const o of ids) if (!of.has(o)) out.push({ orders: [o], zone: -1 });
  return out.sort((p, q) => p.orders[0] - q.orders[0]);
}

// Labor for a set of trips under one or more heuristics. With `exact`, also the optimal route on
// trips with at most MAX_EXACT distinct locations, to measure each heuristic's gap.
export function evalTrips(P, loc, trips, heurs, opts = {}) {
  const { speed, pickSec } = P.cfg;
  const zones = opts.zones ?? P.cfg.zones;
  let lines = 0, pickS = 0, sortS = 0, ergo = 0, golden = 0;
  const dist = Object.fromEntries(heurs.map((h) => [h, 0]));
  const gapH = Object.fromEntries(heurs.map((h) => [h, 0]));
  let gapOpt = 0, gapTrips = 0, optimalHits = Object.fromEntries(heurs.map((h) => [h, 0]));
  for (const t of trips) {
    const skus = tripLines(P, loc, t, zones);
    const picks = skus.map((s) => loc.pt[s]);
    const dx = tripDepotX(P, t, zones);
    lines += skus.length;
    for (const s of skus) {
      const lv = LEVELS[loc.level[s]];
      pickS += pickSec + lv.extra; ergo += lv.ergo;
      if (loc.level[s] === 1 || loc.level[s] === 2) golden++;
    }
    if (t.orders.length > 1) sortS += skus.length * SORT_SEC;
    const lens = heurs.map((h) => route(P.L, picks, h, dx).len);
    heurs.forEach((h, i) => { dist[h] += lens[i]; });
    if (opts.exact) {
      const locs = uniqueLocs(picks);
      if (locs.length <= MAX_EXACT) {
        const o = optimalOrder(P.L, locs, depotPoint(P.L, dx)).len;
        gapOpt += o; gapTrips++;
        heurs.forEach((h, i) => { gapH[h] += lens[i]; if (lens[i] <= o + 1e-6) optimalHits[h]++; });
      }
    }
  }
  let consolS = 0;
  if (trips.some((t) => t.zone >= 0)) {
    for (const o of P.orders) {
      const zs = new Set(Array.from(o.lines, (s) => zoneOf(P.L, zones, loc.aisle[s])));
      if (zs.size > 1) consolS += CONSOL_SEC;
    }
  }
  const orders = P.orders.length;
  const setupS = trips.length * SETUP_SEC;
  const res = {};
  for (const h of heurs) {
    const walkS = dist[h] / speed;
    const labor = (walkS + pickS + sortS + setupS + consolS) / 3600;
    res[h] = {
      dist: dist[h], perOrder: dist[h] / orders, perLine: dist[h] / Math.max(1, lines), trips: trips.length, lines, orders,
      walkH: walkS / 3600, pickH: pickS / 3600, sortH: sortS / 3600, setupH: setupS / 3600, consolH: consolS / 3600,
      laborH: labor, pph: lines / labor, walkShare: walkS / 3600 / labor,
      ergo: (100 * ergo) / Math.max(1, lines), golden: golden / Math.max(1, lines),
      gap: gapTrips ? gapH[h] / gapOpt - 1 : null, gapTrips, optimalShare: gapTrips ? optimalHits[h] / gapTrips : null,
    };
  }
  return res;
}

export const singleTrips = (P) => P.orders.map((_, o) => ({ orders: [o], zone: -1 }));

// Pick density per slot for a day: lines per slot.
export function pickDensity(P, loc) {
  const d = new Float64Array(P.L.nSlots);
  for (const o of P.orders) for (const s of o.lines) d[loc.slotOf[s]] += 1;
  return d;
}

// Average walking distance between pairs of SKUs, weighted by how often each pair is co-ordered.
export function pairDistance(P, loc, pairs) {
  let t = 0, w = 0;
  for (const [a, b, c] of pairs) { t += dist(P.L, loc.pt[a], loc.pt[b]) * c; w += c; }
  return w ? t / w : 0;
}

// ---------------------------------------------------------------------------
// Formatting

export const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
export const fmt1 = (x) => (Math.round(x * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const pct = (x, dp = 1) => `${(x * 100).toFixed(dp)}%`;
