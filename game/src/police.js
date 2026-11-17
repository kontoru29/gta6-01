// police.js — Solmar Bay wanted level and police pursuit system.
//
// Owns the 0-to-5-star wanted level for Leo Marlow: crimes raise it, time spent
// out of sight of every officer lowers it again. Spawns police cars and on-foot
// officers in numbers that grow with the wanted level, drives them after the
// player along the city roads, rams the player's car, and ends the run as
// "busted" (an officer reaches Leo on foot) or "wasted" (Leo's health or his
// car reaches zero). Police always arrive from the roads around the player —
// never teleported on top of him — and give up after a long clean escape.
//
// PUBLIC API — createPoliceSystem(options) returns:
//   getWantedLevel()            -> integer 0..5 (current stars)
//   getHeat()                   -> raw heat 0..100 behind the stars
//   isWanted()                  -> true while stars > 0
//   reportCrime(type, details)  -> raise heat for a crime; type is one of
//                                  'assault' | 'shooting' | 'carTheft' |
//                                  'killPedestrian' | 'killPolice' |
//                                  'hitAndRun' | 'speeding'
//   setWantedLevel(stars)       -> scripted set, used by missions (e.g. a
//                                  robbery mission sets 4 stars); clamps 0..5
//   addHeat(amount)             -> raw heat bump, for unusual scripted crimes
//   clearWanted()               -> drop to 0 stars and stand the police down
//   update(dt, context)         -> advance pursuit/decay one frame; context is
//                                  { playerPosition, playerInCar, playerHealth,
//                                    playerCarHealth, playerCar, roadNetwork,
//                                    policeStation }; returns an events object
//                                  { wantedChanged, busted, wasted, wastedReason,
//                                    spawned, despawned, rammed }
//   getUnits()                  -> live police units (cars + officers) for the
//                                  HUD minimap and for combat targeting
//   getBlips()                  -> [{ x, z, kind }] minimap positions
//   damageUnit(unit, amount)    -> hurt one police unit; returns true if it died
//   spawnAt(position, kind)     -> force one unit at a spot (shot staging)
//   reset()                     -> clear every unit and drop to 0 stars
//   dispose()                   -> remove all meshes from the scene
//   sirenActive                 -> getter: true while any unit is chasing
//   units                       -> getter: the live unit array (read-only use)
//
// Options: { scene, policeStation, onWantedChanged(level), onBusted(),
//            onWasted(reason), onRam(amount), random }
// The caller passes the player's position and health into update() every
// frame; the caller owns the player and the car, this module only reads them.
// Road network (optional): { nearestRoadPoint(pos), randomRoadPointNear(pos,
// minRadius, maxRadius) }. Without one, police chase on a plain 40 m road
// grid snapped from the player's position, which still reads as road pursuit.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning — every number lives here so the integrator can retune in one place.
// ---------------------------------------------------------------------------

export const MAX_WANTED = 5;
const HEAT_PER_STAR = 20;
const MAX_HEAT = MAX_WANTED * HEAT_PER_STAR;

// Heat added by each crime. Killing a police officer is the heaviest crime;
// a single punch is the lightest. Missions call setWantedLevel() instead.
export const CRIME_HEAT = {
  assault: 8,
  shooting: 12,
  carTheft: 14,
  hitAndRun: 10,
  speeding: 4,
  killPedestrian: 26,
  killPolice: 40,
};

// How many units of each kind chase at each wanted level (index = stars).
const POLICE_CARS_PER_STAR = [0, 1, 2, 3, 4, 5];
const OFFICERS_PER_STAR = [0, 0, 1, 1, 2, 3];

const DECAY_GRACE_SECONDS = 8; // no decay right after a crime
const DECAY_RATE_PER_SECOND = 3.0; // heat lost per second while hidden
const HIDDEN_DISTANCE = 60; // farther than this from every unit = hidden
const GIVE_UP_SECONDS = 22; // unseen this long -> heat drains twice as fast
const SPAWN_MIN_DISTANCE = 65; // never spawn closer than this to the player
const SPAWN_MAX_DISTANCE = 130; // never spawn farther than this
const DESPAWN_DISTANCE = 170; // standing-down units vanish past this range
const BUST_RANGE = 2.4; // officer this close starts the arrest
const BUST_HOLD_SECONDS = 1.0; // must stay in range this long to be busted
const RAM_RANGE = 5.0; // police car this close to the player's car rams it
const RAM_DAMAGE = 9; // health lost by the player's car per ram
const RAM_COOLDOWN = 1.6; // seconds between rams from the same car
const OFFICER_RUN_SPEED = 5.4; // m/s — faster than walking, slower than sprinting
const OFFICER_HEALTH = 60;
const POLICE_CAR_HEALTH = 120;
const ROAD_SPACING = 40; // fallback grid spacing when no road network given
const CITY_HALF_SIZE = 220; // fallback city extent, used to clamp spawns

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Accept a THREE.Vector3, a { x, y, z } object or a { x, z } object and
// always answer with a fresh THREE.Vector3 on the ground plane (y = 0).
function toVector3(value, fallback) {
  if (!value) return fallback ? fallback.clone() : new THREE.Vector3();
  if (value.isVector3) return value.clone();
  return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
}

function angleTowards(current, target, maxStep) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + clamp(diff, -maxStep, maxStep);
}

// Snap a point onto the nearest fallback-grid road (roads run every
// ROAD_SPACING metres along both axes through the city centre).
function snapToFallbackRoad(point) {
  const snapped = point.clone();
  const xRoad = Math.round(snapped.x / ROAD_SPACING) * ROAD_SPACING;
  const zRoad = Math.round(snapped.z / ROAD_SPACING) * ROAD_SPACING;
  if (Math.abs(snapped.x - xRoad) <= Math.abs(snapped.z - zRoad)) snapped.x = xRoad;
  else snapped.z = zRoad;
  snapped.x = clamp(snapped.x, -CITY_HALF_SIZE, CITY_HALF_SIZE);
  snapped.z = clamp(snapped.z, -CITY_HALF_SIZE, CITY_HALF_SIZE);
  snapped.y = 0;
  return snapped;
}

// ---------------------------------------------------------------------------
// Procedural police meshes — built only from three.js primitives, no assets.
// ---------------------------------------------------------------------------

function buildPoliceCarMesh() {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.35, metalness: 0.4 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.5, metalness: 0.3 });
  const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x9fc8e8, roughness: 0.1, metalness: 0.6 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 4.4), bodyMaterial);
  body.position.y = 0.55;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.2), glassMaterial);
  cabin.position.set(0, 1.05, -0.2);
  group.add(cabin);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.18, 4.42), darkMaterial);
  stripe.position.y = 0.62;
  group.add(stripe);

  const wheelGeometry = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 14);
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
  for (const [x, z] of [[-0.95, 1.45], [0.95, 1.45], [-0.95, -1.45], [0.95, -1.45]]) {
    const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.36, z);
    group.add(wheel);
  }

  // Light bar: red on the left, blue on the right; update() flashes them.
  const redLight = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.16, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 1 }),
  );
  redLight.position.set(-0.45, 1.42, -0.2);
  const blueLight = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.16, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x0022ff, emissiveIntensity: 1 }),
  );
  blueLight.position.set(0.45, 1.42, -0.2);
  group.add(redLight, blueLight);
  group.userData.redLight = redLight;
  group.userData.blueLight = blueLight;

  const headlightMaterial = new THREE.MeshStandardMaterial({ color: 0xfff6c8, emissive: 0xffee88, emissiveIntensity: 0.7 });
  for (const x of [-0.6, 0.6]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.08), headlightMaterial);
    lamp.position.set(x, 0.6, 2.22);
    group.add(lamp);
  }
  return group;
}

function buildOfficerMesh() {
  const group = new THREE.Group();
  const uniform = new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.7 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.6 });
  const vest = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.6 });

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.3), uniform);
  legs.position.y = 0.43;
  group.add(legs);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.7, 0.36), vest);
  torso.position.y = 1.2;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), skin);
  head.position.y = 1.78;
  group.add(head);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.27, 0.1, 14), uniform);
  cap.position.y = 1.96;
  group.add(cap);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.22), uniform);
  brim.position.set(0, 1.92, 0.26);
  group.add(brim);
  const armGeometry = new THREE.BoxGeometry(0.16, 0.62, 0.16);
  for (const x of [-0.4, 0.4]) {
    const arm = new THREE.Mesh(armGeometry, uniform);
    arm.position.set(x, 1.2, 0);
    group.add(arm);
  }
  return group;
}

// ---------------------------------------------------------------------------
// The wanted system.
// ---------------------------------------------------------------------------

export function createPoliceSystem(options = {}) {
  const scene = options.scene || null;
  const random = options.random || Math.random;
  const station = toVector3(options.policeStation, new THREE.Vector3(0, 0, -160));
  const onWantedChanged = options.onWantedChanged || null;
  const onBusted = options.onBusted || null;
  const onWasted = options.onWasted || null;
  const onRam = options.onRam || null;

  let heat = 0;
  let stars = 0;
  let lastCrimeAt = -Infinity;
  let lastSeenAt = -Infinity;
  let elapsed = 0;
  let nextUnitId = 1;
  let sirenPhase = 0;
  const units = [];

  function starsForHeat(value) {
    if (value <= 0) return 0;
    return clamp(Math.ceil(value / HEAT_PER_STAR), 1, MAX_WANTED);
  }

  function announceStarsChanged() {
    const next = starsForHeat(heat);
    if (next === stars) return false;
    stars = next;
    if (onWantedChanged) onWantedChanged(stars);
    return true;
  }

  function makeUnit(kind, position) {
    const group = kind === 'car' ? buildPoliceCarMesh() : buildOfficerMesh();
    group.position.copy(position);
    group.position.y = 0;
    if (scene) scene.add(group);
    const unit = {
      id: nextUnitId,
      kind,
      group,
      alive: true,
      health: kind === 'car' ? POLICE_CAR_HEALTH : OFFICER_HEALTH,
      maxHealth: kind === 'car' ? POLICE_CAR_HEALTH : OFFICER_HEALTH,
      heading: random() * Math.PI * 2,
      speed: 0,
      state: 'chasing',
      bustTimer: 0,
      ramCooldown: 0,
      stuckTimer: 0,
      leaveTimer: 0,
      lastPosition: position.clone(),
    };
    nextUnitId += 1;
    units.push(unit);
    return unit;
  }

  function removeUnit(unit) {
    const index = units.indexOf(unit);
    if (index >= 0) units.splice(index, 1);
    if (scene) scene.remove(unit.group);
    unit.alive = false;
  }

  function nearestRoadPoint(position, roadNetwork) {
    if (roadNetwork && typeof roadNetwork.nearestRoadPoint === 'function') {
      return toVector3(roadNetwork.nearestRoadPoint(position));
    }
    return snapToFallbackRoad(position);
  }

  function pickSpawnPoint(playerPosition, roadNetwork) {
    // Prefer a road point on a ring around the player, biased toward the
    // police-station side so arrivals read as coming from the station.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let candidate = null;
      if (roadNetwork && typeof roadNetwork.randomRoadPointNear === 'function') {
        candidate = toVector3(roadNetwork.randomRoadPointNear(playerPosition, SPAWN_MIN_DISTANCE, SPAWN_MAX_DISTANCE));
      } else {
        const stationAngle = Math.atan2(station.x - playerPosition.x, station.z - playerPosition.z);
        const angle = stationAngle + (random() - 0.5) * Math.PI * 1.2;
        const radius = SPAWN_MIN_DISTANCE + random() * (SPAWN_MAX_DISTANCE - SPAWN_MIN_DISTANCE);
        candidate = new THREE.Vector3(
          playerPosition.x + Math.sin(angle) * radius,
          0,
          playerPosition.z + Math.cos(angle) * radius,
        );
        candidate = snapToFallbackRoad(candidate);
      }
      if (candidate && distance2D(candidate, playerPosition) >= SPAWN_MIN_DISTANCE * 0.8) return candidate;
    }
    // Fallback: a road point directly station-side of the player.
    const fallback = playerPosition.clone();
    const toStation = new THREE.Vector3(station.x - playerPosition.x, 0, station.z - playerPosition.z);
    if (toStation.lengthSq() > 1) toStation.normalize();
    else toStation.set(0, 0, -1);
    fallback.addScaledVector(toStation, SPAWN_MIN_DISTANCE + 20);
    return snapToFallbackRoad(fallback);
  }

  function desiredCounts() {
    return {
      cars: POLICE_CARS_PER_STAR[stars] || 0,
      officers: OFFICERS_PER_STAR[stars] || 0,
    };
  }

  function maintainSpawns(playerPosition, roadNetwork) {
    const wanted = desiredCounts();
    const liveCars = units.filter((u) => u.kind === 'car' && u.state !== 'leaving').length;
    const liveOfficers = units.filter((u) => u.kind === 'officer' && u.state !== 'leaving').length;
    // Officers arrive on foot from nearby streets; cars roll in from the roads.
    for (let i = liveCars; i < wanted.cars; i += 1) {
      makeUnit('car', pickSpawnPoint(playerPosition, roadNetwork));
    }
    for (let i = liveOfficers; i < wanted.officers; i += 1) {
      makeUnit('officer', pickSpawnPoint(playerPosition, roadNetwork));
    }
    // Too many units for the current level stand down and drive/walk away.
    let excessCars = liveCars - wanted.cars;
    let excessOfficers = liveOfficers - wanted.officers;
    for (const unit of units) {
      if (unit.state === 'leaving') continue;
      if (unit.kind === 'car' && excessCars > 0) { unit.state = 'leaving'; excessCars -= 1; }
      else if (unit.kind === 'officer' && excessOfficers > 0) { unit.state = 'leaving'; excessOfficers -= 1; }
    }
  }

  function updatePoliceCar(unit, dt, playerPosition, roadNetwork) {
    const target = nearestRoadPoint(playerPosition, roadNetwork);
    // Chase the road point under the player, not the player himself, so the
    // car stays on the streets instead of cutting across blocks.
    const toTarget = new THREE.Vector3(target.x - unit.group.position.x, 0, target.z - unit.group.position.z);
    const distance = toTarget.length();
    const cruiseSpeed = 17 + stars * 2.5;
    const desiredHeading = Math.atan2(toTarget.x, toTarget.z);
    unit.heading = angleTowards(unit.heading, desiredHeading, 2.4 * dt);
    const targetSpeed = distance < 6 ? cruiseSpeed * 0.45 : cruiseSpeed;
    unit.speed += clamp(targetSpeed - unit.speed, -22 * dt, 12 * dt);
    unit.group.position.x += Math.sin(unit.heading) * unit.speed * dt;
    unit.group.position.z += Math.cos(unit.heading) * unit.speed * dt;
    unit.group.position.y = 0;
    unit.group.rotation.y = unit.heading;

    // Stuck detection: barely moving while chasing means a building or a
    // traffic jam — back up briefly and swing around it.
    if (distance2D(unit.group.position, unit.lastPosition) < 0.15 && distance > 8) {
      unit.stuckTimer += dt;
      if (unit.stuckTimer > 1.2) {
        unit.heading += Math.PI * 0.6;
        unit.speed = -6;
        unit.stuckTimer = 0;
      }
    } else {
      unit.stuckTimer = 0;
    }
    unit.lastPosition.copy(unit.group.position);
    unit.ramCooldown = Math.max(0, unit.ramCooldown - dt);

    // Flash the light bar, red and blue alternating. sirenPhase advances
    // once per frame in update(), not once per car, so every car flashes
    // in step at the same steady rate.
    const redOn = Math.sin(sirenPhase) > 0;
    const red = unit.group.userData.redLight;
    const blue = unit.group.userData.blueLight;
    if (red) red.material.emissiveIntensity = redOn ? 2.2 : 0.15;
    if (blue) blue.material.emissiveIntensity = redOn ? 0.15 : 2.2;
  }

  function updateOfficer(unit, dt, playerPosition, playerInCar) {
    const toPlayer = new THREE.Vector3(
      playerPosition.x - unit.group.position.x,
      0,
      playerPosition.z - unit.group.position.z,
    );
    const distance = toPlayer.length();
    if (distance > 0.01) toPlayer.normalize();
    const speed = playerInCar ? OFFICER_RUN_SPEED * 0.9 : OFFICER_RUN_SPEED;
    unit.group.position.addScaledVector(toPlayer, speed * dt);
    unit.group.position.y = 0;
    unit.heading = Math.atan2(toPlayer.x, toPlayer.z);
    unit.group.rotation.y = unit.heading;
    // Little run bob so the chase reads as running, not sliding.
    unit.group.position.y = Math.abs(Math.sin(elapsed * 11 + unit.id)) * 0.06;
    return distance;
  }

  function decayWanted(dt, nearestDistance) {
    if (stars === 0) return false;
    if (elapsed - lastCrimeAt < DECAY_GRACE_SECONDS) return false;
    const hidden = nearestDistance === null || nearestDistance > HIDDEN_DISTANCE;
    const longUnseen = elapsed - lastSeenAt > GIVE_UP_SECONDS;
    if (!hidden && !longUnseen) return false;
    const rate = DECAY_RATE_PER_SECOND * (longUnseen ? 2 : 1) * (1 - stars * 0.06);
    heat = Math.max(0, heat - rate * dt);
    return announceStarsChanged();
  }

  // -- Public API -----------------------------------------------------------

  function reportCrime(type, details = {}) {
    const gain = CRIME_HEAT[type] ?? 10;
    heat = clamp(heat + gain, 0, MAX_HEAT);
    lastCrimeAt = elapsed;
    const changed = announceStarsChanged();
    return { stars, heat, changed, type, details };
  }

  function setWantedLevel(level) {
    const clamped = clamp(Math.round(level) || 0, 0, MAX_WANTED);
    // Sit in the middle of the star's heat band so one quiet minute drops a
    // star but a fresh crime does not instantly jump two.
    heat = clamped === 0 ? 0 : (clamped - 0.5) * HEAT_PER_STAR;
    lastCrimeAt = elapsed;
    const changed = announceStarsChanged();
    return { stars, heat, changed };
  }

  function update(dt, context = {}) {
    const step = Math.min(Math.max(dt, 0), 0.1);
    elapsed += step;
    const events = {
      wantedChanged: false,
      busted: false,
      wasted: false,
      wastedReason: null,
      spawned: 0,
      despawned: 0,
      rammed: false,
    };
    const playerPosition = toVector3(context.playerPosition, new THREE.Vector3());
    const playerInCar = Boolean(context.playerInCar);
    const roadNetwork = context.roadNetwork || null;

    const beforeCount = units.length;
    maintainSpawns(playerPosition, roadNetwork);
    events.spawned = Math.max(0, units.length - beforeCount);
    // One shared siren phase for every light bar this frame.
    sirenPhase += step * 6;

    let nearestDistance = null;
    for (const unit of [...units]) {
      if (!unit.alive) continue;
      const distance = distance2D(unit.group.position, playerPosition);
      if (nearestDistance === null || distance < nearestDistance) {
        nearestDistance = distance;
      }
    }
    if (nearestDistance !== null && nearestDistance < 90) lastSeenAt = elapsed;

    // Wasted: Leo's health is gone, or the car he is driving is destroyed.
    if (typeof context.playerHealth === 'number' && context.playerHealth <= 0) {
      events.wasted = true;
      events.wastedReason = 'health';
      if (onWasted) onWasted('health');
      return events;
    }
    if (playerInCar && typeof context.playerCarHealth === 'number' && context.playerCarHealth <= 0) {
      events.wasted = true;
      events.wastedReason = 'vehicleDestroyed';
      if (onWasted) onWasted('vehicleDestroyed');
      return events;
    }

    for (const unit of [...units]) {
      if (!unit.alive) continue;
      if (unit.state === 'leaving') {
        // Drive / walk away from the player, then vanish off the map.
        const away = new THREE.Vector3(
          unit.group.position.x - playerPosition.x,
          0,
          unit.group.position.z - playerPosition.z,
        );
        if (away.lengthSq() < 1) away.set(0, 0, 1);
        away.normalize();
        const speed = unit.kind === 'car' ? 14 : 4;
        unit.group.position.addScaledVector(away, speed * step);
        unit.group.rotation.y = Math.atan2(away.x, away.z);
        unit.leaveTimer += step;
        if (distance2D(unit.group.position, playerPosition) > DESPAWN_DISTANCE || unit.leaveTimer > 12) {
          removeUnit(unit);
          events.despawned += 1;
        }
        continue;
      }

      if (unit.kind === 'car') {
        updatePoliceCar(unit, step, playerPosition, roadNetwork);
        // Ram: a police car that catches the player's car slams it.
        if (playerInCar) {
          const carPosition = context.playerCarPosition
            ? toVector3(context.playerCarPosition)
            : playerPosition;
          if (distance2D(unit.group.position, carPosition) < RAM_RANGE && unit.ramCooldown <= 0) {
            unit.ramCooldown = RAM_COOLDOWN;
            unit.speed = Math.max(unit.speed, 10);
            events.rammed = true;
            if (onRam) onRam(RAM_DAMAGE);
            if (context.playerCar && typeof context.playerCar.applyImpulse === 'function') {
              const push = new THREE.Vector3(
                carPosition.x - unit.group.position.x, 0, carPosition.z - unit.group.position.z,
              ).normalize().multiplyScalar(6);
              context.playerCar.applyImpulse(push);
            }
          }
        }
      } else {
        const distance = updateOfficer(unit, step, playerPosition, playerInCar);
        // Busted: an officer who stays on Leo's heels on foot arrests him.
        // Officers cannot bust Leo while he is inside a car.
        if (!playerInCar && distance < BUST_RANGE) {
          unit.bustTimer += step;
          if (unit.bustTimer >= BUST_HOLD_SECONDS) {
            events.busted = true;
            if (onBusted) onBusted();
            return events;
          }
        } else {
          unit.bustTimer = 0;
        }
      }
    }

    if (decayWanted(step, nearestDistance)) events.wantedChanged = true;
    return events;
  }

  function damageUnit(unit, amount) {
    if (!unit || !unit.alive) return false;
    unit.health = Math.max(0, unit.health - amount);
    if (unit.health > 0) return false;
    removeUnit(unit);
    return true;
  }

  function spawnAt(position, kind = 'car') {
    const point = nearestRoadPoint(toVector3(position), null);
    return makeUnit(kind === 'officer' ? 'officer' : 'car', point);
  }

  function reset() {
    for (const unit of [...units]) removeUnit(unit);
    heat = 0;
    stars = 0;
    lastCrimeAt = -Infinity;
    lastSeenAt = -Infinity;
  }

  function dispose() {
    reset();
  }

  function getBlips() {
    return units
      .filter((unit) => unit.alive)
      .map((unit) => ({ x: unit.group.position.x, z: unit.group.position.z, kind: unit.kind }));
  }

  return {
    get wantedLevel() { return stars; },
    get heat() { return heat; },
    get sirenActive() { return stars > 0 && units.some((u) => u.state === 'chasing'); },
    get units() { return units; },
    getWantedLevel: () => stars,
    getHeat: () => heat,
    isWanted: () => stars > 0,
    reportCrime,
    setWantedLevel,
    addHeat: (amount) => {
      heat = clamp(heat + amount, 0, MAX_HEAT);
      announceStarsChanged();
      return stars;
    },
    clearWanted: () => setWantedLevel(0),
    update,
    getUnits: () => units.filter((unit) => unit.alive),
    getBlips,
    damageUnit,
    spawnAt,
    reset,
    dispose,
  };
}

// Convenience: the star count for a heat value, for HUD code that keeps its
// own heat number instead of asking this module.
export function starsForHeatValue(value) {
  if (value <= 0) return 0;
  return clamp(Math.ceil(value / HEAT_PER_STAR), 1, MAX_WANTED);
}
