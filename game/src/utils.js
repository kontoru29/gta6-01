// utils.js — Solmar Bay small math and random helpers shared by every module.
// A seeded RNG (mulberry32) drives the deterministic screenshot mode, plain
// clamp/lerp/angle helpers keep movement and AI code short, and the tiny
// 2D/3D vector helpers work on plain {x, y, z} objects so modules never have
// to import three.js just to do arithmetic. No state is kept here except the
// default RNG instance; callers that need reproducibility create their own.

import { DEFAULT_SEED } from './config.js';

// ------------------------------------------------------------------- numbers
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpAngle(a, b, t) {
  // Shortest-path interpolation between two headings, in radians.
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export function damp(current, target, rate, dt) {
  // Frame-rate independent exponential approach: rate is ~ how fast it closes.
  if (dt <= 0) return current;
  const t = 1 - Math.exp(-rate * dt);
  return current + (target - current) * t;
}

export function normalizeAngle(angle) {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function angleDifference(from, to) {
  return normalizeAngle(to - from);
}

export function distance2D(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distanceSquared2D(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function formatMoney(amount) {
  const n = Math.round(amount);
  return '$' + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatClock(hour, minute) {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const m = ((Math.floor(minute) % 60) + 60) % 60;
  const hh = h < 10 ? '0' + h : '' + h;
  const mm = m < 10 ? '0' + m : '' + m;
  return hh + ':' + mm;
}

export function formatSpeedKmh(metresPerSecond) {
  return Math.round(Math.abs(metresPerSecond) * 3.6);
}

// ------------------------------------------------------------- seeded random
// mulberry32: small, fast, and good enough for city layout and traffic.
// The same seed always produces the same sequence, which is what makes the
// screenshot staging deterministic.
export function createRng(seed) {
  let state = (seed >>> 0) || 1;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    // Float in [min, max).
    range(min, max) {
      return min + next() * (max - min);
    },
    // Integer in [min, max] inclusive.
    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },
    // True with probability p (0..1).
    chance(p) {
      return next() < p;
    },
    // One element of a non-empty array.
    pick(array) {
      return array[Math.floor(next() * array.length)];
    },
    // In-place Fisher-Yates shuffle; returns the same array.
    shuffle(array) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = array[i];
        array[i] = array[j];
        array[j] = tmp;
      }
      return array;
    },
    // Gaussian-ish value centred on mean, via three averaged draws.
    normal(mean, spread) {
      return mean + ((next() + next() + next()) / 3 - 0.5) * 2 * spread;
    },
  };
}

// Default shared RNG for anything that does not need to be reproducible
// (ambient variation, cosmetic jitter). Deterministic systems must create
// their own RNG from a fixed seed instead of using this one.
export const rng = createRng(DEFAULT_SEED);

// Convenience wrappers over the default RNG, for one-off random picks.
export function randomRange(min, max) {
  return rng.range(min, max);
}
export function randomInt(min, max) {
  return rng.int(min, max);
}
export function randomPick(array) {
  return rng.pick(array);
}

// Turn any short string (a shot name, a save slot) into a stable numeric seed
// so the same name always stages the same deterministic scene.
export function seedFromString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Move a value toward a target by at most maxStep, without overshooting it.
export function moveTowards(current, target, maxStep) {
  if (current < target) return Math.min(target, current + maxStep);
  if (current > target) return Math.max(target, current - maxStep);
  return target;
}

// ------------------------------------------------------------ plain 2D vectors
// Lightweight {x, z} helpers for ground-plane maths (roads, AI, minimap).
export function vec2(x, z) {
  return { x, z };
}

export function vec2Length(v) {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

export function vec2Normalize(v) {
  const len = vec2Length(v);
  if (len < 1e-6) return { x: 0, z: 0 };
  return { x: v.x / len, z: v.z / len };
}

export function vec2Distance(a, b) {
  return distance2D(a.x, a.z, b.x, b.z);
}

// ------------------------------------------------------------ plain 3D vectors
export function vec3(x, y, z) {
  return { x, y, z };
}

export function vec3Distance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ------------------------------------------------------- AABB collision helpers
// Colliders are flat boxes on the ground: { minX, maxX, minZ, maxZ, height }.
// These helpers let the player, cars and pedestrians resolve them the same way.
export function pointInCollider(x, z, collider, margin) {
  const m = margin || 0;
  return (
    x >= collider.minX - m &&
    x <= collider.maxX + m &&
    z >= collider.minZ - m &&
    z <= collider.maxZ + m
  );
}

export function circleHitsCollider(x, z, radius, collider) {
  const closestX = clamp(x, collider.minX, collider.maxX);
  const closestZ = clamp(z, collider.minZ, collider.maxZ);
  const dx = x - closestX;
  const dz = z - closestZ;
  return dx * dx + dz * dz < radius * radius;
}

// Push a circle (player / car) out of a collider; returns the corrected point.
// If the circle is fully inside, it is pushed out along the smallest overlap.
export function resolveCircleCollider(x, z, radius, collider) {
  const closestX = clamp(x, collider.minX, collider.maxX);
  const closestZ = clamp(z, collider.minZ, collider.maxZ);
  let dx = x - closestX;
  let dz = z - closestZ;
  const distSq = dx * dx + dz * dz;
  if (distSq >= radius * radius) return { x, z, hit: false };
  if (distSq > 1e-9) {
    const dist = Math.sqrt(distSq);
    const push = radius - dist;
    return { x: x + (dx / dist) * push, z: z + (dz / dist) * push, hit: true };
  }
  // Centre is inside the box: leave through the nearest face.
  const left = x - collider.minX + radius;
  const right = collider.maxX - x + radius;
  const top = z - collider.minZ + radius;
  const bottom = collider.maxZ - z + radius;
  const smallest = Math.min(left, right, top, bottom);
  if (smallest === left) return { x: collider.minX - radius, z, hit: true };
  if (smallest === right) return { x: collider.maxX + radius, z, hit: true };
  if (smallest === top) return { x, z: collider.minZ - radius, hit: true };
  return { x, z: collider.maxZ + radius, hit: true };
}

// Resolve a circle against a whole list of colliders in one pass.
export function resolveCircleColliders(x, z, radius, colliders) {
  let hit = false;
  let px = x;
  let pz = z;
  for (const c of colliders) {
    const r = resolveCircleCollider(px, pz, radius, c);
    if (r.hit) {
      hit = true;
      px = r.x;
      pz = r.z;
    }
  }
  return { x: px, z: pz, hit };
}

// ------------------------------------------------------------- misc utilities
export function pickWeighted(rngInstance, entries) {
  // entries: [{ value, weight }]. Returns one value, weighted by weight.
  let total = 0;
  for (const e of entries) total += e.weight;
  let roll = rngInstance.next() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll <= 0) return e.value;
  }
  return entries[entries.length - 1].value;
}

export function arrayRemove(array, item) {
  const i = array.indexOf(item);
  if (i >= 0) array.splice(i, 1);
  return array;
}

export function debounce(fn, waitMs) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}
