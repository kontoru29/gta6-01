// vehicles.js — every wheeled thing in Solmar Bay: cars, bikes, traffic.
//
// This module owns the garage and the street. The procedural car factory
// builds six body styles out of boxes and cylinders; one shared arcade
// driving model moves the player's car and the traffic cars alike, so a
// stolen car handles exactly like the one it was. NPC motorbikes weave
// through the same lanes, quicker and looser than the cars, and they are
// never drivable — they are scenery that moves.
//
// The sport garage:
//   * sport coupe, open-top roadster and low supercar — faster than the
//     everyday bodies, rarer on the street, painted in loud colours;
//   * boost: hold Shift in a sport body for an instant surge. The meter
//     drains in about 1.5 s and refills in about 4 s, and the brake
//     lights flare whenever the car brakes or reverses;
//   * NPC bikes: slim two-wheelers with a leaning rider, faster than the
//     cars, swaying across the lane as they filter past traffic.
//
// What other modules use (main.js, player.js, police.js, missions.js, hud.js):
//   createCar(scene, type, colour, x, z, heading) — one car in the scene.
//     Car fields: group, type, colour, heading, speed, steer, health,
//     destroyed, isPlayer, isTraffic, stolen, driver, takenByPlayer,
//     length, width, engineDead, boostMeter, boosting, rearLightMat,
//     laneIndex, waypointIndex, cruiseSpeed, speedKmh getter,
//     damage(amount), dispose().
//   createMotorbike(scene, x, z, heading, colour) — one NPC bike.
//     Fields: group, leanGroup, type, colour, heading, speed, isTraffic,
//     laneIndex, waypointIndex, cruiseSpeed, weavePhase, weaveClock,
//     lean, speedKmh getter, dispose().
//   createVehicleSystem(scene, city, options) — the system object:
//     cars, traffic, bikes, playerCar getter, bindPlayer(p),
//     spawnParked(n), spawnTraffic(n), spawnBikes(n),
//     spawnCarAt(type, colour, x, z, heading),
//     spawnBikeAt(x, z, heading, colour),
//     nearestEnterableVehicle(pos, maxDist),
//     enterPlayerVehicle(car), exitPlayerVehicle(), trySteal(playerPos),
//     getPlayerSpeedKmh(), isPlayerDriving(),
//     damagePlayerCar(amount), stopPlayerCar(),
//     update(dt, input), dispose().
//
// The city argument is optional: with no lanes, colliders or spawns the
// module falls back to a default 5x5 street grid.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning — every number that shapes how driving feels, in one place.
// ---------------------------------------------------------------------------

const TOP_SPEED = {
  sedan: 34,
  hatchback: 30,
  van: 25,
  sport: 44,
  roadster: 48,
  supercar: 52,
};
const ACCEL = { sedan: 13, hatchback: 12, van: 9, sport: 18, roadster: 20, supercar: 22 };
const BRAKE_FORCE = 30;
const REVERSE_TOP_SPEED = 9;
const STEER_RATE = 1.9;
// Steering answers the keys almost at once — the car must feel instant.
const STEER_RESPONSE = 10;
const GRIP = 3.2;
const HANDBRAKE_GRIP = 0.9;
const CAR_RADIUS = 1.35;
const STEAL_RANGE = 3.6;
const TRAFFIC_CRUISE = 11;
const TRAFFIC_BRAKE_AHEAD = 9;
const TRAFFIC_SWERVE_AHEAD = 14;
const TRAFFIC_DESPAWN = 130;

// Sport boost: Shift in a sport body. Instant surge, no wind-up.
const BOOST_TOP_MULT = 1.35;
const BOOST_ACCEL_MULT = 1.6;
const BOOST_DURATION = 1.5;
const BOOST_RECHARGE_RATE = 0.25;

const BODY_TYPES = ['sedan', 'hatchback', 'van', 'sport'];
const ALL_CAR_TYPES = ['sedan', 'hatchback', 'van', 'sport', 'roadster', 'supercar'];
const SPORT_TYPES = ['sport', 'roadster', 'supercar'];
const SPORT_TRAFFIC_CHANCE = 0.12;
const SPORT_PARKED_CHANCE = 0.15;

const BIKE_CRUISE = 16;
const BIKE_TOP_SPEED = 21;
const BIKE_ACCEL = 12;
const BIKE_WEAVE = 1.6;
const BIKE_WEAVE_RATE = 1.1;
const BIKE_COUNT = 5;

const PAINT_COLORS = [
  0xe23b3b, 0x2f7fd0, 0xf2b234, 0x37b268,
  0xf2f0e6, 0x8a5fbf, 0x22262e, 0xe87aa0,
];
// Loud palette reserved for the sport bodies, so they read as special.
const SPORT_PAINT_COLORS = [
  0x39d353, // lime
  0xff7a1a, // tangerine
  0x00c8c8, // lagoon cyan
  0xff2e88, // hot pink
  0xffe600, // electric yellow
];
const WINDOW_COLOR = 0x18222e;
const TYRE_COLOR = 0x14161a;
const HUB_COLOR = 0xb9c0c9;

// One scratch vector for the whole module: the hot loop never allocates.
const _fwd = { x: 0, z: 0 };

// Body dimensions per style: [length, width, bodyHeight, cabinLength].
const BODY_DIMS = {
  sedan: [4.4, 1.9, 0.62, 2.1],
  hatchback: [3.6, 1.8, 0.68, 2.0],
  van: [4.8, 2.0, 1.05, 3.4],
  sport: [4.3, 1.95, 0.5, 1.7],
  roadster: [4.2, 1.9, 0.5, 1.4],
  supercar: [4.4, 2.0, 0.44, 1.5],
};

// ---------------------------------------------------------------------------
// Car factory — six body styles from boxes, cylinders and paint.
// ---------------------------------------------------------------------------

function buildCarBody(type, colour) {
  const body = new THREE.Group();
  body.name = 'Car_' + type;
  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: WINDOW_COLOR, roughness: 0.15, metalness: 0.6 });
  const tyre = new THREE.MeshStandardMaterial({ color: TYRE_COLOR, roughness: 0.95 });
  const hub = new THREE.MeshStandardMaterial({ color: HUB_COLOR, roughness: 0.3, metalness: 0.7 });
  const lightFront = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 0.7 });
  const lightRear = new THREE.MeshStandardMaterial({ color: 0xd21f2b, emissive: 0x8f1018, emissiveIntensity: 0.7 });

  const putBox = (material, x, y, z, w, h, d, parent) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    (parent || body).add(mesh);
    return mesh;
  };

  const dims = BODY_DIMS[type];
  const length = dims[0];
  const width = dims[1];
  const bodyHeight = dims[2];
  const cabinLength = dims[3];
  const isVan = type === 'van';
  const cabinY = 0.55 + bodyHeight / 2 + (isVan ? 0.55 : 0.34);
  const cabinH = isVan ? 1.1 : 0.62;
  const cabinZ = isVan ? 0.1 : 0.15;

  // Slab, glass cabin, and a roof strip — except the roadster, which
  // keeps its cockpit open under a low raked windshield.
  putBox(paint, 0, 0.55, 0, width, bodyHeight, length);
  putBox(glass, 0, cabinY, cabinZ, width - 0.24, cabinH, cabinLength);
  if (type !== 'roadster') {
    putBox(paint, 0, cabinY + cabinH / 2, cabinZ, width - 0.18, 0.08, cabinLength - 0.3);
  }
  if (type === 'sport') {
    putBox(paint, 0, 1.05, length / 2 - 0.15, width - 0.3, 0.07, 0.3);
  }
  if (type === 'roadster') {
    putBox(glass, 0, cabinY + 0.22, -0.55, width - 0.5, 0.3, 0.06);
    putBox(paint, 0, 0.86, -length / 2 + 0.5, width - 0.24, 0.06, 0.9);
  }
  if (type === 'supercar') {
    // Big rear wing on twin struts, front splitter, black roof panel.
    putBox(paint, 0, 1.02, length / 2 - 0.12, width - 0.3, 0.06, 0.34);
    putBox(paint, -width / 2 + 0.35, 0.86, length / 2 - 0.12, 0.08, 0.22, 0.06);
    putBox(paint, width / 2 - 0.35, 0.86, length / 2 - 0.12, 0.08, 0.22, 0.06);
    putBox(paint, 0, 0.32, -length / 2 + 0.05, width - 0.2, 0.08, 0.3);
    putBox(tyre, 0, cabinY + cabinH / 2 + 0.02, 0.15, width - 0.3, 0.05, cabinLength - 0.5);
  }
  if (isVan) {
    putBox(paint, width / 2, 1.15, 0.2, 0.06, 0.5, 2.4);
    putBox(paint, -width / 2, 1.15, 0.2, 0.06, 0.5, 2.4);
  }

  // Headlights at -Z, taillights at +Z. The rear material is kept so
  // braking can flare it.
  putBox(lightFront, -width / 2 + 0.35, 0.62, -length / 2 - 0.01, 0.34, 0.12, 0.06);
  putBox(lightFront, width / 2 - 0.35, 0.62, -length / 2 - 0.01, 0.34, 0.12, 0.06);
  putBox(lightRear, -width / 2 + 0.35, 0.62, length / 2 + 0.01, 0.34, 0.12, 0.06);
  putBox(lightRear, width / 2 - 0.35, 0.62, length / 2 + 0.01, 0.34, 0.12, 0.06);

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

  return { group: body, length, width, rearLightMat: lightRear };
}

export function createCar(scene, type = 'sedan', colour = 0xe23b3b, x = 0, z = 0, heading = 0) {
  if (!ALL_CAR_TYPES.includes(type)) type = 'sedan';
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
    rearLightMat: built.rearLightMat,
    laneIndex: 0,
    waypointIndex: 0,
    cruiseSpeed: TRAFFIC_CRUISE,

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
  const skin = new THREE.MeshStandardMaterial({ color: 0xc98d64, roughness: 0.7 });

  const putBox = (material, x, y, z, w, h, d, parent) => {
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
  putBox(dark, 0, 0.62, 0, 0.09, 0.09, 1.35);
  putBox(paint, 0, 0.78, -0.08, 0.34, 0.22, 0.5);
  putBox(dark, 0, 0.8, 0.38, 0.3, 0.1, 0.45);
  putBox(chrome, 0, 0.95, -0.55, 0.56, 0.06, 0.06);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 1.2 });
  putBox(headMat, 0, 0.72, -0.62, 0.16, 0.12, 0.05);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xd21f2b, emissive: 0x8f1018, emissiveIntensity: 0.7 });
  putBox(tailMat, 0, 0.78, 0.62, 0.16, 0.1, 0.05);

  // Rider: torso leaning over the tank, helmet, arms to the bar, legs tucked.
  const torso = putBox(riderMat, 0, 1.15, 0.08, 0.42, 0.55, 0.26);
  torso.rotation.x = 0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skin);
  head.position.set(0, 1.5, -0.14);
  head.castShadow = true;
  leanGroup.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), helmetMat);
  helmet.position.set(0, 1.52, -0.14);
  helmet.castShadow = true;
  leanGroup.add(helmet);
  for (const side of [-1, 1]) {
    const arm = putBox(riderMat, side * 0.24, 1.28, -0.3, 0.11, 0.5, 0.12);
    arm.rotation.x = -0.9;
    const leg = putBox(dark, side * 0.2, 0.72, 0.18, 0.14, 0.5, 0.14);
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
    cruiseSpeed: BIKE_CRUISE,
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

function angleDifference(from, to) {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

// Forward vector of a heading (forward is -Z at heading 0), written into
// the shared scratch object. Read x/z at once; never hold the reference.
function forwardInto(heading, out) {
  out.x = -Math.sin(heading);
  out.z = -Math.cos(heading);
  return out;
}

// Fallback 5x5 two-way street grid, used only when the city gives no lanes.
function defaultLanes() {
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

function defaultCarSpawns() {
  const spots = [];
  for (let i = -2; i <= 2; i += 1) {
    spots.push({ x: i * 40 + 8, z: -30, heading: Math.PI });
    spots.push({ x: i * 40 - 8, z: 50, heading: 0 });
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Vehicle system
// ---------------------------------------------------------------------------
export function createVehicleSystem(scene, city = {}, options = {}) {
  const lanes = city.lanes && city.lanes.length > 0 ? city.lanes : defaultLanes();
  const colliders = city.buildingColliders || [];
  const carSpawns = city.carSpawns && city.carSpawns.length > 0 ? city.carSpawns : defaultCarSpawns();
  const bounds = city.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const onCarStolen = typeof options.onCarStolen === 'function' ? options.onCarStolen : null;

  let player = options.player || null;
  const cars = [];
  const traffic = [];
  const bikes = [];
  let playerCar = null;
  let spawnCursor = 0;

  // Sport cars are rare by design: most spawns are plain body styles.
  function pickSpawnType(cycleIndex, sportChance) {
    if (Math.random() < sportChance) {
      return SPORT_TYPES[Math.floor(Math.random() * SPORT_TYPES.length)];
    }
    return BODY_TYPES[cycleIndex % BODY_TYPES.length];
  }

  function pickColour(type, index) {
    if (SPORT_TYPES.includes(type)) {
      return SPORT_PAINT_COLORS[index % SPORT_PAINT_COLORS.length];
    }
    return PAINT_COLORS[index % PAINT_COLORS.length];
  }

  // --- collisions ----------------------------------------------------------

  function collidesWithBuildings(x, z, radius) {
    for (const box of colliders) {
      const closestX = Math.max(box.minX, Math.min(x, box.maxX));
      const closestZ = Math.max(box.minZ, Math.min(z, box.maxZ));
      const dx = x - closestX;
      const dz = z - closestZ;
      if (dx * dx + dz * dz < radius * radius) return box;
    }
    return null;
  }

  function collidesWithCar(car, x, z) {
    for (const other of cars) {
      if (other === car || other.destroyed) continue;
      const dx = x - other.group.position.x;
      const dz = z - other.group.position.z;
      const minDist = CAR_RADIUS * 2 - 0.2;
      if (dx * dx + dz * dz < minDist * minDist) return other;
    }
    return null;
  }

  // --- the shared arcade driving model ------------------------------------
  // One function drives every car, player or traffic. Steering tracks the
  // keys almost at once (STEER_RESPONSE 10) but the lock tightens with
  // speed, so fast cars stay forgiving instead of twitchy. Throttle,
  // brake and boost all bite the same frame the key is pressed.
  function driveStep(car, dt, throttle, steerInput, braking, handbrake, boostKey) {
    if (car.engineDead || car.destroyed) {
      car.speed *= Math.max(0, 1 - dt * 2);
      return;
    }
    const isSport = SPORT_TYPES.includes(car.type);
    let topSpeed = TOP_SPEED[car.type];
    let accel = ACCEL[car.type];
    // Boost: Shift in a sport car. Instant surge while the meter lasts;
    // it refills once you lift off.
    if (boostKey && isSport && car.boostMeter > 0) {
      topSpeed *= BOOST_TOP_MULT;
      accel *= BOOST_ACCEL_MULT;
      car.boostMeter = Math.max(0, car.boostMeter - dt / BOOST_DURATION);
      car.boosting = true;
    } else {
      car.boosting = false;
      car.boostMeter = Math.min(1, car.boostMeter + dt * BOOST_RECHARGE_RATE);
    }

    if (throttle > 0) car.speed += accel * throttle * dt;
    else if (throttle < 0) {
      // S: brake while moving forward, reverse once stopped.
      if (car.speed > 0.5) car.speed -= BRAKE_FORCE * dt;
      else car.speed -= accel * 0.6 * dt;
    }
    if (braking) car.speed -= BRAKE_FORCE * dt * (car.speed > 0 ? 1 : -0.4);
    if (handbrake) car.speed *= Math.max(0, 1 - dt * 1.6);

    // Rolling drag and the reverse cap.
    car.speed -= car.speed * 0.35 * dt;
    car.speed = Math.max(-REVERSE_TOP_SPEED, Math.min(topSpeed, car.speed));

    // Steering: less lock at high speed, fast wheel response; the
    // handbrake loosens it on purpose so the tail slides.
    const speedFactor = Math.min(1, Math.abs(car.speed) / 12);
    const targetSteer = steerInput * STEER_RATE * (0.45 + 0.55 * (1 - speedFactor * 0.6));
    const steerResponse = STEER_RESPONSE * (handbrake ? HANDBRAKE_GRIP / GRIP : 1);
    car.steer += (targetSteer - car.steer) * Math.min(1, dt * steerResponse);
    const direction = car.speed >= 0 ? 1 : -1;
    car.heading += car.steer * dt * direction * Math.min(1, Math.abs(car.speed) / 4 + 0.25);

    // Brake lights flare while braking or reversing — just a number on
    // an existing material, no allocation.
    if (car.rearLightMat) {
      car.rearLightMat.emissiveIntensity = (braking || throttle < 0) ? 2.2 : 0.7;
    }

    const fwd = forwardInto(car.heading, _fwd);
    const nextX = car.group.position.x + fwd.x * car.speed * dt;
    const nextZ = car.group.position.z + fwd.z * car.speed * dt;

    // Buildings: stop short and take a little damage on a hard hit.
    if (collidesWithBuildings(nextX, nextZ, CAR_RADIUS)) {
      if (Math.abs(car.speed) > 8) car.damage(Math.abs(car.speed) * 0.6);
      car.speed *= -0.25;
      return;
    }
    // Other cars: soft push — both lose speed instead of passing through.
    const other = collidesWithCar(car, nextX, nextZ);
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

  // --- traffic AI -----------------------------------------------------------
  // A traffic car chases the next point on its lane. If the car ahead (or
  // the player's car, or the player on foot) is too close it brakes; if
  // the blockage sits in its lane it nudges sideways to slip past.
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
    const headingError = angleDifference(car.heading, desiredHeading);
    const steerInput = THREE.MathUtils.clamp(headingError * 1.6, -1, 1);

    // Look ahead along the nose for anything in the way.
    const fwd = forwardInto(car.heading, _fwd);
    let blocked = false;
    let brake = false;
    for (const other of cars) {
      if (other === car || other.destroyed) continue;
      const ox = other.group.position.x - car.group.position.x;
      const oz = other.group.position.z - car.group.position.z;
      const along = ox * fwd.x + oz * fwd.z;
      const side = Math.abs(ox * -fwd.z + oz * fwd.x);
      if (along > 0 && along < TRAFFIC_SWERVE_AHEAD && side < 3.2) {
        blocked = true;
        if (along < TRAFFIC_BRAKE_AHEAD) brake = true;
      }
    }
    // The player on foot is also something to brake for.
    if (playerPos && player && !player.inVehicle) {
      const px = playerPos.x - car.group.position.x;
      const pz = playerPos.z - car.group.position.z;
      const along = px * fwd.x + pz * fwd.z;
      const side = Math.abs(px * -fwd.z + pz * fwd.x);
      if (along > 0 && along < TRAFFIC_BRAKE_AHEAD + 3 && side < 3) {
        blocked = true;
        brake = true;
      }
    }

    // Swerve: aim a little to the side of the blockage instead of stopping.
    let steer = steerInput;
    if (blocked && !brake) steer = THREE.MathUtils.clamp(steerInput + 0.55, -1, 1);
    const throttle = brake ? 0 : 1;
    // Traffic never reverses; ease toward its cruise speed.
    const cruise = Math.min(car.cruiseSpeed, TOP_SPEED[car.type] * 0.5);
    if (car.speed > cruise) car.speed -= 6 * dt;
    driveStep(car, dt, throttle, steer, brake, false, false);
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
    const sway = Math.sin(bike.weaveClock * BIKE_WEAVE_RATE * Math.PI + bike.weavePhase) * BIKE_WEAVE;
    const rightX = Math.cos(bike.heading);
    const rightZ = -Math.sin(bike.heading);
    const aimX = target.x + rightX * sway;
    const aimZ = target.z + rightZ * sway;
    const desiredHeading = Math.atan2(-(aimX - bike.group.position.x), -(aimZ - bike.group.position.z));
    const headingError = angleDifference(bike.heading, desiredHeading);
    const steerInput = THREE.MathUtils.clamp(headingError * 1.6, -1, 1);

    // Look ahead for a car (or the player on foot) to brake for.
    const fwd = forwardInto(bike.heading, _fwd);
    let brake = false;
    for (const other of cars) {
      if (other.destroyed) continue;
      const ox = other.group.position.x - bike.group.position.x;
      const oz = other.group.position.z - bike.group.position.z;
      const along = ox * fwd.x + oz * fwd.z;
      const side = Math.abs(ox * -fwd.z + oz * fwd.x);
      if (along > 0 && along < TRAFFIC_BRAKE_AHEAD && side < 3.0) {
        brake = true;
        break;
      }
    }
    if (!brake && playerPos && player && !player.inVehicle) {
      const px = playerPos.x - bike.group.position.x;
      const pz = playerPos.z - bike.group.position.z;
      const along = px * fwd.x + pz * fwd.z;
      const side = Math.abs(px * -fwd.z + pz * fwd.x);
      if (along > 0 && along < TRAFFIC_BRAKE_AHEAD + 3 && side < 2.5) brake = true;
    }

    // Speed: ease toward cruise, never past the bike's top speed.
    const cruise = Math.min(bike.cruiseSpeed, BIKE_TOP_SPEED);
    if (brake) bike.speed = Math.max(0, bike.speed - 18 * dt);
    else if (bike.speed < cruise) bike.speed = Math.min(cruise, bike.speed + BIKE_ACCEL * dt);
    else bike.speed = Math.max(cruise, bike.speed - 6 * dt);

    // Steering bites harder at low speed; the heading follows the aim.
    const speedFactor = Math.min(1, Math.abs(bike.speed) / 12);
    const turnRate = 2.4 * (0.5 + 0.5 * (1 - speedFactor * 0.5));
    bike.heading += THREE.MathUtils.clamp(headingError, -turnRate * dt, turnRate * dt);

    // Move along the NEW heading, not the one the brake check just read.
    const moveFwd = forwardInto(bike.heading, _fwd);
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

    spawnParked(count = 8) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const spot = carSpawns[spawnCursor % carSpawns.length];
        spawnCursor += 1;
        const type = pickSpawnType(spawnCursor + i, SPORT_PARKED_CHANCE);
        const colour = pickColour(type, spawnCursor * 3 + i);
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
    spawnBikes(count = BIKE_COUNT) {
      const made = [];
      for (let i = 0; i < count; i += 1) {
        const laneIndex = (bikes.length + i * 3) % lanes.length;
        const lane = lanes[laneIndex];
        const segIndex = Math.floor(Math.random() * (lane.points.length - 1));
        const segA = lane.points[segIndex];
        const segB = lane.points[segIndex + 1];
        const segT = Math.random();
        const point = {
          x: segA.x + (segB.x - segA.x) * segT,
          z: segA.z + (segB.z - segA.z) * segT,
        };
        const nextPoint = lane.points[(segIndex + 1) % lane.points.length];
        const heading = Math.atan2(-(nextPoint.x - point.x), -(nextPoint.z - point.z));
        const colour = PAINT_COLORS[(i * 3 + 1) % PAINT_COLORS.length];
        const bike = createMotorbike(scene, point.x, point.z, heading, colour);
        bike.laneIndex = laneIndex;
        bike.waypointIndex = (segIndex + 1) % lane.points.length;
        bike.cruiseSpeed = BIKE_CRUISE * (0.9 + Math.random() * 0.25);
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
        const segIndex = Math.floor(Math.random() * (lane.points.length - 1));
        const segA = lane.points[segIndex];
        const segB = lane.points[segIndex + 1];
        const segT = Math.random();
        const point = {
          x: segA.x + (segB.x - segA.x) * segT,
          z: segA.z + (segB.z - segA.z) * segT,
        };
        const pointIndex = segIndex;
        const type = pickSpawnType(i * 2 + 1, SPORT_TRAFFIC_CHANCE);
        const colour = pickColour(type, i * 5 + 2);
        // Face along the lane from the point the car actually spawns on,
        // toward the next waypoint it will drive to.
        const nextPoint = lane.points[(pointIndex + 1) % lane.points.length];
        const heading = Math.atan2(-(nextPoint.x - point.x), -(nextPoint.z - point.z));
        const car = createCar(scene, type, colour, point.x, point.z, heading);
        car.isTraffic = true;
        car.laneIndex = laneIndex;
        car.waypointIndex = (pointIndex + 1) % lane.points.length;
        car.cruiseSpeed = TRAFFIC_CRUISE * (0.85 + Math.random() * 0.3);
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
      const car = this.nearestEnterableVehicle(playerPos, STEAL_RANGE);
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

    // Police module hooks: damage the player's car, or kill its engine.
    damagePlayerCar(amount) {
      if (playerCar) playerCar.damage(amount);
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
          if (dist > TRAFFIC_DESPAWN) {
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
          if (dist > TRAFFIC_DESPAWN) {
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
