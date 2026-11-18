// shots.js — Solmar Bay deterministic screenshot staging.
//
// Loading the page with ?shot=<name>&seed=<n> poses one fixed scene and
// nothing else: it never changes the real game balance, never edits a
// mission definition, never touches the save file. main.js calls
// applyShotStaging() once after the world is built, renders a few frames
// so the renderer settles, then sets window.__shotReady = true so a
// headless capture script knows the frame is ready.
//
// An optional &cam=<mode> picks a camera variant for the shot:
//   drive: cam=side   — a side profile of Leo's supercar with the road
//                       ahead and the oncoming bike in frame.
//   chase: cam=wide   — the reverse chase angle pulled back and up, so
//                       the whole patrol pack reads in one frame.
// Without &cam the default camera is used (normal driving camera for
// drive, reverse angle for chase).
//
// The four shots, each showing several systems at once:
//   cover   — Leo on foot at golden hour: HUD, minimap, mission objective,
//             traffic, pedestrians, a car waiting to be stolen, plus a
//             roadster parked at the far kerb and a motorbike filtering
//             down the avenue.
//   drive   — Leo driving a red supercar through traffic: speed, minimap,
//             1 wanted star, a motorbike in the oncoming lane.
//   chase   — a police chase: 2-3 patrol cars and a police motorbike
//             behind Leo's yellow sport coupe, 3 wanted stars, police
//             blips on the minimap, mission objective on the HUD.
//   mission — a mission in progress: Leo on foot with his pistol near the
//             bank marker, 2 wanted stars, cash and progress on the HUD,
//             a motorbike cruising the cross street behind him.
//
// `game` is the live context main.js hands over:
//   { player, vehicles, pedestrians, police, combat, missions, world,
//     setCash(amount), startMissionSafe(id), cameraMode }
// Positions are fixed constants, jittered only by the seeded RNG, so the
// same seed always stages the same frame.

import { createRng, seedFromString } from './utils.js';

export const SHOT_NAMES = ['cover', 'drive', 'chase', 'mission'];

// Camera variants each shot understands. Anything else falls back to the
// shot's default camera.
const CAM_VARIANTS = {
  drive: ['side'],
  chase: ['wide'],
};

export function readShotParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const name = (params.get('shot') || '').toLowerCase();
    if (!SHOT_NAMES.includes(name)) return null;
    const seedRaw = parseInt(params.get('seed') || '1', 10);
    const seed = Number.isFinite(seedRaw) ? seedRaw : 1;
    const camRaw = (params.get('cam') || '').toLowerCase();
    const cam = (CAM_VARIANTS[name] || []).includes(camRaw) ? camRaw : null;
    return { name, seed, cam };
  } catch {
    return null;
  }
}

// Move one entity (car, bike, walker, police unit) to a fixed spot.
function poseEntity(entity, x, z, heading, speed) {
  if (!entity) return null;
  entity.group.position.set(x, 0, z);
  entity.heading = heading;
  entity.group.rotation.y = heading;
  if (typeof speed === 'number') entity.speed = speed;
  return entity;
}

// Place the first few traffic cars on the given spots.
function placeTrafficNear(game, spots) {
  const traffic = game.vehicles.traffic || [];
  spots.slice(0, traffic.length).forEach((spot, i) => {
    poseEntity(traffic[i], spot.x, spot.z, spot.heading, spot.speed || 0);
  });
}

function placePedestriansNear(game, spots) {
  const walkers = game.pedestrians.pedestrians || [];
  spots.slice(0, walkers.length).forEach((spot, i) => {
    const ped = walkers[i];
    poseEntity(ped, spot.x, spot.z, spot.heading, 0);
    ped.state = 'walking';
    ped.panic = 0;
  });
}

// Put one parked car where the camera can see it, ready to be stolen.
function placeStealableCar(game, x, z, heading) {
  const parked = (game.vehicles.cars || []).filter((c) => !c.isTraffic && !c.isPlayer);
  const car = parked[0] || (game.vehicles.cars || [])[0];
  return poseEntity(car, x, z, heading, 0);
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
    poseEntity(game.vehicles.spawnBikeAt(3.5, -26, Math.PI), 3.5, -26, Math.PI, 12);
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

function stageDrive(game, rng, cam) {
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
    poseEntity(game.vehicles.spawnBikeAt(3.5, 16, Math.PI), 3.5, 16, Math.PI, 14);
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
  // Camera variant: a side profile that shows the supercar's shape and
  // the road ahead in one frame. Default is the normal driving camera.
  game.cameraMode = cam === 'side' ? 'drive-side' : null;
  void rng;
}

function stageChase(game, rng, cam) {
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
  const pack = [
    { x: -3.5, z: 64 },
    { x: 3.5, z: 72 },
    { x: -3.5, z: 80 },
  ];
  for (const spot of pack) {
    try {
      poseEntity(game.police.spawnAt(spot, 'car'), spot.x, spot.z, Math.PI, 20);
    } catch {
      // One missing patrol car must not sink the shot.
    }
  }
  // A police motorbike rides with the pack, tucked just behind the lead
  // car so it reads in the frame, its light pod flashing — the chase
  // shot's proof the bikes are in the game.
  // Staged before the wanted level for the same reason as the cars.
  try {
    poseEntity(game.police.spawnAt({ x: 0.5, z: 68 }, 'bike'), 0.5, 68, Math.PI, 24);
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
  // Camera variant: 'wide' pulls the reverse angle back and up so the
  // whole pack reads at once. Default is the closer reverse angle.
  game.cameraMode = cam === 'wide' ? 'chase-wide' : 'chase';
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
  // A motorbike on the avenue just ahead of Leo, close enough to read —
  // the mission shot's moving traffic. It is held still (cruise 0) so
  // the staging frame catches it exactly where it was placed instead of
  // drifting off down a lane before the shutter.
  try {
    const bike = poseEntity(game.vehicles.spawnBikeAt(-114, -54, 0), -114, -54, 0, 0);
    if (bike) bike.cruiseSpeed = 0;
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  placePedestriansNear(game, [
    { x: -128, z: -42, heading: 2.2 },
    { x: -106, z: -38, heading: -1.4 },
  ]);
  try {
    poseEntity(game.police.spawnAt({ x: -118, z: -56 }, 'officer'), -118, -56, Math.PI, 0);
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
export function applyShotStaging(game, shotName, seed, cam) {
  const stager = STAGERS[shotName];
  if (!stager || !game) return false;
  const rng = createRng((seed || 1) * 7919 + seedFromString(shotName));
  try {
    stager(game, rng, cam || null);
  } catch (err) {
    // Staging is best-effort: report it, keep the plain game running.
    if (typeof console !== 'undefined') console.warn('[shots] staging failed:', err);
    return false;
  }
  return true;
}

export default applyShotStaging;
