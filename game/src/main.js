// main.js — Solmar Bay bootstrap, game loop and state machine, rebuilt.
//
// This file turns the game modules into a playable game. It builds the
// renderer and the city, wires every module together (with small adapters
// where two modules describe the same thing differently — the city hands
// out lanes as start/end pairs while the vehicle module wants point
// lists, and the missions name places the city calls by other names),
// runs the frame loop, and owns the state machine: menu / playing /
// paused / phone / busted / wasted / mission-complete. It also owns the
// things no single module owns: the player's health, the cash balance,
// the camera while driving, shooting input, and the deterministic
// screenshot mode (?shot=<name>&seed=<n>&cam=<mode> via shots.js).
//
// New this round: stunt jumps actually pay out (the loop watches for the
// player's car crossing a jump point at speed), photo spots get their own
// cyan markers in the world, a PIT shove spins the player's car, rams
// now hurt Leo a little as well as his car, and the driving camera eases
// closer as the car slows down. The menu save note counts seven missions.
//
// Round 8: the bay has weather now — a full day and night cycle with
// clear, overcast, rain, storm and fog states that change the light, the
// grip and the rain on the windscreen — plus the North Docks district
// (containers, cranes, a warehouse and yard hands), a garage where Leo
// tunes whatever he is driving, taxi fares and courier runs, three
// street races, ten hidden packages, an alley arsenal selling an SMG, a
// rifle and a bat, and three new missions that send Leo to the docks
// after dark. The menu save note counts ten missions.
//
// Nothing in here loads over the network: every import is a file under
// game/, and three.js comes from the vendored import map in index.html.
//
// Performance note: the per-frame path allocates nothing. The input,
// police, mission, HUD and minimap payloads are plain objects created
// once and refilled every frame; the road network adapter is built once
// after the city exists. A frame that hands the garbage collector work
// is a frame that can stutter, so the hot loop stays allocation-free.

import * as THREE from 'three';
import {
  GAME_TITLE,
  MONEY,
  CITY,
  CAMERA,
  GAMEPLAY,
  MINIMAP,
  PLAYER,
} from './config.js';
import { clamp, createRng, formatMoney } from './utils.js';
import { buildCity } from './city.js';
import { createPlayer } from './player.js';
import { createVehicleSystem } from './vehicles.js';
import { createPedestrianSystem } from './pedestrians.js';
import { createPoliceSystem } from './police.js';
import { createCombatSystem } from './combat.js';
import { createMissionManager } from './missions.js';
import {
  loadSave,
  saveSave,
  updateSave,
  addCashToSave,
  hasSave,
  resetSave,
  createDefaultSave,
} from './save.js';
import { SolmarHud } from './hud.js';
import { AudioEngine } from './audio.js';
import { readShotParams, applyShotStaging } from './shots.js';
import { createWeatherSystem } from './weather.js';
import { createDistrictSystem } from './district.js';
import { createGarageSystem } from './customization.js';
import { createSideActivitySystem } from './sideactivities.js';
import { createArsenalSystem } from './arsenal.js';

// ---------------------------------------------------------------------------
// Small adapters between modules that describe the world differently.
// ---------------------------------------------------------------------------

// The city returns lanes as {start, end, points, dir, ...}; vehicles and
// pedestrians want lanes as {points: [{x,z}, ...], width}. Convert once,
// preferring the points the city already built.
function toPointLanes(world) {
  return (world.lanes || []).map((lane) => ({
    points: lane.points && lane.points.length >= 2
      ? lane.points
      : [
        { x: lane.start.x, z: lane.start.z },
        { x: lane.end.x, z: lane.end.z },
      ],
    width: CITY.roadWidth,
    axis: lane.axis,
    road: lane.road,
  }));
}

// The mission module names places (pier, alley, marina, chopShop, safehouse,
// rooftop, jumps) that the city knows under other keys. Translate them.
function buildMarkerLookup(world) {
  const markers = world.missionMarkers || {};
  const named = {
    garage: 'garage',
    pier: 'pier',
    alley: 'package',
    plaza: 'plaza',
    marina: 'showroom',
    chopShop: 'chop-shop',
    bank: 'bank',
    safehouse: 'hideout',
    hideout: 'hideout',
    rooftop: 'plaza',
    beach: 'beach',
    dropoff: 'dropoff',
    package: 'package',
    showroom: 'showroom',
    'chop-shop': 'chop-shop',
    policeStation: 'policeStation',
    // Round 8: the North Docks yard, built by city.js as its own
    // markers so the new missions and the side jobs can name them.
    docks: 'docks',
    warehouse: 'warehouse',
    craneYard: 'craneYard',
    gate: 'gate',
    cache: 'cache',
  };
  const jumpPoints = {
    jumpNorth: { x: 0, z: -215 },
    jumpSouth: { x: 0, z: 215 },
    jumpEast: { x: 215, z: 0 },
    jumpWest: { x: -215, z: 0 },
    jumpBeach: { x: -250, z: 60 },
    jumpMarina: { x: 180, z: 60 },
  };
  return {
    getMarkerPoint(name) {
      if (jumpPoints[name]) return { ...jumpPoints[name] };
      const key = named[name] || name;
      const found = markers[key];
      if (found) return { x: found.x, z: found.z };
      return { x: 0, z: 0 };
    },
  };
}

function roadPointNearRing(world, centre, minRadius, maxRadius, rng) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = minRadius + rng() * (maxRadius - minRadius);
    const point = world.nearestRoadPoint(
      centre.x + Math.sin(angle) * radius,
      centre.z + Math.cos(angle) * radius,
    );
    if (point) return { x: point.x, z: point.z };
  }
  const fallback = world.nearestRoadPoint(centre.x, centre.z);
  return fallback ? { x: fallback.x, z: fallback.z } : { x: centre.x, z: centre.z };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const root = document.getElementById('game-root');
const loadingNote = document.getElementById('loading-note');
const shotParams = readShotParams();
const isShotMode = shotParams !== null;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  if (loadingNote) {
    loadingNote.textContent = 'WebGL is not available in this browser — Solmar Bay needs it to run.';
  }
  throw err;
}
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
root.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  CAMERA.fov, window.innerWidth / window.innerHeight, CAMERA.near, CAMERA.cameraFar,
);
camera.position.set(20, 12, 34);

const world = buildCity(scene, {});
const pointLanes = toPointLanes(world);
const cityAdapter = {
  lanes: pointLanes,
  buildingColliders: world.colliders,
  carSpawns: world.carSpawns,
  bounds: world.bounds,
  playerSpawn: world.spawnPoints.playerStart,
};

// --- save: cash and progress are the save file's job, main just mirrors it.
let save = loadSave();
if (!hasSave()) {
  save.cash = MONEY.startCash;
  saveSave(save);
  save = loadSave();
}
let cash = save.cash;
let health = PLAYER.maxHealth;
let lastDamageAt = -Infinity;
let playSeconds = 0;
let clockMinutes = GAMEPLAY.startHour * 60 + GAMEPLAY.startMinute;

const hud = new SolmarHud(document);
const audio = new AudioEngine();
audio.setMuted(Boolean(save.settings && save.settings.muted));

// Stolen-car bookkeeping, declared before the vehicle system so its
// callback can close over them cleanly.
let lastStolenCar = null;
let lastStolenAt = -Infinity;
let lastStolenCarId = null;
let stolenTargetCar = false;

// --- the modules, wired together.
const player = createPlayer(scene, { city: cityAdapter });
const vehicles = createVehicleSystem(scene, cityAdapter, {
  player,
  onCarStolen: (car) => {
    police.reportCrime('carTheft', { vehicle: car.type });
    lastStolenCar = car;
    lastStolenAt = playSeconds;
    // A stable id, taken once at the moment of the theft: deriving it from
    // the car's position would mint a fresh id every frame as the car
    // drives away, and the mission payout would fire again and again.
    // In screenshot mode the staged car entries are not a real theft:
    // minting the id would pay the $100 fence reward a frame later and
    // toast "Stolen car sold on" over the wanted-level line, bumping the
    // staged cash the shot is meant to show. So the id is only minted
    // outside shot mode; the crime report and the notify still run.
    if (!isShotMode) {
      lastStolenCarId = 'stolen-' + car.type + '-'
        + Math.round(car.group.position.x) + '-' + Math.round(car.group.position.z);
    }
    if (missions) {
      const step = missions.getCurrentObjective();
      if (step && (step.missionId === 'hot-wheels' || step.missionId === 'the-getaway')) {
        stolenTargetCar = true;
      }
    }
    updateSave((s) => {
      s.stats.carsStolen = (s.stats.carsStolen || 0) + 1;
    });
    hud.notify('Car stolen — the heat is on', 3);
    audio.cash();
  },
});
player.bindVehicles(vehicles);

const pedestrians = createPedestrianSystem(scene, cityAdapter, { count: 26 });
// Combat needs a health number on each walker; give every pedestrian one.
for (const ped of pedestrians.pedestrians) {
  ped.health = 40;
  ped.alive = true;
}

const police = createPoliceSystem({
  scene,
  policeStation: world.spawnPoints.policeStation,
  onWantedChanged: (stars) => {
    if (stars > 0) hud.toast(`Wanted level ${stars} — lose the patrol cars`, 3);
    else hud.toast('You lost them — heat is off', 3);
  },
  onBusted: () => enterEndState('busted'),
  onWasted: () => enterEndState('wasted'),
  onRam: (amount, kind) => {
    vehicles.damagePlayerCar(amount);
    audio.noiseBurst(0.18, 0.3, 700);
    // A ram hurts Leo a little as well as his car, so the health bar
    // means something in a chase. A PIT is worse: it spins the car.
    const car = vehicles.playerCar;
    if (kind === 'pit' && car) {
      car.heading += (Math.random() < 0.5 ? -1 : 1) * 0.55;
      car.speed *= 0.5;
      hud.toast('PIT maneuver! The patrol spun your car', 2);
    }
    if (car) {
      health = Math.max(0, health - amount * 0.4);
      lastDamageAt = playSeconds;
    }
  },
});

const combat = createCombatSystem({
  scene,
  onCrime: (type, details) => {
    police.reportCrime(type, details || {});
  },
  onShot: (info) => {
    if (info && info.weapon === 'shotgun') {
      audio.shotgun();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 30, 'gunshot');
    } else if (info && info.weapon === 'pistol') {
      audio.shot();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 26, 'gunshot');
    } else if (info && info.weapon === 'smg') {
      audio.shot();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 26, 'gunshot');
    } else if (info && info.weapon === 'rifle') {
      audio.shotgun();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 40, 'gunshot');
    } else if (info && info.weapon === 'fists') {
      audio.punch();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 10, 'attack');
    } else if (info && info.weapon === 'bat') {
      audio.punch();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 10, 'attack');
    }
  },
  onReload: () => audio.reload(),
});

const markerCity = buildMarkerLookup(world);
const missions = createMissionManager({
  scene,
  city: markerCity,
  police: {
    setWanted: (n) => police.setWantedLevel(n),
    getWanted: () => police.getWantedLevel(),
  },
  save: { loadSave, updateSave, addCashToSave },
  onEvent: handleMissionEvent,
  onCash: (amount, reason) => {
    const updated = loadSave();
    cash = updated.cash;
    void reason;
  },
});

// --- Round 8 systems: weather, the docks, the garage, side jobs, arsenal.
// The shops never touch the cash balance directly: they spend through
// spendCash and earn through addCashToSave, so the save file is the one
// source of truth and the HUD mirror (cash) is reloaded after each one.
function getCash() { return cash; }
function spendCash(amount) {
  const price = Math.floor(amount || 0);
  if (price <= 0) return true;
  if (cash < price) return false;
  cash -= price;
  updateSave((s) => { s.cash = cash; });
  return true;
}
function earnCash(amount, reason) {
  // addCashToSave(save, amount) takes a save object, so the earning path
  // goes through updateSave directly: add the gain to the cash balance
  // and to lifetime earnings, then mirror the saved balance into the
  // HUD's cash variable.
  const gain = Math.max(0, Math.floor(amount || 0));
  if (gain <= 0) return;
  updateSave((s) => {
    s.cash = Math.min(999999999, (s.cash || 0) + gain);
    if (s.stats) s.stats.cashEarned = (s.stats.cashEarned || 0) + gain;
  });
  cash = loadSave().cash;
  void reason;
}

// The weather owns the sky and the rain; it reads the same clock main.js
// keeps for the HUD, so the sun never disagrees with the clock.
const weather = createWeatherSystem({ scene, lights: world.lights });
// The North Docks yard: containers, cranes, warehouse, yard hands and
// the smuggler's cache, all built once at boot.
const district = createDistrictSystem({ scene, world });
// The garage tunes whatever Leo is driving; the arsenal sells hardware
// out of the alley; both write their purchases into the save file.
const garage = createGarageSystem({
  vehicles,
  save: { loadSave, updateSave },
  hud,
  getCash,
  spendCash,
});
const arsenal = createArsenalSystem({
  combat,
  save: { loadSave, updateSave },
  hud,
  getCash,
  spendCash,
});
// Weapons Leo already owns from an earlier session unlock in the combat
// system at boot, so keys 4, 5 and 6 work from the first frame.
for (const weaponId of arsenal.getOwned()) {
  combat.unlockWeapon(weaponId);
}
// Side jobs — taxi fares, courier runs, street races, hidden packages —
// pay through the same earn path as the missions.
const side = createSideActivitySystem({
  scene,
  city: markerCity,
  save: { loadSave, updateSave },
  hud,
  onCash: earnCash,
});

// Gold cash-pickup discs in the world, driven by the mission manager.
const pickupMeshes = [];
{
  const pickupGeo = new THREE.CylinderGeometry(0.9, 0.9, 0.16, 20);
  const pickupMat = new THREE.MeshStandardMaterial({
    color: 0xffd23c, metalness: 0.7, roughness: 0.25,
    emissive: 0xaa7711, emissiveIntensity: 0.7,
  });
  for (const pickup of missions.getCashPickups()) {
    const mesh = new THREE.Mesh(pickupGeo, pickupMat);
    mesh.position.set(pickup.x, 1.0, pickup.z);
    mesh.castShadow = true;
    scene.add(mesh);
    pickupMeshes.push(mesh);
  }
}

// Cyan photo-spot discs: stand inside one and hold still for the shot.
const photoMeshes = [];
{
  const photoGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.1, 20);
  const photoMat = new THREE.MeshStandardMaterial({
    color: 0x4fd8e8, metalness: 0.4, roughness: 0.3,
    emissive: 0x1a7a8a, emissiveIntensity: 0.8, transparent: true, opacity: 0.85,
  });
  for (const spot of missions.getPhotoSpots()) {
    const mesh = new THREE.Mesh(photoGeo, photoMat);
    mesh.position.set(spot.x, 1.0, spot.z);
    mesh.castShadow = false;
    scene.add(mesh);
    photoMeshes.push(mesh);
  }
}

// Stunt jump spots, resolved once: the loop checks the player's car
// against them every frame and pays out through the mission manager.
const jumpSpots = missions.stuntJumps.map((jump) => {
  const point = markerCity.getMarkerPoint(jump.point);
  return { name: jump.name, x: point.x, z: point.z };
});

vehicles.spawnParked(10);
vehicles.spawnTraffic(12);
vehicles.spawnBikes(5);

// ---------------------------------------------------------------------------
// Reused per-frame payloads (created once, refilled every frame — see the
// performance note at the top of the file). Nothing below is allocated
// inside stepGame.
// ---------------------------------------------------------------------------

const rng = createRng(20261117);

// The road network adapter the police module wants, built once: it closes
// over the world and the rng, both of which never change after boot. The
// nearest-road lookup accepts either a point object or an (x, z) pair,
// since the police module calls it both ways.
const roadNetwork = {
  nearestRoadPoint: (x, z) => {
    if (typeof x === 'object' && x !== null) return world.nearestRoadPoint(x.x, x.z);
    return world.nearestRoadPoint(x, z);
  },
  randomRoadPointNear: (pos, minR, maxR) =>
    roadPointNearRing(world, pos, minR, maxR, rng.next.bind(rng)),
};

const input = {
  forward: false,
  back: false,
  left: false,
  right: false,
  run: false,
  brake: false,
  handbrake: false,
  enterPressed: false,
  stealPressed: false,
  lookDX: 0,
  lookDY: 0,
};

const policeCtx = {
  playerPosition: null,
  playerInCar: false,
  playerHealth: 100,
  playerCarHealth: null,
  playerCar: null,
  playerCarPosition: null,
  playerCarHeading: 0,
  playerHeading: 0,
  roadNetwork,
  policeStation: world.spawnPoints.policeStation,
};

const missionCtx = {
  playerPos: null,
  inVehicle: false,
  carryingTargetCar: false,
  stolenTargetCar: false,
  stolenCarId: undefined,
  stolenCarModel: undefined,
  stuntJump: undefined,
  speed: 0,
  busted: false,
  wasted: false,
};

const hudSnapshot = {
  health: 100,
  stamina: 100,
  heat: 0,
  cash: 0,
  stars: 0,
  speedMps: 0,
  weaponName: 'fists',
  ammoInMag: 0,
  ammoReserve: 0,
  reloading: false,
  clockHour: 0,
  clockMinute: 0,
  objective: null,
  prompt: '',
  driving: false,
  aiming: false,
  // Round 8: the weather label, whether it is night, the active side
  // job (or null), and whether Leo is standing by the garage or the
  // alley shop — the HUD reads these to draw its weather line and the
  // side-job timer.
  weatherName: 'Clear',
  isNight: false,
  sideActive: null,
  sideStats: null,
  garageNear: false,
  arsenalNear: false,
};

const minimapData = {
  playerX: 0,
  playerZ: 0,
  playerHeading: 0,
  driving: false,
  traffic: [],
  police: null,
  marker: null,
  pickups: null,
  photoSpots: null,
  roads: world.roadSegments,
  worldRadius: MINIMAP.worldRadius,
};
const minimapPointPool = [];

// Refill the minimap traffic list in place, reusing point objects.
function fillMinimapTraffic() {
  const list = minimapData.traffic;
  list.length = 0;
  let n = 0;
  const pushPoint = (x, z) => {
    let point = minimapPointPool[n];
    if (!point) {
      point = { x: 0, z: 0 };
      minimapPointPool[n] = point;
    }
    point.x = x;
    point.z = z;
    list.push(point);
    n += 1;
  };
  for (const car of vehicles.traffic) {
    pushPoint(car.group.position.x, car.group.position.z);
  }
  // Motorbikes are traffic too: they read as grey dots like the cars.
  for (const bike of vehicles.bikes) {
    pushPoint(bike.group.position.x, bike.group.position.z);
  }
}

const threats = [];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = {};
let lookDX = 0;
let lookDY = 0;
let mouseDown = false;
let pointerLocked = false;
let enterPressed = false;
let stealPressed = false;

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space',
  'KeyE', 'KeyF', 'KeyR', 'KeyM', 'KeyP', 'Escape', 'Digit1', 'Digit2', 'Digit3',
  // Round 8: garage (G), arsenal (B), taxi fare (T), courier run (C),
  // and the three new weapons (4 SMG, 5 rifle, 6 bat).
  'KeyG', 'KeyB', 'KeyT', 'KeyC', 'Digit4', 'Digit5', 'Digit6',
]);

window.addEventListener('keydown', (event) => {
  if (GAME_KEYS.has(event.code)) event.preventDefault();
  if (event.repeat) return;
  keys[event.code] = true;
  if (event.code === 'KeyE') enterPressed = true;
  if (event.code === 'KeyF') stealPressed = true;
  if (event.code === 'KeyM') toggleMute();
  if (event.code === 'KeyR' && state === 'playing') combat.reload();
  if (event.code === 'Digit1' && state === 'playing') combat.equipWeapon('fists');
  if (event.code === 'Digit2' && state === 'playing') combat.equipWeapon('pistol');
  if (event.code === 'Digit3' && state === 'playing') combat.equipWeapon('shotgun');
  // Round 8 weapons: the SMG and the rifle need to be bought at the
  // alley arsenal first; the combat system refuses a weapon Leo does
  // not own, so pressing 4 on a fresh save is a no-op, not a bug.
  if (event.code === 'Digit4' && state === 'playing') combat.equipWeapon('smg');
  if (event.code === 'Digit5' && state === 'playing') combat.equipWeapon('rifle');
  if (event.code === 'Digit6' && state === 'playing') combat.equipWeapon('bat');
  if (event.code === 'KeyG' && state === 'playing') toggleGarage();
  if (event.code === 'KeyB' && state === 'playing') toggleArsenal();
  if (event.code === 'KeyT' && state === 'playing') tryTaxiFare();
  if (event.code === 'KeyC' && state === 'playing') tryCourierRun();
  if (event.code === 'KeyP') togglePhone();
  if (event.code === 'Escape') togglePause();
  audio.ensure();
});
window.addEventListener('keyup', (event) => {
  keys[event.code] = false;
});
window.addEventListener('blur', () => {
  for (const code of Object.keys(keys)) keys[code] = false;
  mouseDown = false;
});

renderer.domElement.addEventListener('click', () => {
  if (state !== 'playing') return;
  audio.ensure();
  if (!pointerLocked && renderer.domElement.requestPointerLock) {
    try {
      const p = renderer.domElement.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* pointer lock is a nicety, not a requirement */ }
  }
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', (event) => {
  if (!pointerLocked) return;
  lookDX += event.movementX || 0;
  lookDY += event.movementY || 0;
});
renderer.domElement.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  mouseDown = true;
  if (state === 'playing') tryShoot();
});
window.addEventListener('mouseup', (event) => {
  if (event.button === 0) mouseDown = false;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

let state = 'menu';
let menuOrbit = 0;
let endKind = null;
let shotFramesRendered = 0;
let shotStaged = false;
let shotCameraMode = null; // set by shots.js staging ('chase' = reverse angle)

function showOverlay(id) {
  for (const name of ['menu-overlay', 'pause-overlay', 'phone-overlay', 'end-overlay']) {
    const el = document.getElementById(name);
    if (el) el.classList.toggle('hidden', name !== id);
  }
  if (!id) {
    for (const name of ['menu-overlay', 'pause-overlay', 'phone-overlay', 'end-overlay']) {
      const el = document.getElementById(name);
      if (el) el.classList.add('hidden');
    }
  }
}

function startPlaying() {
  state = 'playing';
  showOverlay(null);
  hud.show();
  audio.ensure();
  audio.startMusic();
  if (loadingNote) loadingNote.style.display = 'none';
}

function togglePause() {
  if (state === 'playing') {
    state = 'paused';
    showOverlay('pause-overlay');
    saveProgress();
  } else if (state === 'paused') {
    startPlaying();
  }
}

function togglePhone() {
  if (state === 'playing') {
    state = 'phone';
    buildPhoneList();
    showOverlay('phone-overlay');
  } else if (state === 'phone') {
    startPlaying();
  }
}

// --- Round 8 shop and side-job toggles -------------------------------------
// The garage and the arsenal are proximity shops: G and B only open them
// when Leo is standing by the marker, and the prompt line (currentPrompt)
// tells him so. The shops are overlays, not game states, so the city
// keeps running behind them — Leo can be robbed while he shops, the
// same as in life.
function toggleGarage() {
  if (garage.isOpen()) {
    garage.setOpen(false);
    return;
  }
  const pos = player.group.position;
  if (garage.isNearGarage(pos)) {
    garage.setOpen(true);
    audio.click();
  } else {
    hud.toast('The garage is on the west side — drive to the marker there', 3);
  }
}

function toggleArsenal() {
  if (arsenal.isOpen()) {
    arsenal.setOpen(false);
    return;
  }
  const pos = player.group.position;
  if (arsenal.isNearShop(pos)) {
    arsenal.setOpen(true);
    audio.click();
  } else {
    hud.toast('The arsenal is down the alley — find the fence there', 3);
  }
}

function tryTaxiFare() {
  const pos = player.group.position;
  if (!player.inVehicle) {
    hud.toast('Fares need wheels — get in a car first', 2);
    return;
  }
  if (side.isNearTaxiStand(pos)) {
    side.startTaxi(pos);
  } else {
    hud.toast('Taxi stand is at the plaza — drive there to pick up a fare', 3);
  }
}

function tryCourierRun() {
  const pos = player.group.position;
  if (side.isNearCourierDepot(pos)) {
    side.startCourier(pos);
  } else {
    hud.toast('Courier depot is at the garage — head there to pick up a parcel', 3);
  }
}

function toggleMute() {
  const muted = audio.setMuted(!audio.isMuted());
  updateSave((s) => { s.settings.muted = muted; });
  hud.toast(muted ? 'Sound muted (M)' : 'Sound on (M)', 2);
}

function enterEndState(kind) {
  if (state === 'busted' || state === 'wasted') return;
  endKind = kind;
  state = kind;
  police.clearWanted();
  const titleEl = document.getElementById('end-title');
  const textEl = document.getElementById('end-text');
  if (kind === 'busted') {
    const fine = Math.min(cash, Math.max(50, Math.floor(cash * 0.1)));
    cash = Math.max(0, cash - fine);
    updateSave((s) => {
      s.cash = cash;
      s.stats.timesBusted = (s.stats.timesBusted || 0) + 1;
    });
    if (titleEl) titleEl.textContent = 'Busted';
    if (textEl) {
      textEl.textContent = `The patrol caught up with Leo outside the station. `
        + `He posted bail of ${formatMoney(fine)} and walked out with ${formatMoney(cash)}. `
        + `The crew is not impressed — but the bay is still his.`;
    }
    audio.busted();
  } else {
    const lost = Math.min(cash, Math.max(25, Math.floor(cash * 0.05)));
    cash = Math.max(0, cash - lost);
    updateSave((s) => {
      s.cash = cash;
      s.stats.timesWasted = (s.stats.timesWasted || 0) + 1;
    });
    if (titleEl) titleEl.textContent = 'Wasted';
    if (textEl) {
      textEl.textContent = `Leo went down in the streets of Marisol Bay. A friend dragged him `
        + `clear and patched him up — ${formatMoney(lost)} lighter, but alive. `
        + `The crew still needs a driver.`;
    }
    audio.wasted();
  }
  health = PLAYER.maxHealth;
  if (vehicles.isPlayerDriving()) {
    try { vehicles.exitPlayerVehicle(); } catch { /* already out */ }
  }
  player.setPosition(
    world.spawnPoints.playerStart.x, world.spawnPoints.playerStart.z,
    world.spawnPoints.playerStart.heading,
  );
  saveProgress();
  showOverlay('end-overlay');
}

function showMissionComplete(missionId, title, reward) {
  void missionId;
  endKind = 'complete';
  state = 'complete';
  const titleEl = document.getElementById('end-title');
  const textEl = document.getElementById('end-text');
  if (titleEl) titleEl.textContent = `Mission Complete: ${title}`;
  if (textEl) {
    textEl.textContent = `The crew pays out ${formatMoney(reward)}. `
      + `Cash now ${formatMoney(cash)} — check the phone (P) for the next job.`;
  }
  audio.jingle();
  showOverlay('end-overlay');
}

function handleMissionEvent(event) {
  if (!event) return;
  if (event.type === 'missionComplete') {
    cash = typeof event.newCashTotal === 'number' ? event.newCashTotal : cash + event.reward;
    saveProgress();
    showMissionComplete(event.missionId, event.title, event.reward);
  } else if (event.type === 'missionStarted') {
    hud.notify(event.briefing || event.title, 6);
    audio.cash();
  } else if (event.type === 'missionFailed') {
    hud.toast(`Mission failed — ${event.reason}. Retry it from the phone (P).`, 5);
    audio.denied();
  } else if (event.type === 'stepComplete') {
    hud.toast('Objective complete', 2);
    audio.pickup();
  } else if (event.type === 'pickup') {
    hud.toast(`Picked up ${formatMoney(event.amount)}`, 2);
    audio.pickup();
  } else if (event.type === 'stunt') {
    hud.toast(`Stunt jump! +${formatMoney(event.amount)}`, 3);
    audio.cash();
  } else if (event.type === 'photo') {
    hud.toast(`Sunset photo sold — +${formatMoney(event.amount)}`, 3);
    audio.cash();
  } else if (event.type === 'carStolen') {
    hud.toast(`Stolen car sold on — +${formatMoney(event.amount)}`, 3);
  } else if (event.type === 'warning') {
    hud.toast(event.text, 4);
  } else if (event.type === 'missionUnlocked') {
    hud.toast(`New job unlocked: ${event.title}`, 4);
  }
}

function saveProgress() {
  updateSave((s) => {
    s.cash = cash;
    s.stats.playSeconds = Math.floor(playSeconds);
    s.best.cash = Math.max(s.best.cash || 0, cash);
    s.best.missionsCompleted = Math.max(
      s.best.missionsCompleted || 0, missions.getCompletedIds().length,
    );
  });
}

// --- menu buttons -----------------------------------------------------------
const btnContinue = document.getElementById('btn-continue');
const btnNewGame = document.getElementById('btn-new-game');
const menuSaveNote = document.getElementById('menu-save-note');
if (menuSaveNote) {
  if (hasSave() && (save.missionsCompleted.length > 0 || save.cash > 0)) {
    menuSaveNote.textContent =
      `Save found: ${formatMoney(save.cash)}, ${save.missionsCompleted.length} of 10 missions done.`;
  } else {
    menuSaveNote.textContent = 'No save yet — a fresh story starts with $120 in Leo’s pocket.';
  }
}
if (btnContinue) {
  btnContinue.addEventListener('click', () => { audio.ensure(); audio.click(); startPlaying(); });
}
if (btnNewGame) {
  btnNewGame.addEventListener('click', () => {
    resetSave();
    window.location.reload();
  });
}
const btnResume = document.getElementById('btn-resume');
if (btnResume) btnResume.addEventListener('click', () => startPlaying());
const btnQuit = document.getElementById('btn-quit-to-menu');
if (btnQuit) {
  btnQuit.addEventListener('click', () => {
    saveProgress();
    state = 'menu';
    showOverlay('menu-overlay');
    hud.hide();
  });
}
const btnClosePhone = document.getElementById('btn-close-phone');
if (btnClosePhone) btnClosePhone.addEventListener('click', () => startPlaying());
const btnEndContinue = document.getElementById('btn-end-continue');
if (btnEndContinue) {
  btnEndContinue.addEventListener('click', () => {
    endKind = null;
    startPlaying();
  });
}

// --- phone mission list -----------------------------------------------------
function buildPhoneList() {
  const listEl = document.getElementById('phone-list');
  const cashEl = document.getElementById('phone-cash');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (cashEl) cashEl.textContent = `Cash: ${formatMoney(cash)}`;
  for (const mission of missions.getMissionList()) {
    const row = document.createElement('button');
    row.className = 'mission-row';
    const status = mission.status;
    const statusLabel = status === 'completed' ? 'Done'
      : status === 'active' ? 'Active'
      : status === 'failed' ? 'Failed — retry'
      : status === 'available' ? 'Available' : 'Locked';
    row.innerHTML =
      `<span><span class="m-title">${mission.title}</span>` +
      `<span class="m-brief" style="display:block">${mission.briefing}</span></span>` +
      `<span class="m-status ${status === 'completed' ? 'done' : status === 'active' ? 'active' : ''}">${statusLabel}</span>` +
      `<span class="m-reward">${formatMoney(mission.reward)}</span>`;
    if (status === 'available') {
      row.addEventListener('click', () => {
        if (missions.startMission(mission.id)) {
          audio.click();
          startPlaying();
        }
      });
    } else if (status === 'failed') {
      row.addEventListener('click', () => {
        if (missions.retryMission(mission.id)) {
          audio.click();
          startPlaying();
        }
      });
    } else {
      row.disabled = true;
    }
    listEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Combat input: aim from the camera, shoot the nearest thing in the way.
// ---------------------------------------------------------------------------

function buildCombatTargets() {
  const targets = [];
  pedestrians.pedestrians.forEach((ped, index) => {
    if (ped.alive === false) return;
    targets.push({
      id: 'ped-' + index,
      kind: 'pedestrian',
      position: ped.group.position,
      radius: 0.6,
      health: ped.health,
      alive: ped.alive !== false,
      takeDamage: (amount) => {
        ped.health = Math.max(0, (ped.health || 0) - amount);
        if (ped.health <= 0) {
          ped.alive = false;
          scene.remove(ped.group);
        }
        return ped.health;
      },
    });
  });
  for (const unit of police.getUnits()) {
    targets.push({
      id: 'police-' + unit.id,
      kind: 'police',
      isPolice: true,
      position: unit.group.position,
      radius: unit.kind === 'car' ? 1.6 : 0.6,
      health: unit.health,
      alive: unit.alive,
      takeDamage: (amount) => {
        const died = police.damageUnit(unit, amount);
        if (died) police.reportCrime('killPolice', { unitId: unit.id });
        return unit.health;
      },
    });
  }
  for (const car of vehicles.cars) {
    if (car.isPlayer || car.destroyed) continue;
    targets.push({
      id: 'car-' + vehicles.cars.indexOf(car),
      kind: 'vehicle',
      position: car.group.position,
      radius: 1.5,
      health: car.health,
      alive: !car.destroyed,
      takeDamage: (amount) => {
        car.damage(amount);
        return car.health;
      },
    });
  }
  return targets;
}

function tryShoot() {
  if (state !== 'playing' || player.inVehicle) return;
  const origin = player.group.position.clone();
  origin.y += 1.5;
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  const facing = new THREE.Vector3(-Math.sin(player.heading), 0, -Math.cos(player.heading));
  const targets = buildCombatTargets();
  const weapon = combat.getWeapon();
  if (weapon === 'pistol' || weapon === 'shotgun' || weapon === 'smg' || weapon === 'rifle') {
    combat.shoot(origin, direction, targets);
  } else {
    // Fists and the bat are both melee: the combat system reads the
    // current weapon's damage and range for the swing.
    combat.punch(origin, facing, targets);
  }
}

// ---------------------------------------------------------------------------
// Driving camera + per-frame update
// ---------------------------------------------------------------------------

const cameraTarget = new THREE.Vector3();
const cameraDesired = new THREE.Vector3();

function updateDrivingCamera(dt) {
  const car = vehicles.playerCar;
  if (!car) return;
  const fwdX = -Math.sin(car.heading);
  const fwdZ = -Math.cos(car.heading);
  const rightX = Math.cos(car.heading);
  const rightZ = -Math.sin(car.heading);
  if (shotCameraMode === 'chase') {
    // Reverse angle for the staged chase: the camera sits ahead of Leo's
    // car and looks back down the road, so the patrol cars behind him are
    // in the frame instead of hidden behind the camera.
    cameraDesired.set(
      car.group.position.x + fwdX * 14 + rightX * 4,
      CAMERA.drivingHeight,
      car.group.position.z + fwdZ * 14 + rightZ * 4,
    );
    camera.position.lerp(cameraDesired, Math.min(1, dt * 5));
    cameraTarget.set(
      car.group.position.x - fwdX * 10,
      1.6,
      car.group.position.z - fwdZ * 10,
    );
    camera.lookAt(cameraTarget);
    return;
  }
  if (shotCameraMode === 'chase-wide') {
    // Same reverse angle, pulled back and up: the whole patrol pack,
    // bike included, reads in one frame. Round 6 pulled it in closer
    // (11 m ahead, 6.2 m up, looking 9 m back): the old 22 m pull-back
    // left the pack as three distant dots and Leo's car as a small box.
    cameraDesired.set(
      car.group.position.x + fwdX * 11 + rightX * 3,
      6.2,
      car.group.position.z + fwdZ * 11 + rightZ * 3,
    );
    camera.position.lerp(cameraDesired, Math.min(1, dt * 5));
    cameraTarget.set(
      car.group.position.x - fwdX * 9,
      1.6,
      car.group.position.z - fwdZ * 9,
    );
    camera.lookAt(cameraTarget);
    return;
  }
  if (shotCameraMode === 'drive-side') {
    // Side profile: the camera sits off Leo's right flank and looks
    // forward past him, so the supercar's shape and the road ahead —
    // including the oncoming bike — share the frame. Round 6 first tried
    // a tighter angle (8 m out, 4.2 m up, 10 m ahead), but that pulled a
    // parked car's roof into the bottom edge of the frame, so the
    // original wider angle stays: 10 m out, 4.5 m up, 14 m ahead.
    cameraDesired.set(
      car.group.position.x - fwdX * 6 + rightX * 10,
      4.5,
      car.group.position.z - fwdZ * 6 + rightZ * 10,
    );
    camera.position.lerp(cameraDesired, Math.min(1, dt * 5));
    cameraTarget.set(
      car.group.position.x + fwdX * 14,
      1.4,
      car.group.position.z + fwdZ * 14,
    );
    camera.lookAt(cameraTarget);
    return;
  }
  // Normal chase camera: the distance eases closer as the car slows, so
  // parking and tight corners feel close in while speed feels open.
  const speedFactor = clamp(Math.abs(car.speed) / 34, 0, 1);
  const distance = CAMERA.drivingDistance * (CAMERA.closeDistanceFactor + CAMERA.farDistanceFactor * speedFactor);
  cameraDesired.set(
    car.group.position.x - fwdX * distance,
    CAMERA.drivingHeight,
    car.group.position.z - fwdZ * distance,
  );
  camera.position.lerp(cameraDesired, Math.min(1, dt * 5));
  cameraTarget.set(
    car.group.position.x + fwdX * CAMERA.lookAhead,
    1.6,
    car.group.position.z + fwdZ * CAMERA.lookAhead,
  );
  camera.lookAt(cameraTarget);
}

function currentPrompt() {
  if (state !== 'playing') return '';
  const pos = player.group.position;
  // Driving: the only prompt that matters on the road is a fare waiting
  // at the plaza. Everything else needs Leo on foot.
  if (player.inVehicle) {
    if (side.isNearTaxiStand(pos)) return '<b>T</b> Pick up a taxi fare at the plaza';
    return '';
  }
  const car = vehicles.nearestEnterableVehicle(pos, PLAYER.enterCarRange);
  if (car) return '<b>E</b> Enter car &nbsp;·&nbsp; <b>F</b> Steal it';
  // Round 8 shops and depots, in the order a player walks past them.
  if (garage.isNearGarage(pos)) return '<b>G</b> Garage — tune your ride';
  if (arsenal.isNearShop(pos)) return '<b>B</b> Alley arsenal — buy weapons';
  if (side.isNearCourierDepot(pos)) return '<b>C</b> Courier run — pick up a parcel';
  const objective = missions.getCurrentObjective();
  if (objective.missionId) {
    const marker = missions.getMarkerTarget();
    if (marker.active) {
      const dx = pos.x - marker.x;
      const dz = pos.z - marker.z;
      if (Math.hypot(dx, dz) < 4) return 'Stand in the marker to work the job';
    }
  }
  return '';
}

// A stunt jump pays when the player's car crosses a jump point at speed.
// The mission manager enforces the speed floor and the per-jump cooldown.
function detectStuntJump(playerCar) {
  if (!playerCar || Math.abs(playerCar.speed) < 24) return null;
  const pos = playerCar.group.position;
  for (const jump of jumpSpots) {
    const dx = pos.x - jump.x;
    const dz = pos.z - jump.z;
    if (dx * dx + dz * dz < 36) return jump.name;
  }
  return null;
}

function stepGame(dt) {
  playSeconds += dt;
  clockMinutes += dt / 6; // one game minute every six real seconds
  const hour = Math.floor(clockMinutes / 60) % 24;
  const minute = Math.floor(clockMinutes % 60);

  // Refill the shared input object (no fresh object per frame). Shift is
  // run on foot and the sport-car boost while driving.
  input.forward = Boolean(keys.KeyW);
  input.back = Boolean(keys.KeyS);
  input.left = Boolean(keys.KeyA);
  input.right = Boolean(keys.KeyD);
  input.run = Boolean(keys.ShiftLeft || keys.ShiftRight);
  input.brake = Boolean(keys.Space);
  input.handbrake = Boolean(keys.Space);
  input.enterPressed = enterPressed;
  input.stealPressed = stealPressed;
  input.lookDX = lookDX;
  input.lookDY = lookDY;

  // Player on foot (camera handled inside when on foot).
  player.update(dt, input, camera);
  // The E press is spent by player.update (enter or exit). Clear it before
  // the vehicle system runs, or the same press would exit the car it just
  // entered — entering and leaving in a single frame.
  input.enterPressed = false;
  if (stealPressed && !player.inVehicle) {
    const stolen = vehicles.trySteal(player.group.position);
    if (!stolen) {
      // Nothing in reach: F does nothing rather than erroring.
    }
  }
  // Driving: the vehicle system moves the car, main moves the camera.
  vehicles.update(dt, input);
  if (player.inVehicle) updateDrivingCamera(dt);

  // Wanted level, pursuit, busted / wasted.
  const playerCar = vehicles.playerCar;
  policeCtx.playerPosition = player.group.position;
  policeCtx.playerInCar = player.inVehicle;
  policeCtx.playerHealth = health;
  policeCtx.playerCarHealth = playerCar ? playerCar.health : null;
  policeCtx.playerCar = playerCar;
  policeCtx.playerCarPosition = playerCar ? playerCar.group.position : null;
  policeCtx.playerCarHeading = playerCar ? playerCar.heading : player.heading;
  policeCtx.playerHeading = player.heading;
  const policeEvents = police.update(dt, policeCtx);
  if (policeEvents.busted) enterEndState('busted');
  if (policeEvents.wasted) enterEndState('wasted');

  // Health regen after a quiet spell.
  if (playSeconds - lastDamageAt > 8 && health > 0 && health < PLAYER.maxHealth) {
    health = Math.min(PLAYER.maxHealth, health + 6 * dt);
  }

  // Combat timers (cooldowns, reloads, tracers).
  combat.update(dt);

  // Missions: objectives, markers, pickups, steals, stunts.
  const stuntJump = detectStuntJump(playerCar);
  missionCtx.playerPos = player.group.position;
  missionCtx.inVehicle = player.inVehicle;
  missionCtx.carryingTargetCar = Boolean(lastStolenCar && player.inVehicle);
  missionCtx.stolenTargetCar = stolenTargetCar;
  missionCtx.stolenCarId = lastStolenCarId && playSeconds - lastStolenAt < 0.5
    ? lastStolenCarId
    : undefined;
  missionCtx.stolenCarModel = lastStolenCar ? lastStolenCar.type : undefined;
  missionCtx.stuntJump = stuntJump || undefined;
  missionCtx.speed = playerCar ? Math.abs(playerCar.speed) : 0;
  missionCtx.busted = state === 'busted';
  missionCtx.wasted = state === 'wasted';
  const missionEvents = missions.update(dt, missionCtx);
  for (const event of missionEvents) handleMissionEvent(event);
  stolenTargetCar = false;

  // Pedestrians walk the sidewalks and flee from danger.
  threats.length = 0;
  if (player.inVehicle && playerCar && Math.abs(playerCar.speed) > 14) {
    threats.push({ x: player.group.position.x, z: player.group.position.z, radius: 12 });
  }
  pedestrians.update(dt, threats);

  // Cash pickup discs spin and bob; collected ones hide until they respawn.
  const pickups = missions.getCashPickups();
  for (let i = 0; i < pickupMeshes.length && i < pickups.length; i += 1) {
    const mesh = pickupMeshes[i];
    mesh.visible = pickups[i].available;
    if (mesh.visible) {
      mesh.rotation.y += dt * 2;
      mesh.position.y = 1.0 + Math.sin(playSeconds * 2 + i) * 0.15;
    }
  }
  // Photo spot discs spin slowly; cooling-down spots dim until ready.
  const spots = missions.getPhotoSpots();
  for (let i = 0; i < photoMeshes.length && i < spots.length; i += 1) {
    const mesh = photoMeshes[i];
    mesh.rotation.y += dt * 0.8;
    mesh.material.opacity = spots[i].ready ? 0.85 : 0.25;
  }

  world.update(dt, playSeconds);

  // Round 8 systems, on the same clock as the HUD: the weather reads
  // main's clock (one game minute every six real seconds) so the sun
  // never disagrees with the clock, the grip it returns goes straight
  // into the vehicle system, and the docks, garage, side jobs and
  // arsenal all watch Leo's position every frame.
  weather.update(dt, { hour, minute });
  vehicles.setWeatherGrip(weather.getGripFactor());
  district.update(dt, { night: weather.isNight() });
  garage.update(dt, { playerPos: player.group.position });
  side.update(dt, {
    playerPos: player.group.position,
    inVehicle: player.inVehicle,
    speed: playerCar ? Math.abs(playerCar.speed) : 0,
  });
  arsenal.update(dt, { playerPos: player.group.position });

  // HUD + minimap + sound, from one snapshot.
  const objective = missions.getCurrentObjective();
  const ammo = combat.getAmmo();
  hudSnapshot.health = health;
  hudSnapshot.stamina = player.stamina;
  hudSnapshot.heat = police.getHeat();
  hudSnapshot.cash = cash;
  hudSnapshot.stars = police.getWantedLevel();
  hudSnapshot.speedMps = playerCar ? playerCar.speed : player.speed;
  hudSnapshot.weaponName = combat.getWeapon();
  hudSnapshot.ammoInMag = ammo.inMagazine;
  hudSnapshot.ammoReserve = ammo.reserve;
  hudSnapshot.reloading = ammo.reloading;
  hudSnapshot.clockHour = hour;
  hudSnapshot.clockMinute = minute;
  hudSnapshot.objective = objective;
  hudSnapshot.prompt = currentPrompt();
  hudSnapshot.driving = player.inVehicle;
  hudSnapshot.aiming = !player.inVehicle && (combat.getWeapon() === 'pistol' || combat.getWeapon() === 'shotgun' || combat.getWeapon() === 'smg' || combat.getWeapon() === 'rifle');
  hudSnapshot.weatherName = weather.getWeatherName();
  hudSnapshot.isNight = weather.isNight();
  hudSnapshot.sideActive = side.getActive();
  hudSnapshot.sideStats = side.getState().stats;
  hudSnapshot.garageNear = garage.isNearGarage(player.group.position);
  hudSnapshot.arsenalNear = arsenal.isNearShop(player.group.position);
  hud.update(hudSnapshot, dt);
  fillMinimapTraffic();
  minimapData.playerX = player.group.position.x;
  minimapData.playerZ = player.group.position.z;
  minimapData.playerHeading = player.inVehicle && playerCar ? playerCar.heading : player.heading;
  minimapData.driving = player.inVehicle;
  minimapData.police = police.getBlips();
  minimapData.marker = missions.getMarkerTarget();
  minimapData.pickups = pickups;
  minimapData.photoSpots = missions.getPhotoSpots();
  hud.drawMinimap(minimapData, dt);
  const speed01 = playerCar ? Math.abs(playerCar.speed) / 34 : 0;
  audio.update(speed01, player.inVehicle, police.getWantedLevel());

  // Edge-triggered inputs are consumed once per frame.
  enterPressed = false;
  stealPressed = false;
  lookDX = 0;
  lookDY = 0;

  // Autosave every 20 seconds of play.
  if (Math.floor(playSeconds) % 20 === 0 && Math.floor(playSeconds - dt) % 20 !== 0) {
    saveProgress();
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state === 'menu') {
    // Slow orbit over the plaza behind the title screen.
    menuOrbit += dt * 0.05;
    camera.position.set(
      30 + Math.sin(menuOrbit) * 42, 26, 30 + Math.cos(menuOrbit) * 42,
    );
    camera.lookAt(30, 2, 30);
    world.update(dt, playSeconds);
    pedestrians.update(dt, []);
    vehicles.update(dt, {});
    renderer.render(scene, camera);
    return;
  }

  if (state === 'playing') {
    stepGame(dt);
  }

  renderer.render(scene, camera);

  // Deterministic screenshot mode: stage once, render a few frames, signal.
  if (isShotMode && !shotStaged) {
    shotStaged = true;
    const shotCtx = {
      player,
      vehicles,
      pedestrians,
      police,
      combat,
      missions,
      world,
      cameraMode: null,
      setCash: (amount) => {
        cash = amount;
        // Keep the save in step so later mission cash events add on top
        // of the staged amount instead of overwriting it with stale save.
        updateSave((s) => { s.cash = amount; });
      },
      startMissionSafe: (id) => missions.startMission(id),
    };
    applyShotStaging(shotCtx, shotParams.name, shotParams.seed, shotParams.cam);
    shotCameraMode = shotCtx.cameraMode || null;
    hud.show();
  }
  if (isShotMode && shotStaged) {
    shotFramesRendered += 1;
    if (shotFramesRendered >= 4 && !window.__shotReady) {
      window.__shotReady = true;
    }
  }
}

window.addEventListener('beforeunload', () => {
  if (state === 'playing' || state === 'paused') saveProgress();
});

// Shot mode skips the menu entirely: the staged scene is the game.
if (isShotMode) {
  if (loadingNote) loadingNote.style.display = 'none';
  state = 'playing';
  showOverlay(null);
  hud.show();
  try { audio.ensure(); } catch { /* headless audio is optional */ }
} else {
  showOverlay('menu-overlay');
}

window.__solmarReady = true;
window.__solmar = {
  get state() { return state; },
  get cash() { return cash; },
  get health() { return health; },
  get wanted() { return police.getWantedLevel(); },
  player,
  vehicles,
  police,
  missions,
  // Round 8 systems, exposed for the headless playtests and the
  // staged screenshots: weather, the docks, the garage, the side jobs
  // and the arsenal all answer getState().
  weather,
  district,
  garage,
  side,
  arsenal,
};
animate();

export { GAME_TITLE };
