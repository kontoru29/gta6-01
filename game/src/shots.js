// shots.js — Solmar Bay deterministic screenshot staging.
//
// When the page is loaded with ?shot=<name>&seed=<n>, this module poses a
// fixed scene for that shot and nothing else: it never changes the real game
// balance, never edits a mission definition, never touches the save file.
// main.js calls applyShotStaging() once after the world is built, runs a few
// frames so the renderer settles, then sets window.__shotReady = true so a
// headless capture script knows the frame is ready.
//
// The four shots, each showing several systems at once:
//   cover   — Leo on foot at golden hour: HUD, minimap, mission objective,
//             traffic, pedestrians, a car waiting to be stolen, plus a
//             roadster parked at the far kerb and a motorbike filtering
//             down the avenue.
//   drive   — Leo driving a red supercar through traffic: speed, minimap,
//             1 wanted star, a motorbike in the oncoming lane.
//   chase   — a police chase: 2–3 patrol cars and a police motorbike
//             behind Leo's yellow sport coupe, 3 wanted stars, police
//             blips on the minimap, mission objective on the HUD.
//   mission — a mission in progress: Leo on foot with his pistol near the
//             bank marker, 2 wanted stars, cash and progress on the HUD,
//             a motorbike cruising the cross street behind him.
//
// `game` is the live context main.js hands over:
//   { player, vehicles, pedestrians, police, combat, missions, world,
//     setCash(amount), startMissionSafe(id), placeCarNear(x, z, heading) }
// Positions are fixed constants, jittered only by the seeded RNG, so the
// same seed always stages the same frame.

import { createRng, seedFromString } from './utils.js';

export const SHOT_NAMES = ['cover', 'drive', 'chase', 'mission'];

// Read ?shot= and ?seed= from the page URL. Unknown names return null.
export function readShotParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const name = (params.get('shot') || '').toLowerCase();
    if (!SHOT_NAMES.includes(name)) return null;
    const seedRaw = parseInt(params.get('seed') || '1', 10);
    const seed = Number.isFinite(seedRaw) ? seedRaw : 1;
    return { name, seed };
  } catch {
    return null;
  }
}

function placeTrafficNear(game, spots) {
  const traffic = game.vehicles.traffic || [];
  for (let i = 0; i < spots.length && i < traffic.length; i += 1) {
    const car = traffic[i];
    const spot = spots[i];
    car.group.position.set(spot.x, 0, spot.z);
    car.heading = spot.heading;
    car.group.rotation.y = spot.heading;
    car.speed = spot.speed || 0;
  }
}

function placePedestriansNear(game, spots) {
  const walkers = game.pedestrians.pedestrians || [];
  for (let i = 0; i < spots.length && i < walkers.length; i += 1) {
    const ped = walkers[i];
    const spot = spots[i];
    ped.group.position.set(spot.x, 0, spot.z);
    ped.heading = spot.heading;
    ped.group.rotation.y = spot.heading;
    ped.state = 'walking';
    ped.panic = 0;
  }
}

// Put one parked car where the camera can see it, ready to be stolen.
function placeStealableCar(game, x, z, heading) {
  const parked = (game.vehicles.cars || []).filter((c) => !c.isTraffic && !c.isPlayer);
  const car = parked[0] || (game.vehicles.cars || [])[0];
  if (!car) return null;
  car.group.position.set(x, 0, z);
  car.heading = heading;
  car.group.rotation.y = heading;
  car.speed = 0;
  return car;
}

function startMissionIfFree(game, id) {
  try {
    if (game.missions.getActiveMission()) return;
    game.missions.startMission(id);
  } catch {
    // Staging must never throw: a failed start just leaves free roam.
  }
}

// --- the four staged scenes -----------------------------------------------

function stageCover(game, rng) {
  // Leo on foot at the central crossroads, looking down the avenue into
  // the sunset side of the city. Traffic rolls past, walkers stroll the
  // pavements, and a bright sedan sits parked at the kerb.
  game.player.setPosition(6, 10, 0.15);
  game.setCash(120);
  game.police.setWantedLevel(0);
  startMissionIfFree(game, 'first-fare');
  placeStealableCar(game, 12.5, -2, Math.PI / 2);
  // A blue roadster parked at the far kerb, and a motorbike filtering
  // down the avenue toward the camera, so the cover shows the new rides.
  try {
    game.vehicles.spawnCarAt('roadster', 0x2f7fd0, -12.5, -6, Math.PI / 2);
    const bike = game.vehicles.spawnBikeAt(3.5, -26, Math.PI);
    if (bike) bike.speed = 12;
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  placeTrafficNear(game, [
    { x: -3.5, z: -30, heading: 0, speed: 10 },
    { x: 3.5, z: 28, heading: Math.PI, speed: 9 },
    { x: -3.5, z: 48, heading: 0, speed: 11 },
    { x: -56.5, z: 3.5, heading: Math.PI / 2, speed: 8 },
  ]);
  placePedestriansNear(game, [
    { x: 9.5, z: -6, heading: 2.4 },
    { x: -9.5, z: 16, heading: -1.2 },
    { x: 10.5, z: 26, heading: 0.6 },
    { x: -10.5, z: -14, heading: 1.8 },
    { x: 9.5, z: -22, heading: -0.4 },
  ]);
  void rng;
}

function stageDrive(game, rng) {
  // Leo driving north up the central avenue at a brisk cruise, traffic
  // ahead and behind, one star on the board from a fender-bender earlier.
  // Order matters: taking the car is itself a crime, so the wanted level
  // and the cash are set after the car is entered, not before. The car
  // itself is a red supercar — the fastest thing on the island.
  const car = game.vehicles.spawnCarAt('supercar', 0xd21f2b, 0, 46, 0);
  if (car) {
    game.vehicles.enterPlayerVehicle(car);
    car.speed = 16;
  }
  game.police.setWantedLevel(1);
  game.setCash(350);
  startMissionIfFree(game, 'first-fare');
  // A motorbike in the oncoming lane, closing on Leo as he drives north.
  try {
    const bike = game.vehicles.spawnBikeAt(3.5, 16, Math.PI);
    if (bike) bike.speed = 14;
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  placeTrafficNear(game, [
    { x: -3.5, z: 6, heading: 0, speed: 11 },
    { x: 3.5, z: -18, heading: Math.PI, speed: 10 },
    { x: -3.5, z: -44, heading: 0, speed: 12 },
    { x: 3.5, z: 78, heading: Math.PI, speed: 9 },
    { x: -56.5, z: 42.5, heading: Math.PI / 2, speed: 8 },
  ]);
  placePedestriansNear(game, [
    { x: 9.5, z: 20, heading: 1.1 },
    { x: -9.5, z: 60, heading: -2.0 },
  ]);
  void rng;
}

function stageChase(game, rng) {
  // Full pursuit: Leo flooring it north up the avenue at three stars,
  // patrol cars fanned out behind him, the crew's job still on the HUD.
  // The car is taken first: its theft heat lands before the wanted level
  // is set, so the shot holds three stars instead of jumping to four.
  // Leo's ride is a yellow sport coupe; a police bike hunts with the cars.
  const car = game.vehicles.spawnCarAt('sport', 0xf2b234, 0, 52, 0);
  if (car) {
    game.vehicles.enterPlayerVehicle(car);
    car.speed = 23;
  }
  // Patrol cars behind Leo, staggered across both lanes so the chase
  // reads as a pack, not a single car. main.js switches to a reverse
  // camera angle for this shot, so these cars are in the frame. They sit
  // close (12–28 m back) and face north (heading PI in the police
  // module's convention, where 0 faces +Z): staged facing away, they
  // would drive off down the road instead of chasing.
  // They are staged BEFORE setWantedLevel on purpose: that call resizes
  // the force, and a resize that finds more units than the star count
  // wants removes the newest ones first, so staging them after it would
  // delete the pack on the next frame and leave only the far spawns by
  // the station. Staged first, the resize counts them as the force.
  const behind = [
    { x: -3.5, z: 64 },
    { x: 3.5, z: 72 },
    { x: -3.5, z: 80 },
  ];
  for (const spot of behind) {
    try {
      const unit = game.police.spawnAt(spot, 'car');
      if (unit) {
        unit.group.position.set(spot.x, 0, spot.z);
        unit.heading = Math.PI;
        unit.group.rotation.y = Math.PI;
        unit.speed = 20;
      }
    } catch {
      // One missing patrol car must not sink the shot.
    }
  }
  // A police motorbike rides with the pack, tucked just behind the lead
  // car so it reads in the frame, its light pod flashing — the chase
  // shot's proof the bikes are in the game.
  // Staged before the wanted level for the same reason as the cars.
  try {
    const bike = game.police.spawnAt({ x: 0.5, z: 68 }, 'bike');
    if (bike) {
      bike.group.position.set(0.5, 0, 68);
      bike.heading = Math.PI;
      bike.group.rotation.y = Math.PI;
      bike.speed = 24;
    }
  } catch {
    // The shot still works without the bike in frame.
  }
  game.police.setWantedLevel(3);
  game.setCash(820);
  startMissionIfFree(game, 'first-fare');
  placeTrafficNear(game, [
    { x: -3.5, z: 8, heading: 0, speed: 11 },
    { x: 3.5, z: -30, heading: Math.PI, speed: 10 },
  ]);
  game.cameraMode = 'chase';
  void rng;
}

function stageMission(game, rng) {
  // A job in progress: Leo on foot by the garage marker with his pistol
  // drawn, two stars burning, an officer closing in from the street and a
  // getaway car waiting at the kerb. The first mission is the one open at
  // the start of the story, so it is the one this shot stages.
  game.setCash(2450);
  game.police.setWantedLevel(2);
  startMissionIfFree(game, 'first-fare');
  game.player.setPosition(-112, -46, -0.5);
  try {
    game.combat.equipWeapon('pistol');
  } catch {
    // Pistol is cosmetic for the frame; never fail the shot over it.
  }
  placeStealableCar(game, -108.5, -58, Math.PI / 2);
  placeTrafficNear(game, [
    { x: -123.5, z: -80, heading: Math.PI, speed: 9 },
    { x: -116.5, z: -16, heading: 0, speed: 10 },
  ]);
  // A motorbike cruising the avenue ahead of Leo, oncoming and close
  // enough to read — the mission shot's moving traffic.
  try {
    const bike = game.vehicles.spawnBikeAt(-116.5, -62, 0);
    if (bike) bike.speed = 11;
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  placePedestriansNear(game, [
    { x: -128, z: -42, heading: 2.2 },
    { x: -106, z: -38, heading: -1.4 },
  ]);
  try {
    const officer = game.police.spawnAt({ x: -118, z: -56 }, 'officer');
    if (officer) {
      officer.group.position.set(-118, 0, -56);
      officer.heading = Math.PI;
      officer.group.rotation.y = Math.PI;
    }
  } catch {
    // The shot still works without the officer in frame.
  }
  void rng;
}

const STAGERS = {
  cover: stageCover,
  drive: stageDrive,
  chase: stageChase,
  mission: stageMission,
};

// Pose the scene for `shotName`. Returns true when a stager ran.
// `seed` only jitters cosmetic details through the seeded RNG.
export function applyShotStaging(game, shotName, seed) {
  const stager = STAGERS[shotName];
  if (!stager || !game) return false;
  const rng = createRng((seed || 1) * 7919 + seedFromString(shotName));
  try {
    stager(game, rng);
  } catch (err) {
    // Staging is best-effort: report it, keep the plain game running.
    if (typeof console !== 'undefined') console.warn('[shots] staging failed:', err);
    return false;
  }
  return true;
}

export default applyShotStaging;
