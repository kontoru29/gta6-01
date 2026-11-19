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
// Every shot is staged at sunset: applyShotStaging warms the light
// (deeper orange sun, peach sky, warm fog, glowing lamps) so the
// colourful buildings, the palms and the neon signs glow the way a
// beachfront evening should. Normal play keeps the standard golden-hour
// light; only the staged screenshots get the extra warmth.
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

import * as THREE from 'three';
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

// Warm the whole scene toward sunset: a deeper orange sun, a peach-pink
// sky and warm fog, with a warmer hemisphere fill and the street lamps
// turned up so they glow. Best-effort and guarded — a failure here must
// never stop the shot from staging.
function warmSunsetLight(game) {
  try {
    const world = game && game.world;
    if (!world || !world.group) return;
    const scene = world.group.parent;
    if (!scene) return;
    const sky = 0xee8f6b;
    const fogColour = 0xf0a878;
    const sunColour = 0xff8a3d;
    const skyFill = 0xf2b48a;
    const groundFill = 0xd9985e;
    if (scene.background && scene.background.isColor) {
      scene.background.set(sky);
    } else {
      scene.background = new THREE.Color(sky);
    }
    if (scene.fog && scene.fog.color) {
      scene.fog.color.set(fogColour);
    }
    const lights = world.lights || {};
    if (lights.sun) {
      lights.sun.color.set(sunColour);
      lights.sun.intensity = 3.0;
    }
    if (lights.hemi) {
      lights.hemi.color.set(skyFill);
      lights.hemi.groundColor.set(groundFill);
      lights.hemi.intensity = 0.9;
    }
    // Fallback when the world does not expose its lights: walk the scene
    // and warm the first sun and sky fill found.
    if (!lights.sun || !lights.hemi) {
      scene.traverse((obj) => {
        if (!lights.sun && obj.isDirectionalLight) {
          obj.color.set(sunColour);
          obj.intensity = 3.0;
        }
        if (!lights.hemi && obj.isHemisphereLight) {
          obj.color.set(skyFill);
          obj.groundColor.set(groundFill);
          obj.intensity = 0.9;
        }
      });
    }
    // Street lamps: any mesh whose material already glows warm (the lamp
    // heads) gets its emissive turned up, so the lamps read as lit
    // against the sunset. Anything else is left alone.
    scene.traverse((obj) => {
      if (!obj.isMesh || !obj.material || !obj.material.emissive) return;
      const glow = obj.material.emissive;
      if (glow.r > glow.b + 0.2 && glow.r >= glow.g) {
        obj.material.emissiveIntensity = Math.max(
          obj.material.emissiveIntensity || 0,
          2.6,
        );
      }
    });
  } catch {
    // Sunset is cosmetic; a miss just leaves the standard golden hour.
  }
}

// Put one entity (car, bike, walker, police unit) on a fixed spot.
function place(entity, x, z, heading, speed) {
  if (!entity) return null;
  entity.group.position.set(x, 0, z);
  entity.heading = heading;
  entity.group.rotation.y = heading;
  if (typeof speed === 'number') entity.speed = speed;
  return entity;
}

// Spread the first few traffic cars over the given spots.
function spreadTraffic(game, spots) {
  const traffic = game.vehicles.traffic || [];
  spots.slice(0, traffic.length).forEach((spot, i) => {
    place(traffic[i], spot.x, spot.z, spot.heading, spot.speed || 0);
  });
}

function spreadWalkers(game, spots) {
  const walkers = game.pedestrians.pedestrians || [];
  spots.slice(0, walkers.length).forEach((spot, i) => {
    const ped = walkers[i];
    place(ped, spot.x, spot.z, spot.heading, 0);
    ped.state = 'walking';
    ped.panic = 0;
  });
}

// Put one parked car where the camera can see it, ready to be stolen.
function parkStealable(game, x, z, heading) {
  const parked = (game.vehicles.cars || []).filter((c) => !c.isTraffic && !c.isPlayer);
  const car = parked[0] || (game.vehicles.cars || [])[0];
  return place(car, x, z, heading, 0);
}

function openMission(game, id) {
  try {
    if (game.missions.getActiveMission()) return;
    game.missions.startMission(id);
  } catch {
    // Staging must never throw: a failed start just leaves free roam.
  }
}

// --- the four staged scenes -----------------------------------------------

// Far corners of the city, for parking the traffic the shot does not
// need where the camera cannot see it: the boot traffic is placed at
// random, and a stray car can wander into the frame or even nudge Leo's
// staged car. Every stager below places all 12 traffic cars — the ones
// the shot wants near, the rest out here.
const FAR_TRAFFIC = [
  { x: 180, z: 180, heading: 0, speed: 9 },
  { x: -180, z: 180, heading: 0, speed: 9 },
  { x: 180, z: -180, heading: 0, speed: 9 },
  { x: -180, z: -180, heading: 0, speed: 9 },
  { x: 60, z: 180, heading: 0, speed: 9 },
  { x: -60, z: 180, heading: 0, speed: 9 },
  { x: 180, z: 60, heading: 0, speed: 9 },
  { x: 180, z: -60, heading: 0, speed: 9 },
  { x: -180, z: 60, heading: 0, speed: 9 },
  { x: -180, z: -60, heading: 0, speed: 9 },
  { x: 60, z: -180, heading: 0, speed: 9 },
  { x: -60, z: -180, heading: 0, speed: 9 },
];

function stageCover(game, rng) {
  // Leo on foot in the middle of the central avenue at the crossroads,
  // looking north down the avenue into the sunset side of the city. The
  // old staging stood him on the sidewalk corner, so the bottom half of
  // the frame was empty pavement; standing him on the road puts traffic,
  // walkers and the ferris wheel ahead of him and the road itself in the
  // foreground. Traffic rolls both ways, walkers stroll the pavements,
  // and a bright sedan sits parked at the kerb.
  game.player.setPosition(0, 14, 0.1);
  game.setCash(120);
  game.police.setWantedLevel(0);
  openMission(game, 'first-fare');
  parkStealable(game, 12.5, -2, Math.PI / 2);
  // A blue roadster parked at the far kerb, and a motorbike filtering
  // down the avenue toward the camera, so the cover shows the new rides.
  // A second parked car — a yellow coupe on the east kerb — so the cover
  // shows two rides waiting to be stolen, not one.
  try {
    game.vehicles.spawnCarAt('roadster', 0x2f7fd0, -12.5, -6, Math.PI / 2);
    game.vehicles.spawnCarAt('coupe', 0xe8b93c, 12.5, -12, Math.PI / 2);
    place(game.vehicles.spawnBikeAt(3.5, -14, Math.PI), 3.5, -14, Math.PI, 12);
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  // Every traffic car is ahead of Leo (north, smaller z), so the road
  // ahead reads as busy instead of empty. The nearest one sits 14 m up
  // the road, close enough to read, and the rest of the traffic is
  // parked at the far corners so no stray car photobombs the frame.
  spreadTraffic(game, [
    { x: -3.5, z: 0, heading: 0, speed: 10 },
    { x: 3.5, z: -30, heading: Math.PI, speed: 9 },
    { x: -3.5, z: -55, heading: 0, speed: 11 },
    { x: 3.5, z: -80, heading: Math.PI, speed: 10 },
    ...FAR_TRAFFIC.slice(0, 8),
  ]);
  spreadWalkers(game, [
    { x: 9.5, z: -2, heading: 2.4 },
    { x: -9.5, z: -18, heading: -1.2 },
    { x: 10.5, z: -34, heading: 0.6 },
    { x: -10.5, z: -8, heading: 1.8 },
    { x: 9.5, z: -48, heading: -0.4 },
    // One walker on the near kerb, just ahead of Leo, so the foreground
    // has a person in it instead of bare asphalt.
    { x: 9.5, z: 4, heading: -0.9 },
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
  openMission(game, 'first-fare');
  // A motorbike in the oncoming lane, closing on Leo as he drives north.
  try {
    place(game.vehicles.spawnBikeAt(3.5, 16, Math.PI), 3.5, 16, Math.PI, 14);
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  // The old frame left the lower right as empty sidewalk and the road
  // ahead thin: one more oncoming car close to the camera and a walker
  // on the near kerb, so the near side of the road reads as lived-in.
  // The rest of the traffic is parked at the far corners: a stray boot
  // car once wandered into the frame and read as a collision with Leo.
  spreadTraffic(game, [
    { x: -3.5, z: 6, heading: 0, speed: 11 },
    { x: 3.5, z: -18, heading: Math.PI, speed: 10 },
    { x: -3.5, z: -44, heading: 0, speed: 12 },
    { x: 3.5, z: 78, heading: Math.PI, speed: 9 },
    { x: -56.5, z: 42.5, heading: Math.PI / 2, speed: 8 },
    // The near oncoming car sits 36 m up the road, not 16: at 16 m it
    // closed head-on with Leo's car and the two met right as the shutter
    // fired — a probe caught it 3 m off Leo's bumper, braking. At 36 m
    // it still reads as oncoming traffic and stays clear of the shot.
    { x: 3.5, z: 10, heading: Math.PI, speed: 10 },
    ...FAR_TRAFFIC.slice(0, 6),
  ]);
  spreadWalkers(game, [
    { x: 9.5, z: 20, heading: 1.1 },
    { x: -9.5, z: 60, heading: -2.0 },
    { x: 9.5, z: 54, heading: -0.6 },
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
  // close (6-18 m back) and face north (heading PI in the police
  // module's convention, where 0 faces +Z): staged facing away, they
  // would drive off down the road instead of chasing. The old staging
  // put them 12-28 m back and the wide camera 22 m ahead, so the pack
  // read as three distant dots; pulled in, the pack fills the frame.
  // They are staged BEFORE setWantedLevel on purpose: that call resizes
  // the force, and a resize that finds more units than the star count
  // wants removes the newest ones first, so staging them after it would
  // delete the pack on the next frame and leave only the far spawns by
  // the station. Staged first, the resize counts them as the force.
  const pack = [
    { x: -3.5, z: 58 },
    { x: 3.5, z: 64 },
    { x: -3.5, z: 70 },
  ];
  for (const spot of pack) {
    try {
      place(game.police.spawnAt(spot, 'car'), spot.x, spot.z, Math.PI, 20);
    } catch {
      // One missing patrol car must not sink the shot.
    }
  }
  // A police motorbike rides with the pack, tucked just behind the lead
  // car so it reads in the frame, its light pod flashing — the chase
  // shot's proof the bikes are in the game.
  // Staged before the wanted level for the same reason as the cars.
  try {
    place(game.police.spawnAt({ x: 0.5, z: 61 }, 'bike'), 0.5, 61, Math.PI, 24);
  } catch {
    // The shot still works without the bike in frame.
  }
  game.police.setWantedLevel(3);
  game.setCash(820);
  openMission(game, 'first-fare');
  spreadTraffic(game, [
    { x: -3.5, z: 8, heading: 0, speed: 11 },
    { x: 3.5, z: -30, heading: Math.PI, speed: 10 },
    // One car crossing the intersection south of the pack, so the road
    // the chase runs down reads as a live city, not an empty runway.
    { x: -56.5, z: 60, heading: Math.PI / 2, speed: 8 },
    ...FAR_TRAFFIC.slice(0, 9),
  ]);
  // A walker on the south kerb, close to the camera, so the near side of
  // the avenue is not empty pavement while the chase fills the road.
  spreadWalkers(game, [
    { x: 9.5, z: 68, heading: -1.6 },
  ]);
  // Camera variant: 'wide' pulls the reverse angle back and up so the
  // whole pack reads at once. Default is the closer reverse angle.
  game.cameraMode = cam === 'wide' ? 'chase-wide' : 'chase';
  void rng;
}

function stageMission(game, rng) {
  // A job in progress: Leo on foot in the middle of the -120 avenue,
  // facing north up the road toward the garage marker with his pistol
  // drawn, two stars burning, an officer closing in and a getaway car
  // waiting at the kerb. The old staging stood him at (-112, -46) facing
  // away from the marker, so the right half of the frame was one flat
  // building wall and the marker ring sat at the frame's edge; standing
  // him on the avenue facing the marker puts the ring dead centre, the
  // street ahead full of traffic, and the buildings framing the shot
  // instead of swallowing it. The first mission is the one open at the
  // start of the story, so it is the one this shot stages.
  game.setCash(2450);
  game.police.setWantedLevel(2);
  openMission(game, 'first-fare');
  game.player.setPosition(-120, -38, 0);
  try {
    game.combat.equipWeapon('pistol');
  } catch {
    // Pistol is cosmetic for the frame; never fail the shot over it.
  }
  parkStealable(game, -108.5, -58, Math.PI / 2);
  // Traffic on the avenue ahead: one car coming south toward the camera
  // in the west lane, one driving north away in the east lane, so the
  // road ahead of Leo reads as busy in both directions. The rest of the
  // traffic is parked at the far corners so no stray car blocks the
  // marker or wanders into the frame.
  spreadTraffic(game, [
    { x: -123.5, z: -70, heading: Math.PI, speed: 9 },
    { x: -116.5, z: -90, heading: 0, speed: 10 },
    ...FAR_TRAFFIC.slice(0, 10),
  ]);
  // A motorbike on the avenue just ahead of Leo, close enough to read —
  // the mission shot's moving traffic. It is held still (cruise 0) so
  // the staging frame catches it exactly where it was placed instead of
  // drifting off down a lane before the shutter.
  try {
    const bike = place(game.vehicles.spawnBikeAt(-114, -56, 0), -114, -56, 0, 0);
    if (bike) bike.cruiseSpeed = 0;
  } catch {
    // Staging extras are optional; the shot still works without them.
  }
  // Walkers on both pavements ahead of Leo, close enough to read, plus
  // one more on the west pavement near the camera for foreground depth.
  spreadWalkers(game, [
    { x: -112, z: -46, heading: 2.2 },
    { x: -128, z: -44, heading: -1.4 },
    { x: -128, z: -30, heading: 0.9 },
  ]);
  // The officer stands just ahead of Leo on the way to the marker, big
  // enough to read as the second star's pursuit, not a speck at the edge.
  try {
    place(game.police.spawnAt({ x: -117, z: -48 }, 'officer'), -117, -48, Math.PI, 0);
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
    warmSunsetLight(game);
    stager(game, rng, cam || null);
  } catch (err) {
    // Staging is best-effort: report it, keep the plain game running.
    if (typeof console !== 'undefined') console.warn('[shots] staging failed:', err);
    return false;
  }
  return true;
}

export default applyShotStaging;
