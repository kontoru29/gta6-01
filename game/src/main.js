// main.js — Solmar Bay bootstrap, game loop and state machine.
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

// ---------------------------------------------------------------------------
// Small adapters between modules that describe the world differently.
// ---------------------------------------------------------------------------

// The city returns lanes as {start, end, dir, ...}; vehicles and
// pedestrians want lanes as {points: [{x,z}, ...], width}. Convert once.
function toPointLanes(world) {
  return (world.lanes || []).map((lane) => ({
    points: [
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
    pier: 'dropoff',
    alley: 'package',
    plaza: 'plaza',
    marina: 'showroom',
    chopShop: 'chop-shop',
    bank: 'bank',
    safehouse: 'hideout',
    rooftop: 'plaza',
    beach: 'beach',
    dropoff: 'dropoff',
    package: 'package',
    showroom: 'showroom',
    'chop-shop': 'chop-shop',
    hideout: 'hideout',
    policeStation: 'policeStation',
  };
  const jumpPoints = {
    jumpNorth: { x: 0, z: -180 },
    jumpSouth: { x: 0, z: 180 },
    jumpEast: { x: 180, z: 0 },
    jumpWest: { x: -180, z: 0 },
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
    lastStolenCarId = 'stolen-' + car.type + '-'
      + Math.round(car.group.position.x) + '-' + Math.round(car.group.position.z);
    if (missions) {
      const step = missions.getCurrentObjective();
      if (step && step.missionId === 'hot-wheels') stolenTargetCar = true;
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

let lastStolenCar = null;
let lastStolenAt = -Infinity;
let lastStolenCarId = null;
let stolenTargetCar = false;

const police = createPoliceSystem({
  scene,
  policeStation: world.spawnPoints.policeStation,
  onWantedChanged: (stars) => {
    if (stars > 0) hud.toast(`Wanted level ${stars} — lose the patrol cars`, 3);
    else hud.toast('You lost them — heat is off', 3);
  },
  onBusted: () => enterEndState('busted'),
  onWasted: () => enterEndState('wasted'),
  onRam: (amount) => {
    vehicles.damagePlayerCar(amount);
    audio.noiseBurst(0.18, 0.3, 700);
  },
});

const combat = createCombatSystem({
  scene,
  onCrime: (type, details) => {
    police.reportCrime(type, details || {});
  },
  onShot: (info) => {
    if (info && info.weapon === 'pistol') {
      audio.shot();
      const pos = player.group.position;
      pedestrians.addThreat(pos.x, pos.z, 26, 'gunshot');
    } else if (info && info.weapon === 'fists') {
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
// over the world and the rng, both of which never change after boot.
const roadNetwork = {
  nearestRoadPoint: (pos) => world.nearestRoadPoint(pos.x, pos.z),
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
  busted: false,
  wasted: false,
};

const hudSnapshot = {
  health: 100,
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
  'KeyE', 'KeyF', 'KeyR', 'KeyM', 'KeyP', 'Escape', 'Digit1', 'Digit2',
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
      `Save found: ${formatMoney(save.cash)}, ${save.missionsCompleted.length} of 5 missions done.`;
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
  if (combat.getWeapon() === 'pistol') {
    combat.shoot(origin, direction, targets);
  } else {
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
    // bike included, reads in one frame.
    cameraDesired.set(
      car.group.position.x + fwdX * 22 + rightX * 6,
      CAMERA.drivingHeight + 3,
      car.group.position.z + fwdZ * 22 + rightZ * 6,
    );
    camera.position.lerp(cameraDesired, Math.min(1, dt * 5));
    cameraTarget.set(
      car.group.position.x - fwdX * 16,
      1.6,
      car.group.position.z - fwdZ * 16,
    );
    camera.lookAt(cameraTarget);
    return;
  }
  if (shotCameraMode === 'drive-side') {
    // Side profile: the camera sits off Leo's right flank and looks
    // forward past him, so the supercar's shape and the road ahead —
    // including the oncoming bike — share the frame.
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
  cameraDesired.set(
    car.group.position.x - fwdX * CAMERA.drivingDistance,
    CAMERA.drivingHeight,
    car.group.position.z - fwdZ * CAMERA.drivingDistance,
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
  if (state !== 'playing' || player.inVehicle) return '';
  const pos = player.group.position;
  const car = vehicles.nearestEnterableVehicle(pos, PLAYER.enterCarRange);
  if (car) return '<b>E</b> Enter car &nbsp;·&nbsp; <b>F</b> Steal it';
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
  const policeEvents = police.update(dt, policeCtx);
  if (policeEvents.busted) enterEndState('busted');
  if (policeEvents.wasted) enterEndState('wasted');

  // Health regen after a quiet spell.
  if (playSeconds - lastDamageAt > 8 && health > 0 && health < PLAYER.maxHealth) {
    health = Math.min(PLAYER.maxHealth, health + 6 * dt);
  }

  // Combat timers (cooldowns, reloads, tracers).
  combat.update(dt);

  // Missions: objectives, markers, pickups, steals.
  missionCtx.playerPos = player.group.position;
  missionCtx.inVehicle = player.inVehicle;
  missionCtx.carryingTargetCar = Boolean(lastStolenCar && player.inVehicle);
  missionCtx.stolenTargetCar = stolenTargetCar;
  missionCtx.stolenCarId = lastStolenCarId && playSeconds - lastStolenAt < 0.5
    ? lastStolenCarId
    : undefined;
  missionCtx.stolenCarModel = lastStolenCar ? lastStolenCar.type : undefined;
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

  world.update(dt, playSeconds);

  // HUD + minimap + sound, from one snapshot.
  const objective = missions.getCurrentObjective();
  const ammo = combat.getAmmo();
  hudSnapshot.health = health;
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
  hudSnapshot.aiming = !player.inVehicle && combat.getWeapon() === 'pistol';
  hud.update(hudSnapshot, dt);
  fillMinimapTraffic();
  minimapData.playerX = player.group.position.x;
  minimapData.playerZ = player.group.position.z;
  minimapData.playerHeading = player.inVehicle && playerCar ? playerCar.heading : player.heading;
  minimapData.driving = player.inVehicle;
  minimapData.police = police.getBlips();
  minimapData.marker = missions.getMarkerTarget();
  minimapData.pickups = pickups;
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
};
animate();

export { GAME_TITLE };
