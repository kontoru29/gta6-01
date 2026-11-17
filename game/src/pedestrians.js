// pedestrians.js — the people of Marisol Bay, out on its sidewalks.
//
// This module owns the crowd: procedural walkers in varied clothes and
// heights, strolling the pavements beside the city roads, pausing now and
// then to look around, and breaking into a panicked run when something
// scares them — a gunshot, a speeding car, or Leo throwing a punch.
//
// What other modules call (the contract — keep every name and signature):
//   createPedestrianSystem(scene, city, options)
//     options.count  — how many walkers to have out at once (default 26).
//     options.random — a random function; Math.random when not given.
//     Returns the system:
//       system.pedestrians — every live walker, in spawn order.
//       system.spawn(count) — add more walkers (up to an internal cap).
//       system.addThreat(x, z, radius, kind)
//                             — scare everyone near a point. kind is
//                               'gunshot' | 'car' | 'attack'; scarier kinds
//                               spread the panic further than the radius.
//       system.fleeFrom(x, z, radius)
//                             — the same scare, plain-language alias.
//       system.nearestPedestrian(pos, maxDist)
//                             — the closest walker, for combat hit checks.
//       system.update(dt, threats)
//                             — one frame: walk the pavements, run from
//                               danger. threats is an optional array of
//                               { x, z, radius } live danger points (the
//                               player's speeding car, a fresh gunshot).
//       system.dispose()    — take every walker out of the scene.
//
// What this module wants from the city (all optional — a default pavement
// grid is used when the city hands over nothing):
//   city.sidewalks — walkways, each { points: [{x, z}, ...] }; a walker
//                    follows the points in order, then turns and walks back.
//   city.lanes     — without sidewalks, pavements are derived by pushing
//                    each lane sideways by half its width plus a margin.
//   city.bounds    — { minX, maxX, minZ, maxZ } of the walkable city.
//
// A walker is a plain object carrying its THREE.Group body:
//   walker.group, walker.heading, walker.speed, walker.state
//   ('walking' | 'idle' | 'fleeing'), walker.panic (0..1, fading once the
//   danger is gone), plus the limb pivots the walk animation swings
//   (walker.armLeft, walker.armRight, walker.legLeft, walker.legRight).
//   main.js also sets walker.health and walker.alive for combat; they are
//   initialised here so the fields always exist.

import * as THREE from 'three';
import { PEDESTRIANS } from './config.js';
import {
  clamp,
  lerpAngle,
  randomPick,
  distance2D,
} from './utils.js';

// ---------------------------------------------------------------------------
// Tuning — local to this module so it still works on its own.
// ---------------------------------------------------------------------------
const MAX_WALKERS = 48;
const PANIC_FADE = 0.25; // panic lost per second once the danger is gone
const SCARE_GUNSHOT = 26; // metres a gunshot's panic reaches, at least
const SCARE_CAR = 16; // metres a speeding car's panic reaches, at least
const SCARE_ATTACK = 12; // metres a punch's panic reaches, at least
const PAUSE_CHANCE = 0.12; // walkers who stop for a breather at waypoints
const PAUSE_SHORT = 2; // seconds, shortest breather
const PAUSE_LONG = 6; // seconds, longest breather
const WALK_SPEED_MIN = PEDESTRIANS.walkSpeedMin;
const WALK_SPEED_MAX = PEDESTRIANS.walkSpeedMax;
const FLEE_SPEED = PEDESTRIANS.fleeSpeed;

// Crowd variety: skin, hair, shirts and trousers picked per walker, so a
// street full of them reads as people, not clones.
const SKIN_TONES = [0xc98d64, 0x8a5a3b, 0xe8b98d, 0x6e4426, 0xd9a077];
const HAIR_COLORS = [0x2b1d12, 0x111111, 0x6e4a1f, 0x9a9a9a, 0x3d2b1f];
const HAIR_STYLES = ['cap', 'tail', 'flat', 'afro'];
const SHIRT_COLORS = [
  0xe23b3b, 0x2f7fd0, 0xf2b234, 0x37b268, 0xf2f0e6,
  0x8a5fbf, 0xe87aa0, 0x3a6b4f, 0xd97b2f, 0x5b7a99,
];
const TROUSER_COLORS = [0x2e3d55, 0x3a3a3a, 0x6b4a2f, 0x7a7f8a, 0x243b2e];
const SHOE_COLOR = 0x2a2320;

// ---------------------------------------------------------------------------
// One procedural walker. Same idea as Leo's figure — boxes, spheres and
// cylinders on pivots at shoulders and hips — but smaller, cheaper and
// randomised, so a street full of them reads as a crowd.
// ---------------------------------------------------------------------------
function makeWalkerFigure(rand) {
  const root = new THREE.Group();
  const stature = 0.92 + rand() * 0.16; // 0.92 .. 1.08, a head of variety

  const skinMat = new THREE.MeshStandardMaterial({
    color: randomPick(SKIN_TONES, rand), roughness: 0.8,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: randomPick(HAIR_COLORS, rand), roughness: 0.95,
  });
  const shirtMat = new THREE.MeshStandardMaterial({
    color: randomPick(SHIRT_COLORS, rand), roughness: 0.9,
  });
  const trouserMat = new THREE.MeshStandardMaterial({
    color: randomPick(TROUSER_COLORS, rand), roughness: 0.9,
  });
  const shoeMat = new THREE.MeshStandardMaterial({ color: SHOE_COLOR, roughness: 0.85 });

  // A slab is a box dropped into place, shadow and all.
  function slab(material, size, at, parent) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // Shirt torso, trouser hips, head, then hair in one of four styles.
  slab(shirtMat, [0.48, 0.58, 0.28], [0, 1.14, 0], root);
  slab(trouserMat, [0.46, 0.2, 0.28], [0, 0.8, 0], root);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skinMat);
  head.position.set(0, 1.62, 0);
  head.castShadow = true;
  root.add(head);

  const style = randomPick(HAIR_STYLES, rand);
  if (style === 'cap') {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      hairMat,
    );
    cap.position.set(0, 1.66, 0);
    root.add(cap);
  } else if (style === 'tail') {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.45),
      hairMat,
    );
    cap.position.set(0, 1.66, 0);
    root.add(cap);
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), hairMat);
    tail.position.set(0, 1.6, -0.2);
    root.add(tail);
  } else if (style === 'afro') {
    const afro = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), hairMat);
    afro.position.set(0, 1.72, 0);
    afro.scale.set(1, 0.85, 1);
    root.add(afro);
  } else {
    // 'flat': a low slab of hair across the top of the head.
    slab(hairMat, [0.34, 0.07, 0.34], [0, 1.78, 0], root);
  }

  // Arms and legs hang from pivots, like Leo's, for the same swing walk.
  function buildArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.29 * side, 1.38, 0);
    slab(shirtMat, [0.14, 0.5, 0.16], [0, -0.25, 0], pivot);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), skinMat);
    hand.position.set(0, -0.52, 0);
    pivot.add(hand);
    root.add(pivot);
    return pivot;
  }
  function buildLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.13 * side, 0.72, 0);
    slab(trouserMat, [0.18, 0.58, 0.2], [0, -0.29, 0], pivot);
    slab(shoeMat, [0.19, 0.08, 0.3], [0, -0.62, 0.04], pivot);
    root.add(pivot);
    return pivot;
  }

  root.scale.setScalar(stature);
  return {
    root,
    armLeft: buildArm(-1),
    armRight: buildArm(1),
    legLeft: buildLeg(-1),
    legRight: buildLeg(1),
  };
}

// Fallback pavements (only when the city supplies neither sidewalks nor
// lanes): walkways running alongside a 5x5 street grid, 40 metres apart.
function fallbackRoutes() {
  const routes = [];
  const step = 40;
  for (let i = -2; i <= 2; i += 1) {
    const c = i * step;
    routes.push({ points: [{ x: c - 6, z: -100 }, { x: c - 6, z: 100 }] });
    routes.push({ points: [{ x: c + 6, z: 100 }, { x: c + 6, z: -100 }] });
    routes.push({ points: [{ x: -100, z: c - 6 }, { x: 100, z: c - 6 }] });
    routes.push({ points: [{ x: 100, z: c + 6 }, { x: -100, z: c + 6 }] });
  }
  return routes;
}

// Pavements derived from lanes: each lane gets a walkway pushed to each
// side by half the road width plus a pavement margin.
function routesFromLanes(lanes) {
  const routes = [];
  for (const lane of lanes) {
    if (!lane.points || lane.points.length < 2) continue;
    const offset = (lane.width || 7) / 2 + 2.5;
    for (const side of [-1, 1]) {
      const points = lane.points.map((point, i) => {
        const next = lane.points[Math.min(i + 1, lane.points.length - 1)];
        const prev = lane.points[Math.max(i - 1, 0)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const length = Math.hypot(dx, dz) || 1;
        // Sideways is the perpendicular of the road direction.
        return {
          x: point.x + (-dz / length) * offset * side,
          z: point.z + (dx / length) * offset * side,
        };
      });
      routes.push({ points });
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Pedestrian system
// ---------------------------------------------------------------------------
export function createPedestrianSystem(scene, city = {}, options = {}) {
  let routes = [];
  if (city.sidewalks && city.sidewalks.length > 0) {
    routes = city.sidewalks;
  } else if (city.lanes && city.lanes.length > 0) {
    routes = routesFromLanes(city.lanes);
  } else {
    routes = fallbackRoutes();
  }
  const limits = city.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const rand = typeof options.random === 'function' ? options.random : Math.random;

  const walkers = [];
  // Danger points fed in by update() this frame; each is { x, z, radius }.
  let liveThreats = [];

  function pickRoute() {
    return routes[Math.floor(rand() * routes.length)];
  }

  function spawnOne() {
    if (walkers.length >= MAX_WALKERS) return null;
    const figure = makeWalkerFigure(rand);
    const route = pickRoute();
    // Spawn at a random spot ALONG a random stretch of the route, not on
    // its listed corners — otherwise every walker would start bunched up.
    const legIndex = Math.floor(rand() * (route.points.length - 1));
    const from = route.points[legIndex];
    const to = route.points[legIndex + 1];
    const along = rand();
    const spotX = from.x + (to.x - from.x) * along + (rand() - 0.5) * 1.6;
    const spotZ = from.z + (to.z - from.z) * along + (rand() - 0.5) * 1.6;
    figure.root.position.set(spotX, 0, spotZ);
    scene.add(figure.root);

    const walker = {
      group: figure.root,
      armLeft: figure.armLeft,
      armRight: figure.armRight,
      legLeft: figure.legLeft,
      legRight: figure.legRight,
      heading: rand() * Math.PI * 2,
      speed: 0,
      walkSpeed: WALK_SPEED_MIN + rand() * (WALK_SPEED_MAX - WALK_SPEED_MIN),
      state: 'walking',
      panic: 0,
      health: 40,
      alive: true,
      walkPhase: rand() * Math.PI * 2,
      route,
      routeIndex: Math.floor(rand() * route.points.length),
      routeDir: rand() < 0.5 ? 1 : -1,
      idleLeft: 0,
      fleeX: 0,
      fleeZ: 0,
    };
    walker.group.rotation.y = walker.heading;
    walkers.push(walker);
    return walker;
  }

  // --- panic ---------------------------------------------------------------
  // Panic is a number 0..1. A scare sets it to 1; it fades once the danger
  // is gone. While panicking the walker runs straight away from the nearest
  // threat and leaves the pavement — getting off the road is the point.
  function scareWalker(walker, threatX, threatZ) {
    walker.panic = 1;
    walker.state = 'fleeing';
    walker.idleLeft = 0;
    const dx = walker.group.position.x - threatX;
    const dz = walker.group.position.z - threatZ;
    const length = Math.hypot(dx, dz) || 1;
    walker.fleeX = dx / length;
    walker.fleeZ = dz / length;
  }

  function turnWalker(walker, targetHeading, dt, rate) {
    walker.heading = lerpAngle(walker.heading, targetHeading, rate * dt);
  }

  function swingWalker(walker, amount) {
    const wave = Math.sin(walker.walkPhase);
    walker.legLeft.rotation.x = wave * amount;
    walker.legRight.rotation.x = -wave * amount;
    walker.armLeft.rotation.x = -wave * amount * 0.7;
    walker.armRight.rotation.x = wave * amount * 0.7;
  }

  function restWalker(walker, dt) {
    const ease = Math.min(1, dt * 6);
    walker.legLeft.rotation.x *= 1 - ease;
    walker.legRight.rotation.x *= 1 - ease;
    walker.armLeft.rotation.x *= 1 - ease;
    walker.armRight.rotation.x *= 1 - ease;
  }

  // Fleeing walkers drift apart from each other a little, so a panicked
  // crowd spreads instead of running in a single clump.
  function separationNudge(walker) {
    let pushX = 0;
    let pushZ = 0;
    for (const other of walkers) {
      if (other === walker || other.state !== 'fleeing') continue;
      const dx = walker.group.position.x - other.group.position.x;
      const dz = walker.group.position.z - other.group.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 2.25 && distSq > 0.0001) {
        const dist = Math.sqrt(distSq);
        pushX += (dx / dist) * (1.5 - dist);
        pushZ += (dz / dist) * (1.5 - dist);
      }
    }
    return { x: pushX, z: pushZ };
  }

  function stepWalker(walker, dt) {
    const pos = walker.group.position;

    // Live threats first: the closest danger inside its radius wins.
    let closestThreat = null;
    let closestDist = Infinity;
    for (const threat of liveThreats) {
      const dist = distance2D(pos.x, pos.z, threat.x, threat.z);
      if (dist < threat.radius && dist < closestDist) {
        closestThreat = threat;
        closestDist = dist;
      }
    }
    if (closestThreat) scareWalker(walker, closestThreat.x, closestThreat.z);

    if (walker.state === 'fleeing') {
      // Run away from the threat, weaving gently so walkers fan out.
      const weave = Math.sin(walker.walkPhase * 0.7) * 0.3;
      const nudge = separationNudge(walker);
      let runX = walker.fleeX + -walker.fleeZ * weave + nudge.x * 0.4;
      let runZ = walker.fleeZ + walker.fleeX * weave + nudge.z * 0.4;
      const runLength = Math.hypot(runX, runZ) || 1;
      runX /= runLength;
      runZ /= runLength;
      turnWalker(walker, Math.atan2(-runX, -runZ), dt, 5);
      walker.speed = FLEE_SPEED * (0.6 + walker.panic * 0.4);
      pos.x = clamp(pos.x + runX * walker.speed * dt, limits.minX, limits.maxX);
      pos.z = clamp(pos.z + runZ * walker.speed * dt, limits.minZ, limits.maxZ);
      walker.group.rotation.y = walker.heading;
      walker.walkPhase += dt * walker.speed * 2.2;
      swingWalker(walker, 0.9);
      walker.panic = Math.max(0, walker.panic - PANIC_FADE * dt);
      if (walker.panic <= 0) {
        // Calmed down: stroll again from the closest point of a route,
        // instead of marching across the city to a random waypoint.
        walker.state = 'walking';
        walker.route = pickRoute();
        let nearestIndex = 0;
        let nearestDist = Infinity;
        walker.route.points.forEach((point, index) => {
          const d = (point.x - pos.x) * (point.x - pos.x) + (point.z - pos.z) * (point.z - pos.z);
          if (d < nearestDist) {
            nearestDist = d;
            nearestIndex = index;
          }
        });
        walker.routeIndex = nearestIndex;
        walker.routeDir = 1;
      }
      return;
    }

    // Idle: standing still, looking around, then carrying on.
    if (walker.state === 'idle') {
      walker.idleLeft -= dt;
      walker.speed = 0;
      walker.heading += Math.sin(walker.walkPhase) * dt * 0.4;
      walker.group.rotation.y = walker.heading;
      restWalker(walker, dt);
      if (walker.idleLeft <= 0) walker.state = 'walking';
      return;
    }

    // Walking: chase the next point on the route, then the next one.
    const points = walker.route.points;
    const target = points[walker.routeIndex];
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.2) {
      walker.routeIndex += walker.routeDir;
      if (walker.routeIndex >= points.length || walker.routeIndex < 0) {
        // Reached the end: turn around and walk back the way we came.
        walker.routeDir *= -1;
        walker.routeIndex = clamp(walker.routeIndex, 0, points.length - 1);
      }
      // Sometimes stop for a breather instead of marching on.
      if (rand() < PAUSE_CHANCE) {
        walker.state = 'idle';
        walker.idleLeft = PAUSE_SHORT + rand() * (PAUSE_LONG - PAUSE_SHORT);
      }
      return;
    }
    turnWalker(walker, Math.atan2(-dx, -dz), dt, 4);
    walker.speed = walker.walkSpeed;
    pos.x += -Math.sin(walker.heading) * walker.speed * dt;
    pos.z += -Math.cos(walker.heading) * walker.speed * dt;
    walker.group.rotation.y = walker.heading;
    walker.walkPhase += dt * walker.speed * 2.0;
    swingWalker(walker, 0.55);
  }

  // A scare event: gunshot, speeding car or attack. Everyone within the
  // radius panics; the radius depends on how scary the event is.
  function addThreat(x, z, radius, kind = 'attack') {
    let effectiveRadius = radius;
    if (kind === 'gunshot') effectiveRadius = Math.max(radius, SCARE_GUNSHOT);
    if (kind === 'car') effectiveRadius = Math.max(radius, SCARE_CAR);
    if (kind === 'attack') effectiveRadius = Math.max(radius, SCARE_ATTACK);
    for (const walker of walkers) {
      const dx = walker.group.position.x - x;
      const dz = walker.group.position.z - z;
      if (dx * dx + dz * dz < effectiveRadius * effectiveRadius) {
        scareWalker(walker, x, z);
      }
    }
  }

  // --- the system object ----------------------------------------------------
  const system = {
    pedestrians: walkers,

    spawn(count = 1) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const walker = spawnOne();
        if (walker) made.push(walker);
      }
      return made;
    },

    addThreat,

    fleeFrom(x, z, radius = SCARE_ATTACK) {
      addThreat(x, z, radius, 'attack');
    },

    nearestPedestrian(pos, maxDist = 3) {
      let best = null;
      let bestDist = maxDist;
      for (const walker of walkers) {
        const dist = distance2D(walker.group.position.x, walker.group.position.z, pos.x, pos.z);
        if (dist < bestDist) {
          best = walker;
          bestDist = dist;
        }
      }
      return best;
    },

    update(dt, threats = []) {
      liveThreats = threats || [];
      for (const walker of walkers) stepWalker(walker, dt);
      liveThreats = [];
    },

    dispose() {
      for (const walker of walkers) scene.remove(walker.group);
      walkers.length = 0;
    },
  };

  // Seed the streets right away so the city never looks empty.
  system.spawn(options.count !== undefined ? options.count : PEDESTRIANS.count);
  return system;
}
