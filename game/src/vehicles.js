// vehicles.js — every wheeled thing in Marisol Bay, rebuilt for Round 7.
//
// The garage grew: eight body styles now, with two newcomers — the taxi,
// a yellow sedan with a roof sign that cruises the avenues, and the
// pickup, an open-bed workhorse. The driving model is the same arcade
// feel as Round 5 (instant steering, sport boost on Shift, brake lights
// that flare), with three new touches: reverse lights that glow white
// when the car backs up, smoke that puffs from a dying engine, and
// traffic that yields at intersections instead of barging through them.
//
// Traffic cars chase waypoints down their lane, brake for the car ahead,
// swerve around a blockage, and pull over to a fresh lane when they
// drift too far from the player. Motorbikes weave through the same
// lanes, quicker and looser, leaning into every turn. Bikes are scenery
// that moves: they are never drivable and never stealable.
//
// What the rest of the game uses (main.js, player.js, police.js,
// missions.js, hud.js):
//   createCar(scene, type, colour, x, z, heading) -> car
//     car: { group, type, colour, heading, speed, steer, health,
//       destroyed, isPlayer, isTraffic, stolen, driver, takenByPlayer,
//       length, width, engineDead, boostMeter, boosting, rearLightMat,
//       reverseLightMat, laneIndex, waypointIndex, cruiseSpeed,
//       speedKmh getter, damage(amount), dispose() }
//   createMotorbike(scene, x, z, heading, colour) -> bike
//     bike: { group, leanGroup, type, colour, heading, speed, isTraffic,
//       laneIndex, waypointIndex, cruiseSpeed, weavePhase, weaveClock,
//       lean, speedKmh getter, dispose() }
//   createVehicleSystem(scene, city, options) -> system
//     system: { cars, traffic, bikes, playerCar getter, bindPlayer(p),
//       spawnParked(n), spawnTraffic(n), spawnBikes(n),
//       spawnCarAt(type, colour, x, z, heading),
//       spawnBikeAt(x, z, heading, colour),
//       nearestEnterableVehicle(pos, maxDist),
//       enterPlayerVehicle(car), exitPlayerVehicle(), trySteal(playerPos),
//       getPlayerSpeedKmh(), isPlayerDriving(),
//       damagePlayerCar(amount), stopPlayerCar(), update(dt, input),
//       dispose() }
// The city argument is optional: with no lanes, colliders or spawns the
// module falls back to a default 5x5 street grid.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning — every number that shapes how driving feels, in one place.
// ---------------------------------------------------------------------------

const TOP_SPEEDS = {
  sedan: 34,
  hatchback: 30,
  van: 25,
  sport: 44,
  roadster: 48,
  supercar: 52,
  taxi: 32,
  pickup: 31,
};
const ACCELERATION = {
  sedan: 13,
  hatchback: 12,
  van: 9,
  sport: 18,
  roadster: 20,
  supercar: 22,
  taxi: 12,
  pickup: 11,
};
const BRAKE_POWER = 30;
const REVERSE_LIMIT = 9;
const STEER_LOCK = 1.9;
// The wheel answers almost at once — the car must feel instant.
const STEER_SPEED = 10;
const GRIP_NORMAL = 3.2;
const GRIP_HANDBRAKE = 0.9;
const CAR_RADIUS = 1.35;
const STEAL_DISTANCE = 3.6;
const TRAFFIC_CRUISE_SPEED = 11;
const TRAFFIC_BRAKE_DISTANCE = 9;
const TRAFFIC_SWERVE_DISTANCE = 14;
const TRAFFIC_RECYCLE_DISTANCE = 130;
const INTERSECTION_YIELD_RADIUS = 12;

// Sport boost: hold Shift in a sport body. Instant surge, no wind-up.
const BOOST_TOP_SPEED_MULT = 1.35;
const BOOST_ACCEL_MULT = 1.6;
const BOOST_DRAIN_SECONDS = 1.5;
const BOOST_REFILL_RATE = 0.25;

// A damaged engine smokes below this health, and the smoke puffs on a
// short timer so it reads as a leak, not a solid cloud.
const SMOKE_HEALTH_BELOW = 35;
const SMOKE_PUFF_INTERVAL = 0.4;

const EVERYDAY_BODIES = ['sedan', 'hatchback', 'van', 'taxi', 'pickup'];
const ALL_BODIES = ['sedan', 'hatchback', 'van', 'sport', 'roadster', 'supercar', 'taxi', 'pickup'];
const SPORT_BODIES = ['sport', 'roadster', 'supercar'];
const SPORT_TRAFFIC_ODDS = 0.12;
const SPORT_PARKED_ODDS = 0.15;
const TAXI_TRAFFIC_ODDS = 0.14;

const BIKE_CRUISE_SPEED = 16;
const BIKE_LIMIT = 21;
const BIKE_ACCELERATION = 12;
const BIKE_SWAY = 1.6;
const BIKE_SWAY_RATE = 1.1;
const BIKE_SPAWN_COUNT = 5;

const PAINT_JOBS = [
  0xe23b3b, 0x2f7fd0, 0xf2b234, 0x37b268,
  0xf2f0e6, 0x8a5fbf, 0x22262e, 0xe87aa0,
];
// Loud paint reserved for the sport bodies, so they read as special.
const SPORT_PAINT_JOBS = [
  0x39d353, // lime
  0xff7a1a, // tangerine
  0x00c8c8, // lagoon cyan
  0xff2e88, // hot pink
  0xffe600, // electric yellow
];
const TAXI_YELLOW = 0xf2b234;
const GLASS_COLOR = 0x18222e;
const TYRE_COLOR = 0x14161a;
const HUBCAP_COLOR = 0xb9c0c9;

// One scratch vector for the whole module: the hot loop never allocates.
const _ahead = { x: 0, z: 0 };

// Body dimensions per style: [length, width, bodyHeight, cabinLength].
const BODY_MEASURES = {
  sedan: [4.4, 1.9, 0.62, 2.1],
  hatchback: [3.6, 1.8, 0.68, 2.0],
  van: [4.8, 2.0, 1.05, 3.4],
  sport: [4.3, 1.95, 0.5, 1.7],
  roadster: [4.2, 1.9, 0.5, 1.4],
  supercar: [4.4, 2.0, 0.44, 1.5],
  taxi: [4.4, 1.9, 0.62, 2.1],
  pickup: [4.7, 1.95, 0.7, 1.1],
};

// ---------------------------------------------------------------------------
// Car factory — eight body styles from boxes, cylinders and paint.
// ---------------------------------------------------------------------------

function buildCarBody(type, colour) {
  const body = new THREE.Group();
  body.name = `Car_${type}`;
  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: GLASS_COLOR, roughness: 0.15, metalness: 0.6 });
  const tyre = new THREE.MeshStandardMaterial({ color: TYRE_COLOR, roughness: 0.95 });
  const hub = new THREE.MeshStandardMaterial({ color: HUBCAP_COLOR, roughness: 0.3, metalness: 0.7 });
  const frontLight = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 0.7 });
  const rearLight = new THREE.MeshStandardMaterial({ color: 0xd21f2b, emissive: 0x8f1018, emissiveIntensity: 0.7 });
  const reverseLight = new THREE.MeshStandardMaterial({ color: 0xf2f0e6, emissive: 0xffffff, emissiveIntensity: 0 });

  const box = (material, x, y, z, w, h, d, parent) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    (parent || body).add(mesh);
    return mesh;
  };

  const dims = BODY_MEASURES[type];
  const length = dims[0];
  const width = dims[1];
  const bodyHeight = dims[2];
  const cabinLength = dims[3];
  const isVan = type === 'van';
  const isPickup = type === 'pickup';
  const cabinY = 0.55 + bodyHeight / 2 + (isVan ? 0.55 : 0.34);
  const cabinH = isVan ? 1.1 : 0.62;
  const cabinZ = isVan ? 0.1 : (isPickup ? -0.5 : 0.15);

  // Slab and glass cabin — except the roadster, which keeps its cockpit
  // open under a low raked windshield, and the pickup, whose cabin sits
  // forward over an open bed.
  box(paint, 0, 0.55, 0, width, bodyHeight, length);
  if (!isPickup) {
    box(glass, 0, cabinY, cabinZ, width - 0.24, cabinH, cabinLength);
  } else {
    box(glass, 0, cabinY, cabinZ, width - 0.24, cabinH, cabinLength);
    // Open bed: low side walls and a tailgate at the rear.
    box(paint, -width / 2 + 0.08, 0.95, length / 2 - 0.7, 0.12, 0.5, 1.6);
    box(paint, width / 2 - 0.08, 0.95, length / 2 - 0.7, 0.12, 0.5, 1.6);
    box(paint, 0, 0.95, length / 2 - 0.08, width - 0.2, 0.5, 0.12);
    // A crate in the bed, so the pickup reads as a workhorse.
    box(new THREE.MeshStandardMaterial({ color: 0x8a6f5c, roughness: 0.9 }), 0, 1.0, length / 2 - 0.7, 1.1, 0.4, 1.1);
  }
  if (type !== 'roadster' && !isPickup) {
    box(paint, 0, cabinY + cabinH / 2, cabinZ, width - 0.18, 0.08, cabinLength - 0.3);
  }
  if (type === 'sport') {
    box(paint, 0, 1.05, length / 2 - 0.15, width - 0.3, 0.07, 0.3);
  }
  if (type === 'roadster') {
    box(glass, 0, cabinY + 0.22, -0.55, width - 0.5, 0.3, 0.06);
    box(paint, 0, 0.86, -length / 2 + 0.5, width - 0.24, 0.06, 0.9);
  }
  if (type === 'supercar') {
    // Big rear wing on twin struts, front splitter, black roof panel.
    box(paint, 0, 1.02, length / 2 - 0.12, width - 0.3, 0.06, 0.34);
    box(paint, -width / 2 + 0.35, 0.86, length / 2 - 0.12, 0.08, 0.22, 0.06);
    box(paint, width / 2 - 0.35, 0.86, length / 2 - 0.12, 0.08, 0.22, 0.06);
    box(paint, 0, 0.32, -length / 2 + 0.05, width - 0.2, 0.08, 0.3);
    box(tyre, 0, cabinY + cabinH / 2 + 0.02, 0.15, width - 0.3, 0.05, cabinLength - 0.5);
  }
  if (isVan) {
    box(paint, width / 2, 1.15, 0.2, 0.06, 0.5, 2.4);
    box(paint, -width / 2, 1.15, 0.2, 0.06, 0.5, 2.4);
  }
  if (type === 'taxi') {
    // Roof sign: a small yellow box with a glowing top, plus a dark band
    // down the side so the taxi reads at a glance.
    const signMat = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.6 });
    box(signMat, 0, cabinY + cabinH / 2 + 0.18, 0.15, 0.9, 0.3, 0.4);
    const signGlow = new THREE.MeshStandardMaterial({ color: 0xf2b234, emissive: 0xf2b234, emissiveIntensity: 0.9 });
    box(signGlow, 0, cabinY + cabinH / 2 + 0.18, 0.15, 0.94, 0.1, 0.44);
    box(new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.7 }), 0, 0.62, 0, width + 0.02, 0.14, length - 0.4);
  }

  // Headlights at -Z, taillights at +Z, reverse lights just inside the
  // taillights. The rear and reverse materials are kept so braking and
  // reversing can flare them.
  box(frontLight, -width / 2 + 0.35, 0.62, -length / 2 - 0.01, 0.34, 0.12, 0.06);
  box(frontLight, width / 2 - 0.35, 0.62, -length / 2 - 0.01, 0.34, 0.12, 0.06);
  box(rearLight, -width / 2 + 0.35, 0.62, length / 2 + 0.01, 0.34, 0.12, 0.06);
  box(rearLight, width / 2 - 0.35, 0.62, length / 2 + 0.01, 0.34, 0.12, 0.06);
  box(reverseLight, -width / 2 + 0.75, 0.62, length / 2 + 0.01, 0.22, 0.1, 0.06);
  box(reverseLight, width / 2 - 0.75, 0.62, length / 2 + 0.01, 0.22, 0.1, 0.06);

  // Four wheels with hub caps.
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18);
  const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.28, 12);
  const wheelSpots = [
    [-width / 2, -length / 2 + 0.85],
    [width / 2, -length / 2 + 0.85],
    [-width / 2, length / 2 - 0.85],
    [width / 2, length / 2 - 0.85],
  ];
  for (const spot of wheelSpots) {
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(spot[0], 0.36, spot[1]);
    wheel.castShadow = true;
    body.add(wheel);
    const cap = new THREE.Mesh(hubGeo, hub);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(spot[0], 0.36, spot[1]);
    body.add(cap);
  }

  return {
    group: body, length, width,
    rearLightMat: rearLight, reverseLightMat: reverseLight,
    // Round 8: the paint material is kept so the garage can repaint a
    // car in place instead of rebuilding its body.
    paintMat: paint,
  };
}

export function createCar(scene, type = 'sedan', colour = 0xe23b3b, x = 0, z = 0, heading = 0) {
  if (!ALL_BODIES.includes(type)) type = 'sedan';
  const built = buildCarBody(type, colour);
  const group = built.group;
  group.position.set(x, 0, z);
  group.rotation.y = heading;
  scene.add(group);

  const car = {
    group,
    type,
    colour,
    heading,
    speed: 0,
    steer: 0,
    health: 100,
    destroyed: false,
    isPlayer: false,
    isTraffic: false,
    stolen: false,
    driver: null,
    takenByPlayer: false,
    length: built.length,
    width: built.width,
    engineDead: false,
    boostMeter: 1,
    boosting: false,
    // Round 8: garage tuning rides on the car (engine, wheels, armour)
    // and the paint material rides with it for repaints.
    tuning: null,
    paintMat: built.paintMat,
    rearLightMat: built.rearLightMat,
    reverseLightMat: built.reverseLightMat,
    laneIndex: 0,
    waypointIndex: 0,
    cruiseSpeed: TRAFFIC_CRUISE_SPEED,
    smokeTimer: 0,
    smokePuffs: [],

    get speedKmh() {
      return Math.abs(this.speed) * 3.6;
    },

    damage(amount) {
      if (this.destroyed) return;
      this.health = Math.max(0, this.health - amount);
      if (this.health <= 0) {
        this.destroyed = true;
        this.engineDead = true;
        this.speed = 0;
      }
    },

    dispose() {
      scene.remove(group);
    },
  };
  return car;
}

// ---------------------------------------------------------------------------
// Motorbikes — NPC traffic only. Slim two-wheeler, rider leaning forward,
// banking into corners via an inner lean group rolling around Z.
// ---------------------------------------------------------------------------

function buildBikeBody(colour, riderColour, helmetColour) {
  const group = new THREE.Group();
  group.name = 'Motorbike';
  const leanGroup = new THREE.Group();
  group.add(leanGroup);
  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xb9c0c9, roughness: 0.25, metalness: 0.8 });
  const riderMat = new THREE.MeshStandardMaterial({ color: riderColour, roughness: 0.8 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: helmetColour, roughness: 0.3, metalness: 0.2 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc98d64, roughness: 0.7 });

  const box = (material, x, y, z, w, h, d, parent) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    (parent || leanGroup).add(mesh);
    return mesh;
  };

  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16);
  for (const wz of [-0.55, 0.55]) {
    const wheel = new THREE.Mesh(wheelGeo, dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, 0.34, wz);
    wheel.castShadow = true;
    leanGroup.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.14, 10), chrome);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(0, 0.34, wz);
    leanGroup.add(hub);
  }
  // Spine, tank, seat, handlebar, bright headlight, taillight.
  box(dark, 0, 0.62, 0, 0.09, 0.09, 1.35);
  box(paint, 0, 0.78, -0.08, 0.34, 0.22, 0.5);
  box(dark, 0, 0.8, 0.38, 0.3, 0.1, 0.45);
  box(chrome, 0, 0.95, -0.55, 0.56, 0.06, 0.06);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 1.2 });
  box(headMat, 0, 0.72, -0.62, 0.16, 0.12, 0.05);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xd21f2b, emissive: 0x8f1018, emissiveIntensity: 0.7 });
  box(tailMat, 0, 0.78, 0.62, 0.16, 0.1, 0.05);

  // Rider: torso leaning over the tank, helmet, arms to the bar, legs tucked.
  const torso = box(riderMat, 0, 1.15, 0.08, 0.42, 0.55, 0.26);
  torso.rotation.x = 0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skinMat);
  head.position.set(0, 1.5, -0.14);
  head.castShadow = true;
  leanGroup.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), helmetMat);
  helmet.position.set(0, 1.52, -0.14);
  helmet.castShadow = true;
  leanGroup.add(helmet);
  for (const side of [-1, 1]) {
    const arm = box(riderMat, side * 0.24, 1.28, -0.3, 0.11, 0.5, 0.12);
    arm.rotation.x = -0.9;
    const leg = box(dark, side * 0.2, 0.72, 0.18, 0.14, 0.5, 0.14);
    leg.rotation.x = 0.35;
  }

  return { group, leanGroup };
}

export function createMotorbike(scene, x = 0, z = 0, heading = 0, colour = 0xd21f2b) {
  const riderColours = [0x2f7fd0, 0x37b268, 0xf2b234, 0xe87aa0, 0x8a5fbf];
  const helmetColours = [0xf2f0e6, 0xd21f2b, 0x2f7fd0, 0xf2b234, 0x22262e];
  const pick = Math.floor(Math.random() * riderColours.length);
  const built = buildBikeBody(colour, riderColours[pick], helmetColours[pick]);
  const group = built.group;
  group.position.set(x, 0, z);
  group.rotation.y = heading;
  scene.add(group);

  const bike = {
    group,
    leanGroup: built.leanGroup,
    type: 'bike',
    colour,
    heading,
    speed: 0,
    isTraffic: true,
    laneIndex: 0,
    waypointIndex: 0,
    cruiseSpeed: BIKE_CRUISE_SPEED,
    weavePhase: Math.random() * Math.PI * 2,
    weaveClock: 0,
    lean: 0,

    get speedKmh() {
      return Math.abs(this.speed) * 3.6;
    },

    dispose() {
      scene.remove(group);
    },
  };
  return bike;
}

// ---------------------------------------------------------------------------
// Small helpers — allocation-free in the hot path.
// ---------------------------------------------------------------------------

function angleDiff(from, to) {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

// Forward vector of a heading (forward is -Z at heading 0), written into
// the shared scratch object. Read x/z at once; never hold the reference.
function forwardVector(heading, out) {
  out.x = -Math.sin(heading);
  out.z = -Math.cos(heading);
  return out;
}

// Fallback 5x5 two-way street grid, used only when the city gives no lanes.
function fallbackLanes() {
  const lanes = [];
  const step = 40;
  for (let i = -2; i <= 2; i += 1) {
    const c = i * step;
    lanes.push({ points: [{ x: c - 2.5, z: -100 }, { x: c - 2.5, z: 100 }], width: 7 });
    lanes.push({ points: [{ x: c + 2.5, z: 100 }, { x: c + 2.5, z: -100 }], width: 7 });
    lanes.push({ points: [{ x: -100, z: c - 2.5 }, { x: 100, z: c - 2.5 }], width: 7 });
    lanes.push({ points: [{ x: 100, z: c + 2.5 }, { x: -100, z: c + 2.5 }], width: 7 });
  }
  return lanes;
}

function fallbackCarSpawns() {
  const spots = [];
  for (let i = -2; i <= 2; i += 1) {
    spots.push({ x: i * 40 + 8, z: -30, heading: Math.PI });
    spots.push({ x: i * 40 - 8, z: 50, heading: 0 });
  }
  return spots;
}

// A point on a lane segment, for spreading spawns along the road.
function pointOnLane(lane, t) {
  const points = lane.points;
  const segIndex = Math.floor(Math.random() * (points.length - 1));
  const a = points[segIndex];
  const b = points[segIndex + 1];
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    segIndex,
  };
}

// ---------------------------------------------------------------------------
// Vehicle system
// ---------------------------------------------------------------------------
export function createVehicleSystem(scene, city = {}, options = {}) {
  const lanes = city.lanes && city.lanes.length > 0 ? city.lanes : fallbackLanes();
  const colliders = city.buildingColliders || city.colliders || [];
  const carSpawns = city.carSpawns && city.carSpawns.length > 0 ? city.carSpawns : fallbackCarSpawns();
  const bounds = city.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const roadCentres = city.roadCentres || [-180, -120, -60, 0, 60, 120, 180];
  const onCarStolen = typeof options.onCarStolen === 'function' ? options.onCarStolen : null;

  let player = options.player || null;
  const cars = [];
  const traffic = [];
  const bikes = [];
  let playerCar = null;
  let spawnCursor = 0;
  // Round 8: the weather grip the weather system hands over every
  // frame (1.0 dry, 0.88 rain, 0.78 storm). It scales top speed,
  // acceleration and steering response in driveStep.
  let weatherGrip = 1;

  // Sport cars are rare by design: most spawns are plain body styles.
  function chooseSpawnType(cycleIndex, sportChance) {
    const roll = Math.random();
    if (roll < sportChance) {
      return SPORT_BODIES[Math.floor(Math.random() * SPORT_BODIES.length)];
    }
    if (roll < sportChance + TAXI_TRAFFIC_ODDS) return 'taxi';
    return EVERYDAY_BODIES[cycleIndex % EVERYDAY_BODIES.length];
  }

  function chooseColour(type, index) {
    if (SPORT_BODIES.includes(type)) {
      return SPORT_PAINT_JOBS[index % SPORT_PAINT_JOBS.length];
    }
    if (type === 'taxi') return TAXI_YELLOW;
    return PAINT_JOBS[index % PAINT_JOBS.length];
  }

  // --- collisions ----------------------------------------------------------

  function hitsBuilding(x, z, radius) {
    for (const box of colliders) {
      const closestX = Math.max(box.minX, Math.min(x, box.maxX));
      const closestZ = Math.max(box.minZ, Math.min(z, box.maxZ));
      const dx = x - closestX;
      const dz = z - closestZ;
      if (dx * dx + dz * dz < radius * radius) return box;
    }
    return null;
  }

  function hitsCar(car, x, z) {
    for (const other of cars) {
      if (other === car || other.destroyed) continue;
      const dx = x - other.group.position.x;
      const dz = z - other.group.position.z;
      const minDist = CAR_RADIUS * 2 - 0.2;
      if (dx * dx + dz * dz < minDist * minDist) return other;
    }
    return null;
  }

  // --- engine smoke ---------------------------------------------------------
  // A dying engine puffs dark smoke from under the bonnet on a short
  // timer. Each puff is a sphere that grows and fades, then is removed.
  const smokeGeo = new THREE.SphereGeometry(0.55, 8, 6);
  const smokeMat = new THREE.MeshBasicMaterial({
    color: 0x2a2a2a, transparent: true, opacity: 0.45, depthWrite: false,
  });

  function puffSmoke(car, dt) {
    car.smokeTimer -= dt;
    if (car.health < SMOKE_HEALTH_BELOW && !car.destroyed && car.smokeTimer <= 0) {
      car.smokeTimer = SMOKE_PUFF_INTERVAL;
      const puff = new THREE.Mesh(smokeGeo, smokeMat);
      const fwd = forwardVector(car.heading, _ahead);
      puff.position.set(
        car.group.position.x - fwd.x * 1.6,
        1.1,
        car.group.position.z - fwd.z * 1.6,
      );
      scene.add(puff);
      car.smokePuffs.push({ mesh: puff, age: 0 });
    }
    for (let i = car.smokePuffs.length - 1; i >= 0; i -= 1) {
      const puff = car.smokePuffs[i];
      puff.age += dt;
      puff.mesh.position.y += dt * 1.2;
      const scale = 1 + puff.age * 2.2;
      puff.mesh.scale.set(scale, scale, scale);
      puff.mesh.material = smokeMat;
      if (puff.age > 1.1) {
        scene.remove(puff.mesh);
        car.smokePuffs.splice(i, 1);
      }
    }
  }

  // --- the shared arcade driving model ------------------------------------
  // One function drives every car, player or traffic. Steering tracks the
  // keys almost at once (STEER_SPEED 10) but the lock tightens with
  // speed, so fast cars stay forgiving instead of twitchy. Throttle,
  // brake and boost all bite the same frame the key is pressed.
  function driveStep(car, dt, throttle, steerInput, braking, handbrake, boostKey) {
    if (car.engineDead || car.destroyed) {
      car.speed *= Math.max(0, 1 - dt * 2);
      return;
    }
    const isSport = SPORT_BODIES.includes(car.type);
    let topSpeed = TOP_SPEEDS[car.type];
    let accel = ACCELERATION[car.type];
    // Round 8: garage tuning first, weather grip second. A tuned car
    // carries its engine and wheel bonuses on top of the base numbers,
    // and rain and storm then scale everything down — traffic cars feel
    // the weather too, since they share driveStep.
    const tuning = car.tuning || null;
    if (tuning) {
      topSpeed *= 1 + (tuning.topSpeedBonus || 0);
      accel *= 1 + (tuning.accelBonus || 0);
    }
    topSpeed *= weatherGrip;
    accel *= weatherGrip;
    // Boost: Shift in a sport car. Instant surge while the meter lasts;
    // it refills once you lift off.
    if (boostKey && isSport && car.boostMeter > 0) {
      topSpeed *= BOOST_TOP_SPEED_MULT;
      accel *= BOOST_ACCEL_MULT;
      car.boostMeter = Math.max(0, car.boostMeter - dt / BOOST_DRAIN_SECONDS);
      car.boosting = true;
    } else {
      car.boosting = false;
      car.boostMeter = Math.min(1, car.boostMeter + dt * BOOST_REFILL_RATE);
    }

    if (throttle > 0) car.speed += accel * throttle * dt;
    else if (throttle < 0) {
      // S: brake while moving forward, reverse once stopped.
      if (car.speed > 0.5) car.speed -= BRAKE_POWER * dt;
      else car.speed -= accel * 0.6 * dt;
    }
    if (braking) car.speed -= BRAKE_POWER * dt * (car.speed > 0 ? 1 : -0.4);
    if (handbrake) car.speed *= Math.max(0, 1 - dt * 1.6);

    // Rolling drag and the reverse cap.
    car.speed -= car.speed * 0.35 * dt;
    car.speed = Math.max(-REVERSE_LIMIT, Math.min(topSpeed, car.speed));

    // Steering: less lock at high speed, fast wheel response; the
    // handbrake loosens it on purpose so the tail slides.
    const speedFactor = Math.min(1, Math.abs(car.speed) / 12);
    const targetSteer = steerInput * STEER_LOCK * (0.45 + 0.55 * (1 - speedFactor * 0.6));
    // Round 8: the weather grip loosens the steering response, so a
    // storm chase feels slippery instead of identical to a dry one.
    const steerResponse = STEER_SPEED * (handbrake ? GRIP_HANDBRAKE / GRIP_NORMAL : 1) * weatherGrip;
    car.steer += (targetSteer - car.steer) * Math.min(1, dt * steerResponse);
    const direction = car.speed >= 0 ? 1 : -1;
    car.heading += car.steer * dt * direction * Math.min(1, Math.abs(car.speed) / 4 + 0.25);

    // Brake lights flare while braking or reversing; reverse lights glow
    // white whenever the car is actually moving backwards.
    if (car.rearLightMat) {
      car.rearLightMat.emissiveIntensity = (braking || throttle < 0) ? 2.2 : 0.7;
    }
    if (car.reverseLightMat) {
      car.reverseLightMat.emissiveIntensity = car.speed < -0.5 ? 2.0 : 0;
    }

    const fwd = forwardVector(car.heading, _ahead);
    const nextX = car.group.position.x + fwd.x * car.speed * dt;
    const nextZ = car.group.position.z + fwd.z * car.speed * dt;

    // Buildings: stop short and take a little damage on a hard hit.
    if (hitsBuilding(nextX, nextZ, CAR_RADIUS)) {
      if (Math.abs(car.speed) > 8) car.damage(Math.abs(car.speed) * 0.6);
      car.speed *= -0.25;
      return;
    }
    // Other cars: soft push — both lose speed instead of passing through.
    const other = hitsCar(car, nextX, nextZ);
    if (other) {
      const impact = Math.abs(car.speed - other.speed);
      if (impact > 6) {
        car.damage(impact * 0.4);
        other.damage(impact * 0.3);
      }
      car.speed *= 0.4;
      if (!other.isPlayer && other.isTraffic) other.speed *= 0.6;
      return;
    }
    // City edge: bounce back in rather than driving into the void.
    if (nextX < bounds.minX || nextX > bounds.maxX || nextZ < bounds.minZ || nextZ > bounds.maxZ) {
      car.speed *= -0.3;
      return;
    }
    car.group.position.x = nextX;
    car.group.position.z = nextZ;
    car.group.rotation.y = car.heading;
  }

  // --- intersection yielding -------------------------------------------------
  // A traffic car approaching a crossing checks whether another car is
  // already inside the intersection box; if so it brakes instead of
  // barging through. Crossings are where an avenue and a street meet.
  function carInsideIntersection(x, z) {
    for (const ax of roadCentres) {
      for (const az of roadCentres) {
        if (Math.abs(x - ax) < INTERSECTION_YIELD_RADIUS && Math.abs(z - az) < INTERSECTION_YIELD_RADIUS) {
          return true;
        }
      }
    }
    return false;
  }

  function shouldYieldAtCrossing(car) {
    const pos = car.group.position;
    const fwd = forwardVector(car.heading, _ahead);
    // Look one car-length ahead: is the nose about to enter a crossing?
    const noseX = pos.x + fwd.x * 7;
    const noseZ = pos.z + fwd.z * 7;
    if (!carInsideIntersection(noseX, noseZ)) return false;
    // Is anyone else already inside that same crossing?
    for (const other of cars) {
      if (other === car || other.destroyed) continue;
      const ox = other.group.position.x;
      const oz = other.group.position.z;
      if (carInsideIntersection(ox, oz)) {
        const gap = Math.hypot(ox - pos.x, oz - pos.z);
        if (gap > 4 && gap < 30) return true;
      }
    }
    return false;
  }

  // --- traffic AI -----------------------------------------------------------
  // A traffic car chases the next point on its lane. If the car ahead (or
  // the player's car, or the player on foot) is too close it brakes; if
  // the blockage sits in its lane it nudges sideways to slip past; if a
  // crossing ahead is occupied it yields.
  function updateTrafficCar(car, dt, playerPos) {
    const lane = lanes[car.laneIndex % lanes.length];
    const points = lane.points;
    const target = points[car.waypointIndex % points.length];
    const dx = target.x - car.group.position.x;
    const dz = target.z - car.group.position.z;
    const distToTarget = Math.hypot(dx, dz);
    if (distToTarget < 6) {
      car.waypointIndex += 1;
      if (car.waypointIndex >= points.length) {
        car.laneIndex = (car.laneIndex + 1) % lanes.length;
        car.waypointIndex = 0;
      }
      return;
    }

    const desiredHeading = Math.atan2(-dx, -dz);
    const headingError = angleDiff(car.heading, desiredHeading);
    const steerInput = THREE.MathUtils.clamp(headingError * 1.6, -1, 1);

    // Look ahead along the nose for anything in the way.
    const fwd = forwardVector(car.heading, _ahead);
    let blocked = false;
    let brake = false;
    for (const other of cars) {
      if (other === car || other.destroyed) continue;
      const ox = other.group.position.x - car.group.position.x;
      const oz = other.group.position.z - car.group.position.z;
      const along = ox * fwd.x + oz * fwd.z;
      const side = Math.abs(ox * -fwd.z + oz * fwd.x);
      if (along > 0 && along < TRAFFIC_SWERVE_DISTANCE && side < 3.2) {
        blocked = true;
        if (along < TRAFFIC_BRAKE_DISTANCE) brake = true;
      }
    }
    // The player on foot is also something to brake for.
    if (playerPos && player && !player.inVehicle) {
      const px = playerPos.x - car.group.position.x;
      const pz = playerPos.z - car.group.position.z;
      const along = px * fwd.x + pz * fwd.z;
      const side = Math.abs(px * -fwd.z + pz * fwd.x);
      if (along > 0 && along < TRAFFIC_BRAKE_DISTANCE + 3 && side < 3) {
        blocked = true;
        brake = true;
      }
    }
    // Yield at a busy crossing, even if nothing is directly ahead.
    if (!brake && shouldYieldAtCrossing(car)) brake = true;

    // Swerve: aim a little to the side of the blockage instead of stopping.
    let steer = steerInput;
    if (blocked && !brake) steer = THREE.MathUtils.clamp(steerInput + 0.55, -1, 1);
    const throttle = brake ? 0 : 1;
    // Traffic never reverses; ease toward its cruise speed.
    const cruise = Math.min(car.cruiseSpeed, TOP_SPEEDS[car.type] * 0.5);
    if (car.speed > cruise) car.speed -= 6 * dt;
    driveStep(car, dt, throttle, steer, brake, false, false);
    puffSmoke(car, dt);
  }

  // --- traffic bikes ---------------------------------------------------------
  // A bike rides the same lanes as the cars, but quicker and looser: it
  // sways across the lane as it filters through traffic, leans into every
  // turn, and brakes for the car ahead instead of barging through it.
  function updateTrafficBike(bike, dt, playerPos) {
    const lane = lanes[bike.laneIndex % lanes.length];
    const points = lane.points;
    const target = points[bike.waypointIndex % points.length];
    const dx = target.x - bike.group.position.x;
    const dz = target.z - bike.group.position.z;
    const distToTarget = Math.hypot(dx, dz);
    if (distToTarget < 6) {
      bike.waypointIndex += 1;
      if (bike.waypointIndex >= points.length) {
        bike.laneIndex = (bike.laneIndex + 1) % lanes.length;
        bike.waypointIndex = 0;
      }
      return;
    }

    // Weave: slide the aim point sideways across the lane, so the bike
    // reads as filtering through traffic instead of glued to a rail.
    bike.weaveClock += dt;
    const sway = Math.sin(bike.weaveClock * BIKE_SWAY_RATE * Math.PI + bike.weavePhase) * BIKE_SWAY;
    const rightX = Math.cos(bike.heading);
    const rightZ = -Math.sin(bike.heading);
    const aimX = target.x + rightX * sway;
    const aimZ = target.z + rightZ * sway;
    const desiredHeading = Math.atan2(-(aimX - bike.group.position.x), -(aimZ - bike.group.position.z));
    const headingError = angleDiff(bike.heading, desiredHeading);
    const steerInput = THREE.MathUtils.clamp(headingError * 1.6, -1, 1);

    // Look ahead for a car (or the player on foot) to brake for.
    const fwd = forwardVector(bike.heading, _ahead);
    let brake = false;
    for (const other of cars) {
      if (other.destroyed) continue;
      const ox = other.group.position.x - bike.group.position.x;
      const oz = other.group.position.z - bike.group.position.z;
      const along = ox * fwd.x + oz * fwd.z;
      const side = Math.abs(ox * -fwd.z + oz * fwd.x);
      if (along > 0 && along < TRAFFIC_BRAKE_DISTANCE && side < 3.0) {
        brake = true;
        break;
      }
    }
    if (!brake && playerPos && player && !player.inVehicle) {
      const px = playerPos.x - bike.group.position.x;
      const pz = playerPos.z - bike.group.position.z;
      const along = px * fwd.x + pz * fwd.z;
      const side = Math.abs(px * -fwd.z + pz * fwd.x);
      if (along > 0 && along < TRAFFIC_BRAKE_DISTANCE + 3 && side < 2.5) brake = true;
    }

    // Speed: ease toward cruise, never past the bike's top speed.
    const cruise = Math.min(bike.cruiseSpeed, BIKE_LIMIT);
    if (brake) bike.speed = Math.max(0, bike.speed - 18 * dt);
    else if (bike.speed < cruise) bike.speed = Math.min(cruise, bike.speed + BIKE_ACCELERATION * dt);
    else bike.speed = Math.max(cruise, bike.speed - 6 * dt);

    // Steering bites harder at low speed; the heading follows the aim.
    const speedFactor = Math.min(1, Math.abs(bike.speed) / 12);
    const turnRate = 2.4 * (0.5 + 0.5 * (1 - speedFactor * 0.5));
    bike.heading += THREE.MathUtils.clamp(headingError, -turnRate * dt, turnRate * dt);

    // Move along the NEW heading, not the one the brake check just read.
    const moveFwd = forwardVector(bike.heading, _ahead);
    const nx = bike.group.position.x + moveFwd.x * bike.speed * dt;
    const nz = bike.group.position.z + moveFwd.z * bike.speed * dt;
    if (nx < bounds.minX || nx > bounds.maxX || nz < bounds.minZ || nz > bounds.maxZ) {
      bike.speed *= 0.4;
      return;
    }
    bike.group.position.x = nx;
    bike.group.position.z = nz;
    bike.group.rotation.y = bike.heading;

    // Lean into the turn: steering left rolls the bike left. Smoothed so
    // it banks instead of snapping.
    const leanTarget = THREE.MathUtils.clamp(steerInput * 0.42, -0.45, 0.45);
    bike.lean += (leanTarget - bike.lean) * Math.min(1, dt * 6);
    bike.leanGroup.rotation.z = bike.lean;
  }

  // --- the system object ----------------------------------------------------
  const system = {
    cars,
    traffic,
    bikes,
    get playerCar() {
      return playerCar;
    },

    bindPlayer(p) {
      player = p;
    },

    // Round 8: the weather system hands the grip over every frame, and
    // the garage hands a car its tuning and its paint. The tuning object
    // rides on the car so driveStep can read it without a lookup.
    setWeatherGrip(grip) {
      weatherGrip = Math.max(0.5, Math.min(1, Number(grip) || 1));
    },

    getWeatherGrip() {
      return weatherGrip;
    },

    repaintCar(car, hex) {
      if (!car || !car.paintMat) return false;
      car.paintMat.color.setHex(hex);
      car.colour = hex;
      return true;
    },

    applyTuning(car, tuning) {
      if (!car) return false;
      car.tuning = tuning || null;
      return true;
    },

    spawnParked(count = 8) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const spot = carSpawns[spawnCursor % carSpawns.length];
        spawnCursor += 1;
        const type = chooseSpawnType(spawnCursor + i, SPORT_PARKED_ODDS);
        const colour = chooseColour(type, spawnCursor * 3 + i);
        const car = createCar(scene, type, colour, spot.x, spot.z, spot.heading);
        cars.push(car);
        made.push(car);
      }
      return made;
    },

    // Put one specific car at an exact spot (shot staging uses this to
    // guarantee a sport car in the frame). Not traffic, not the player's.
    spawnCarAt(type, colour, x, z, heading = 0) {
      const car = createCar(scene, type, colour, x, z, heading);
      cars.push(car);
      return car;
    },

    // Put one motorbike at an exact spot (shot staging uses this).
    spawnBikeAt(x, z, heading = 0, colour = 0xd21f2b) {
      const bike = createMotorbike(scene, x, z, heading, colour);
      bikes.push(bike);
      return bike;
    },

    // Scatter motorbikes through traffic: same lanes as the cars, faster
    // cruise, each with its own weave phase so they do not move in step.
    spawnBikes(count = BIKE_SPAWN_COUNT) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const laneIndex = (bikes.length + i * 3) % lanes.length;
        const lane = lanes[laneIndex];
        const spot = pointOnLane(lane, Math.random());
        const nextPoint = lane.points[(spot.segIndex + 1) % lane.points.length];
        const heading = Math.atan2(-(nextPoint.x - spot.x), -(nextPoint.z - spot.z));
        const colour = PAINT_JOBS[(i * 3 + 1) % PAINT_JOBS.length];
        const bike = createMotorbike(scene, spot.x, spot.z, heading, colour);
        bike.laneIndex = laneIndex;
        bike.waypointIndex = (spot.segIndex + 1) % lane.points.length;
        bike.cruiseSpeed = BIKE_CRUISE_SPEED * (0.9 + Math.random() * 0.25);
        bikes.push(bike);
        made.push(bike);
      }
      return made;
    },

    spawnTraffic(count = 10) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const laneIndex = (traffic.length + i) % lanes.length;
        const lane = lanes[laneIndex];
        // Spawn at a random spot ALONG a random lane segment, so traffic
        // is spread down the road instead of bunched at the lane ends.
        // If the spot is too close to an existing car, try another point.
        let spot = pointOnLane(lane, Math.random());
        for (let attempt = 0; attempt < 4; attempt += 1) {
          let crowded = false;
          for (const other of cars) {
            const dx = other.group.position.x - spot.x;
            const dz = other.group.position.z - spot.z;
            if (dx * dx + dz * dz < 64) { crowded = true; break; }
          }
          if (!crowded) break;
          spot = pointOnLane(lane, Math.random());
        }
        const pointIndex = spot.segIndex;
        const type = chooseSpawnType(i * 2 + 1, SPORT_TRAFFIC_ODDS);
        const colour = chooseColour(type, i * 5 + 2);
        // Face along the lane from the point the car actually spawns on,
        // toward the next waypoint it will drive to.
        const nextPoint = lane.points[(pointIndex + 1) % lane.points.length];
        const heading = Math.atan2(-(nextPoint.x - spot.x), -(nextPoint.z - spot.z));
        const car = createCar(scene, type, colour, spot.x, spot.z, heading);
        car.isTraffic = true;
        car.laneIndex = laneIndex;
        car.waypointIndex = (pointIndex + 1) % lane.points.length;
        car.cruiseSpeed = TRAFFIC_CRUISE_SPEED * (0.85 + Math.random() * 0.3);
        car.driver = { name: 'driver', fleeing: false };
        cars.push(car);
        traffic.push(car);
        made.push(car);
      }
      return made;
    },

    nearestEnterableVehicle(pos, maxDist = 3.4) {
      let best = null;
      let bestDist = maxDist;
      for (const car of cars) {
        if (car.destroyed || car.engineDead || car.isPlayer) continue;
        const dx = car.group.position.x - pos.x;
        const dz = car.group.position.z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < bestDist) {
          best = car;
          bestDist = dist;
        }
      }
      return best;
    },

    enterPlayerVehicle(car) {
      if (!car || !player) return false;
      if (car.isTraffic) {
        // Taking a traffic car: it stops being traffic and its driver flees.
        car.isTraffic = false;
        const index = traffic.indexOf(car);
        if (index >= 0) traffic.splice(index, 1);
        if (car.driver) car.driver.fleeing = true;
        car.driver = null;
        car.stolen = true;
      } else if (!car.takenByPlayer) {
        // Taking a parked car is also taking someone else's car.
        car.stolen = true;
      }
      // The theft callback fires once per car, the first time the player
      // takes it — re-entering a car he already owns is not a new crime.
      if (!car.takenByPlayer) {
        car.takenByPlayer = true;
        if (onCarStolen) onCarStolen(car);
      }
      car.isPlayer = true;
      playerCar = car;
      player.enterVehicle(car);
      return true;
    },

    exitPlayerVehicle() {
      if (!playerCar || !player) return false;
      const car = playerCar;
      car.isPlayer = false;
      playerCar = null;
      // The car stays parked where it was left; it can be entered again.
      return player.exitVehicle();
    },

    // F key: take the nearest car in reach, parked or in traffic.
    trySteal(playerPos) {
      if (!player || player.inVehicle) return null;
      const car = this.nearestEnterableVehicle(playerPos, STEAL_DISTANCE);
      if (!car) return null;
      this.enterPlayerVehicle(car);
      return car;
    },

    getPlayerSpeedKmh() {
      if (!playerCar) return 0;
      return Math.round(playerCar.speedKmh);
    },

    isPlayerDriving() {
      return playerCar !== null;
    },

    // How many cars are parked and stealable right now (traffic excluded).
    getParkedCount() {
      return cars.filter((car) => !car.isTraffic && !car.isPlayer).length;
    },

    // Police module hooks: damage the player's car, or kill its engine.
    // Round 8: garage armour plates the car, so a tuned car takes less
    // of the hit — the reduction rides on the car's tuning object.
    damagePlayerCar(amount) {
      if (playerCar) {
        const reduction = (playerCar.tuning && playerCar.tuning.damageReduction) || 0;
        playerCar.damage(amount * (1 - reduction));
      }
    },

    stopPlayerCar() {
      if (!playerCar) return;
      playerCar.engineDead = true;
      playerCar.speed = 0;
    },

    update(dt, input = {}) {
      // --- the player's car ------------------------------------------------
      if (playerCar && player && player.inVehicle) {
        const steerInput = (input.left ? -1 : 0) + (input.right ? 1 : 0);
        const throttle = (input.forward ? 1 : 0) + (input.back ? -1 : 0);
        // Shift is the sport-car boost while driving (on foot it is run).
        driveStep(playerCar, dt, throttle, steerInput, !!input.brake, !!input.handbrake, !!input.run);
        puffSmoke(playerCar, dt);
        // Keep the hidden player glued to the driver's seat.
        player.group.position.copy(playerCar.group.position);
        player.group.rotation.y = playerCar.heading;

        if (input.enterPressed) this.exitPlayerVehicle();
      }

      // --- traffic -----------------------------------------------------------
      // The player's group follows the car while driving, so this position
      // is the right anchor for traffic awareness in both modes.
      const playerPos = player ? player.group.position : null;
      for (let i = traffic.length - 1; i >= 0; i -= 1) {
        const car = traffic[i];
        if (car.destroyed) {
          traffic.splice(i, 1);
          continue;
        }
        updateTrafficCar(car, dt, playerPos);
        // Recycle cars that drifted far from the player back onto a lane
        // near the action, so the streets never empty out.
        if (playerPos) {
          const dist = Math.hypot(
            car.group.position.x - playerPos.x,
            car.group.position.z - playerPos.z,
          );
          if (dist > TRAFFIC_RECYCLE_DISTANCE) {
            const lane = lanes[(car.laneIndex + 1) % lanes.length];
            const point = lane.points[0];
            car.group.position.set(point.x, 0, point.z);
            car.laneIndex = (car.laneIndex + 1) % lanes.length;
            car.waypointIndex = 1;
            car.speed = 0;
          }
        }
      }
      // --- motorbikes ------------------------------------------------------
      // Bikes ride the same streets as the cars, quicker and looser.
      // They are never enterable, so nothing here can steal or drive one.
      for (let i = bikes.length - 1; i >= 0; i -= 1) {
        const bike = bikes[i];
        updateTrafficBike(bike, dt, playerPos);
        // Recycle a bike that drifted far from the player back onto a lane
        // near the action, so the streets never run out of bikes.
        if (playerPos) {
          const dist = Math.hypot(
            bike.group.position.x - playerPos.x,
            bike.group.position.z - playerPos.z,
          );
          if (dist > TRAFFIC_RECYCLE_DISTANCE) {
            const lane = lanes[(bike.laneIndex + 1) % lanes.length];
            const point = lane.points[0];
            bike.group.position.set(point.x, 0, point.z);
            bike.laneIndex = (bike.laneIndex + 1) % lanes.length;
            bike.waypointIndex = 1;
            bike.speed = 0;
          }
        }
      }
    },

    dispose() {
      for (const car of cars) car.dispose();
      for (const bike of bikes) bike.dispose();
      cars.length = 0;
      traffic.length = 0;
      bikes.length = 0;
      playerCar = null;
    },
  };

  return system;
}
