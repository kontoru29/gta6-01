// vehicles.js — every car in Solmar Bay: factory, driving, theft, traffic.
//
// This module owns all vehicles. One car factory and one arcade driving
// model serve both the player's car and the traffic cars, so a stolen
// traffic car drives exactly like any other car. It covers:
//   * procedural cars in four original body styles (sedan, hatchback, van,
//     sport coupe) in bright coastal paint colours — no real-world models,
//   * arcade driving: acceleration, steering, brake and handbrake, with
//     simple circle-vs-building and car-vs-car collision,
//   * stealing: walk up to a parked car or a car in traffic and press F to
//     take it (a traffic driver bails out and runs off on foot),
//   * traffic AI: cars follow the city module's road lanes, brake for the
//     car ahead and swerve around a blocked lane, and never leave the road.
//
// Public interface (what main.js, player.js, police.js, missions.js and
// hud.js call):
//   createCar(scene, type, colour, x, z, heading)
//     Build one car and add it to the scene. type is 'sedan' | 'hatchback' |
//     'van' | 'sport'. Returns a car object:
//       car.group, car.type, car.colour, car.heading, car.speed (m/s),
//       car.health (0..100), car.isPlayer, car.isTraffic, car.stolen,
//       car.driver (traffic driver marker, null once stolen),
//       car.setSpeedKmh(), car.damage(amount), car.destroyed
//   createVehicleSystem(scene, city, options)
//     options.player — the player object from player.js (may be attached
//                      later with system.bindPlayer(p)).
//     options.onCarStolen(car) — callback fired when the player steals a car.
//     Returns the system:
//       system.cars            — every live car (player + traffic + parked)
//       system.traffic         — the traffic cars only
//       system.playerCar       — the car the player drives, or null
//       system.bindPlayer(p)   — attach the player object
//       system.spawnParked(count)  — scatter parked cars at city carSpawns
//       system.spawnTraffic(count) — put AI cars on the city lanes
//       system.nearestEnterableVehicle(pos, maxDist)
//                              — closest car the player may enter with E
//       system.enterPlayerVehicle(car) — player gets in (E key)
//       system.exitPlayerVehicle()     — player gets out (E key)
//       system.trySteal(playerPos)     — F key: steal nearest car in reach
//       system.getPlayerSpeedKmh()     — HUD speedometer reading (0 on foot)
//       system.isPlayerDriving()       — true while the player is in a car
//       system.damagePlayerCar(amount) — police module: smash / stop the car
//       system.stopPlayerCar()         — police module: kill the engine
//       system.update(dt, input)       — one frame: drive the player car,
//                                        run traffic AI, resolve collisions.
//                                        input is { forward, back, left,
//                                        right, brake, handbrake,
//                                        enterPressed, stealPressed }
//       system.dispose()       — remove all cars from the scene
//
// What this module expects from the city module (all optional — a default
// street grid is used when the city data is not there yet):
//   city.lanes — array of lanes, each { points: [{x, z}, ...], width }.
//                A lane is one direction of one road. Traffic follows the
//                points in order and loops back to the start.
//   city.buildingColliders — array of { minX, maxX, minZ, maxZ }.
//   city.carSpawns — array of { x, z, heading } parking spots.
//   city.bounds — { minX, maxX, minZ, maxZ } of the drivable city.
//
// A car the player drives keeps its traffic driver slot empty; a traffic car
// keeps a simple driver record so the steal flow can make the driver flee.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning — local to this module so it works before the city agent's
// config.js exists. Same values the integrator can move into config later.
// ---------------------------------------------------------------------------
const TOP_SPEED = {
  sedan: 34, // ~122 km/h
  hatchback: 30, // ~108 km/h
  van: 25, // ~90 km/h
  sport: 44, // ~158 km/h
};
const ACCEL = { sedan: 13, hatchback: 12, van: 9, sport: 18 };
const BRAKE_FORCE = 30;
const REVERSE_TOP_SPEED = 9;
const STEER_RATE = 1.9; // radians per second at full lock, low speed
const GRIP = 3.2; // how fast the car settles back to straight driving
const HANDBRAKE_GRIP = 0.9; // low grip while handbraking = sliding
const CAR_RADIUS = 1.35; // collision circle around a car's centre
const STEAL_RANGE = 3.6; // how close the player must be to press F
const TRAFFIC_CRUISE = 11; // m/s, about 40 km/h — calm city traffic
const TRAFFIC_BRAKE_AHEAD = 9; // metres: brake for the car ahead
const TRAFFIC_SWERVE_AHEAD = 14; // metres: start steering around a block
const TRAFFIC_DESPAWN = 130; // metres from player before a traffic car respawns

const BODY_TYPES = ['sedan', 'hatchback', 'van', 'sport'];
const PAINT_COLORS = [
  0xe23b3b, // sunset red
  0x2f7fd0, // ocean blue
  0xf2b234, // taxi yellow
  0x37b268, // palm green
  0xf2f0e6, // sand white
  0x8a5fbf, // dusk purple
  0x22262e, // midnight black
  0xe87aa0, // coral pink
];
const WINDOW_COLOR = 0x18222e;
const TYRE_COLOR = 0x14161a;
const HUB_COLOR = 0xb9c0c9;

// ---------------------------------------------------------------------------
// Car factory — one procedural body per type, all from boxes and cylinders.
// A car is a group whose forward direction is -Z, matching the player.
// ---------------------------------------------------------------------------
function buildCarBody(type, colour) {
  const body = new THREE.Group();
  body.name = `Car_${type}`;
  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: WINDOW_COLOR, roughness: 0.15, metalness: 0.6 });
  const tyre = new THREE.MeshStandardMaterial({ color: TYRE_COLOR, roughness: 0.95 });
  const hub = new THREE.MeshStandardMaterial({ color: HUB_COLOR, roughness: 0.3, metalness: 0.7 });

  const addBox = (material, w, h, d, x, y, z, parent = body) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Dimensions per body style: [length, width, bodyHeight, cabinLength].
  const dims = {
    sedan: [4.4, 1.9, 0.62, 2.1],
    hatchback: [3.6, 1.8, 0.68, 2.0],
    van: [4.8, 2.0, 1.05, 3.4],
    sport: [4.3, 1.95, 0.5, 1.7],
  }[type];
  const [length, width, bodyHeight, cabinLength] = dims;

  // Lower body slab, cabin, and a sloped hood/trunk suggestion.
  addBox(paint, width, bodyHeight, length, 0, 0.55, 0);
  const cabinY = 0.55 + bodyHeight / 2 + (type === 'van' ? 0.55 : 0.34);
  const cabinH = type === 'van' ? 1.1 : 0.62;
  const cabin = addBox(glass, width - 0.24, cabinH, cabinLength, 0, cabinY, type === 'van' ? 0.1 : 0.15);
  // Paint roof strip over the glass cabin so it reads as a car, not a box.
  addBox(paint, width - 0.18, 0.08, cabinLength - 0.3, 0, cabinY + cabinH / 2, type === 'van' ? 0.1 : 0.15);
  if (type === 'sport') {
    // Low rear spoiler.
    addBox(paint, width - 0.3, 0.07, 0.3, 0, 1.05, length / 2 - 0.15);
  }
  if (type === 'van') {
    // Side panel line and a roof rack hint.
    addBox(paint, 0.06, 0.5, 2.4, width / 2, 1.15, 0.2);
    addBox(paint, 0.06, 0.5, 2.4, -width / 2, 1.15, 0.2);
  }

  // Headlights (front = -Z) and taillights (rear = +Z).
  const lightFront = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 0.7 });
  const lightRear = new THREE.MeshStandardMaterial({ color: 0xd21f2b, emissive: 0x8f1018, emissiveIntensity: 0.7 });
  addBox(lightFront, 0.34, 0.12, 0.06, -width / 2 + 0.35, 0.62, -length / 2 - 0.01);
  addBox(lightFront, 0.34, 0.12, 0.06, width / 2 - 0.35, 0.62, -length / 2 - 0.01);
  addBox(lightRear, 0.34, 0.12, 0.06, -width / 2 + 0.35, 0.62, length / 2 + 0.01);
  addBox(lightRear, 0.34, 0.12, 0.06, width / 2 - 0.35, 0.62, length / 2 + 0.01);

  // Four wheels: dark cylinders turned sideways, with a hub cap disc.
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18);
  const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.28, 12);
  const wheelPositions = [
    [-width / 2, -length / 2 + 0.85],
    [width / 2, -length / 2 + 0.85],
    [-width / 2, length / 2 - 0.85],
    [width / 2, length / 2 - 0.85],
  ];
  for (const [wx, wz] of wheelPositions) {
    const wheel = new THREE.Mesh(wheelGeo, tyre);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.36, wz);
    wheel.castShadow = true;
    body.add(wheel);
    const cap = new THREE.Mesh(hubGeo, hub);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(wx, 0.36, wz);
    body.add(cap);
  }

  return { group: body, length, width };
}

export function createCar(scene, type = 'sedan', colour = 0xe23b3b, x = 0, z = 0, heading = 0) {
  if (!BODY_TYPES.includes(type)) type = 'sedan';
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
    driver: null, // traffic driver record; null for parked / player cars
    takenByPlayer: false, // set once the player first takes this car
    length: built.length,
    width: built.width,
    engineDead: false,
    // Traffic-AI state, ignored for the player car.
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
// Small helpers
// ---------------------------------------------------------------------------
function angleDifference(from, to) {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function forwardOf(heading) {
  return { x: -Math.sin(heading), z: -Math.cos(heading) };
}

// Default street grid used only when the city module has not supplied lanes
// yet: a 5x5 grid of two-way streets 40 metres apart.
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
  let playerCar = null;
  let spawnCursor = 0;

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
  // Every car in the game — player or traffic — moves through this one
  // function. Steering only bites while the car is moving; the handbrake
  // cuts grip so the tail slides; hitting a building scrubs speed hard.
  function driveStep(car, dt, throttle, steerInput, braking, handbrake) {
    if (car.engineDead || car.destroyed) {
      car.speed *= Math.max(0, 1 - dt * 2);
      return;
    }
    const topSpeed = TOP_SPEED[car.type];
    const accel = ACCEL[car.type];

    if (throttle > 0) car.speed += accel * throttle * dt;
    else if (throttle < 0) {
      // S or Down: brake while moving forward, reverse once stopped.
      if (car.speed > 0.5) car.speed -= BRAKE_FORCE * dt;
      else car.speed -= accel * 0.6 * dt;
    }
    if (braking) car.speed -= BRAKE_FORCE * dt * (car.speed > 0 ? 1 : -0.4);
    if (handbrake) car.speed *= Math.max(0, 1 - dt * 1.6);

    // Rolling drag and the reverse cap.
    car.speed -= car.speed * 0.35 * dt;
    car.speed = Math.max(-REVERSE_TOP_SPEED, Math.min(topSpeed, car.speed));

    // Steering: less lock at high speed so the car stays controllable.
    const speedFactor = Math.min(1, Math.abs(car.speed) / 12);
    const targetSteer = steerInput * STEER_RATE * (0.45 + 0.55 * (1 - speedFactor * 0.6));
    const grip = handbrake ? HANDBRAKE_GRIP : GRIP;
    car.steer += (targetSteer - car.steer) * Math.min(1, dt * grip * 3);
    const direction = car.speed >= 0 ? 1 : -1;
    car.heading += car.steer * dt * direction * Math.min(1, Math.abs(car.speed) / 4 + 0.25);

    const fwd = forwardOf(car.heading);
    const nextX = car.group.position.x + fwd.x * car.speed * dt;
    const nextZ = car.group.position.z + fwd.z * car.speed * dt;

    // Buildings: stop dead-ish and take a little damage on a hard hit.
    if (collidesWithBuildings(nextX, nextZ, CAR_RADIUS)) {
      if (Math.abs(car.speed) > 8) car.damage(Math.abs(car.speed) * 0.6);
      car.speed *= -0.25;
      return;
    }
    // Other cars: soft push — both cars lose speed instead of passing through.
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
  // the player's car, or the player on foot) is too close it brakes; if the
  // blockage sits in its lane it nudges sideways to slip past. It only ever
  // steers between lane waypoints, so it cannot leave the road.
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
        // Loop the lane: pick a fresh lane nearby so traffic keeps flowing.
        car.laneIndex = (car.laneIndex + 1) % lanes.length;
        car.waypointIndex = 0;
      }
      return;
    }

    const desiredHeading = Math.atan2(-dx, -dz);
    const headingError = angleDifference(car.heading, desiredHeading);
    const steerInput = THREE.MathUtils.clamp(headingError * 1.6, -1, 1);

    // Look ahead along the car's nose for anything in the way.
    const fwd = forwardOf(car.heading);
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
    driveStep(car, dt, throttle, steer, brake, false);
  }

  // --- the system object ----------------------------------------------------
  const system = {
    cars,
    traffic,
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
        const type = BODY_TYPES[(spawnCursor + i) % BODY_TYPES.length];
        const colour = PAINT_COLORS[(spawnCursor * 3 + i) % PAINT_COLORS.length];
        const car = createCar(scene, type, colour, spot.x, spot.z, spot.heading);
        cars.push(car);
        made.push(car);
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
        const type = BODY_TYPES[(i * 2 + 1) % BODY_TYPES.length];
        const colour = PAINT_COLORS[(i * 5 + 2) % PAINT_COLORS.length];
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

    // F key: take the nearest car in reach, parked or in traffic. Stealing
    // a traffic car counts as a crime (the police module listens through
    // onCarStolen); taking a parked car is the same action here.
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

    // Police module hooks: damage the player's car, or kill its engine so a
    // chase can end with the player busted on foot.
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
        driveStep(playerCar, dt, throttle, steerInput, !!input.brake, !!input.handbrake);
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
    },

    dispose() {
      for (const car of cars) car.dispose();
      cars.length = 0;
      traffic.length = 0;
      playerCar = null;
    },
  };

  return system;
}
