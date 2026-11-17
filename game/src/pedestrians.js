// pedestrians.js — the people of Marisol Bay, walking its sidewalks.
//
// This module owns every pedestrian: procedural walkers with varied looks
// (height, skin, hair, shirt and trouser colours — all built from plain
// three.js shapes), strolling along the sidewalks next to the city module's
// roads, and running away in a panic when something threatens them — a
// gunshot, a car bearing down fast, or the player attacking.
//
// Public interface (what main.js, combat.js and vehicles.js call):
//   createPedestrianSystem(scene, city, options)
//     options.count — how many pedestrians to spawn at once (default 24).
//     Returns the system:
//       system.pedestrians — every live pedestrian
//       system.spawn(count) — add more walkers (up to an internal cap)
//       system.addThreat(x, z, radius, kind)
//                             — scare everyone near a point; kind is
//                               'gunshot' | 'car' | 'attack' (only used
//                               for how far the panic spreads)
//       system.fleeFrom(x, z, radius)
//                             — same as addThreat, plain-language alias
//       system.nearestPedestrian(pos, maxDist)
//                             — closest walker, for combat hit checks
//       system.update(dt, threats)
//                             — one frame: walk the sidewalks, run from
//                               threats. threats is an optional array of
//                               { x, z, radius } live danger points
//                               (for example the player's car while it
//                               speeds, or a fresh gunshot).
//       system.dispose()    — remove all pedestrians from the scene
//
// What this module expects from the city module (all optional — a default
// sidewalk grid is used when the city data is not there yet):
//   city.sidewalks — array of walkways, each { points: [{x, z}, ...] }.
//                    A pedestrian walks the points in order, then turns
//                    around and walks back.
//   city.lanes — if no sidewalks are given, walkways are built by offsetting
//                each lane sideways by half its width plus a pavement margin.
//   city.bounds — { minX, maxX, minZ, maxZ } of the walkable city.
//
// A pedestrian is a plain object with a THREE.Group body:
//   ped.group, ped.heading, ped.speed, ped.state ('walking' | 'fleeing' |
//   'idle'), ped.panic (0..1, decays after the danger passes), plus the
//   limb pivots used by the walk animation (ped.leftArm, ped.rightArm,
//   ped.leftLeg, ped.rightLeg).

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning — local to this module so it works before the city agent's
// config.js exists.
// ---------------------------------------------------------------------------
const MAX_PEDESTRIANS = 48;
const WALK_SPEED_MIN = 1.1;
const WALK_SPEED_MAX = 1.9;
const FLEE_SPEED = 5.2; // panicked run — still slower than a car
const PANIC_DECAY = 0.25; // panic per second once the danger is gone
const PANIC_RADIUS_GUNSHOT = 26;
const PANIC_RADIUS_CAR = 16;
const PANIC_RADIUS_ATTACK = 12;
const IDLE_CHANCE = 0.12; // walkers who pause and look around at waypoints
const IDLE_TIME_MIN = 2;
const IDLE_TIME_MAX = 6;

const SKIN_TONES = [0xc98d64, 0x8a5a3b, 0xe8b98d, 0x6e4426, 0xd9a077];
const HAIR_COLORS = [0x2b1d12, 0x111111, 0x6e4a1f, 0x9a9a9a, 0x3d2b1f];
const HAIR_STYLES = ['cap', 'bun', 'short', 'long'];
const SHIRT_COLORS = [
  0xe23b3b, 0x2f7fd0, 0xf2b234, 0x37b268, 0xf2f0e6,
  0x8a5fbf, 0xe87aa0, 0x3a6b4f, 0xd97b2f, 0x5b7a99,
];
const TROUSER_COLORS = [0x2e3d55, 0x3a3a3a, 0x6b4a2f, 0x7a7f8a, 0x243b2e];
const SHOE_COLOR = 0x2a2320;

// ---------------------------------------------------------------------------
// One procedural walker. Same idea as the player body (boxes, spheres,
// cylinders with pivots at shoulders and hips) but smaller, cheaper and
// randomised, so a street full of them reads as a crowd, not clones.
// ---------------------------------------------------------------------------
function buildPedestrianBody(random) {
  const group = new THREE.Group();
  const heightScale = 0.92 + random() * 0.16; // 0.92 .. 1.08

  const skin = new THREE.MeshStandardMaterial({
    color: SKIN_TONES[Math.floor(random() * SKIN_TONES.length)],
    roughness: 0.8,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: HAIR_COLORS[Math.floor(random() * HAIR_COLORS.length)],
    roughness: 0.95,
  });
  const shirt = new THREE.MeshStandardMaterial({
    color: SHIRT_COLORS[Math.floor(random() * SHIRT_COLORS.length)],
    roughness: 0.9,
  });
  const trousers = new THREE.MeshStandardMaterial({
    color: TROUSER_COLORS[Math.floor(random() * TROUSER_COLORS.length)],
    roughness: 0.9,
  });
  const shoe = new THREE.MeshStandardMaterial({ color: SHOE_COLOR, roughness: 0.85 });

  const addBox = (material, w, h, d, x, y, z, parent) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Torso and hips.
  addBox(shirt, 0.46, 0.56, 0.26, 0, 1.12, 0, group);
  addBox(trousers, 0.44, 0.2, 0.26, 0, 0.78, 0, group);

  // Head and hair — four simple styles so the crowd varies at a glance.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), skin);
  head.position.set(0, 1.6, 0);
  head.castShadow = true;
  group.add(head);
  const style = HAIR_STYLES[Math.floor(random() * HAIR_STYLES.length)];
  if (style === 'cap') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.195, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat);
    cap.position.set(0, 1.64, 0);
    group.add(cap);
  } else if (style === 'bun') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.195, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), hairMat);
    cap.position.set(0, 1.64, 0);
    group.add(cap);
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), hairMat);
    bun.position.set(0, 1.78, -0.12);
    group.add(bun);
  } else if (style === 'long') {
    addBox(hairMat, 0.3, 0.42, 0.12, 0, 1.52, -0.14, group);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.195, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), hairMat);
    cap.position.set(0, 1.64, 0);
    group.add(cap);
  } else {
    // 'short': a flat hair slab on top of the head.
    addBox(hairMat, 0.32, 0.07, 0.32, 0, 1.76, 0, group);
  }

  // Arms and legs on pivots, like the player's, for the same swing walk.
  const makeArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.28 * side, 1.36, 0);
    addBox(shirt, 0.13, 0.48, 0.15, 0, -0.24, 0, pivot);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), skin);
    hand.position.set(0, -0.5, 0);
    pivot.add(hand);
    group.add(pivot);
    return pivot;
  };
  const makeLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.12 * side, 0.7, 0);
    addBox(trousers, 0.17, 0.56, 0.19, 0, -0.28, 0, pivot);
    addBox(shoe, 0.18, 0.08, 0.28, 0, -0.6, 0.04, pivot);
    group.add(pivot);
    return pivot;
  };

  group.scale.setScalar(heightScale);
  return {
    group,
    leftArm: makeArm(-1),
    rightArm: makeArm(1),
    leftLeg: makeLeg(-1),
    rightLeg: makeLeg(1),
  };
}

// Default sidewalks (used only when the city module supplies none): pavements
// running alongside a 5x5 street grid, 40 metres apart.
function defaultSidewalks() {
  const walks = [];
  const step = 40;
  for (let i = -2; i <= 2; i += 1) {
    const c = i * step;
    walks.push({ points: [{ x: c - 6, z: -100 }, { x: c - 6, z: 100 }] });
    walks.push({ points: [{ x: c + 6, z: 100 }, { x: c + 6, z: -100 }] });
    walks.push({ points: [{ x: -100, z: c - 6 }, { x: 100, z: c - 6 }] });
    walks.push({ points: [{ x: 100, z: c + 6 }, { x: -100, z: c + 6 }] });
  }
  return walks;
}

// Sidewalks derived from lanes: each lane gets a pavement offset to its side.
function sidewalksFromLanes(lanes) {
  const walks = [];
  for (const lane of lanes) {
    if (!lane.points || lane.points.length < 2) continue;
    const offset = (lane.width || 7) / 2 + 2.5;
    for (const side of [-1, 1]) {
      const points = lane.points.map((p, i) => {
        const next = lane.points[Math.min(i + 1, lane.points.length - 1)];
        const prev = lane.points[Math.max(i - 1, 0)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        // Sideways = perpendicular of the road direction.
        return { x: p.x + (-dz / len) * offset * side, z: p.z + (dx / len) * offset * side };
      });
      walks.push({ points });
    }
  }
  return walks;
}

// ---------------------------------------------------------------------------
// Pedestrian system
// ---------------------------------------------------------------------------
export function createPedestrianSystem(scene, city = {}, options = {}) {
  let sidewalks = [];
  if (city.sidewalks && city.sidewalks.length > 0) {
    sidewalks = city.sidewalks;
  } else if (city.lanes && city.lanes.length > 0) {
    sidewalks = sidewalksFromLanes(city.lanes);
  } else {
    sidewalks = defaultSidewalks();
  }
  const bounds = city.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const random = typeof options.random === 'function' ? options.random : Math.random;

  const pedestrians = [];
  // Live danger points fed in by update(); each entry is { x, z, radius }.
  let activeThreats = [];

  function pickWalk() {
    return sidewalks[Math.floor(random() * sidewalks.length)];
  }

  function spawnOne() {
    if (pedestrians.length >= MAX_PEDESTRIANS) return null;
    const parts = buildPedestrianBody(random);
    const walk = pickWalk();
    // Spawn at a random spot ALONG a random segment of the walkway, not
    // just on its listed vertices — otherwise every walker would start
    // bunched at the same few corners.
    const segIndex = Math.floor(random() * (walk.points.length - 1));
    const a = walk.points[segIndex];
    const b = walk.points[segIndex + 1];
    const t = random();
    const point = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    // Stand a little off the exact line so walkers do not march in a row.
    const jitterX = (random() - 0.5) * 1.6;
    const jitterZ = (random() - 0.5) * 1.6;
    parts.group.position.set(point.x + jitterX, 0, point.z + jitterZ);
    scene.add(parts.group);

    const ped = {
      group: parts.group,
      leftArm: parts.leftArm,
      rightArm: parts.rightArm,
      leftLeg: parts.leftLeg,
      rightLeg: parts.rightLeg,
      heading: random() * Math.PI * 2,
      speed: 0,
      walkSpeed: WALK_SPEED_MIN + random() * (WALK_SPEED_MAX - WALK_SPEED_MIN),
      state: 'walking',
      panic: 0,
      walkPhase: random() * Math.PI * 2,
      walkway: walk,
      waypointIndex: Math.floor(random() * walk.points.length),
      walkDirection: random() < 0.5 ? 1 : -1,
      idleTimer: 0,
      fleeX: 0,
      fleeZ: 0,
    };
    ped.group.rotation.y = ped.heading;
    pedestrians.push(ped);
    return ped;
  }

  // --- fleeing --------------------------------------------------------------
  // Panic is a number 0..1. A threat sets it to 1; it decays once the danger
  // is gone. While panicking the walker runs directly away from the nearest
  // threat and ignores the sidewalk — getting off the pavement is the point.
  function scarePedestrian(ped, threatX, threatZ) {
    ped.panic = 1;
    ped.state = 'fleeing';
    ped.idleTimer = 0;
    const dx = ped.group.position.x - threatX;
    const dz = ped.group.position.z - threatZ;
    const len = Math.hypot(dx, dz) || 1;
    ped.fleeX = dx / len;
    ped.fleeZ = dz / len;
  }

  function updatePedestrian(ped, dt) {
    const pos = ped.group.position;

    // Check live threats first: the nearest danger inside its radius wins.
    let nearestThreat = null;
    let nearestDist = Infinity;
    for (const threat of activeThreats) {
      const dx = pos.x - threat.x;
      const dz = pos.z - threat.z;
      const dist = Math.hypot(dx, dz);
      if (dist < threat.radius && dist < nearestDist) {
        nearestThreat = threat;
        nearestDist = dist;
      }
    }
    if (nearestThreat) scarePedestrian(ped, nearestThreat.x, nearestThreat.z);

    if (ped.state === 'fleeing') {
      // Run away from the threat, steering gently so walkers spread out.
      const wobble = Math.sin(ped.walkPhase * 0.7) * 0.3;
      const runX = ped.fleeX + -ped.fleeZ * wobble;
      const runZ = ped.fleeZ + ped.fleeX * wobble;
      const len = Math.hypot(runX, runZ) || 1;
      const targetHeading = Math.atan2(-runX / len, -runZ / len);
      ped.heading = turnToward(ped.heading, targetHeading, dt * 5);
      ped.speed = FLEE_SPEED * (0.6 + ped.panic * 0.4);
      pos.x = THREE.MathUtils.clamp(pos.x + (runX / len) * ped.speed * dt, bounds.minX, bounds.maxX);
      pos.z = THREE.MathUtils.clamp(pos.z + (runZ / len) * ped.speed * dt, bounds.minZ, bounds.maxZ);
      ped.group.rotation.y = ped.heading;
      ped.walkPhase += dt * ped.speed * 2.2;
      swingLimbs(ped, 0.9);
      ped.panic = Math.max(0, ped.panic - PANIC_DECAY * dt);
      if (ped.panic <= 0) {
        // Calmed down: stroll again from the nearest point of a sidewalk,
        // rather than marching across the city to a random waypoint.
        ped.state = 'walking';
        ped.walkway = pickWalk();
        let nearestIndex = 0;
        let nearestDist = Infinity;
        ped.walkway.points.forEach((point, index) => {
          const d = (point.x - pos.x) ** 2 + (point.z - pos.z) ** 2;
          if (d < nearestDist) {
            nearestDist = d;
            nearestIndex = index;
          }
        });
        ped.waypointIndex = nearestIndex;
        ped.walkDirection = 1;
      }
      return;
    }

    // Idle: standing still, looking around, then carrying on.
    if (ped.state === 'idle') {
      ped.idleTimer -= dt;
      ped.speed = 0;
      ped.heading += Math.sin(ped.walkPhase) * dt * 0.4;
      ped.group.rotation.y = ped.heading;
      easeLimbs(ped, dt);
      if (ped.idleTimer <= 0) ped.state = 'walking';
      return;
    }

    // Walking: chase the next point on the sidewalk, then the next one.
    const points = ped.walkway.points;
    const target = points[ped.waypointIndex];
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.2) {
      ped.waypointIndex += ped.walkDirection;
      if (ped.waypointIndex >= points.length || ped.waypointIndex < 0) {
        // Reached the end: turn around and walk back the way we came.
        ped.walkDirection *= -1;
        ped.waypointIndex = THREE.MathUtils.clamp(ped.waypointIndex, 0, points.length - 1);
      }
      // Sometimes stop for a breather instead of marching on.
      if (random() < IDLE_CHANCE) {
        ped.state = 'idle';
        ped.idleTimer = IDLE_TIME_MIN + random() * (IDLE_TIME_MAX - IDLE_TIME_MIN);
      }
      return;
    }
    const targetHeading = Math.atan2(-dx, -dz);
    ped.heading = turnToward(ped.heading, targetHeading, dt * 4);
    ped.speed = ped.walkSpeed;
    pos.x += -Math.sin(ped.heading) * ped.speed * dt;
    pos.z += -Math.cos(ped.heading) * ped.speed * dt;
    ped.group.rotation.y = ped.heading;
    ped.walkPhase += dt * ped.speed * 2.0;
    swingLimbs(ped, 0.55);
  }

  function turnToward(current, target, maxStep) {
    let diff = target - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return current + THREE.MathUtils.clamp(diff, -maxStep, maxStep);
  }

  function swingLimbs(ped, amount) {
    const s = Math.sin(ped.walkPhase);
    ped.leftLeg.rotation.x = s * amount;
    ped.rightLeg.rotation.x = -s * amount;
    ped.leftArm.rotation.x = -s * amount * 0.7;
    ped.rightArm.rotation.x = s * amount * 0.7;
  }

  function easeLimbs(ped, dt) {
    const ease = Math.min(1, dt * 6);
    ped.leftLeg.rotation.x *= 1 - ease;
    ped.rightLeg.rotation.x *= 1 - ease;
    ped.leftArm.rotation.x *= 1 - ease;
    ped.rightArm.rotation.x *= 1 - ease;
  }

  // A scare event: gunshot, speeding car or attack. Everyone within the
  // radius panics; the radius depends on how scary the event is.
  function addThreat(x, z, radius, kind = 'attack') {
    let effectiveRadius = radius;
    if (kind === 'gunshot') effectiveRadius = Math.max(radius, PANIC_RADIUS_GUNSHOT);
    if (kind === 'car') effectiveRadius = Math.max(radius, PANIC_RADIUS_CAR);
    if (kind === 'attack') effectiveRadius = Math.max(radius, PANIC_RADIUS_ATTACK);
    for (const ped of pedestrians) {
      const dx = ped.group.position.x - x;
      const dz = ped.group.position.z - z;
      if (dx * dx + dz * dz < effectiveRadius * effectiveRadius) {
        scarePedestrian(ped, x, z);
      }
    }
  }

  // --- the system object ----------------------------------------------------
  const system = {
    pedestrians,

    spawn(count = 1) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const ped = spawnOne();
        if (ped) made.push(ped);
      }
      return made;
    },

    addThreat,

    fleeFrom(x, z, radius = PANIC_RADIUS_ATTACK) {
      addThreat(x, z, radius, 'attack');
    },

    nearestPedestrian(pos, maxDist = 3) {
      let best = null;
      let bestDist = maxDist;
      for (const ped of pedestrians) {
        const dx = ped.group.position.x - pos.x;
        const dz = ped.group.position.z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < bestDist) {
          best = ped;
          bestDist = dist;
        }
      }
      return best;
    },

    update(dt, threats = []) {
      activeThreats = threats || [];
      for (const ped of pedestrians) updatePedestrian(ped, dt);
      activeThreats = [];
    },

    dispose() {
      for (const ped of pedestrians) scene.remove(ped.group);
      pedestrians.length = 0;
    },
  };

  // Seed the streets right away so the city never looks empty.
  system.spawn(options.count !== undefined ? options.count : 24);
  return system;
}
