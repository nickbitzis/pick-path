import {
  AISLE_W, BATCHING, BAY_W, CROSS_W, DEFAULTS, DEPOTS, HEURISTICS, LEVELS, MAX_EXACT, RACK_D, SLOTTINGS, clamp, decodeConfig,
  encodeConfig, fmt1, fmtInt, locate, makeProblem, pct, route, singleTrips, slotIndex, tripDepotX, tripLines, uniqueLocs, zoneDepotX, zoneOf,
} from "./warehouse.js";
import { compute } from "./run.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";

let cfg = decodeConfig(location.hash);
let P = null, pKey = ""; // the problem, rebuilt locally from the same seed
let SL = null; // slot arrays per slotting, from the worker
let M = null; // slotting x routing results
let B = null; // batching results and trips
let loc = null, skuAt = null, today = null;
let view = "class", rsel = cfg.route, tripIdx = -1, needTrip = true;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const narrow = () => matchMedia("(max-width: 600px)").matches;
const m0 = (x) => `${fmtInt(x)} m`;
const m1 = (x) => `${fmt1(x)} m`;
const ROUTES = { ...Object.fromEntries(Object.entries(HEURISTICS).map(([k, v]) => [k, v.label])), optimal: "Exact" };
const CLASS = ["A", "B", "C"];

// ---------------------------------------------------------------------------
// Form

const F = (name, label, title, step = 1) => ({ name, label, title, step });
const opts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.label ?? v]));

const GROUPS = [
  { legend: "Layout", fields: [
    { name: "depot", label: "Depot", type: "select", options: DEPOTS, title: "Where pickers start and end each trip, on the front cross aisle" },
    F("aisles", "Aisles", "Parallel picking aisles, 5.2 m apart"),
    F("bays", "Bays per aisle", "1.3 m sections along each aisle, shelving on both faces"),
    F("levels", "Levels (2 to 5)", "Shelf levels per bay: floor, two golden zone levels, high, top"),
    { name: "cross", label: "Middle cross aisle", type: "check", title: "A 3 m cross aisle halfway along every aisle" },
  ] },
  { legend: "Demand", fields: [
    F("skus", "SKUs", "Active SKUs in the pick area, capped at 97% of slots", 100),
    F("orders", "Orders per day", "Customer orders in the day being picked", 500),
    F("aff", "Co-order affinity (%)", "Chance that a later line in an order comes from the same product family as an earlier one"),
    F("seed", "Random seed", "SKUs, history, and the day's orders all come from this seed"),
  ] },
  { legend: "Picking", fields: [
    { name: "slot", label: "Slotting", type: "select", options: opts(SLOTTINGS), title: "Rule that assigns SKUs to slots, from two days of order history" },
    { name: "route", label: "Routing", type: "select", options: opts(HEURISTICS), title: "How the picker walks a pick list" },
    { name: "batch", label: "Batching", type: "select", options: opts(BATCHING), title: "How orders are grouped into cart trips" },
    F("n", "Orders per cart", "Totes on a cart, one order each. Also orders per zone trip."),
    F("zones", "Zones", "Groups of aisles for zone picking"),
    F("speed", "Walk speed (m/s)", "With a cart, including turns and stops", 0.1),
    F("pickSec", "Seconds per pick", "Find, pick, and scan at waist height. Floor, high, and top levels add 5 to 9 s."),
  ] },
];

function field(f) {
  if (f.type === "select") {
    return el("label", { title: f.title || null }, [f.label, el("select", { name: f.name }, Object.entries(f.options).map(([v, t]) => el("option", { value: v, text: t })))]);
  }
  if (f.type === "check") return el("label", { class: "check", title: f.title || null }, [el("input", { type: "checkbox", name: f.name }), f.label]);
  return el("label", { title: f.title || null }, [f.label, el("input", { type: "number", name: f.name, step: f.step, min: 0, inputmode: "decimal" })]);
}

function buildForm() {
  form.replaceChildren(...GROUPS.map((g) => {
    const selects = g.fields.filter((f) => f.type === "select");
    const nums = g.fields.filter((f) => !f.type);
    const checks = g.fields.filter((f) => f.type === "check");
    const kids = [el("legend", { text: g.legend }), ...selects.map(field)];
    if (nums.length) kids.push(el("div", { class: "grid2" }, nums.map(field)));
    kids.push(...checks.map(field));
    if (g.legend === "Picking") kids.push(el("span", { class: "field-hint", id: "pick-note" }));
    if (g.legend === "Demand") kids.push(el("span", { class: "field-hint", id: "demand-note" }));
    return el("fieldset", {}, kids);
  }));
  fillForm();
}

function fillForm() {
  for (const f of form.elements) {
    if (!f.name || !(f.name in cfg)) continue;
    if (f.type === "checkbox") f.checked = !!cfg[f.name]; else f.value = cfg[f.name];
  }
  $("pick-note").textContent = `${SLOTTINGS[cfg.slot].label}: ${SLOTTINGS[cfg.slot].note}. ${BATCHING[cfg.batch].label}: ${BATCHING[cfg.batch].note}.`;
  $("demand-note").textContent = P && P.skusCut ? `Capped at ${fmtInt(P.n)} SKUs to fit the ${fmtInt(P.L.nSlots)} slots.` : "";
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  let v = f.value;
  if (f.type === "checkbox") v = f.checked ? 1 : 0;
  else if (f.tagName !== "SELECT") {
    v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
  }
  cfg = clamp({ ...cfg, [f.name]: v });
  if (f.name === "route") rsel = cfg.route;
  if (["batch", "n", "zones", "slot"].includes(f.name)) needTrip = true;
  schedule();
});
form.addEventListener("change", () => fillForm());

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, 400);
}

// ---------------------------------------------------------------------------
// Worker

let worker = null, jobId = 0, started = 0;
const localCache = {};
// ?noworker runs everything on the main thread, for headless screenshots and debugging.
try {
  if (new URLSearchParams(location.search).has("noworker")) throw new Error("no worker");
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => onResult(e.data);
  worker.onerror = () => { worker = null; runLocal(jobId); };
} catch {
  worker = null;
}

const secs = () => ((performance.now() - started) / 1000).toFixed(1);

function onResult(m) {
  if (m.id !== jobId) return;
  if (m.stage === "slots") {
    SL = m.slots;
    setLoc();
    $("status").textContent = `Slotted in ${secs()} s. Routing ${fmtInt(P.orders.length)} orders under 4 slottings and 6 routes...`;
  } else if (m.stage === "matrix") {
    M = m.matrix;
    $("status").textContent = `Routed in ${secs()} s. Batching...`;
    $("batch-status").textContent = "Batching...";
  } else {
    B = m;
    $("status").textContent = `Done in ${secs()} s`;
    $("batch-status").textContent = "";
    if (needTrip || tripIdx < 0 || tripIdx >= B.trips.length) tripIdx = defaultTrip(0, 5, cfg.batch === "single" ? 9 : MAX_EXACT);
    needTrip = false;
  }
  drawAll();
}

function runLocal(id) {
  setTimeout(() => { if (id === jobId) compute(cfg, (msg) => onResult({ id, ...msg }), localCache); }, 30);
}

const PROBLEM_KEYS = ["aisles", "bays", "levels", "cross", "depot", "skus", "orders", "aff", "seed", "speed", "pickSec"];

function update() {
  const key = PROBLEM_KEYS.map((k) => cfg[k]).join("|");
  if (key !== pKey) { P = makeProblem(cfg); pKey = key; SL = null; M = null; loc = null; tripIdx = -1; needTrip = true; }
  P.cfg = { ...P.cfg, ...cfg };
  B = null;
  jobId++;
  started = performance.now();
  $("status").textContent = SL ? "Batching..." : `Slotting ${fmtInt(P.n)} SKUs four ways...`;
  if (SL) setLoc();
  if (worker) worker.postMessage({ id: jobId, cfg });
  else runLocal(jobId);
  history.replaceState(null, "", `#${encodeConfig(cfg)}`);
  fillForm();
  drawAll();
}

function setLoc() {
  loc = locate(P, SL[cfg.slot]);
  skuAt = new Int32Array(P.L.nSlots).fill(-1);
  for (let s = 0; s < P.n; s++) skuAt[loc.slotOf[s]] = s;
  today = new Float64Array(P.n);
  for (const o of P.orders) for (const s of o.lines) today[s] += 1;
  if (tripIdx < 0) tripIdx = defaultTrip();
}

// ---------------------------------------------------------------------------
// Trips

const curTrips = () => (B && B.trips) || singleTrips(P);

function tripPicks(t) {
  const skus = tripLines(P, loc, t, cfg.zones);
  return { skus, picks: skus.map((s) => loc.pt[s]), dx: B ? tripDepotX(P, t, cfg.zones) : P.L.depotX };
}

function defaultTrip(from = 0, minLocs = 5, maxLocs = 9) {
  if (!loc) return 0;
  const ts = curTrips();
  for (let k = 0; k < ts.length; k++) {
    const i = (from + k) % ts.length;
    const n = uniqueLocs(tripPicks(ts[i]).picks).length;
    if (n >= minLocs && n <= maxLocs) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Summary

function drawAll() {
  drawTabs();
  drawPlan();
  drawCards();
  drawMap();
  drawMatrix();
  drawRouting();
  drawBatch();
  drawSweep();
  drawLabor();
}

function tabs(id, items, cur, attr) {
  $(id).replaceChildren(...Object.entries(items).map(([k, label]) => el("button", {
    type: "button", class: "tab", role: "tab", [`data-${attr}`]: k, "aria-selected": String(k === cur),
  }, [label])));
}

function drawTabs() {
  for (const b of $("view-tabs").children) b.setAttribute("aria-selected", String(b.dataset.view === view));
  tabs("route-tabs", ROUTES, rsel, "route");
}

const cur = () => (B ? B.batching[cfg.batch] : M ? M[cfg.slot].res[cfg.route] : null);

function bestCell() {
  let best = null;
  for (const s of Object.keys(SLOTTINGS)) for (const h of Object.keys(HEURISTICS)) {
    const r = M[s].res[h];
    if (!best || r.perOrder < best.r.perOrder) best = { s, h, r };
  }
  return best;
}

function drawPlan() {
  if (!M) { $("rec").textContent = `Slotting ${fmtInt(P.n)} SKUs into ${fmtInt(P.L.nSlots)} slots four ways, then routing ${fmtInt(P.orders.length)} orders (${fmtInt(P.lines)} lines) with five heuristics and the exact route.`; return; }
  const r = M[cfg.slot].res[cfg.route], rnd = M.random.res[cfg.route], best = bestCell();
  const parts = [
    `${fmtInt(P.orders.length)} orders with ${fmtInt(P.lines)} lines, ${pct(P.orders.filter((o) => o.lines.length === 1).length / P.orders.length, 0)} of them single line. With ${SLOTTINGS[cfg.slot].label} slotting and ${HEURISTICS[cfg.route].label.toLowerCase()} routing, a picker walks ${m0(r.perOrder)} per order, ${pct(1 - r.perOrder / rnd.perOrder, 0)} less than with random slotting, and the route is ${pct(r.gap)} longer than the exact shortest route.`,
    `The shortest single order walk is ${SLOTTINGS[best.s].label} with ${HEURISTICS[best.h].label.toLowerCase()} (${m0(best.r.perOrder)} per order).`,
  ];
  if (B) {
    const s = B.batching.single, c = B.batching[cfg.batch];
    if (cfg.batch === "single") {
      const sv = B.batching.savings;
      parts.push(`Savings batching ${cfg.n} orders per cart cuts walking to ${m0(sv.perOrder)} per order and the day from ${fmtInt(s.laborH)} to ${fmtInt(sv.laborH)} labor hours.`);
    } else {
      parts.push(`${BATCHING[cfg.batch].label} with ${cfg.n} orders per ${cfg.batch === "zone" ? "zone trip" : "cart"} walks ${m0(c.perOrder)} per order and takes ${fmtInt(c.laborH)} labor hours against ${fmtInt(s.laborH)} for single order picking, ${fmtInt(c.pph)} picks per hour against ${fmtInt(s.pph)}.`);
    }
  }
  $("rec").textContent = parts.join(" ");
}

function card(label, value, sub, title, cls = "") {
  return el("div", { class: "card", title }, [el("span", { class: "card-label", text: label }), el("span", { class: `card-total ${cls}`, text: value }), el("span", { class: "card-sub", text: sub })]);
}

function drawCards() {
  if (!M) { $("cards").replaceChildren(); return; }
  const c = cur(), single = M[cfg.slot].res[cfg.route], rnd = M.random.res[cfg.route];
  const lbl = B ? BATCHING[cfg.batch].label.toLowerCase() : "single order";
  $("cards").replaceChildren(
    card("Walk per order", m0(c.perOrder), `${m1(c.perLine)} per line, ${lbl}`, "Meters walked in the day divided by orders"),
    card("Picks per labor hour", fmtInt(c.pph), `${pct(c.walkShare, 0)} of labor time is walking`, "Lines per hour, with walking, picking, setup, sorting, and consolidation"),
    card("Labor for the day", `${fmtInt(c.laborH)} h`, `${fmt1(c.laborH / 7.5)} picker shifts of 7.5 h`, "Total labor hours to pick the day"),
    card("Slotting vs random", pct(1 - single.perOrder / rnd.perOrder, 0), `less walking: ${m0(single.perOrder)} vs ${m0(rnd.perOrder)} per order`, "Same routing, single order picking", single.perOrder < rnd.perOrder ? "good" : ""),
    card("Gap to the exact route", pct(single.gap), `on the ${pct(single.gapTrips / P.orders.length, 0)} of orders with at most ${MAX_EXACT} locations`, "Heuristic meters over exact shortest route meters", single.gap > 0.1 ? "bad" : ""),
    card("Ergonomic score", fmt1(c.ergo), `${pct(c.golden, 0)} of lines in the golden zone`, "Average of 100 (golden zone), 95, 60 (floor), 55 (high), 35 (top) over lines"),
  );
}

// ---------------------------------------------------------------------------
// Map

const S = 10; // px per m
let G = null; // map geometry for this layout

function geom() {
  const L = P.L, padT = 22, padB = 34;
  const W = L.width * S + 16, H = (L.depth + CROSS_W / 2) * S + padT + padB;
  return { L, W, H, X: (x) => 8 + x * S, Y: (y) => padT + (L.depth - y) * S };
}

const heatRamp = ["#f2b15a", "#e0612e", "#9c1f12"];
function hexMix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(" ")})`;
}
function heatColor(t, base) {
  const stops = [base, ...heatRamp];
  const f = Math.min(0.999, Math.max(0, t)) * (stops.length - 1), i = Math.floor(f);
  return hexMix(stops[i], stops[i + 1], f - i);
}

function mapLegend() {
  const items = view === "class"
    ? [["c-a", "A: top 20% by lines"], ["c-b", "B: next 30%"], ["c-c", "C: slowest 50%"], ["c-empty", "Empty"]]
    : [["heat", "Lines picked today per bay face, low to high"]];
  const li = items.map(([c, t]) => el("li", {}, [el("i", { class: `swatch ${c}` }), t]));
  li.push(el("li", {}, [el("i", { class: "linekey route" }), "Route"]), el("li", {}, [el("i", { class: "dot d-pick" }), "Pick"]));
  $("map-legend").replaceChildren(...li);
}

function drawMap() {
  mapLegend();
  G = geom();
  const { L, W, H, X, Y } = G;
  const g = $("map");
  g.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const nodes = [];
  nodes.push(svg("rect", { x: X(0), y: Y(L.depth), width: L.width * S, height: (L.depth + CROSS_W / 2) * S, class: "floor" }));
  for (const c of L.crossY) nodes.push(svg("rect", { x: X(0), y: Y(c + CROSS_W / 2), width: L.width * S, height: CROSS_W * S, class: "xaisle" }));
  if (cfg.batch === "zone") {
    for (let z = 0; z < cfg.zones; z++) {
      const as = L.aisleX.map((x, a) => a).filter((a) => zoneOf(L, cfg.zones, a) === z);
      const x0 = L.aisleX[as[0]] - PITCH_HALF, x1 = L.aisleX[as[as.length - 1]] + PITCH_HALF;
      nodes.push(svg("rect", { x: X(x0) + 1, y: Y(L.depth) + 1, width: (x1 - x0) * S - 2, height: L.depth * S - 2, class: "zone" }));
    }
  }
  // Rack faces, one cell per bay face, colored by the fastest SKU on it or by today's lines.
  const cells = new Map();
  if (loc) {
    for (let s = 0; s < P.n; s++) {
      const sl = loc.slotOf[s], key = (L.sA[sl] * L.bays + L.sB[sl]) * 2 + L.sSide[sl];
      const c = cells.get(key) || { cls: 3, lines: 0 };
      c.cls = Math.min(c.cls, P.prof.cls[s]);
      c.lines += today[s];
      cells.set(key, c);
    }
  }
  let maxLines = 1;
  for (const c of cells.values()) maxLines = Math.max(maxLines, c.lines);
  const css = getComputedStyle(document.documentElement);
  const classFill = ["--c-a", "--c-b", "--c-c", "--c-empty"].map((v) => css.getPropertyValue(v).trim());
  const heat0 = css.getPropertyValue("--c-heat0").trim() || "#f4f1ea";
  for (let a = 0; a < L.aisles; a++) for (let b = 0; b < L.bays; b++) for (let side = 0; side < 2; side++) {
    const key = (a * L.bays + b) * 2 + side, c = cells.get(key);
    const x0 = side ? L.aisleX[a] + AISLE_W / 2 : L.aisleX[a] - AISLE_W / 2 - RACK_D;
    const fill = !c ? classFill[3] : view === "class" ? classFill[c.cls] : heatColor(Math.sqrt(c.lines / maxLines), heat0);
    nodes.push(svg("rect", { x: X(x0), y: Y(L.bayY[b] + BAY_W / 2), width: RACK_D * S, height: BAY_W * S, class: "cell", fill, "data-c": key }));
  }
  const step = narrow() || L.aisles > 20 ? 2 : 1;
  for (let a = 0; a < L.aisles; a += step) nodes.push(svg("text", { x: X(L.aisleX[a]), y: Y(L.depth) - 6, class: "alabel", "text-anchor": "middle" }, `${a + 1}`));
  // The selected trip.
  let note = "";
  if (loc) {
    const ts = curTrips(), t = ts[Math.min(tripIdx, ts.length - 1)];
    const { skus, picks, dx } = tripPicks(t);
    const r = route(L, picks, rsel, dx);
    if (r) {
      const d = r.pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("");
      nodes.push(svg("path", { d, class: "route" }));
    }
    for (const s of skus) {
      const sl = loc.slotOf[s], side = L.sSide[sl];
      const x = L.aisleX[L.sA[sl]] + (side ? 1 : -1) * (AISLE_W / 2 - 0.35);
      nodes.push(svg("circle", { cx: X(x), cy: Y(L.bayY[L.sB[sl]]), r: narrow() ? 6 : 4, class: "pick" }));
    }
    drawTripTable(picks, dx);
    const nLoc = uniqueLocs(picks).length;
    $("trip-label").textContent = `Trip ${fmtInt(tripIdx + 1)} of ${fmtInt(ts.length)}: ${t.orders.length === 1 ? `order ${t.orders[0] + 1}` : `${t.orders.length} orders`}${t.zone >= 0 ? `, zone ${t.zone + 1}` : ""}, ${skus.length} ${skus.length === 1 ? "line" : "lines"} in ${nLoc} ${nLoc === 1 ? "location" : "locations"}`;
    note = r
      ? `${ROUTES[rsel]}: ${rsel === "optimal" ? "the shortest walk through every pick, from Held-Karp over the distinct locations" : HEURISTICS[rsel].note}. ${m1(r.len)} for this trip.`
      : `The exact route is computed for at most ${MAX_EXACT} distinct locations; this trip has ${nLoc}.`;
  }
  const depots = cfg.batch === "zone" && B ? Array.from({ length: cfg.zones }, (_, z) => zoneDepotX(L, cfg.zones, z)) : [L.depotX];
  for (const x of depots) nodes.push(svg("rect", { x: X(x) - 7, y: Y(0) + CROSS_W / 2 * S + 4, width: 14, height: 10, rx: 2, class: "depot" }));
  nodes.push(svg("text", { x: X(depots[0]) + (depots.length > 1 ? 10 : 12), y: Y(0) + CROSS_W / 2 * S + 14, class: "lbl" }, depots.length > 1 ? "Zone drop points" : "Depot"));
  g.replaceChildren(...nodes);
  $("map-note").textContent = `${note} ${fmtInt(L.aisles)} aisles of ${fmtInt(L.bays)} bays, ${fmt1(L.width)} by ${fmt1(L.depth)} m, ${fmtInt(L.nSlots)} slots on ${L.levels} levels. Each cell is one bay face; hover it for the SKUs on each level.`;
}
const PITCH_HALF = (AISLE_W + 2 * RACK_D) / 2;

function drawTripTable(picks, dx) {
  const opt = route(P.L, picks, "optimal", dx);
  $("trip-rows").replaceChildren(...Object.keys(ROUTES).map((h) => {
    const r = h === "optimal" ? opt : route(P.L, picks, h, dx);
    const over = r && opt ? r.len - opt.len : null;
    return el("tr", { "data-key": h, class: h === rsel ? "selected" : null }, [
      el("td", { class: "name", text: ROUTES[h] }),
      el("td", { class: "num", text: r ? m1(r.len) : "n/a" }),
      el("td", { class: `num${over > 0.05 ? "" : over != null ? " good" : ""}`, text: over == null ? "n/a" : over < 0.05 ? "exact" : `+${m1(over)} (${pct(over / opt.len, 0)})` }),
      el("td", { class: "num", text: r ? `${fmtInt(r.len / cfg.speed)} s` : "n/a" }),
    ]);
  }));
}

const tipRow = (a, b) => el("div", { class: "tip-row" }, [el("span", { text: a }), el("b", { text: b })]);

function placeTip(tip, box, e) {
  tip.hidden = false;
  const left = e.clientX - box.left;
  const w = tip.offsetWidth;
  let x = left > box.width / 2 ? left - w - 12 : left + 12;
  x = Math.max(0, Math.min(box.width - w, x));
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top + 14)}px`;
}

{
  const map = $("map"), tip = map.nextElementSibling;
  map.addEventListener("pointermove", (e) => {
    const t = e.target.closest("[data-c]");
    if (!t || !loc) { tip.hidden = true; return; }
    const L = P.L, key = Number(t.dataset.c), side = key % 2, ab = (key - side) / 2, b = ab % L.bays, a = (ab - b) / L.bays;
    const rows = [el("strong", { text: `Aisle ${a + 1}, bay ${b + 1}, ${side ? "right" : "left"} face` }), tipRow("From the depot", m1(L.sD0[slotIndex(L, a, b, side, 0)]))];
    for (let l = L.levels - 1; l >= 0; l--) {
      const s = skuAt[slotIndex(L, a, b, side, l)];
      rows.push(tipRow(`${LEVELS[l].name}`, s < 0 ? "empty" : `SKU ${s + 1}, ${CLASS[P.prof.cls[s]]}, ${fmt1(P.prof.lines[s])} lines/day, ${fmt1(P.prof.req[s])} L`));
    }
    tip.replaceChildren(...rows);
    placeTip(tip, map.parentElement.getBoundingClientRect(), e);
  });
  map.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Tables

function drawMatrix() {
  const H = Object.keys(HEURISTICS);
  $("matrix-head").replaceChildren(el("tr", {}, [
    el("th", { text: "Slotting" }),
    ...H.map((h) => el("th", { class: "num", text: HEURISTICS[h].label, title: HEURISTICS[h].note })),
    el("th", { class: "num", text: "Pair distance", title: "Average walking distance between the 200 SKU pairs ordered together most often" }),
  ]));
  if (!M) { $("matrix-rows").replaceChildren(); $("matrix-note").textContent = "Routing..."; return; }
  const best = bestCell();
  $("matrix-rows").replaceChildren(...Object.keys(SLOTTINGS).map((s) => {
    const rowBest = H.reduce((x, y) => (M[s].res[y].perOrder < M[s].res[x].perOrder ? y : x));
    return el("tr", {}, [
      el("td", { class: "name", text: SLOTTINGS[s].label }),
      ...H.map((h) => el("td", {
        class: `num${s === cfg.slot && h === cfg.route ? " selected" : ""}${s === best.s && h === best.h ? " good" : h === rowBest ? " good" : ""}`,
        "data-cell": `${s}|${h}`, text: fmt1(M[s].res[h].perOrder), title: `${SLOTTINGS[s].label}, ${HEURISTICS[h].label}: ${m1(M[s].res[h].perLine)} per line, ${pct(M[s].res[h].gap)} over exact`,
      })),
      el("td", { class: "num", text: m1(M[s].pairDist) }),
    ]);
  }));
  $("matrix-note").textContent = `Meters walked per order, every order picked on its own. Green is the best routing for each slotting. Click a cell to select that slotting and routing. Slotting uses two earlier days of orders; the day measured is a new day from the same demand.`;
}

function drawRouting() {
  $("routing-sub").textContent = SLOTTINGS[cfg.slot].label;
  if (!M) { $("routing-rows").replaceChildren(); return; }
  const R = M[cfg.slot].res;
  const best = Object.keys(HEURISTICS).reduce((x, y) => (R[y].perOrder < R[x].perOrder ? y : x));
  $("routing-rows").replaceChildren(...Object.keys(HEURISTICS).map((h) => {
    const r = R[h];
    return el("tr", { "data-key": h, class: h === cfg.route ? "selected" : null }, [
      el("td", { class: "name" }, [HEURISTICS[h].label, el("small", { text: HEURISTICS[h].note })]),
      el("td", { class: `num${h === best ? " good" : ""}`, text: fmt1(r.perOrder) }),
      el("td", { class: "num", text: fmt1(r.perLine) }),
      el("td", { class: "num", text: pct(r.gap) }),
      el("td", { class: "num", text: pct(r.optimalShare, 0) }),
      el("td", { class: "num", text: fmtInt(r.pph) }),
      el("td", { class: "num", text: fmtInt(r.laborH) }),
    ]);
  }));
  const r = R.combined;
  $("routing-note").textContent = `Single order picking. The exact route is computed for the ${fmtInt(r.gapTrips)} orders (${pct(r.gapTrips / P.orders.length, 1)}) with at most ${MAX_EXACT} distinct locations, which is nearly all of them here because most orders are small. Orders in one aisle are the same walk for every heuristic, so the gaps come from multi-aisle orders. Click a row to select it.`;
}

function drawBatch() {
  if (!B) { $("batch-rows").replaceChildren(); $("batch-note").textContent = M ? "Batching..." : ""; return; }
  const best = Object.keys(BATCHING).reduce((x, y) => (B.batching[y].laborH < B.batching[x].laborH ? y : x));
  $("batch-rows").replaceChildren(...Object.keys(BATCHING).map((k) => {
    const r = B.batching[k];
    return el("tr", { "data-key": k, class: k === cfg.batch ? "selected" : null }, [
      el("td", { class: "name" }, [k === "single" ? BATCHING[k].label : `${BATCHING[k].label}, ${cfg.n} ${k === "zone" ? `per trip, ${cfg.zones} zones` : "per cart"}`, el("small", { text: BATCHING[k].note })]),
      el("td", { class: "num", text: fmtInt(r.trips) }),
      el("td", { class: "num", text: fmt1(r.perOrder) }),
      el("td", { class: "num", text: pct(r.walkShare, 0) }),
      el("td", { class: "num", text: fmtInt(r.pph) }),
      el("td", { class: `num${k === best ? " good" : ""}`, text: fmtInt(r.laborH) }),
      el("td", { class: "num", text: fmt1(r.laborH / 7.5) }),
    ]);
  }));
  const z = B.batching.zone, sv = B.batching.savings;
  $("batch-note").textContent = `${SLOTTINGS[cfg.slot].label} slotting, ${HEURISTICS[cfg.route].label.toLowerCase()} routing. Orders are released in waves of 250 and carts never mix waves. A cart trip costs 60 s of setup, and with more than one order on the cart each line costs 3 s more to sort into its tote. Savings batching takes ${fmt1(sv.ms / 1000)} s here. Zone picking walks ${m0(z.perOrder)} per order in ${fmtInt(z.trips)} short trips, but adds ${fmt1(z.consolH)} h of consolidation at 30 s per order that spans zones; the conveyor from the zones to packing is not costed. Click a row to select it.`;
}

function drawSweep() {
  const g = $("sweep");
  if (!B) { g.replaceChildren(); g.setAttribute("viewBox", "0 0 800 40"); $("sweep-note").textContent = ""; return; }
  const W = narrow() ? 440 : 800, H = 200, Pd = { l: 46, r: 16, t: 12, b: 32 };
  const data = B.sweep, max = Math.max(...data.map((d) => d.perOrder)) * 1.08;
  const X = (n) => Pd.l + ((n - 1) / 11) * (W - Pd.l - Pd.r);
  const Y = (v) => H - Pd.b - (v / max) * (H - Pd.t - Pd.b);
  g.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const nodes = [];
  const step = max > 200 ? 50 : max > 80 ? 20 : 10;
  for (let v = 0; v <= max; v += step) {
    nodes.push(svg("line", { x1: Pd.l, x2: W - Pd.r, y1: Y(v), y2: Y(v), class: "grid" }));
    nodes.push(svg("text", { x: Pd.l - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, v));
  }
  for (const d of data) nodes.push(svg("text", { x: X(d.n), y: H - Pd.b + 16, class: "tick", "text-anchor": "middle" }, d.n));
  nodes.push(svg("path", { class: "l-main", d: data.map((d, i) => `${i ? "L" : "M"}${X(d.n)},${Y(d.perOrder)}`).join("") }));
  data.forEach((d, i) => {
    nodes.push(svg("circle", { cx: X(d.n), cy: Y(d.perOrder), r: 4.5, class: `pt${cfg.batch === "seed" && d.n === cfg.n ? " sel" : ""}` }));
    nodes.push(svg("rect", { x: X(d.n) - 22, y: Pd.t, width: 44, height: H - Pd.t - Pd.b, class: "hit", "data-i": i }));
  });
  nodes.push(svg("text", { x: W - Pd.r, y: H - 2, class: "tick", "text-anchor": "end" }, "orders per cart"));
  nodes.push(svg("text", { x: Pd.l, y: Pd.t - 2, class: "tick" }, "m per order"));
  g.replaceChildren(...nodes);
  g._data = data;
  const a = data[0], b = data[data.length - 1];
  $("sweep-note").textContent = `From 1 to 12 orders per cart, walking falls from ${m0(a.perOrder)} to ${m0(b.perOrder)} per order and picks per labor hour rise from ${fmtInt(a.pph)} to ${fmtInt(b.pph)}. Most of the gain comes with the first few totes; after that, sorting time and the long tail of slow movers set the pace. A real cart is also limited by tote count and weight.`;
}

{
  const g = $("sweep"), tip = g.nextElementSibling;
  g.addEventListener("pointermove", (e) => {
    const t = e.target.closest("[data-i]");
    if (!t) { tip.hidden = true; return; }
    const d = g._data[Number(t.dataset.i)];
    tip.replaceChildren(el("strong", { text: `${d.n} ${d.n === 1 ? "order" : "orders"} per cart` }), tipRow("Walk per order", m1(d.perOrder)), tipRow("Trips", fmtInt(d.trips)), tipRow("Picks per hour", fmtInt(d.pph)), tipRow("Labor", `${fmtInt(d.laborH)} h`));
    placeTip(tip, g.parentElement.getBoundingClientRect(), e);
  });
  g.addEventListener("pointerleave", () => { tip.hidden = true; });
}

function drawLabor() {
  if (!M) { $("labor-rows").replaceChildren(); return; }
  $("labor-rows").replaceChildren(...Object.keys(SLOTTINGS).map((s) => {
    const r = M[s].res[cfg.route];
    return el("tr", { class: s === cfg.slot ? "selected" : null, "data-key": s }, [
      el("td", { class: "name", text: SLOTTINGS[s].label }),
      el("td", { class: "num", text: fmtInt(r.walkH) }),
      el("td", { class: "num", text: fmtInt(r.pickH) }),
      el("td", { class: "num", text: fmtInt(r.setupH + r.sortH + r.consolH) }),
      el("td", { class: "num", text: fmt1(r.ergo) }),
      el("td", { class: "num", text: pct(r.golden, 0) }),
      el("td", { class: "num", text: m1(M[s].pairDist) }),
    ]);
  }));
  $("labor-note").textContent = `Single order picking with ${HEURISTICS[cfg.route].label.toLowerCase()} routing at ${cfg.speed} m/s and ${cfg.pickSec} s per pick. Slotting changes walking a lot and pick time a little: the fastest movers need floor slots for a day of stock, so they cannot all sit in the golden zone. Slots are ranked by walking seconds plus three times the reach or bend seconds.`;
}

// ---------------------------------------------------------------------------
// Interaction

$("view-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) { view = b.dataset.view; drawTabs(); drawMap(); } });
$("route-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-route]"); if (b) { rsel = b.dataset.route; drawTabs(); drawMap(); } });
$("trip-rows").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) { rsel = r.dataset.key; drawTabs(); drawMap(); } });
$("prev").addEventListener("click", () => { const n = curTrips().length; tripIdx = (tripIdx - 1 + n) % n; drawMap(); });
$("next").addEventListener("click", () => { tripIdx = (tripIdx + 1) % curTrips().length; drawMap(); });
$("busy").addEventListener("click", () => { tripIdx = defaultTrip(tripIdx + 1, 7, 12); drawMap(); });

function choose(over) {
  cfg = clamp({ ...cfg, ...over });
  if (over.route) rsel = cfg.route;
  fillForm();
  update();
}

$("matrix-rows").addEventListener("click", (e) => { const c = e.target.closest("[data-cell]"); if (c) { const [slot, rt] = c.dataset.cell.split("|"); choose({ slot, route: rt }); } });
$("routing-rows").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) choose({ route: r.dataset.key }); });
$("batch-rows").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) { needTrip = true; choose({ batch: r.dataset.key }); } });
$("labor-rows").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) choose({ slot: r.dataset.key }); });

$("reset").addEventListener("click", () => {
  cfg = clamp({ ...DEFAULTS });
  rsel = cfg.route;
  buildForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

window.addEventListener("hashchange", () => {
  if (location.hash.slice(1) === encodeConfig(cfg)) return;
  cfg = decodeConfig(location.hash);
  rsel = cfg.route;
  buildForm();
  update();
});

let wasNarrow = narrow();
window.addEventListener("resize", () => {
  if (narrow() === wasNarrow) return;
  wasNarrow = narrow();
  drawAll();
});

matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => drawMap());

buildForm();
update();
