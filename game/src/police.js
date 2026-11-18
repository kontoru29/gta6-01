// police.js — the Marisol Bay police: wanted level, pursuit, arrest.
//
// One system owns everything about the law. Crimes feed a heat number
// (0-100); every 20 heat is one wanted star, up to five. The star count
// decides how many patrol cars, foot officers and police motorbikes hunt
// Leo: more stars means more units, faster cars and less patience.
// Motorbikes join from two stars — quicker and nimbler than the patrol
// cars, they cut through traffic to stay on Leo's tail, and on foot a
// rider can grab him just like an officer. Heat cools only while Leo is
// out of sight for a while, so a chase ends by breaking line of sight
// and staying away. Officers on foot can arrest Leo (busted); a wrecked
// car or zero health ends the run (wasted).
//
// The system is created once by main.js and driven every frame through
// update(dt, context). It never touches the HUD, the missions or the save
// file directly — it reports through the callbacks it was given
// (onWantedChanged, onBusted, onWasted, onRam) and through the small
// read-outs getWantedLevel(), getUnits() and getBlips().

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Public constants: the wanted scale and what each crime is worth.
// ---------------------------------------------------------------------------

export const MAX_WANTED = 5;

// Heat added by each kind of crime. A punch is a slap on the wrist;
// killing an officer is the fastest way to five stars.
export const CRIME_HEAT = {
  assault: 8,
  shooting: 12,
  carTheft: 14,
  hitAndRun: 10,
  speeding: 4,
  killPedestrian: 26,
  killPolice: 40,
};

// ---------------------------------------------------------------------------
// Tuning: everything that shapes how a chase feels, in one place.
// ---------------------------------------------------------------------------

const HEAT_PER_STAR = 20;
const MAX_HEAT = MAX_WANTED * HEAT_PER_STAR;

// Units on the street at each star count (index = stars).
const PATROL_CARS_PER_STAR = [0, 1, 2, 3, 4, 5];
const OFFICERS_PER_STAR = [0, 0, 1, 1, 2, 3];
// Police motorbikes join the chase from two stars: quicker and nimbler
// than the patrol cars, they cut through traffic to stay on Leo's tail.
const BIKES_PER_STAR = [0, 0, 1, 1, 2, 2];

// Heat only starts falling this long after the last crime, and only while
// Leo is hidden from every unit.
const COOLDOWN_AFTER_CRIME = 8; // seconds
const HEAT_LOSS_PER_SECOND = 3.0;
const HIDDEN_RANGE = 60; // farther than this from every unit counts as hidden
const UNSEEN_GIVE_UP = 22; // unseen this long and heat drains twice as fast

// Where fresh units appear and disappear.
const SPAWN_NEAR = 65; // never closer than this to the player
const SPAWN_FAR = 130; // never farther than this
const STAND_DOWN_RANGE = 170; // standing-down units vanish past this range

// Arrest and ramming rules.
const ARREST_RANGE = 2.4; // an officer this close starts the arrest
const ARREST_HOLD = 1.0; // seconds inside the range before the bust lands
const RAM_RANGE = 5.0; // a patrol car this close rams the player's car
const RAM_HIT = 9; // car health lost per ram
const RAM_PAUSE = 1.6; // seconds between rams from the same car

// Unit bodies.
const OFFICER_SPEED = 5.4; // metres per second on foot
const OFFICER_TOUGHNESS = 60; // health of one officer
const PATROL_TOUGHNESS = 120; // health of one patrol car
const CAR_TOP_SPEED = 26; // fastest a patrol car drives in a chase
const CAR_TURN_RATE = 2.4; // radians per second of steering
// A police bike outruns the patrol cars and turns on a coin: it is the
// unit that stays glued to Leo when the cars fall behind in traffic.
const BIKE_TOP_SPEED = 33;
const BIKE_TURN_RATE = 3.6;
const BIKE_TOUGHNESS = 60;

// Fallbacks used when the caller hands us no road network at all.
const FALLBACK_ROAD_GAP = 40;
const CITY_EDGE = 220;

let nextUnitId = 1;

// ---------------------------------------------------------------------------
// Pure helpers. Nothing here knows about the game.
// ---------------------------------------------------------------------------

function clampValue(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function dist2d(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

// Move `angle` toward `target` by at most `step` radians, the short way
// around the circle.
function turnToward(angle, target, step) {
  let diff = target - angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (diff > step) return angle + step;
  if (diff < -step) return angle - step;
  return target;
}

// A random point on a ring around (cx, cz), using the caller's rng.
function ringSpot(rng, cx, cz, near, far) {
  const angle = rng() * Math.PI * 2;
  const radius = near + rng() * (far - near);
  return { x: cx + Math.sin(angle) * radius, z: cz + Math.cos(angle) * radius };
}

// Snap a point onto the fallback road grid (streets every FALLBACK_ROAD_GAP
// metres, crossing at the origin) when no real road network is available.
function snapToGrid(point) {
  const gap = FALLBACK_ROAD_GAP;
  if (Math.abs(point.z % gap) < Math.abs(point.x % gap)) {
    return { x: point.x, z: Math.round(point.z / gap) * gap };
  }
  return { x: Math.round(point.x / gap) * gap, z: point.z };
}

// Small box-mesh helper shared by the three mesh factories.
function boxMesh(material, w, h, d, x, y, z, parent) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  if (parent) parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Mesh factories: what a patrol car, an officer and a police bike look like.
// ---------------------------------------------------------------------------

// A black-and-white patrol car: dark body, pale doors, a roof light bar
// whose red and blue halves flash while the car is chasing. The materials
// for the two halves are returned so update() can flash them.
function makePatrolCarMesh() {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x14181f, metalness: 0.55, roughness: 0.4 });
  const doorPaint = new THREE.MeshStandardMaterial({ color: 0xf2f0e8, metalness: 0.3, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2a33, metalness: 0.8, roughness: 0.15 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });

  const body = boxMesh(paint, 2.0, 0.62, 4.3, 0, 0.55, 0, group);
  body.castShadow = true;
  const cabin = boxMesh(glass, 1.7, 0.55, 2.2, 0, 1.12, -0.2, group);
  cabin.castShadow = true;

  // Pale doors on both flanks, so the car reads as a patrol car from the side.
  for (const side of [-1, 1]) {
    boxMesh(doorPaint, 0.06, 0.5, 1.7, side * 1.01, 0.62, 0.1, group);
  }

  const redLamp = new THREE.MeshStandardMaterial({
    color: 0xaa1111, emissive: 0xff2020, emissiveIntensity: 0.2,
  });
  const blueLamp = new THREE.MeshStandardMaterial({
    color: 0x1122aa, emissive: 0x2244ff, emissiveIntensity: 0.2,
  });
  boxMesh(tyre, 1.3, 0.12, 0.4, 0, 1.46, -0.2, group);
  boxMesh(redLamp, 0.55, 0.14, 0.34, -0.32, 1.56, -0.2, group);
  boxMesh(blueLamp, 0.55, 0.14, 0.34, 0.32, 1.56, -0.2, group);

  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 14);
  for (const [wx, wz] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) {
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.36, wz);
    wheel.castShadow = true;
    group.add(wheel);
  }

  return { group, redLamp, blueLamp };
}

// An officer on foot: navy uniform, cap, pale shirt front. Small on purpose
// — officers are read at a distance by the navy block and the cap.
function makeOfficerMesh() {
  const group = new THREE.Group();
  const uniform = new THREE.MeshStandardMaterial({ color: 0x1c2f55, roughness: 0.75 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc98d64, roughness: 0.7 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x101c33, roughness: 0.6 });

  const torso = boxMesh(uniform, 0.55, 0.72, 0.32, 0, 1.08, 0, group);
  torso.castShadow = true;
  boxMesh(shirt, 0.3, 0.5, 0.05, 0, 1.1, 0.18, group);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), skin);
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.24, 0.1, 12), capMat);
  cap.position.y = 1.78;
  group.add(cap);
  boxMesh(capMat, 0.34, 0.03, 0.22, 0, 1.74, 0.2, group);

  for (const side of [-1, 1]) {
    const leg = boxMesh(uniform, 0.2, 0.72, 0.22, side * 0.15, 0.36, 0, group);
    leg.castShadow = true;
    boxMesh(uniform, 0.14, 0.62, 0.16, side * 0.36, 1.05, 0, group);
  }

  return group;
}

// A police motorbike: a white patrol bike with a navy rider in a white
// helmet, and a small red-and-blue light pod on the rear rack that flashes
// with the rest of the force. The rider and bike sit in an inner lean
// group, so the whole unit banks into corners while it chases.
// Police heading convention: 0 faces +Z, so a left turn (heading growing)
// leans the bike toward +X — the lean group rolls the other way round
// from the traffic bikes in vehicles.js, which face -Z.
function makePoliceBikeMesh() {
  const group = new THREE.Group();
  const leanGroup = new THREE.Group();
  group.add(leanGroup);

  const paint = new THREE.MeshStandardMaterial({ color: 0xf2f0e8, metalness: 0.35, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14181f, metalness: 0.5, roughness: 0.5 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xb9c0c9, roughness: 0.25, metalness: 0.8 });
  const uniform = new THREE.MeshStandardMaterial({ color: 0x1c2f55, roughness: 0.75 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.3 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc98d64, roughness: 0.7 });

  // Two wheels, frame spine, tank, seat and handlebar. The bike faces +Z
  // here (the police module's forward), so the front wheel is at +Z.
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.12, 16);
  for (const wz of [-0.55, 0.55]) {
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, 0.34, wz);
    wheel.castShadow = true;
    leanGroup.add(wheel);
  }
  boxMesh(dark, 0.09, 0.09, 1.35, 0, 0.62, 0, leanGroup);
  boxMesh(paint, 0.34, 0.22, 0.5, 0, 0.78, 0.08, leanGroup);
  boxMesh(dark, 0.3, 0.1, 0.45, 0, 0.8, -0.38, leanGroup);
  boxMesh(chrome, 0.56, 0.06, 0.06, 0, 0.95, 0.55, leanGroup);

  // The rider: navy uniform, white helmet, leaning forward over the tank.
  const torso = boxMesh(uniform, 0.42, 0.55, 0.26, 0, 1.15, -0.08, leanGroup);
  torso.rotation.x = -0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), skin);
  head.position.set(0, 1.5, 0.14);
  head.castShadow = true;
  leanGroup.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), helmetMat);
  helmet.position.set(0, 1.52, 0.14);
  helmet.castShadow = true;
  leanGroup.add(helmet);
  for (const side of [-1, 1]) {
    const arm = boxMesh(uniform, 0.11, 0.5, 0.12, side * 0.24, 1.28, 0.3, leanGroup);
    arm.rotation.x = 0.9;
    const leg = boxMesh(uniform, 0.14, 0.5, 0.14, side * 0.2, 0.72, -0.18, leanGroup);
    leg.rotation.x = -0.35;
  }

  // Rear light pod: red on the left, blue on the right, flashing with
  // the patrol cars. Materials are returned so flashSirens can drive them.
  const redLamp = new THREE.MeshStandardMaterial({
    color: 0xaa1111, emissive: 0xff2020, emissiveIntensity: 0.2,
  });
  const blueLamp = new THREE.MeshStandardMaterial({
    color: 0x1122aa, emissive: 0x2244ff, emissiveIntensity: 0.2,
  });
  boxMesh(dark, 0.5, 0.08, 0.3, 0, 0.95, -0.55, leanGroup);
  boxMesh(redLamp, 0.2, 0.12, 0.22, -0.13, 1.04, -0.55, leanGroup);
  boxMesh(blueLamp, 0.2, 0.12, 0.22, 0.13, 1.04, -0.55, leanGroup);

  return { group, leanGroup, redLamp, blueLamp };
}

// ---------------------------------------------------------------------------
// The department itself — a closure, not a class: the state lives in local
// variables and the returned object is the whole public surface.
// ---------------------------------------------------------------------------

// The factory main.js calls. Options:
// { scene, policeStation, onWantedChanged(level), onBusted(), onWasted(reason),
//   onRam(amount), random }
export function createPoliceSystem(options = {}) {
  const scene = options.scene || null;
  const station = options.policeStation || { x: 0, z: 0 };
  const onWantedChanged = typeof options.onWantedChanged === 'function' ? options.onWantedChanged : null;
  const onBusted = typeof options.onBusted === 'function' ? options.onBusted : null;
  const onWasted = typeof options.onWasted === 'function' ? options.onWasted : null;
  const onRam = typeof options.onRam === 'function' ? options.onRam : null;
  const rng = typeof options.random === 'function' ? options.random : Math.random;

  let heat = 0;
  let stars = 0;
  let clock = 0;
  let lastCrimeAt = -Infinity;
  let lastSeenAt = -Infinity;
  let ended = false;
  const units = [];
  // Reused per-frame scratch: update() returns the same events object
  // every frame, and getBlips() refills the same blip list, so the hot
  // loop never allocates.
  const frameEvents = { busted: false, wasted: false };
  const blipPool = [];
  const blipsOut = [];

  // --- unit construction ----------------------------------------------------

  function baseUnit(kind, group, toughness, lamps) {
    const id = nextUnitId;
    nextUnitId += 1;
    return {
      id,
      kind,
      group,
      health: toughness,
      maxHealth: toughness,
      alive: true,
      mode: 'chasing',
      heading: 0,
      speed: 0,
      lean: 0,
      arrestTimer: 0,
      lastRamAt: -Infinity,
      lamps: lamps || null,
    };
  }

  // Build one unit object (car, bike or officer) and put its mesh in the scene.
  function buildUnit(kind, spot) {
    if (kind === 'officer') {
      const group = makeOfficerMesh();
      group.position.set(spot.x, 0, spot.z);
      if (scene) scene.add(group);
      return baseUnit('officer', group, OFFICER_TOUGHNESS, null);
    }
    if (kind === 'bike') {
      const built = makePoliceBikeMesh();
      built.group.position.set(spot.x, 0, spot.z);
      if (scene) scene.add(built.group);
      const unit = baseUnit('bike', built.group, BIKE_TOUGHNESS, { red: built.redLamp, blue: built.blueLamp });
      unit.leanGroup = built.leanGroup;
      return unit;
    }
    const built = makePatrolCarMesh();
    built.group.position.set(spot.x, 0, spot.z);
    if (scene) scene.add(built.group);
    return baseUnit('car', built.group, PATROL_TOUGHNESS, { red: built.redLamp, blue: built.blueLamp });
  }

  function removeUnit(unit) {
    if (scene) scene.remove(unit.group);
    unit.alive = false;
    const index = units.indexOf(unit);
    if (index >= 0) units.splice(index, 1);
  }

  // Pick a spawn point for a fresh unit: a ring around the player, snapped
  // to a road when the caller gave us a road network.
  function pickSpawnSpot(playerPos, roads) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ring = ringSpot(rng, playerPos.x, playerPos.z, SPAWN_NEAR, SPAWN_FAR);
      let spot = ring;
      if (roads && typeof roads.randomRoadPointNear === 'function') {
        const roadSpot = roads.randomRoadPointNear(playerPos, SPAWN_NEAR, SPAWN_FAR);
        if (roadSpot) spot = roadSpot;
      } else if (roads && typeof roads.nearestRoadPoint === 'function') {
        const roadSpot = roads.nearestRoadPoint(ring);
        if (roadSpot) spot = roadSpot;
      } else {
        spot = snapToGrid(ring);
      }
      spot.x = clampValue(spot.x, -CITY_EDGE, CITY_EDGE);
      spot.z = clampValue(spot.z, -CITY_EDGE, CITY_EDGE);
      if (dist2d(spot.x, spot.z, playerPos.x, playerPos.z) >= SPAWN_NEAR) return spot;
    }
    return { x: playerPos.x + SPAWN_NEAR, z: playerPos.z };
  }

  // Grow or shrink the force until it matches the current star count.
  // Counts in one pass and removes surplus farthest-first, one at a
  // time — no temporary arrays, so this stays cheap every frame.
  function syncForce(playerPos, roads) {
    const anchor = playerPos || station;
    const wantCars = PATROL_CARS_PER_STAR[stars] || 0;
    const wantOfficers = OFFICERS_PER_STAR[stars] || 0;
    const wantBikes = BIKES_PER_STAR[stars] || 0;
    let cars = 0;
    let officers = 0;
    let bikes = 0;
    for (const unit of units) {
      if (!unit.alive) continue;
      if (unit.kind === 'car') cars += 1;
      else if (unit.kind === 'officer') officers += 1;
      else if (unit.kind === 'bike') bikes += 1;
    }
    for (let i = cars; i < wantCars; i += 1) {
      units.push(buildUnit('car', pickSpawnSpot(anchor, roads)));
    }
    for (let i = officers; i < wantOfficers; i += 1) {
      units.push(buildUnit('officer', pickSpawnSpot(anchor, roads)));
    }
    for (let i = bikes; i < wantBikes; i += 1) {
      units.push(buildUnit('bike', pickSpawnSpot(anchor, roads)));
    }
    // Too many: stand down the farthest ones first.
    const removeFarthest = (kind, want) => {
      let count = 0;
      for (const unit of units) {
        if (unit.alive && unit.kind === kind) count += 1;
      }
      while (count > want) {
        let farthest = null;
        let farDist = -1;
        for (const unit of units) {
          if (!unit.alive || unit.kind !== kind) continue;
          const d = dist2d(unit.group.position.x, unit.group.position.z, anchor.x, anchor.z);
          if (d > farDist) {
            farDist = d;
            farthest = unit;
          }
        }
        if (!farthest) break;
        farthest.mode = 'standingDown';
        removeUnit(farthest);
        count -= 1;
      }
    };
    removeFarthest('car', wantCars);
    removeFarthest('officer', wantOfficers);
    removeFarthest('bike', wantBikes);
  }

  // Tell the game the star count moved, and resize the force to match it.
  function publishStars() {
    const wanted = starsForHeatValue(heat);
    if (wanted === stars) return;
    stars = wanted;
    syncForce();
    if (onWantedChanged) onWantedChanged(stars);
  }

  // --- one unit, one frame ---------------------------------------------------

  // One patrol car, one frame: steer at the target, close in, ram on contact.
  function stepPatrolCar(unit, dt, playerPos, playerCarPos, playerInCar) {
    const target = playerInCar && playerCarPos ? playerCarPos : playerPos;
    const dx = target.x - unit.group.position.x;
    const dz = target.z - unit.group.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.01) return;
    const wantedHeading = Math.atan2(dx, dz);
    unit.heading = turnToward(unit.heading, wantedHeading, CAR_TURN_RATE * dt);
    const cruise = Math.min(CAR_TOP_SPEED, 12 + stars * 2.5);
    const desiredSpeed = distance > 10 ? cruise : cruise * 0.55;
    unit.speed += (desiredSpeed - unit.speed) * Math.min(1, dt * 2.5);
    unit.group.position.x += Math.sin(unit.heading) * unit.speed * dt;
    unit.group.position.z += Math.cos(unit.heading) * unit.speed * dt;
    unit.group.rotation.y = unit.heading;
    unit.mode = 'chasing';

    // Ram: close to the player's car, cooldown respected, one hit at a time.
    if (playerInCar && playerCarPos && distance < RAM_RANGE) {
      if (clock - unit.lastRamAt > RAM_PAUSE) {
        unit.lastRamAt = clock;
        // Shove the patrol car back a touch so it does not glue itself on.
        unit.group.position.x -= Math.sin(unit.heading) * 1.2;
        unit.group.position.z -= Math.cos(unit.heading) * 1.2;
        if (onRam) onRam(RAM_HIT);
      }
    }
  }

  // One police bike, one frame: outrun the patrol cars, cut through
  // traffic and stay on Leo's tail. Bikes never ram a car — they are too
  // light for that — but on foot a rider grabs Leo just like an officer
  // does. Returns true when the rider makes the bust.
  function stepBike(unit, dt, playerPos, playerInCar) {
    const dx = playerPos.x - unit.group.position.x;
    const dz = playerPos.z - unit.group.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.01) return false;
    const wantedHeading = Math.atan2(dx, dz);
    const beforeHeading = unit.heading;
    unit.heading = turnToward(unit.heading, wantedHeading, BIKE_TURN_RATE * dt);
    const cruise = Math.min(BIKE_TOP_SPEED, 14 + stars * 3);
    const desiredSpeed = distance > 12 ? cruise : cruise * 0.6;
    unit.speed += (desiredSpeed - unit.speed) * Math.min(1, dt * 3);
    unit.group.position.x += Math.sin(unit.heading) * unit.speed * dt;
    unit.group.position.z += Math.cos(unit.heading) * unit.speed * dt;
    unit.group.rotation.y = unit.heading;
    unit.mode = 'chasing';

    // Lean into the turn. This module faces +Z, so a growing heading is a
    // left turn and the bike banks toward +X: the lean group rolls the
    // opposite way from the traffic bikes, which face -Z.
    const turnRate = (unit.heading - beforeHeading) / Math.max(dt, 0.001);
    const leanTarget = clampValue(turnRate * -0.12, -0.5, 0.5);
    unit.lean = (unit.lean || 0) + (leanTarget - (unit.lean || 0)) * Math.min(1, dt * 8);
    if (unit.leanGroup) unit.leanGroup.rotation.z = unit.lean;

    if (!playerInCar && distance < ARREST_RANGE) {
      unit.arrestTimer += dt;
      if (unit.arrestTimer >= ARREST_HOLD) return true;
    } else {
      unit.arrestTimer = 0;
    }
    return false;
  }

  // One officer, one frame: run at Leo on foot. Returns true on a bust.
  function stepOfficer(unit, dt, playerPos, playerInCar) {
    if (playerInCar) {
      unit.arrestTimer = 0;
      unit.mode = 'chasing';
      return false;
    }
    const dx = playerPos.x - unit.group.position.x;
    const dz = playerPos.z - unit.group.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance > 0.01) {
      const wantedHeading = Math.atan2(dx, dz);
      unit.heading = turnToward(unit.heading, wantedHeading, 5.0 * dt);
      unit.group.position.x += Math.sin(unit.heading) * OFFICER_SPEED * dt;
      unit.group.position.z += Math.cos(unit.heading) * OFFICER_SPEED * dt;
      unit.group.rotation.y = unit.heading;
    }
    unit.mode = 'chasing';
    if (distance < ARREST_RANGE) {
      unit.arrestTimer += dt;
      if (unit.arrestTimer >= ARREST_HOLD) return true;
    } else {
      unit.arrestTimer = 0;
    }
    return false;
  }

  // Alternate the red and blue halves of every light bar. A bike's pod
  // strobes twice as fast and brighter than a car's bar, so the bike
  // reads as an urgent flashing unit even at a distance.
  function flashSirens() {
    for (const unit of units) {
      if (!unit.lamps) continue;
      const isBike = unit.kind === 'bike';
      const rate = isBike ? 5.6 : 2.8;
      const peak = isBike ? 2.6 : 1.8;
      const phase = Math.floor(clock * rate) % 2 === 0;
      unit.lamps.red.emissiveIntensity = phase ? peak : 0.15;
      unit.lamps.blue.emissiveIntensity = phase ? 0.15 : peak;
    }
  }

  // Send every unit home without a fuss (after a bust, mainly).
  function standDownAll() {
    for (const unit of [...units]) {
      unit.mode = 'standingDown';
      removeUnit(unit);
    }
  }

  // Hurt one unit. Returns true when the hit killed it.
  function damageUnit(unit, amount) {
    if (!unit || !unit.alive) return false;
    unit.health = Math.max(0, unit.health - (amount || 0));
    if (unit.health > 0) return false;
    unit.alive = false;
    if (scene) scene.remove(unit.group);
    const index = units.indexOf(unit);
    if (index >= 0) units.splice(index, 1);
    return true;
  }

  // --- the frame step --------------------------------------------------------

  function update(dt, context) {
    const ctx = context || {};
    const step = Math.max(0, dt || 0);
    clock += step;
    frameEvents.busted = false;
    frameEvents.wasted = false;
    const events = frameEvents;
    if (ended) return events;

    const playerPos = ctx.playerPosition || { x: 0, y: 0, z: 0 };
    const playerInCar = Boolean(ctx.playerInCar);
    const playerHealth = typeof ctx.playerHealth === 'number' ? ctx.playerHealth : 100;
    const playerCarHealth = typeof ctx.playerCarHealth === 'number' ? ctx.playerCarHealth : null;
    const playerCarPos = ctx.playerCarPosition || null;
    const roads = ctx.roadNetwork || null;

    // Wasted: Leo is down, or his car is a wreck.
    if (playerHealth <= 0) {
      ended = true;
      if (onWasted) onWasted('health');
      events.wasted = true;
      return events;
    }
    if (playerCarHealth !== null && playerCarHealth <= 0) {
      ended = true;
      if (onWasted) onWasted('vehicleDestroyed');
      events.wasted = true;
      return events;
    }

    // How close is the nearest unit? That decides hiding and giving up.
    let nearest = Infinity;
    for (const unit of units) {
      if (!unit.alive) continue;
      const d = dist2d(unit.group.position.x, unit.group.position.z, playerPos.x, playerPos.z);
      if (d < nearest) nearest = d;
    }
    const hidden = nearest > HIDDEN_RANGE || units.length === 0;
    if (!hidden) lastSeenAt = clock;

    // Heat cools only after the grace period, and only while hidden.
    if (hidden && clock - lastCrimeAt > COOLDOWN_AFTER_CRIME && heat > 0) {
      let loss = HEAT_LOSS_PER_SECOND * step;
      if (clock - lastSeenAt > UNSEEN_GIVE_UP) loss *= 2;
      heat = Math.max(0, heat - loss);
      publishStars();
    }

    // Keep the force matched to the stars, then move every unit.
    syncForce(playerPos, roads);
    for (const unit of [...units]) {
      if (!unit.alive) continue;
      let caught = false;
      if (unit.kind === 'car') {
        stepPatrolCar(unit, step, playerPos, playerCarPos, playerInCar);
      } else if (unit.kind === 'bike') {
        caught = stepBike(unit, step, playerPos, playerInCar);
      } else {
        caught = stepOfficer(unit, step, playerPos, playerInCar);
      }
      if (caught) {
        ended = true;
        if (onBusted) onBusted();
        events.busted = true;
        standDownAll();
        return events;
      }
    }

    // Units that gave up and drifted far away quietly leave.
    for (const unit of [...units]) {
      if (!unit.alive) continue;
      if (unit.mode === 'standingDown') {
        const d = dist2d(unit.group.position.x, unit.group.position.z, playerPos.x, playerPos.z);
        if (d > STAND_DOWN_RANGE) removeUnit(unit);
      }
    }

    flashSirens();
    return events;
  }

  // --- the public surface ----------------------------------------------------

  return {
    get wantedLevel() { return stars; },
    get heatValue() { return heat; },
    get sirenActive() { return stars > 0 && units.some((unit) => unit.mode === 'chasing'); },
    get liveUnits() { return units; },

    getWantedLevel() { return stars; },
    getHeat() { return heat; },
    isWanted() { return stars > 0; },
    getUnits() { return units.filter((unit) => unit.alive); },
    // Minimap blips, refilled in place every call: the same array and
    // the same blip objects come back, so the per-frame minimap read
    // never allocates.
    getBlips() {
      blipsOut.length = 0;
      let n = 0;
      for (const unit of units) {
        if (!unit.alive) continue;
        let blip = blipPool[n];
        if (!blip) {
          blip = { x: 0, z: 0, kind: '' };
          blipPool[n] = blip;
        }
        blip.x = unit.group.position.x;
        blip.z = unit.group.position.z;
        blip.kind = unit.kind;
        blipsOut.push(blip);
        n += 1;
      }
      return blipsOut;
    },

    publishStars,
    reportCrime(type, details) {
      const heatGain = Object.prototype.hasOwnProperty.call(CRIME_HEAT, type)
        ? CRIME_HEAT[type]
        : 10;
      heat = clampValue(heat + heatGain, 0, MAX_HEAT);
      lastCrimeAt = clock;
      const before = stars;
      publishStars();
      return {
        stars,
        heat,
        changed: stars !== before,
        type,
        details: details || {},
      };
    },
    setWantedLevel(level) {
      const wanted = clampValue(Math.round(level) || 0, 0, MAX_WANTED);
      const before = stars;
      heat = wanted * HEAT_PER_STAR;
      lastCrimeAt = clock;
      publishStars();
      return { stars, heat, changed: stars !== before };
    },
    addHeat(amount) {
      heat = clampValue(heat + (amount || 0), 0, MAX_HEAT);
      publishStars();
      return stars;
    },
    clearWanted() {
      return this.setWantedLevel(0);
    },

    buildUnit,
    removeUnit,
    // Force one unit to appear at an exact spot (shot staging uses this).
    spawnAt(position, kind) {
      const wantedKind = kind === 'officer' ? 'officer' : kind === 'bike' ? 'bike' : 'car';
      const spot = {
        x: position && typeof position.x === 'number' ? position.x : 0,
        z: position && typeof position.z === 'number' ? position.z : 0,
      };
      const unit = buildUnit(wantedKind, spot);
      units.push(unit);
      return unit;
    },
    pickSpawnSpot,
    syncForce,
    damageUnit,

    update,
    stepPatrolCar,
    stepBike,
    stepOfficer,
    flashSirens,
    standDownAll,

    reset() {
      standDownAll();
      heat = 0;
      stars = 0;
      ended = false;
      lastCrimeAt = -Infinity;
      lastSeenAt = -Infinity;
    },
    dispose() {
      for (const unit of [...units]) removeUnit(unit);
      heat = 0;
      stars = 0;
      ended = false;
    },
  };
}

// Convenience: the star count for a heat value, for HUD code that keeps its
// own heat number instead of asking this module.
export function starsForHeatValue(value) {
  if (value <= 0) return 0;
  return clampValue(Math.floor(value / HEAT_PER_STAR), 0, MAX_WANTED);
}
