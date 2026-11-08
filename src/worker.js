// Runs slotting, routing, and batching off the main thread. Keeps the last problem so that changing
// only the slotting, routing, or batching choice skips the slow part.
import { compute } from "./run.js";

const cache = {};
self.onmessage = (e) => {
  const { id, cfg } = e.data;
  compute(cfg, (msg) => self.postMessage({ id, ...msg }), cache);
};
