// pedestrians.js — the people of Marisol Bay, out on its sidewalks.
//
// This module owns the crowd: procedural walkers in varied clothes and
// heights, strolling the pavements beside the city roads, pausing now and
// then to look around, and breaking into a panicked run when something
// scares them — a gunshot, a speeding car, or Leo throwing a punch.
//
// New this round: a quarter of the crowd walks in pairs — two friends on
// the same route, a few steps apart — and one walker in five strolls with
// a glowing phone in hand, head down, a little slower than everyone else.
// The street reads as people living their lives, not clones on a rail.
//
// The contract other modules rely on (every name and signature stays):
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
  distance2D,
} from './utils.js';

// ---------------------------------------------------------------------------
// Tuning — local to this module so it still works on its own.
// ---------------------------------------------------------------------------
const CROWD_LIMIT = 48;
const PANIC_DECAY = 0.25; // panic lost per second once the danger is gone
const REACH_GUNSHOT = 26; // metres a gunshot's panic reaches, at least
const REACH_CAR = 16; // metres a speeding car's panic reaches, at least
const REACH_ATTACK = 12; // metres a punch's panic reaches, at least
const BREATHER_ODDS = 0.12; // walkers who stop for a breather at waypoints
const BREATHER_MIN = 2; // seconds, shortest breather
const BREATHER_MAX = 6; // seconds, longest breather
const DODGE_NOTICE = 2.2; // how much further than a threat's radius a walker notices it
const DODGE_SPAN = 0.5; // seconds a sidestep lasts
const DODGE_PACE = 2.0; // metres per second, stepping sideways
const DODGE_WAIT = 1.2; // seconds before the same walker dodges again
const PAIR_ODDS = 0.25; // walkers who arrive with a friend on the same route
const PHONE_ODDS = 0.2; // walkers glued to a glowing phone, head down
const PHONE_SLOWDOWN = 0.75; // phone walkers stroll this much slower

// One shared empty threat list, used when update() gets no threats —
// assigning it costs nothing, unlike building a fresh array per frame.
const NO_THREATS = [];
const STROLL_SLOW = PEDESTRIANS.walkSpeedMin;
const STROLL_FAST = PEDESTRIANS.walkSpeedMax;
const RUN_SPEED = PEDESTRIANS.fleeSpeed;

// Crowd variety: skin, hair, shirts and trousers picked per walker, so a
// street full of them reads as people, not clones.
const SKIN_TONES = [0xc98d64, 0x8a5a3b, 0xe8b98d, 0x6e4426, 0xd9a077];
const HAIR_TONES = [0x2b1d12, 0x111111, 0x6e4a1f, 0x9a9a9a, 0x3d2b1f];
const HAIR_STYLES = ['cap', 'tail', 'flat', 'afro'];
const SHIRT_TONES = [
  0xe23b3b, 0x2f7fd0, 0xf2b234, 0x37b268, 0xf2f0e6,
  0x8a5fbf, 0xe87aa0, 0x3a6b4f, 0xd97b2f, 0x5b7a99,
];
const PANTS_TONES = [0x2e3d55, 0x3a3a3a, 0x6b4a2f, 0x7a7f8a, 0x243b2e];
const SHOE_TONE = 0x2a2320;

// ---------------------------------------------------------------------------
// One procedural walker. Same idea as Leo's figure — boxes, spheres and
// cylinders on pivots at shoulders and hips — but smaller, cheaper and
// randomised, so a street full of them reads as a crowd.
// ---------------------------------------------------------------------------
function buildFigure(rand) {
  const body = new THREE.Group();
  const stature = 0.92 + rand() * 0.16; // 0.92 .. 1.08, a head of variety

  // Pick one entry from a list with the injected random source.
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const skinMat = new THREE.MeshStandardMaterial({
    color: pick(SKIN_TONES), roughness: 0.8,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: pick(HAIR_TONES), roughness: 0.95,
  });
  const shirtMat = new THREE.MeshStandardMaterial({
    color: pick(SHIRT_TONES), roughness: 0.9,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: pick(PANTS_TONES), roughness: 0.9,
  });
  const shoeMat = new THREE.MeshStandardMaterial({ color: SHOE_TONE, roughness: 0.85 });

  // A slab is a box dropped into place, shadow and all.
  function slab(material, size, at, parent) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // Shirt torso, trouser hips, head, then hair in one of four styles.
  slab(shirtMat, [0.48, 0.58, 0.28], [0, 1.14, 0], body);
  slab(pantsMat, [0.46, 0.2, 0.28], [0, 0.8, 0], body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skinMat);
  head.position.set(0, 1.62, 0);
  head.castShadow = true;
  body.add(head);

  const style = pick(HAIR_STYLES);
  if (style === 'cap') {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      hairMat,
    );
    cap.position.set(0, 1.66, 0);
    body.add(cap);
  } else if (style === 'tail') {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.45),
      hairMat,
    );
    cap.position.set(0, 1.66, 0);
    body.add(cap);
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), hairMat);
    tail.position.set(0, 1.6, -0.2);
    body.add(tail);
  } else if (style === 'afro') {
    const afro = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), hairMat);
    afro.position.set(0, 1.72, 0);
    afro.scale.set(1, 0.85, 1);
    body.add(afro);
  } else {
    // 'flat': a low slab of hair across the top of the head.
    slab(hairMat, [0.34, 0.07, 0.34], [0, 1.78, 0], body);
  }

  // Arms and legs hang from pivots, like Leo's, for the same swing walk.
  function buildArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.29 * side, 1.38, 0);
    slab(shirtMat, [0.14, 0.5, 0.16], [0, -0.25, 0], pivot);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), skinMat);
    hand.position.set(0, -0.52, 0);
    pivot.add(hand);
    body.add(pivot);
    return pivot;
  }
  function buildLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.13 * side, 0.72, 0);
    slab(pantsMat, [0.18, 0.58, 0.2], [0, -0.29, 0], pivot);
    slab(shoeMat, [0.19, 0.08, 0.3], [0, -0.62, 0.04], pivot);
    body.add(pivot);
    return pivot;
  }

  const armLeft = buildArm(-1);
  const armRight = buildArm(1);

  // One walker in five is glued to a phone: a small glowing slab held in
  // the right hand, head tilted down at it, strolling a little slower.
  let phone = null;
  if (rand() < PHONE_ODDS) {
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x16222e, emissive: 0x7fb8d9, emissiveIntensity: 1.2, roughness: 0.4,
    });
    phone = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.02), screenMat);
    phone.position.set(0, -0.55, 0.08);
    phone.rotation.x = -0.7;
    armRight.add(phone);
    head.rotation.x = 0.35;
  }

  body.scale.setScalar(stature);
  return {
    root: body,
    head,
    armLeft,
    armRight,
    legLeft: buildLeg(-1),
    legRight: buildLeg(1),
    hasPhone: phone !== null,
  };
}

// Fallback pavements (only when the city supplies neither sidewalks nor
// lanes): walkways running alongside a 5x5 street grid, 40 metres apart.
function gridRoutes() {
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
    routes = gridRoutes();
  }
  const limits = city.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const rand = typeof options.random === 'function' ? options.random : Math.random;

  const walkers = [];
  // Danger points fed in by update() this frame; each is { x, z, radius }.
  let liveThreats = [];

  function chooseRoute() {
    return routes[Math.floor(rand() * routes.length)];
  }

  function spawnWalker(sharedRoute, sharedIndex) {
    if (walkers.length >= CROWD_LIMIT) return null;
    const figure = buildFigure(rand);
    const route = sharedRoute || chooseRoute();
    // Spawn at a random spot ALONG a random stretch of the route, not on
    // its listed corners — otherwise every walker would start bunched up.
    const legCount = Math.max(1, route.points.length - 1);
    const legIndex = sharedIndex !== undefined
      ? Math.min(sharedIndex, legCount - 1)
      : Math.floor(rand() * legCount);
    const from = route.points[legIndex];
    const to = route.points[legIndex + 1];
    const along = rand();
    const spotX = from.x + (to.x - from.x) * along + (rand() - 0.5) * 1.6;
    const spotZ = from.z + (to.z - from.z) * along + (rand() - 0.5) * 1.6;
    figure.root.position.set(spotX, 0, spotZ);
    scene.add(figure.root);

    const walker = {
      group: figure.root,
      head: figure.head,
      armLeft: figure.armLeft,
      armRight: figure.armRight,
      legLeft: figure.legLeft,
      legRight: figure.legRight,
      hasPhone: figure.hasPhone,
      heading: rand() * Math.PI * 2,
      speed: 0,
      walkSpeed: STROLL_SLOW + rand() * (STROLL_FAST - STROLL_SLOW),
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
      // Sidestep state: a short sideways hop when a car comes close.
      dodgeT: 0,
      dodgeCool: 0,
      dodgeX: 0,
      dodgeZ: 0,
      // Gait variety: every walker swings their arms a little differently.
      swing: 0.45 + rand() * 0.25,
    };
    if (walker.hasPhone) walker.walkSpeed *= PHONE_SLOWDOWN;
    walker.group.rotation.y = walker.heading;
    walkers.push(walker);
    return walker;
  }

  // A pair: two friends on the same route, a few steps apart, walking the
  // same way. The second one shares the first's route and direction.
  function spawnPair() {
    const first = spawnWalker();
    if (!first) return [];
    const second = spawnWalker(first.route, first.routeIndex);
    if (!second) return [first];
    second.routeDir = first.routeDir;
    second.routeIndex = Math.max(0, first.routeIndex - 1);
    second.group.position.x = first.group.position.x + 1.2;
    second.group.position.z = first.group.position.z + 0.8;
    return [first, second];
  }

  // --- panic ---------------------------------------------------------------
  // Panic is a number 0..1. A scare sets it to 1; it fades once the danger
  // is gone. While panicking the walker runs straight away from the nearest
  // threat and leaves the pavement — getting off the road is the point.
  function panicWalker(walker, threatX, threatZ) {
    walker.panic = 1;
    walker.state = 'fleeing';
    walker.idleLeft = 0;
    const dx = walker.group.position.x - threatX;
    const dz = walker.group.position.z - threatZ;
    const length = Math.hypot(dx, dz) || 1;
    walker.fleeX = dx / length;
    walker.fleeZ = dz / length;
  }

  function faceToward(walker, targetHeading, dt, rate) {
    walker.heading = lerpAngle(walker.heading, targetHeading, rate * dt);
  }

  function swingLimbs(walker, amount) {
    const wave = Math.sin(walker.walkPhase);
    walker.legLeft.rotation.x = wave * amount;
    walker.legRight.rotation.x = -wave * amount;
    // A phone walker keeps the right arm bent at the phone instead of
    // swinging it; the left arm swings alone.
    if (walker.hasPhone) {
      walker.armRight.rotation.x = -0.9;
      walker.armLeft.rotation.x = -wave * amount * 0.7;
    } else {
      walker.armLeft.rotation.x = -wave * amount * 0.7;
      walker.armRight.rotation.x = wave * amount * 0.7;
    }
  }

  function settleLimbs(walker, dt) {
    const ease = Math.min(1, dt * 6);
    walker.legLeft.rotation.x *= 1 - ease;
    walker.legRight.rotation.x *= 1 - ease;
    walker.armLeft.rotation.x *= 1 - ease;
    if (!walker.hasPhone) walker.armRight.rotation.x *= 1 - ease;
  }

  // (Separation between fleeing walkers is computed inline in stepWalker,
  // straight into local numbers — no throwaway object per walker per frame.)

  function stepWalker(walker, dt) {
    const pos = walker.group.position;

    // Live threats first: the closest danger inside its radius wins.
    // In the same pass, notice a threat just outside the panic radius —
    // a car closing in is worth a sidestep, not a full-blown panic.
    let nearestThreat = null;
    let nearestDist = Infinity;
    let nearThreat = null;
    let nearDist = Infinity;
    for (const threat of liveThreats) {
      const dist = distance2D(pos.x, pos.z, threat.x, threat.z);
      if (dist < threat.radius && dist < nearestDist) {
        nearestThreat = threat;
        nearestDist = dist;
      } else if (dist < threat.radius * DODGE_NOTICE && dist < nearDist) {
        nearThreat = threat;
        nearDist = dist;
      }
    }
    if (nearestThreat) panicWalker(walker, nearestThreat.x, nearestThreat.z);

    // Sidestep timers tick down in every state.
    if (walker.dodgeCool > 0) walker.dodgeCool -= dt;
    if (walker.dodgeT > 0) walker.dodgeT -= dt;

    // A car closing in: step sideways, away from it, for half a second.
    // Only while strolling — a fleeing walker is already running for it.
    if (nearThreat && walker.state === 'walking'
      && walker.dodgeT <= 0 && walker.dodgeCool <= 0) {
      const awayX = pos.x - nearThreat.x;
      const awayZ = pos.z - nearThreat.z;
      // Step perpendicular to the way the walker faces, picking the side
      // that leads away from the threat.
      const fwdX = -Math.sin(walker.heading);
      const fwdZ = -Math.cos(walker.heading);
      let sideX = fwdZ;
      let sideZ = -fwdX;
      if (sideX * awayX + sideZ * awayZ < 0) {
        sideX = -sideX;
        sideZ = -sideZ;
      }
      walker.dodgeX = sideX;
      walker.dodgeZ = sideZ;
      walker.dodgeT = DODGE_SPAN;
      walker.dodgeCool = DODGE_WAIT;
    }

    if (walker.state === 'fleeing') {
      // Run away from the threat, weaving gently so walkers fan out.
      const weave = Math.sin(walker.walkPhase * 0.7) * 0.3;
      // Fleeing walkers drift apart a little, so a panicked crowd spreads
      // instead of running in a single clump. Straight into local numbers.
      let pushX = 0;
      let pushZ = 0;
      for (const other of walkers) {
        if (other === walker || other.state !== 'fleeing') continue;
        const dx = pos.x - other.group.position.x;
        const dz = pos.z - other.group.position.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < 2.25 && distSq > 0.0001) {
          const dist = Math.sqrt(distSq);
          pushX += (dx / dist) * (1.5 - dist);
          pushZ += (dz / dist) * (1.5 - dist);
        }
      }
      let runX = walker.fleeX + -walker.fleeZ * weave + pushX * 0.4;
      let runZ = walker.fleeZ + walker.fleeX * weave + pushZ * 0.4;
      const runLength = Math.hypot(runX, runZ) || 1;
      runX /= runLength;
      runZ /= runLength;
      faceToward(walker, Math.atan2(-runX, -runZ), dt, 5);
      walker.speed = RUN_SPEED * (0.6 + walker.panic * 0.4);
      pos.x = clamp(pos.x + runX * walker.speed * dt, limits.minX, limits.maxX);
      pos.z = clamp(pos.z + runZ * walker.speed * dt, limits.minZ, limits.maxZ);
      pos.y = 0;
      walker.group.rotation.y = walker.heading;
      walker.walkPhase += dt * walker.speed * 2.2;
      swingLimbs(walker, 0.9);
      walker.panic = Math.max(0, walker.panic - PANIC_DECAY * dt);
      if (walker.panic <= 0) {
        // Calmed down: stroll again from the closest point of a route,
        // instead of marching across the city to a random waypoint.
        walker.state = 'walking';
        walker.route = chooseRoute();
        let bestIndex = 0;
        let bestDist = Infinity;
        for (let i = 0; i < walker.route.points.length; i += 1) {
          const point = walker.route.points[i];
          const d = (point.x - pos.x) * (point.x - pos.x) + (point.z - pos.z) * (point.z - pos.z);
          if (d < bestDist) {
            bestDist = d;
            bestIndex = i;
          }
        }
        walker.routeIndex = bestIndex;
        walker.routeDir = 1;
      }
      return;
    }

    // Idle: standing still, looking around, then carrying on.
    if (walker.state === 'idle') {
      walker.idleLeft -= dt;
      walker.speed = 0;
      pos.y = 0;
      walker.heading += Math.sin(walker.walkPhase) * dt * 0.4;
      walker.group.rotation.y = walker.heading;
      settleLimbs(walker, dt);
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
      if (rand() < BREATHER_ODDS) {
        walker.state = 'idle';
        walker.idleLeft = BREATHER_MIN + rand() * (BREATHER_MAX - BREATHER_MIN);
      }
      return;
    }
    faceToward(walker, Math.atan2(-dx, -dz), dt, 4);
    walker.speed = walker.walkSpeed;
    pos.x += -Math.sin(walker.heading) * walker.speed * dt;
    pos.z += -Math.cos(walker.heading) * walker.speed * dt;
    // A sidestep in progress rides on top of the stroll, then fades out.
    if (walker.dodgeT > 0) {
      pos.x = clamp(pos.x + walker.dodgeX * DODGE_PACE * dt, limits.minX, limits.maxX);
      pos.z = clamp(pos.z + walker.dodgeZ * DODGE_PACE * dt, limits.minZ, limits.maxZ);
    }
    // A small bob with each step, sized to this walker's own gait.
    pos.y = Math.abs(Math.sin(walker.walkPhase)) * 0.03;
    walker.group.rotation.y = walker.heading;
    walker.walkPhase += dt * walker.speed * 2.0;
    swingLimbs(walker, walker.swing);
  }

  // A scare event: gunshot, speeding car or attack. Everyone within the
  // radius panics; the radius depends on how scary the event is.
  function addThreat(x, z, radius, kind = 'attack') {
    let reach = radius;
    if (kind === 'gunshot') reach = Math.max(radius, REACH_GUNSHOT);
    if (kind === 'car') reach = Math.max(radius, REACH_CAR);
    if (kind === 'attack') reach = Math.max(radius, REACH_ATTACK);
    for (const walker of walkers) {
      const dx = walker.group.position.x - x;
      const dz = walker.group.position.z - z;
      if (dx * dx + dz * dz < reach * reach) {
        panicWalker(walker, x, z);
      }
    }
  }

  // --- the system object ----------------------------------------------------
  const system = {
    pedestrians: walkers,

    spawn(count = 1) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        // A quarter of spawns arrive as a pair on the same route.
        if (rand() < PAIR_ODDS && walkers.length + 1 < CROWD_LIMIT) {
          made.push(...spawnPair());
        } else {
          const walker = spawnWalker();
          if (walker) made.push(walker);
        }
      }
      return made;
    },

    addThreat,

    fleeFrom(x, z, radius = REACH_ATTACK) {
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

    // How many walkers are fleeing right now — the crowd-panic read.
    getFleeingCount() {
      let fleeing = 0;
      for (const walker of walkers) {
        if (walker.state === 'fleeing') fleeing += 1;
      }
      return fleeing;
    },

    update(dt, threats = []) {
      liveThreats = threats || NO_THREATS;
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
