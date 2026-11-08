// The full evaluation as plain data, shared by the worker and the main-thread fallback.
import {
  BATCHING, HEURISTICS, SLOTTINGS, coOccurrence, evalTrips, locate, makeProblem, makeTrips, pairDistance, singleTrips, slotting,
} from "./warehouse.js";

export const SWEEP = [1, 2, 3, 4, 6, 8, 10, 12];
const PROBLEM_KEYS = ["aisles", "bays", "levels", "cross", "depot", "skus", "orders", "aff", "seed", "speed", "pickSec"];
const problemKey = (cfg) => PROBLEM_KEYS.map((k) => cfg[k]).join("|");

// The 200 most co-ordered pairs in the history, for the pair distance column.
function topPairs(co, k = 200) {
  return [...co].sort((p, q) => q[1] - p[1] || p[0] - q[0]).slice(0, k).map(([key, c]) => [Math.floor(key / 65536), key % 65536, c]);
}

export function compute(cfg, post, cache = {}) {
  const t0 = Date.now();
  let base = cache.key === problemKey(cfg) ? cache.base : null;
  if (!base) {
    const P = makeProblem(cfg);
    const slots = {};
    for (const k of Object.keys(SLOTTINGS)) slots[k] = slotting(P, k);
    post({ stage: "slots", slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, Array.from(v)])) });
    const pairs = topPairs(P.co || (P.co = coOccurrence(P.hist)));
    const matrix = {};
    const heurs = Object.keys(HEURISTICS);
    for (const k of Object.keys(SLOTTINGS)) {
      const loc = locate(P, slots[k]);
      matrix[k] = { res: evalTrips(P, loc, singleTrips(P), heurs, { exact: true }), pairDist: pairDistance(P, loc, pairs) };
    }
    post({ stage: "matrix", matrix, ms: Date.now() - t0 });
    base = { P, slots, matrix };
    cache.key = problemKey(cfg);
    cache.base = base;
  } else {
    post({ stage: "slots", slots: Object.fromEntries(Object.entries(base.slots).map(([k, v]) => [k, Array.from(v)])) });
    post({ stage: "matrix", matrix: base.matrix, ms: 0 });
  }
  const P = { ...base.P, cfg: { ...base.P.cfg, ...cfg } };
  const loc = locate(P, base.slots[cfg.slot]);
  const batching = {};
  let trips = null;
  for (const m of Object.keys(BATCHING)) {
    const t1 = Date.now();
    const tr = makeTrips(P, loc, m, m === "single" ? 1 : cfg.n, cfg.zones, cfg.route);
    batching[m] = { ...evalTrips(P, loc, tr, [cfg.route])[cfg.route], ms: Date.now() - t1 };
    if (m === cfg.batch) trips = tr;
  }
  const sweep = SWEEP.map((n) => ({ n, ...evalTrips(P, loc, makeTrips(P, loc, "seed", n, cfg.zones, cfg.route), [cfg.route])[cfg.route] }));
  post({ stage: "batch", batching, sweep, trips, ms: Date.now() - t0 });
}
