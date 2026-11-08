import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, HEURISTICS, LEVELS, PITCH, SETUP_SEC, SLOTTINGS, SMALL_CAP, SORT_SEC, WAVE, clamp, clusterSkus, coOccurrence, covers,
  decodeConfig, depotPoint, dist, encodeConfig, evalTrips, locate, makeLayout, makeProblem, makeTrips, mulberry32, optimalOrder,
  pairDistance, profileSkus, route, singleTrips, slotABC, slotAffinity, slotCost, slotIndex, slotPoint, slotting, splitAisle, tripLines,
  uniqueLocs, validMoves, zoneOf,
} from "../src/warehouse.js";
import { compute } from "../src/run.js";

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const HEURS = Object.keys(HEURISTICS);

const P = makeProblem({ orders: 1500, skus: 1500, aisles: 12, bays: 20, seed: 3 });
const SLOTS = Object.fromEntries(Object.keys(SLOTTINGS).map((k) => [k, slotting(P, k)]));

// Small hand layout: 3 aisles at x = 2.6, 7.8, 13.0; 10 bays at y = 2.15, 3.45, ..., 13.85; back cross aisle at y = 16.
const H = makeLayout({ aisles: 3, bays: 10, levels: 1, cross: 0, depot: "left" });
const at = (L, a, b) => ({ a, x: L.aisleX[a], y: L.bayY[b] });

// Random pick lists on a layout.
function randomPicks(L, rng, k) {
  return Array.from({ length: k }, () => at(L, Math.floor(rng() * L.aisles), Math.floor(rng() * L.bays)));
}

function checkRoute(L, picks, r, depotX = L.depotX) {
  assert.ok(r, "route exists");
  const first = r.pts[0], last = r.pts[r.pts.length - 1];
  assert.deepEqual(first, [depotX, 0], "starts at the depot");
  assert.deepEqual(last, [depotX, 0], "ends at the depot");
  assert.ok(validMoves(L, r.pts, depotX), "moves run along aisles and cross aisles");
  for (const p of picks) assert.ok(covers(r.pts, p), `pick in aisle ${p.a} at ${p.y} is on the route`);
  let len = 0;
  for (let i = 1; i < r.pts.length; i++) len += Math.abs(r.pts[i][0] - r.pts[i - 1][0]) + Math.abs(r.pts[i][1] - r.pts[i - 1][1]);
  close(len, r.len, 1e-6);
}

// --- Randomness and demand -------------------------------------------------------------

test("mulberry32 is deterministic and seed dependent", () => {
  const a = mulberry32(9), b = mulberry32(9), c = mulberry32(10);
  const xs = Array.from({ length: 20 }, a);
  assert.deepEqual(xs, Array.from({ length: 20 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 20 }, c));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test("the problem is reproducible from the seed", () => {
  const a = makeProblem({ orders: 1500, skus: 1500, aisles: 12, bays: 20, seed: 3 });
  const c = makeProblem({ orders: 1500, skus: 1500, aisles: 12, bays: 20, seed: 4 });
  assert.deepEqual(a.orders.map((o) => Array.from(o.lines)), P.orders.map((o) => Array.from(o.lines)));
  assert.deepEqual(Array.from(a.cat.cube), Array.from(P.cat.cube));
  assert.notDeepEqual(c.orders.slice(0, 50).map((o) => Array.from(o.lines)), P.orders.slice(0, 50).map((o) => Array.from(o.lines)));
});

test("demand has a Pareto shape and e-commerce order sizes", () => {
  const single = P.orders.filter((o) => o.lines.length === 1).length / P.orders.length;
  close(single, 0.45, 0.04);
  close(P.lines / P.orders.length, 2.2, 0.15);
  for (const o of P.orders) assert.equal(new Set(o.lines).size, o.lines.length, "no SKU twice in an order");
  const counts = new Float64Array(P.n);
  for (const o of P.hist) for (const s of o.lines) counts[s]++;
  const sorted = [...counts].sort((a, b) => b - a), total = sorted.reduce((t, x) => t + x, 0);
  const top20 = sorted.slice(0, Math.round(P.n * 0.2)).reduce((t, x) => t + x, 0) / total;
  assert.ok(top20 > 0.7 && top20 < 0.9, `top 20% of SKUs take ${top20} of lines`);
});

test("co-order affinity raises the share of pairs from one product family", () => {
  const share = (aff) => {
    const Q = makeProblem({ orders: 2000, skus: 1500, aisles: 12, bays: 20, seed: 5, aff });
    let same = 0, all = 0;
    for (const o of Q.orders) for (let i = 0; i < o.lines.length; i++) for (let j = i + 1; j < o.lines.length; j++) {
      all++; if (Q.cat.fam[o.lines[i]] === Q.cat.fam[o.lines[j]]) same++;
    }
    return same / all;
  };
  const lo = share(0), hi = share(60);
  assert.ok(lo < 0.05, `no affinity: ${lo}`);
  assert.ok(hi > 0.2 && hi > 5 * lo, `60% affinity: ${hi}`);
});

test("slot volume needs: at least three units, at most a floor slot", () => {
  for (let s = 0; s < P.n; s++) {
    assert.ok(P.prof.req[s] >= Math.min(P.cat.cube[s] * 3, LEVELS[0].cap) - 0.05);
    assert.ok(P.prof.req[s] <= LEVELS[0].cap);
  }
  assert.ok(P.prof.req.filter((r) => r > SMALL_CAP).length > 0, "some SKUs need a floor slot");
});

// --- Layout and distance ---------------------------------------------------------------

test("layout geometry: slots, aisle pitch, cross aisles", () => {
  const L = makeLayout({ aisles: 16, bays: 26, levels: 4 });
  assert.equal(L.nSlots, 16 * 26 * 2 * 4);
  close(L.aisleX[1] - L.aisleX[0], PITCH, 1e-9);
  assert.deepEqual(H.crossY, [0, 16]);
  close(H.bayY[0], 2.15); close(H.bayY[9], 13.85);
  const s = slotIndex(L, 3, 7, 1, 2);
  assert.deepEqual([L.sA[s], L.sB[s], L.sSide[s], L.sL[s]], [3, 7, 1, 2]);
  const C = makeLayout({ aisles: 3, bays: 10, levels: 1, cross: 1 });
  assert.deepEqual(C.crossY, [0, 9.5, 19]);
  close(C.bayY[5] - C.bayY[4], 1.3 + 3, 1e-9);
});

test("distance in the same aisle is straight along it", () => {
  close(dist(H, at(H, 1, 2), at(H, 1, 8)), H.bayY[8] - H.bayY[2]);
});

test("distance between aisles goes around the nearer end", () => {
  // Both low: via the front, 2.15 + 3.45 + 10.4.
  close(dist(H, at(H, 0, 0), at(H, 2, 1)), 2.15 + 3.45 + 10.4);
  // Both high: via the back, (16 - 13.85) + (16 - 12.55) + 5.2.
  close(dist(H, at(H, 0, 9), at(H, 1, 8)), 2.15 + 3.45 + 5.2);
  // Depot to a pick: across the front, then up the aisle.
  close(dist(H, depotPoint(H), at(H, 2, 4)), 10.4 + H.bayY[4]);
});

test("a middle cross aisle shortens trips between the halves", () => {
  const C = makeLayout({ aisles: 3, bays: 10, levels: 1, cross: 1 });
  const p = at(C, 0, 4), q = at(C, 1, 5);
  close(p.y, 7.35); close(q.y, 11.65);
  close(dist(C, p, q), 2.15 + 2.15 + 5.2);
  const Hp = at(H, 0, 4), Hq = at(H, 1, 5);
  assert.ok(dist(H, Hp, Hq) > dist(C, p, q) + 5);
});

test("distance is symmetric and obeys the triangle inequality", () => {
  const rng = mulberry32(2);
  for (const L of [P.L, makeLayout({ aisles: 8, bays: 20, cross: 1 })]) {
    for (let i = 0; i < 300; i++) {
      const [p, q, r] = randomPicks(L, rng, 3);
      close(dist(L, p, q), dist(L, q, p));
      assert.ok(dist(L, p, r) <= dist(L, p, q) + dist(L, q, r) + 1e-9);
    }
  }
});

// --- Routing ---------------------------------------------------------------------------

const LAYOUTS = {
  "single block, depot left": makeLayout({ aisles: 10, bays: 20, levels: 1 }),
  "single block, depot center": makeLayout({ aisles: 9, bays: 20, levels: 1, depot: "center" }),
  "middle cross aisle": makeLayout({ aisles: 10, bays: 20, levels: 1, cross: 1 }),
  "middle cross aisle, depot center": makeLayout({ aisles: 9, bays: 21, levels: 1, cross: 1, depot: "center" }),
};

for (const [name, L] of Object.entries(LAYOUTS)) {
  test(`every heuristic visits every pick and returns to the depot: ${name}`, () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 150; i++) {
      const picks = randomPicks(L, rng, 1 + Math.floor(rng() * 25));
      for (const h of HEURS) checkRoute(L, picks, route(L, picks, h));
    }
  });

  test(`the exact route is never longer than any heuristic: ${name}`, () => {
    const rng = mulberry32(12);
    for (let i = 0; i < 120; i++) {
      const picks = randomPicks(L, rng, 1 + Math.floor(rng() * 9));
      const opt = route(L, picks, "optimal");
      checkRoute(L, picks, opt);
      close(opt.len, optimalOrder(L, uniqueLocs(picks), depotPoint(L)).len, 1e-6);
      for (const h of HEURS) assert.ok(opt.len <= route(L, picks, h).len + 1e-6, `${h} beat the optimum`);
    }
  });
}

test("Held-Karp matches brute force over all visiting orders", () => {
  const rng = mulberry32(13);
  const L = LAYOUTS["middle cross aisle"];
  const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  for (let i = 0; i < 25; i++) {
    const locs = uniqueLocs(randomPicks(L, rng, 2 + Math.floor(rng() * 5)));
    const d0 = depotPoint(L);
    let best = Infinity;
    for (const p of perms(locs.map((_, k) => k))) {
      let t = dist(L, d0, locs[p[0]]);
      for (let k = 1; k < p.length; k++) t += dist(L, locs[p[k - 1]], locs[p[k]]);
      best = Math.min(best, t + dist(L, locs[p[p.length - 1]], d0));
    }
    close(optimalOrder(L, locs, d0).len, best, 1e-6);
  }
});

test("the exact route is skipped above 12 distinct locations", () => {
  const picks = Array.from({ length: 13 }, (_, i) => at(P.L, i % P.L.aisles, i));
  assert.equal(route(P.L, picks, "optimal"), null);
  assert.equal(route(P.L, [], "sshape").len, 0);
});

// Hand example 1: picks in aisle 0 at y 4.75, aisle 1 at 11.25, aisle 2 at 3.45.
const EX1 = [at(H, 0, 2), at(H, 1, 7), at(H, 2, 1)];
// Hand example 2: aisle 0 at 8.65, aisle 1 at 2.15 and 13.85, aisle 2 at 8.65.
const EX2 = [at(H, 0, 5), at(H, 1, 0), at(H, 1, 9), at(H, 2, 5)];

test("S-shape on hand-worked examples", () => {
  // Up aisle 0 (16), down aisle 1 (16); three aisles, so the last is entered and left from the front.
  // Across: out to aisle 2 and back, 2 x 10.4.
  close(route(H, EX1, "sshape").len, 16 + 16 + 2 * 3.45 + 20.8);
  close(route(H, EX2, "sshape").len, 16 + 16 + 2 * 8.65 + 20.8);
  // Two aisles: both walked through.
  close(route(H, [at(H, 0, 1), at(H, 2, 3)], "sshape").len, 16 + 16 + 20.8);
});

test("largest gap on hand-worked examples", () => {
  // Aisle 1's largest gap is from the front to its pick, so it is entered from the back: 2 x (16 - 11.25).
  close(route(H, EX1, "lgap").len, 16 + 2 * 4.75 + 16 + 20.8);
  // Aisle 1's largest gap is between its two picks: 2 x 2.15 from the back and 2 x 2.15 from the front.
  close(route(H, EX2, "lgap").len, 16 + 4.3 + 16 + 4.3 + 20.8);
});

test("return and midpoint on hand-worked examples", () => {
  close(route(H, EX1, "return").len, 2 * (4.75 + 11.25 + 3.45) + 20.8);
  close(route(H, EX1, "midpoint").len, 16 + 2 * 4.75 + 16 + 20.8); // 11.25 is in the back half
  close(route(H, EX2, "midpoint").len, 16 + 4.3 + 16 + 4.3 + 20.8);
});

test("splitAisle finds the largest gap", () => {
  assert.deepEqual(splitAisle([2, 3], 0, 10, "lgap"), { front: [2, 3], back: [] }); // gap 3 to 10
  assert.deepEqual(splitAisle([8, 9], 0, 10, "lgap"), { front: [], back: [8, 9] }); // gap 0 to 8
  assert.deepEqual(splitAisle([1, 9], 0, 10, "lgap"), { front: [1], back: [9] });
  assert.deepEqual(splitAisle([1, 6, 9], 0, 10, "midpoint"), { front: [1], back: [6, 9] });
});

test("combined is never longer than S-shape or return on a single block", () => {
  const L = LAYOUTS["single block, depot left"], rng = mulberry32(14);
  for (let i = 0; i < 300; i++) {
    const picks = randomPicks(L, rng, 1 + Math.floor(rng() * 20));
    const c = route(L, picks, "combined").len;
    assert.ok(c <= route(L, picks, "sshape").len + 1e-6);
    assert.ok(c <= route(L, picks, "return").len + 1e-6);
  }
});

test("a single-aisle pick list is the same walk for every heuristic", () => {
  const picks = [at(H, 2, 3), at(H, 2, 6)];
  const want = 2 * 10.4 + 2 * H.bayY[6];
  for (const h of [...HEURS, "optimal"]) close(route(H, picks, h).len, want);
});

// --- Slotting --------------------------------------------------------------------------

test("every slotting places every SKU once and respects slot capacity", () => {
  for (const [k, slotOf] of Object.entries(SLOTS)) {
    assert.equal(slotOf.length, P.n);
    assert.equal(new Set(slotOf).size, P.n, `${k}: one SKU per slot`);
    for (let s = 0; s < P.n; s++) {
      assert.ok(slotOf[s] >= 0 && slotOf[s] < P.L.nSlots);
      assert.ok(P.L.sCap[slotOf[s]] >= P.prof.req[s], `${k}: SKU ${s} fits`);
    }
  }
});

test("floor slots are kept for SKUs too big for upper levels", () => {
  const L = makeLayout({ aisles: 4, bays: 10, levels: 4 });
  const n = 300, req = new Float64Array(n).fill(5);
  for (let s = 0; s < 80; s++) req[s] = 100; // 80 big SKUs, 80 floor slots
  const lines = Float64Array.from({ length: n }, (_, s) => n - s); // the big ones are slow movers
  lines.reverse();
  const prof = { req, lines, cls: Int8Array.from({ length: n }, (_, s) => (lines[s] > 200 ? 0 : lines[s] > 100 ? 1 : 2)) };
  const slotOf = slotABC(L, prof, 1, 1);
  for (let s = 0; s < 80; s++) assert.equal(L.sL[slotOf[s]], 0);
});

test("ABC puts the top movers nearest the depot and in the golden zone", () => {
  const cost = slotCost(P.L, P.cfg.speed);
  const mean = (slotOf, c) => {
    const xs = [...Array(P.n).keys()].filter((s) => P.prof.cls[s] === c);
    return xs.reduce((t, s) => t + cost[slotOf[s]], 0) / xs.length;
  };
  const abc = SLOTS.abc;
  assert.ok(mean(abc, 0) < mean(abc, 1) && mean(abc, 1) < mean(abc, 2));
  assert.ok(mean(abc, 0) < 0.6 * mean(SLOTS.random, 0));
  // The 50 fastest SKUs that fit an upper slot are all in the cheapest quarter of slots.
  const q = [...cost].sort((a, b) => a - b)[Math.floor(P.L.nSlots / 4)];
  const top = P.prof.byVel.filter((s) => P.prof.req[s] <= SMALL_CAP).slice(0, 50);
  for (const s of top) assert.ok(cost[abc[s]] <= q, `SKU ${s} at cost ${cost[abc[s]]}`);
  // More lines are picked in the golden zone than with random slotting. The fastest movers need floor
  // slots for their volume, so the gain is limited.
  const r = (slotOf) => evalTrips(P, locate(P, slotOf), singleTrips(P), ["lgap"]).lgap;
  assert.ok(r(abc).golden > r(SLOTS.random).golden + 0.03);
  assert.ok(r(abc).ergo > r(SLOTS.random).ergo);
});

test("COI favors small fast movers", () => {
  const cost = slotCost(P.L, P.cfg.speed), coi = (s) => P.prof.req[s] / Math.max(P.prof.lines[s], 0.25);
  const order = [...Array(P.n).keys()].sort((a, b) => coi(a) - coi(b));
  const avg = (xs) => xs.reduce((t, s) => t + cost[SLOTS.coi[s]], 0) / xs.length;
  const d = Math.floor(P.n / 10);
  assert.ok(avg(order.slice(0, d)) < 0.5 * avg(order.slice(-d)));
});

test("clustering merges the heaviest co-order edges up to the size cap", () => {
  const co = new Map([[0 * 65536 + 1, 10], [1 * 65536 + 2, 8], [2 * 65536 + 3, 6], [4 * 65536 + 5, 1]]);
  const cl = clusterSkus(6, co, 3).map((c) => c.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(cl, [[0, 1, 2], [3], [4], [5]]);
});

test("affinity slotting puts co-ordered pairs closer on a constructed case", () => {
  // 400 SKUs on a 6-aisle layout. Pairs (2k, 2k+1) for k < 40 are always ordered together;
  // their popularity is spread so ABC scatters each pair across the class.
  const L = makeLayout({ aisles: 6, bays: 12, levels: 4 });
  const n = 400, rng = mulberry32(21), hist = [];
  for (let i = 0; i < 4000; i++) {
    if (rng() < 0.5) { const k = Math.floor(rng() * 40); hist.push({ lines: Int32Array.of(2 * k, 2 * k + 1), units: Int32Array.of(1, 1) }); }
    else hist.push({ lines: Int32Array.of(80 + Math.floor(rng() ** 2 * 320)), units: Int32Array.of(1) });
  }
  const cat = { n, cube: new Float64Array(n).fill(0.5) };
  const prof = profileSkus(cat, hist, 2, L);
  const Q = { L, n, cfg: { speed: 0.9 }, orders: hist.filter((o) => o.lines.length === 2).slice(0, 300) };
  const pairs = Array.from({ length: 40 }, (_, k) => [2 * k, 2 * k + 1, 1]);
  const aff = locate(Q, slotAffinity(L, prof, coOccurrence(hist), 0.9));
  const abc = locate(Q, slotABC(L, prof, 0.9, 1));
  const da = pairDistance(Q, aff, pairs), db = pairDistance(Q, abc, pairs);
  assert.ok(da < 0.5 * db, `affinity ${da} m, ABC ${db} m between partners`);
  // And the orders that contain a pair are shorter to pick.
  const walk = (loc) => Q.orders.reduce((t, o) => t + route(L, Array.from(o.lines, (s) => loc.pt[s]), "lgap").len, 0);
  assert.ok(walk(aff) < walk(abc));
});

// --- Batching and labor ----------------------------------------------------------------

const LOC = locate(P, SLOTS.abc);

for (const mode of ["seed", "savings"]) {
  test(`${mode} batching covers every order once in carts of at most N`, () => {
    const trips = makeTrips(P, LOC, mode, 5, 4, "lgap");
    const seen = new Uint8Array(P.orders.length);
    for (const t of trips) {
      assert.ok(t.orders.length >= 1 && t.orders.length <= 5);
      const waves = new Set(t.orders.map((o) => Math.floor(o / WAVE)));
      assert.equal(waves.size, 1, "a batch stays in its wave");
      for (const o of t.orders) { assert.equal(seen[o], 0); seen[o] = 1; }
    }
    assert.equal(seen.reduce((t, x) => t + x, 0), P.orders.length);
    assert.ok(trips.length < P.orders.length / 3);
  });
}

test("zone picking splits each order's lines across zones exactly once", () => {
  const trips = makeTrips(P, LOC, "zone", 4, 3, "lgap");
  let lines = 0;
  for (const t of trips) {
    assert.ok(t.zone >= 0 && t.zone < 3 && t.orders.length <= 4);
    const ls = tripLines(P, LOC, t, 3);
    assert.ok(ls.length > 0);
    for (const s of ls) assert.equal(zoneOf(P.L, 3, LOC.aisle[s]), t.zone);
    lines += ls.length;
  }
  assert.equal(lines, P.lines);
});

test("batching cuts walking per order, and bigger carts cut it more", () => {
  const per = (mode, n) => evalTrips(P, LOC, makeTrips(P, LOC, mode, n, 4, "lgap"), ["lgap"]).lgap.perOrder;
  const one = evalTrips(P, LOC, singleTrips(P), ["lgap"]).lgap.perOrder;
  assert.ok(per("seed", 4) < 0.6 * one);
  assert.ok(per("seed", 8) < per("seed", 4));
  assert.ok(per("savings", 6) < one);
  close(per("seed", 1), one, 1e-9);
});

test("labor hours on a hand-built day", () => {
  const L = makeLayout({ aisles: 3, bays: 10, levels: 2 });
  const slotOf = Int32Array.of(slotIndex(L, 0, 2, 0, 1), slotIndex(L, 1, 7, 1, 0)); // golden at y 4.75, floor at 11.25
  const orders = [{ lines: Int32Array.of(0, 1), units: Int32Array.of(1, 1) }, { lines: Int32Array.of(0, 1), units: Int32Array.of(1, 1) }];
  const Q = { L, n: 2, orders, lines: 4, cfg: { speed: 1, pickSec: 10, zones: 2 } };
  const loc = locate(Q, slotOf);
  const one = evalTrips(Q, loc, singleTrips(Q), ["return"]).return;
  // Walk: 2 x 4.75 + 2 x 5.2 across + 2 x 11.25 = 42.4 m per order at 1 m/s.
  close(one.perOrder, 42.4); close(one.perLine, 21.2);
  // Per order: 42.4 s walk + (10 + 0) + (10 + 5) s picks + 60 s setup = 127.4 s.
  close(one.laborH, (2 * 127.4) / 3600);
  close(one.pph, 4 / ((2 * 127.4) / 3600));
  close(one.ergo, 80);
  // One cart with both orders: one walk, one setup, and 3 s per line to sort into totes.
  const cart = evalTrips(Q, loc, [{ orders: [0, 1], zone: -1 }], ["return"]).return;
  close(cart.laborH, (42.4 + 2 * 25 + SETUP_SEC + 4 * SORT_SEC) / 3600);
  close(cart.perOrder, 21.2);
  close(cart.walkH + cart.pickH + cart.sortH + cart.setupH + cart.consolH, cart.laborH);
});

test("day results add up", () => {
  const r = evalTrips(P, LOC, singleTrips(P), HEURS, { exact: true });
  for (const h of HEURS) {
    close(r[h].perOrder * r[h].orders, r[h].dist, 1e-6);
    close(r[h].perLine * r[h].lines, r[h].dist, 1e-6);
    assert.equal(r[h].lines, P.lines);
    assert.ok(r[h].gap >= 0, `${h} gap ${r[h].gap}`);
    assert.ok(r[h].gapTrips > 0.95 * P.orders.length);
  }
  assert.ok(r.combined.perOrder <= r.sshape.perOrder);
});

test("the full evaluation is deterministic", () => {
  const cfg = clamp({ orders: 600, skus: 800, aisles: 8, bays: 14, batch: "savings", n: 4 });
  const run = () => { const out = []; compute(cfg, (m) => out.push(m)); return JSON.stringify(out.map(({ ms, ...m }) => ({ ...m, batching: m.batching && Object.fromEntries(Object.entries(m.batching).map(([k, v]) => [k, { ...v, ms: 0 }])) }))); };
  assert.equal(run(), run());
});

test("config clamping and URL round trip", () => {
  const c = clamp({ aisles: 99, levels: 1, speed: 0.93, slot: "nope", route: "combined", extra: 1 });
  assert.equal(c.aisles, 30); assert.equal(c.levels, 2); assert.equal(c.speed, 0.9);
  assert.equal(c.slot, DEFAULTS.slot); assert.equal(c.route, "combined"); assert.ok(!("extra" in c));
  assert.deepEqual(decodeConfig(`#${encodeConfig(c)}`), c);
  assert.equal(encodeConfig(DEFAULTS), "");
  assert.ok(slotPoint(P.L, 0).a === 0);
});
