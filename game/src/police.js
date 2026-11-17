// police.js — the Marisol Bay police department: wanted level, pursuit,
// arrests and the "wasted" end of a chase.
//
// One system owns everything about the law in Solmar Bay. Crimes feed a
// heat number (0-100); every 20 heat is one wanted star, up to five. The
// star count decides how many patrol cars and foot officers hunt Leo:
// more stars means more units, faster cars and less patience. Heat cools
// down only while Leo is out of sight for a while, so a chase ends by
// breaking line of sight and staying away, not by waiting it out in the
// open. Officers on foot can arrest Leo (busted); a wrecked car or zero
// health ends the run (wasted).
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

// Heat added by each kind of crime. A punch is a slap on the wrist; killing
// an officer is the fastest way to five stars.
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

// Fallbacks used when the caller hands us no road network at all.
const FALLBACK_ROAD_GAP = 40;
const CITY_EDGE = 220;

// ---------------------------------------------------------------------------
// Tiny helpers. Nothing here knows about the game; they are pure maths.
// ---------------------------------------------------------------------------

function limitNumber(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function flatDistance(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

// Turn `angle` toward `target` by at most `step` radians, taking the short
// way around the circle.
function steerAngle(angle, target, step) {
  let diff = target - angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (diff > step) return angle + step;
  if (diff < -step) return angle - step;
  return target;
}

// A random point on a ring around (cx, cz), using the caller's rng.
function ringPoint(rng, cx, cz, near, far) {
  const angle = rng() * Math.PI * 2;
  const radius = near + rng() * (far - near);
  return { x: cx + Math.sin(angle) * radius, z: cz + Math.cos(angle) * radius };
}

// Snap a point onto the fallback road grid (streets every FALLBACK_ROAD_GAP
// metres, crossing at the origin) when no real road network is available.
function snapToGrid(point) {
  const gap = FALLBACK_ROAD_GAP;
  const onXRoad = Math.abs(point.z % gap) < Math.abs(point.x % gap);
  if (onXRoad) {
    return { x: point.x, z: Math.round(point.z / gap) * gap };
  }
  return { x: Math.round(point.x / gap) * gap, z: point.z };
}

// ---------------------------------------------------------------------------
// Mesh factories: what a patrol car and an officer look like.
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

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.62, 4.3), paint);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.2), glass);
  cabin.position.set(0, 1.12, -0.2);
  cabin.castShadow = true;
  group.add(cabin);

  // Pale doors on both flanks, so the car reads as a patrol car from the side.
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 1.7), doorPaint);
    door.position.set(side * 1.01, 0.62, 0.1);
    group.add(door);
  }

  const redLamp = new THREE.MeshStandardMaterial({
    color: 0xaa1111, emissive: 0xff2020, emissiveIntensity: 0.2,
  });
  const blueLamp = new THREE.MeshStandardMaterial({
    color: 0x1122aa, emissive: 0x2244ff, emissiveIntensity: 0.2,
  });
  const barBase = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.4), tyre);
  barBase.position.set(0, 1.46, -0.2);
  group.add(barBase);
  const redHalf = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.34), redLamp);
  redHalf.position.set(-0.32, 1.56, -0.2);
  group.add(redHalf);
  const blueHalf = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.34), blueLamp);
  blueHalf.position.set(0.32, 1.56, -0.2);
  group.add(blueHalf);

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

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.72, 0.32), uniform);
  torso.position.y = 1.08;
  torso.castShadow = true;
  group.add(torso);

  const shirtFront = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.05), shirt);
  shirtFront.position.set(0, 1.1, 0.18);
  group.add(shirtFront);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), skin);
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.24, 0.1, 12), capMat);
  cap.position.y = 1.78;
  group.add(cap);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.22), capMat);
  brim.position.set(0, 1.74, 0.2);
  group.add(brim);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.22), uniform);
    leg.position.set(side * 0.15, 0.36, 0);
    leg.castShadow = true;
    group.add(leg);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.62, 0.16), uniform);
    arm.position.set(side * 0.36, 1.05, 0);
    group.add(arm);
  }

  return group;
}

// ---------------------------------------------------------------------------
// The department itself.
// ---------------------------------------------------------------------------

let nextUnitId = 1;

class PoliceDepartment {
  constructor(options) {
    const opts = options || {};
    this.scene = opts.scene || null;
    this.station = opts.policeStation || { x: 0, z: 0 };
    this.onWantedChanged = typeof opts.onWantedChanged === 'function' ? opts.onWantedChanged : null;
    this.onBusted = typeof opts.onBusted === 'function' ? opts.onBusted : null;
    this.onWasted = typeof opts.onWasted === 'function' ? opts.onWasted : null;
    this.onRam = typeof opts.onRam === 'function' ? opts.onRam : null;
    this.rng = typeof opts.random === 'function' ? opts.random : Math.random;

    this.heat = 0;
    this.stars = 0;
    this.units = [];
    this.clock = 0;
    this.lastCrimeAt = -Infinity;
    this.lastSeenAt = -Infinity;
    this.ended = false;
  }

  // --- read-outs -----------------------------------------------------------

  get wantedLevel() {
    return this.stars;
  }

  get heatValue() {
    return this.heat;
  }

  get sirenActive() {
    return this.stars > 0 && this.units.some((unit) => unit.mode === 'chasing');
  }

  get liveUnits() {
    return this.units;
  }

  getWantedLevel() {
    return this.stars;
  }

  getHeat() {
    return this.heat;
  }

  isWanted() {
    return this.stars > 0;
  }

  getUnits() {
    return this.units.filter((unit) => unit.alive);
  }

  getBlips() {
    return this.units
      .filter((unit) => unit.alive)
      .map((unit) => ({
        x: unit.group.position.x,
        z: unit.group.position.z,
        kind: unit.kind,
      }));
  }

  // --- heat and stars ------------------------------------------------------

  // Tell the game the star count moved, and resize the force to match it.
  publishStars() {
    const wanted = starsForHeatValue(this.heat);
    if (wanted === this.stars) return;
    this.stars = wanted;
    this.syncForce();
    if (this.onWantedChanged) this.onWantedChanged(this.stars);
  }

  reportCrime(type, details) {
    const heatGain = Object.prototype.hasOwnProperty.call(CRIME_HEAT, type)
      ? CRIME_HEAT[type]
      : 10;
    this.heat = limitNumber(this.heat + heatGain, 0, MAX_HEAT);
    this.lastCrimeAt = this.clock;
    const before = this.stars;
    this.publishStars();
    return {
      stars: this.stars,
      heat: this.heat,
      changed: this.stars !== before,
      type,
      details: details || {},
    };
  }

  setWantedLevel(level) {
    const wanted = limitNumber(Math.round(level) || 0, 0, MAX_WANTED);
    const before = this.stars;
    this.heat = wanted * HEAT_PER_STAR;
    this.lastCrimeAt = this.clock;
    this.publishStars();
    return { stars: this.stars, heat: this.heat, changed: this.stars !== before };
  }

  addHeat(amount) {
    this.heat = limitNumber(this.heat + (amount || 0), 0, MAX_HEAT);
    this.publishStars();
    return this.stars;
  }

  clearWanted() {
    return this.setWantedLevel(0);
  }

  // --- units ---------------------------------------------------------------

  // Build one unit object (car or officer) and put its mesh in the scene.
  buildUnit(kind, spot) {
    const id = nextUnitId;
    nextUnitId += 1;
    if (kind === 'officer') {
      const group = makeOfficerMesh();
      group.position.set(spot.x, 0, spot.z);
      if (this.scene) this.scene.add(group);
      return {
        id,
        kind: 'officer',
        group,
        health: OFFICER_TOUGHNESS,
        maxHealth: OFFICER_TOUGHNESS,
        alive: true,
        mode: 'chasing',
        heading: 0,
        speed: 0,
        arrestTimer: 0,
        lastRamAt: -Infinity,
        lamps: null,
      };
    }
    const built = makePatrolCarMesh();
    built.group.position.set(spot.x, 0, spot.z);
    if (this.scene) this.scene.add(built.group);
    return {
      id,
      kind: 'car',
      group: built.group,
      health: PATROL_TOUGHNESS,
      maxHealth: PATROL_TOUGHNESS,
      alive: true,
      mode: 'chasing',
      heading: 0,
      speed: 0,
      arrestTimer: 0,
      lastRamAt: -Infinity,
      lamps: { red: built.redLamp, blue: built.blueLamp },
    };
  }

  removeUnit(unit) {
    if (this.scene) this.scene.remove(unit.group);
    unit.alive = false;
    const index = this.units.indexOf(unit);
    if (index >= 0) this.units.splice(index, 1);
  }

  // Force one unit to appear at an exact spot (shot staging uses this).
  spawnAt(position, kind) {
    const wantedKind = kind === 'officer' ? 'officer' : 'car';
    const spot = {
      x: position && typeof position.x === 'number' ? position.x : 0,
      z: position && typeof position.z === 'number' ? position.z : 0,
    };
    const unit = this.buildUnit(wantedKind, spot);
    this.units.push(unit);
    return unit;
  }

  // Pick a spawn point for a fresh unit: a ring around the player, snapped
  // to a road when the caller gave us a road network.
  pickSpawnSpot(playerPos, roads) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ring = ringPoint(this.rng, playerPos.x, playerPos.z, SPAWN_NEAR, SPAWN_FAR);
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
      spot.x = limitNumber(spot.x, -CITY_EDGE, CITY_EDGE);
      spot.z = limitNumber(spot.z, -CITY_EDGE, CITY_EDGE);
      if (flatDistance(spot.x, spot.z, playerPos.x, playerPos.z) >= SPAWN_NEAR) return spot;
    }
    return { x: playerPos.x + SPAWN_NEAR, z: playerPos.z };
  }

  // Grow or shrink the force until it matches the current star count.
  syncForce(playerPos, roads) {
    const wantCars = PATROL_CARS_PER_STAR[this.stars] || 0;
    const wantOfficers = OFFICERS_PER_STAR[this.stars] || 0;
    const anchor = playerPos || this.station;
    const cars = this.units.filter((unit) => unit.kind === 'car' && unit.alive);
    const officers = this.units.filter((unit) => unit.kind === 'officer' && unit.alive);
    for (let i = cars.length; i < wantCars; i += 1) {
      this.units.push(this.buildUnit('car', this.pickSpawnSpot(anchor, roads)));
    }
    for (let i = officers.length; i < wantOfficers; i += 1) {
      this.units.push(this.buildUnit('officer', this.pickSpawnSpot(anchor, roads)));
    }
    // Too many: stand down the farthest ones first.
    const surplus = (list, want) => {
      const extra = list.filter((unit) => unit.alive).slice(want);
      extra.sort((a, b) => flatDistance(b.group.position.x, b.group.position.z, anchor.x, anchor.z)
        - flatDistance(a.group.position.x, a.group.position.z, anchor.x, anchor.z));
      for (const unit of extra) {
        unit.mode = 'standingDown';
        this.removeUnit(unit);
      }
    };
    surplus(cars, wantCars);
    surplus(officers, wantOfficers);
  }

  // --- damage --------------------------------------------------------------

  // Hurt one unit. Returns true when the hit killed it.
  damageUnit(unit, amount) {
    if (!unit || !unit.alive) return false;
    unit.health = Math.max(0, unit.health - (amount || 0));
    if (unit.health > 0) return false;
    unit.alive = false;
    if (this.scene) this.scene.remove(unit.group);
    const index = this.units.indexOf(unit);
    if (index >= 0) this.units.splice(index, 1);
    return true;
  }

  // --- the frame step ------------------------------------------------------

  update(dt, context) {
    const ctx = context || {};
    const step = Math.max(0, dt || 0);
    this.clock += step;
    const events = { busted: false, wasted: false };
    if (this.ended) return events;

    const playerPos = ctx.playerPosition || { x: 0, y: 0, z: 0 };
    const playerInCar = Boolean(ctx.playerInCar);
    const playerHealth = typeof ctx.playerHealth === 'number' ? ctx.playerHealth : 100;
    const playerCarHealth = typeof ctx.playerCarHealth === 'number' ? ctx.playerCarHealth : null;
    const playerCarPos = ctx.playerCarPosition || null;
    const roads = ctx.roadNetwork || null;

    // Wasted: Leo is down, or his car is a wreck.
    if (playerHealth <= 0) {
      this.ended = true;
      if (this.onWasted) this.onWasted('health');
      events.wasted = true;
      return events;
    }
    if (playerCarHealth !== null && playerCarHealth <= 0) {
      this.ended = true;
      if (this.onWasted) this.onWasted('vehicleDestroyed');
      events.wasted = true;
      return events;
    }

    // How close is the nearest unit? That decides hiding and giving up.
    let nearest = Infinity;
    for (const unit of this.units) {
      if (!unit.alive) continue;
      const d = flatDistance(
        unit.group.position.x, unit.group.position.z, playerPos.x, playerPos.z,
      );
      if (d < nearest) nearest = d;
    }
    const hidden = nearest > HIDDEN_RANGE || this.units.length === 0;
    if (!hidden) this.lastSeenAt = this.clock;

    // Heat cools only after the grace period, and only while hidden.
    if (hidden && this.clock - this.lastCrimeAt > COOLDOWN_AFTER_CRIME && this.heat > 0) {
      let loss = HEAT_LOSS_PER_SECOND * step;
      if (this.clock - this.lastSeenAt > UNSEEN_GIVE_UP) loss *= 2;
      this.heat = Math.max(0, this.heat - loss);
      this.publishStars();
    }

    // Keep the force matched to the stars, then move every unit.
    this.syncForce(playerPos, roads);
    for (const unit of [...this.units]) {
      if (!unit.alive) continue;
      if (unit.kind === 'car') {
        this.stepPatrolCar(unit, step, playerPos, playerCarPos, playerInCar, ctx);
      } else {
        const caught = this.stepOfficer(unit, step, playerPos, playerInCar);
        if (caught) {
          this.ended = true;
          if (this.onBusted) this.onBusted();
          events.busted = true;
          this.standDownAll();
          return events;
        }
      }
    }

    // Units that gave up and drifted far away quietly leave.
    for (const unit of [...this.units]) {
      if (!unit.alive) continue;
      if (unit.mode === 'standingDown') {
        const d = flatDistance(
          unit.group.position.x, unit.group.position.z, playerPos.x, playerPos.z,
        );
        if (d > STAND_DOWN_RANGE) this.removeUnit(unit);
      }
    }

    this.flashSirens();
    return events;
  }

  // One patrol car, one frame: steer at the target, close in, ram on contact.
  stepPatrolCar(unit, dt, playerPos, playerCarPos, playerInCar, ctx) {
    const target = playerInCar && playerCarPos ? playerCarPos : playerPos;
    const dx = target.x - unit.group.position.x;
    const dz = target.z - unit.group.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.01) return;
    const wantedHeading = Math.atan2(dx, dz);
    unit.heading = steerAngle(unit.heading, wantedHeading, CAR_TURN_RATE * dt);
    const cruise = Math.min(CAR_TOP_SPEED, 12 + this.stars * 2.5);
    const desiredSpeed = distance > 10 ? cruise : cruise * 0.55;
    unit.speed += (desiredSpeed - unit.speed) * Math.min(1, dt * 2.5);
    unit.group.position.x += Math.sin(unit.heading) * unit.speed * dt;
    unit.group.position.z += Math.cos(unit.heading) * unit.speed * dt;
    unit.group.rotation.y = unit.heading;
    unit.mode = 'chasing';

    // Ram: close to the player's car, cooldown respected, one hit at a time.
    if (playerInCar && playerCarPos && distance < RAM_RANGE) {
      if (this.clock - unit.lastRamAt > RAM_PAUSE) {
        unit.lastRamAt = this.clock;
        // Shove the patrol car back a touch so it does not glue itself on.
        unit.group.position.x -= Math.sin(unit.heading) * 1.2;
        unit.group.position.z -= Math.cos(unit.heading) * 1.2;
        if (this.onRam) this.onRam(RAM_HIT);
      }
    }
    void ctx;
  }

  // One officer, one frame: run at Leo on foot. Returns true on a bust.
  stepOfficer(unit, dt, playerPos, playerInCar) {
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
      unit.heading = steerAngle(unit.heading, wantedHeading, 5.0 * dt);
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

  // Alternate the red and blue halves of every light bar.
  flashSirens() {
    const phase = Math.floor(this.clock * 2.8) % 2 === 0;
    for (const unit of this.units) {
      if (!unit.lamps) continue;
      unit.lamps.red.emissiveIntensity = phase ? 1.8 : 0.15;
      unit.lamps.blue.emissiveIntensity = phase ? 0.15 : 1.8;
    }
  }

  // Send every unit home without a fuss (after a bust, mainly).
  standDownAll() {
    for (const unit of [...this.units]) {
      unit.mode = 'standingDown';
      this.removeUnit(unit);
    }
  }

  // --- lifecycle -----------------------------------------------------------

  reset() {
    this.standDownAll();
    this.heat = 0;
    this.stars = 0;
    this.ended = false;
    this.lastCrimeAt = -Infinity;
    this.lastSeenAt = -Infinity;
  }

  dispose() {
    for (const unit of [...this.units]) this.removeUnit(unit);
    this.heat = 0;
    this.stars = 0;
    this.ended = false;
  }
}

// The factory main.js calls. Options:
// { scene, policeStation, onWantedChanged(level), onBusted(), onWasted(reason),
//   onRam(amount), random }
export function createPoliceSystem(options = {}) {
  return new PoliceDepartment(options);
}

// Convenience: the star count for a heat value, for HUD code that keeps its
// own heat number instead of asking this module.
export function starsForHeatValue(value) {
  if (value <= 0) return 0;
  return limitNumber(Math.floor(value / HEAT_PER_STAR), 0, MAX_WANTED);
}
