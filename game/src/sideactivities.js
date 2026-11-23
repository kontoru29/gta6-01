// sideactivities.js — Solmar Bay side jobs, Round 8.
//
// The story missions are the spine, but Marisol Bay is a working city,
// and Leo is a driver for hire. Four side hustles pay the bills between
// jobs, all of them live in the world rather than in a menu:
//
//   Taxi fares — press T near the plaza while driving: a passenger
//     climbs in and names a corner of the city. Get them there before
//     the meter runs out and the fare is yours, with a bonus for speed.
//   Courier runs — press C at the garage: a package for somewhere
//     across town, on foot or in a car, against the clock.
//   Street races — three checkpoint routes painted on the roads. Drive
//     through the start ring and the clock starts; hit every ring in
//     order and beat the par time for the purse.
//   Hidden packages — ten glowing parcels stashed around the city, from
//     the pier to the docks. Walk into one and it is yours, $100 a
//     parcel, and the save file remembers which ones Leo already found.
//
// Each activity is a small state machine with a beacon in the world
// (gold for fares, cyan for courier, magenta for races, green for the
// hidden parcels), a timer, and a payout through the onCash callback
// main.js provides. Progress lives in save.side, so a fare Leo finished
// yesterday still counts tomorrow.
//
// `createSideActivitySystem({ scene, city, save, hud, onCash })` —
// `city` is the marker lookup main.js builds (getMarkerPoint). The
// per-frame `update(dt, ctx)` takes { playerPos, inVehicle, speed }.

import * as THREE from 'three';

export const TAXI_POINT = 'plaza';
export const COURIER_POINT = 'garage';

export const TAXI_FARE = {
  basePay: 60,
  perMetre: 0.35,
  timeBonus: 40,
  radius: 14,
};

export const COURIER_RUN = {
  basePay: 100,
  perMetre: 0.5,
  timeBonus: 60,
  radius: 10,
};

// Three checkpoint routes. Every checkpoint sits on a road (road
// centres are -180..180 in steps of 60), so a route is always drivable
// without cutting across a block.
export const RACE_ROUTES = [
  {
    id: 'plaza-loop',
    name: 'Plaza Loop',
    parSeconds: 75,
    reward: 300,
    start: { x: 0, z: 0 },
    checkpoints: [
      { x: 60, z: 0 },
      { x: 120, z: 0 },
      { x: 120, z: 120 },
      { x: 0, z: 120 },
    ],
  },
  {
    id: 'beach-sprint',
    name: 'Beach Sprint',
    parSeconds: 60,
    reward: 350,
    start: { x: -180, z: -60 },
    checkpoints: [
      { x: -180, z: 60 },
      { x: -120, z: 120 },
      { x: -60, z: 120 },
      { x: -60, z: -60 },
    ],
  },
  {
    id: 'docks-dash',
    name: 'Docks Dash',
    parSeconds: 70,
    reward: 400,
    start: { x: 180, z: -180 },
    checkpoints: [
      { x: 180, z: -60 },
      { x: 120, z: -60 },
      { x: 120, z: -180 },
    ],
  },
];

export const HIDDEN_PACKAGES = [
  { id: 'pkg-pier', point: 'pier', dx: 6, dz: -8, reward: 100 },
  { id: 'pkg-beach', point: 'beach', dx: -10, dz: 12, reward: 100 },
  { id: 'pkg-plaza', point: 'plaza', dx: -14, dz: -6, reward: 100 },
  { id: 'pkg-marina', point: 'marina', dx: 8, dz: 10, reward: 100 },
  { id: 'pkg-alley', point: 'alley', dx: -8, dz: 8, reward: 100 },
  { id: 'pkg-garage', point: 'garage', dx: 10, dz: -10, reward: 100 },
  { id: 'pkg-safehouse', point: 'safehouse', dx: -10, dz: -8, reward: 100 },
  { id: 'pkg-showroom', point: 'showroom', dx: 12, dz: 6, reward: 100 },
  { id: 'pkg-dropoff', point: 'dropoff', dx: -12, dz: -10, reward: 100 },
  { id: 'pkg-docks', point: 'docks', dx: 8, dz: 8, reward: 100 },
];

const DESTINATIONS = [
  'pier', 'beach', 'plaza', 'marina', 'alley', 'garage',
  'safehouse', 'showroom', 'dropoff', 'bank', 'docks', 'warehouse',
];

const BEACON_COLORS = {
  taxi: 0xffd23c,
  courier: 0x4fd8e8,
  race: 0xe83a8a,
  package: 0x7ed07a,
  start: 0xff8a3d,
};

function formatMoney(amount) {
  return '$' + Math.floor(amount || 0).toLocaleString('en-US');
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

function makeBeacon(color, radius = 2.2) {
  const group = new THREE.Group();
  const beamMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 18, 16, 1, true),
    beamMat,
  );
  beam.position.y = 9;
  group.add(beam);
  const ringMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.6, radius, 24), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.2;
  group.add(ring);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  core.position.y = 1.0;
  group.add(core);
  group.userData.beam = beam;
  group.userData.ring = ring;
  group.userData.core = core;
  return group;
}

export function createSideActivitySystem(deps = {}) {
  const scene = deps.scene || null;
  const city = deps.city || null;
  const saveApi = deps.save || null;
  const hud = deps.hud || null;
  const onCash = typeof deps.onCash === 'function' ? deps.onCash : null;
  const rng = typeof deps.rng === 'function' ? deps.rng : Math.random;

  const beacons = new Map();
  let taxi = null; // { dest, destPoint, timeLeft, totalTime, startPos }
  let courier = null; // { dest, destPoint, timeLeft, totalTime }
  let race = null; // { route, checkpointIndex, timeLeft, totalTime }
  let raceArmed = true;
  let packages = [];
  let stats = { faresDone: 0, deliveriesDone: 0, racesWon: 0, packagesFound: 0 };
  let bestTimes = {};
  let totalSeconds = 0;

  function resolvePoint(name) {
    if (city && typeof city.getMarkerPoint === 'function') {
      try {
        const p = city.getMarkerPoint(name);
        if (p && typeof p.x === 'number') return { x: p.x, z: p.z };
      } catch { /* fall through to the fallback table */ }
    }
    const fallback = {
      plaza: { x: 30, z: 30 }, garage: { x: -120, z: -120 },
      pier: { x: -260, z: 60 }, beach: { x: -250, z: 0 },
      marina: { x: 180, z: -60 }, alley: { x: -60, z: -60 },
      safehouse: { x: -180, z: 120 }, showroom: { x: 180, z: -60 },
      dropoff: { x: 120, z: 60 }, bank: { x: 60, z: -180 },
      docks: { x: 215, z: -215 }, warehouse: { x: 228, z: -230 },
    };
    return fallback[name] || { x: 0, z: 0 };
  }

  function readSideSave() {
    try {
      const saved = saveApi && typeof saveApi.loadSave === 'function'
        ? saveApi.loadSave()
        : null;
      const side = (saved && saved.side) || {};
      stats = {
        faresDone: side.faresDone || 0,
        deliveriesDone: side.deliveriesDone || 0,
        racesWon: side.racesWon || 0,
        packagesFound: Array.isArray(side.packagesFound) ? side.packagesFound.length : 0,
      };
      bestTimes = (side.racesBest && typeof side.racesBest === 'object') ? side.racesBest : {};
      return Array.isArray(side.packagesFound) ? side.packagesFound : [];
    } catch {
      return [];
    }
  }

  function writeSideSave(foundIds) {
    if (!saveApi || typeof saveApi.updateSave !== 'function') return;
    try {
      saveApi.updateSave((s) => {
        s.side = {
          faresDone: stats.faresDone,
          deliveriesDone: stats.deliveriesDone,
          racesWon: stats.racesWon,
          racesBest: { ...bestTimes },
          packagesFound: [...foundIds],
        };
      });
    } catch { /* save failure must not break the job */ }
  }

  function notify(text, seconds = 3) {
    if (hud && typeof hud.notify === 'function') hud.notify(text, seconds);
  }

  function pay(amount, reason) {
    if (onCash) {
      try { onCash(amount, reason); } catch { /* payout is best-effort */ }
    }
  }

  function setBeacon(key, color, x, z, visible = true) {
    let beacon = beacons.get(key);
    if (!beacon) {
      beacon = makeBeacon(color);
      beacons.set(key, beacon);
      if (scene) scene.add(beacon);
    }
    beacon.position.set(x, 0, z);
    beacon.visible = visible;
    return beacon;
  }

  function hideBeacon(key) {
    const beacon = beacons.get(key);
    if (beacon) beacon.visible = false;
  }

  function pickDestination(exceptPoint) {
    const options = DESTINATIONS.filter((d) => d !== exceptPoint);
    return options[Math.floor(rng() * options.length)];
  }

  // --- taxi fares ---------------------------------------------------------------
  function startTaxi(playerPos) {
    if (taxi) {
      notify('Already carrying a fare — finish this one first', 2);
      return false;
    }
    const destName = pickDestination(TAXI_POINT);
    const destPoint = resolvePoint(destName);
    const dist = distance2D(playerPos, destPoint);
    const totalTime = Math.max(45, dist / 11 + 25);
    taxi = {
      dest: destName, destPoint, timeLeft: totalTime, totalTime,
      startPos: { x: playerPos.x, z: playerPos.z },
    };
    setBeacon('taxi', BEACON_COLORS.taxi, destPoint.x, destPoint.z, true);
    notify(`Fare: take them to the ${destName} — ${Math.ceil(totalTime)}s on the meter`, 4);
    return true;
  }

  function updateTaxi(dt, ctx) {
    if (!taxi) return;
    taxi.timeLeft -= dt;
    if (taxi.timeLeft <= 0) {
      notify('Fare cancelled — the passenger got out and walked', 3);
      hideBeacon('taxi');
      taxi = null;
      return;
    }
    if (!ctx.inVehicle) {
      notify('Fare lost — the passenger will not wait on the kerb', 3);
      hideBeacon('taxi');
      taxi = null;
      return;
    }
    if (ctx.playerPos && distance2D(ctx.playerPos, taxi.destPoint) < 5) {
      const dist = distance2D(taxi.startPos, taxi.destPoint);
      const timeBonus = taxi.timeLeft > taxi.totalTime * 0.4 ? TAXI_FARE.timeBonus : 0;
      const payout = Math.round(TAXI_FARE.basePay + dist * TAXI_FARE.perMetre + timeBonus);
      pay(payout, 'taxi fare');
      stats.faresDone += 1;
      writeSideSave(foundPackageIds());
      hideBeacon('taxi');
      notify(`Fare paid ${formatMoney(payout)} — nice driving, Leo`, 4);
      taxi = null;
    }
  }

  // --- courier runs ---------------------------------------------------------------
  function startCourier(playerPos) {
    if (courier) {
      notify('Already carrying a parcel — deliver it first', 2);
      return false;
    }
    const destName = pickDestination(COURIER_POINT);
    const destPoint = resolvePoint(destName);
    const dist = distance2D(playerPos, destPoint);
    const totalTime = Math.max(50, dist / 9 + 30);
    courier = {
      dest: destName, destPoint, timeLeft: totalTime, totalTime,
      startPos: { x: playerPos.x, z: playerPos.z },
    };
    setBeacon('courier', BEACON_COLORS.courier, destPoint.x, destPoint.z, true);
    notify(`Courier: parcel for the ${destName} — ${Math.ceil(totalTime)}s`, 4);
    return true;
  }

  function updateCourier(dt, ctx) {
    if (!courier) return;
    courier.timeLeft -= dt;
    if (courier.timeLeft <= 0) {
      notify('Courier run failed — the parcel went back to the depot', 3);
      hideBeacon('courier');
      courier = null;
      return;
    }
    if (ctx.playerPos && distance2D(ctx.playerPos, courier.destPoint) < 4) {
      const dist = distance2D(courier.startPos, courier.destPoint);
      const timeBonus = courier.timeLeft > courier.totalTime * 0.4 ? COURIER_RUN.timeBonus : 0;
      const payout = Math.round(COURIER_RUN.basePay + dist * COURIER_RUN.perMetre + timeBonus);
      pay(payout, 'courier delivery');
      stats.deliveriesDone += 1;
      writeSideSave(foundPackageIds());
      hideBeacon('courier');
      notify(`Parcel delivered — ${formatMoney(payout)} earned`, 4);
      courier = null;
    }
  }

  // --- street races -----------------------------------------------------------------
  function startRace(route) {
    if (race) return false;
    race = {
      route,
      checkpointIndex: 0,
      timeLeft: route.parSeconds,
      totalTime: route.parSeconds,
      startedAt: totalSeconds,
    };
    raceArmed = false;
    const first = route.checkpoints[0];
    setBeacon('race', BEACON_COLORS.race, first.x, first.z, true);
    notify(`${route.name}: hit every ring before the clock ends — ${route.parSeconds}s`, 4);
    return true;
  }

  function updateRace(dt, ctx) {
    if (!race) {
      // Not racing: watch the start rings. Driving through one starts
      // that route. A short re-arm delay stops an instant restart.
      if (!raceArmed) return;
      if (!ctx.inVehicle || !ctx.playerPos) return;
      for (const route of RACE_ROUTES) {
        if (distance2D(ctx.playerPos, route.start) < 5) {
          startRace(route);
          return;
        }
      }
      return;
    }
    race.timeLeft -= dt;
    if (race.timeLeft <= 0) {
      notify(`${race.route.name}: out of time — the purse goes to someone else`, 3);
      hideBeacon('race');
      race = null;
      raceArmed = false;
      setTimeout(() => { raceArmed = true; }, 0);
      return;
    }
    if (!ctx.inVehicle) {
      notify(`${race.route.name}: out of the car, out of the race`, 3);
      hideBeacon('race');
      race = null;
      raceArmed = false;
      setTimeout(() => { raceArmed = true; }, 0);
      return;
    }
    const next = race.route.checkpoints[race.checkpointIndex];
    if (ctx.playerPos && next && distance2D(ctx.playerPos, next) < 6) {
      race.checkpointIndex += 1;
      if (race.checkpointIndex >= race.route.checkpoints.length) {
        const elapsed = race.totalTime - race.timeLeft;
        const timeBonus = Math.max(0, Math.round((race.route.parSeconds - elapsed) * 2));
        const payout = race.route.reward + timeBonus;
        pay(payout, 'street race win');
        stats.racesWon += 1;
        const prev = bestTimes[race.route.id];
        if (prev === undefined || elapsed < prev) bestTimes[race.route.id] = Math.round(elapsed * 10) / 10;
        writeSideSave(foundPackageIds());
        hideBeacon('race');
        notify(`${race.route.name} won in ${elapsed.toFixed(1)}s — ${formatMoney(payout)}`, 4);
        race = null;
        raceArmed = false;
        setTimeout(() => { raceArmed = true; }, 0);
        return;
      }
      const following = race.route.checkpoints[race.checkpointIndex];
      setBeacon('race', BEACON_COLORS.race, following.x, following.z, true);
      notify(`Ring ${race.checkpointIndex + 1} of ${race.route.checkpoints.length}`, 2);
    }
  }

  // --- hidden packages ----------------------------------------------------------------
  function foundPackageIds() {
    return packages.filter((p) => p.found).map((p) => p.id);
  }

  function buildPackages(foundIds) {
    packages = HIDDEN_PACKAGES.map((def) => {
      const point = resolvePoint(def.point);
      const x = point.x + (def.dx || 0);
      const z = point.z + (def.dz || 0);
      const found = foundIds.includes(def.id);
      const beacon = makeBeacon(BEACON_COLORS.package, 1.4);
      beacon.position.set(x, 0, z);
      beacon.visible = !found;
      if (scene) scene.add(beacon);
      beacons.set('package-' + def.id, beacon);
      return { ...def, x, z, found };
    });
  }

  function updatePackages(ctx) {
    if (!ctx.playerPos) return;
    for (const pkg of packages) {
      if (pkg.found) continue;
      if (distance2D(ctx.playerPos, { x: pkg.x, z: pkg.z }) < 3) {
        pkg.found = true;
        stats.packagesFound += 1;
        const beacon = beacons.get('package-' + pkg.id);
        if (beacon) beacon.visible = false;
        pay(pkg.reward, 'hidden package');
        writeSideSave(foundPackageIds());
        notify(`Hidden package found — ${formatMoney(pkg.reward)} (${stats.packagesFound}/10)`, 4);
      }
    }
  }

  function buildRaceStartRings() {
    for (const route of RACE_ROUTES) {
      const ring = makeBeacon(BEACON_COLORS.start, 3.2);
      ring.position.set(route.start.x, 0, route.start.z);
      if (scene) scene.add(ring);
      beacons.set('race-start-' + route.id, ring);
    }
  }

  // --- public API -----------------------------------------------------------------------
  function isNearTaxiStand(playerPos) {
    if (!playerPos) return false;
    const plaza = resolvePoint(TAXI_POINT);
    return distance2D(playerPos, plaza) < TAXI_FARE.radius;
  }

  function isNearCourierDepot(playerPos) {
    if (!playerPos) return false;
    const garage = resolvePoint(COURIER_POINT);
    return distance2D(playerPos, garage) < COURIER_RUN.radius;
  }

  function getActive() {
    if (taxi) {
      return {
        kind: 'taxi',
        text: `Fare to the ${taxi.dest}`,
        timeLeft: Math.ceil(taxi.timeLeft),
        totalTime: taxi.totalTime,
      };
    }
    if (courier) {
      return {
        kind: 'courier',
        text: `Parcel for the ${courier.dest}`,
        timeLeft: Math.ceil(courier.timeLeft),
        totalTime: courier.totalTime,
      };
    }
    if (race) {
      return {
        kind: 'race',
        text: `${race.route.name} — ring ${race.checkpointIndex + 1}/${race.route.checkpoints.length}`,
        timeLeft: Math.ceil(race.timeLeft),
        totalTime: race.totalTime,
      };
    }
    return null;
  }

  function update(dt, ctx = {}) {
    const step = Math.max(0, dt || 0);
    totalSeconds += step;
    updateTaxi(step, ctx);
    updateCourier(step, ctx);
    updateRace(step, ctx);
    updatePackages(ctx);
    // Beacons breathe: the rings pulse so a player can spot the next
    // target from a street away.
    for (const beacon of beacons.values()) {
      if (!beacon.visible) continue;
      const pulse = 0.85 + Math.sin(totalSeconds * 3) * 0.15;
      if (beacon.userData.ring) beacon.userData.ring.material.opacity = pulse;
      if (beacon.userData.core) {
        beacon.userData.core.position.y = 1.0 + Math.sin(totalSeconds * 2) * 0.15;
      }
    }
  }

  function getState() {
    return {
      active: getActive(),
      stats: { ...stats },
      bestTimes: { ...bestTimes },
      packagesFound: foundPackageIds(),
      packagesTotal: HIDDEN_PACKAGES.length,
      taxi: taxi ? { dest: taxi.dest, timeLeft: taxi.timeLeft } : null,
      courier: courier ? { dest: courier.dest, timeLeft: courier.timeLeft } : null,
      race: race ? { route: race.route.id, checkpoint: race.checkpointIndex, timeLeft: race.timeLeft } : null,
    };
  }

  // Build the world pieces once, at boot.
  const foundIds = readSideSave();
  buildPackages(foundIds);
  buildRaceStartRings();
  // The race re-arm starts true after a short beat so the player does
  // not trigger a race the frame the game loads while standing on a
  // start ring.
  raceArmed = false;
  setTimeout(() => { raceArmed = true; }, 1500);

  return {
    update,
    startTaxi,
    startCourier,
    isNearTaxiStand,
    isNearCourierDepot,
    getActive,
    getState,
    get stats() { return { ...stats }; },
    dispose() {
      for (const beacon of beacons.values()) {
        if (scene) {
          try { scene.remove(beacon); } catch { /* teardown only */ }
        }
      }
      beacons.clear();
    },
  };
}

export default createSideActivitySystem;
