// missions.js — story missions, objectives and free-roam activities, rebuilt.
//
// This module owns the mission layer of Solmar Bay: the seven story
// missions of Leo Marlow and the Marisol crew, the step-by-step objective
// shown on the HUD, the glowing 3D marker in the world, the blip the
// minimap follows, and the free-roam ways to earn cash between missions
// (scattered cash pickups, stunt jumps, sunset photo spots and stealing
// cars). It does not draw the HUD or the minimap itself — it hands main.js
// and hud.js the current objective text and the marker position, and
// main.js calls update() every frame with where the player is and what
// they are doing.
//
// Two new missions join the story this round: Midnight Run, a timed
// drive from the pier to the hideout, and The Getaway, a showroom theft
// with a clock ticking on the delivery. Two new step kinds support them:
// 'timedDrive' (reach a marker before the clock runs out) and 'carryTo'
// (grab something, then carry it to a second marker). Sunset photo spots
// are the new free-roam earner: hold still at a scenic point and the
// shot pays out.
//
// Public interface:
//   createMissionManager(deps) -> manager
//     deps (all optional, duck-typed; the manager still works without them):
//       scene    : a three.js Scene the marker mesh is added to
//       city     : { getMarkerPoint(name) -> { x, z } } named world points
//       police   : { setWanted(n), getWanted() -> n, wantedLevel }
//       save     : { loadSave(), updateSave(patch), addCashToSave(save, n) }
//       onEvent  : function (event) called for every mission/cash event
//       onCash   : function (amount, reason) called when cash is earned
//     manager:
//       definitions            : the seven mission definitions (read-only data)
//       getMissionList()       -> [{ id, title, status, reward, ... }] for menus
//       getActiveMission()     -> the active definition or null
//       getCurrentObjective()  -> { title, text, step, steps } for the HUD
//       getMarkerTarget()      -> { x, z, active } for the minimap blip
//       startMission(id)       -> true when the mission could be started
//       abortMission()         -> abandons the active mission (no penalty)
//       retryMission(id)       -> restarts a failed mission from step one
//       update(dt, ctx)        -> advances timers/markers, returns events []
//       getCashPickups()       -> live pickup list for rendering / HUD
//       getPhotoSpots()        -> live photo spot list for rendering / HUD
//       collectNearbyPickups(pos) -> cash collected near a position (also in update)
//       registerStuntJump(name, speed) -> cash award when a jump is landed
//       registerCarStolen(carId, modelName) -> cash award, once per car
//       getCashEarned()        -> total cash this manager has paid out
//       getCompletedIds()      -> ids of finished missions, in order
//       getStateSnapshot()     -> small plain object for debugging / shots
//       dispose()              -> removes the marker mesh from the scene
//
//   Events returned by update() (and passed to deps.onEvent) look like:
//     { type: 'objective', text }            objective text changed
//     { type: 'stepComplete', missionId, stepId }
//     { type: 'missionComplete', missionId, title, reward, newCashTotal }
//     { type: 'missionFailed', missionId, reason }
//     { type: 'missionStarted', missionId, title }
//     { type: 'missionUnlocked', missionId, title }
//     { type: 'cash', amount, reason, newCashTotal }
//     { type: 'warning', text }               e.g. patrols closing in
//     { type: 'pickup', amount, x, z }
//     { type: 'stunt', amount, jumpName }
//     { type: 'photo', amount, spotName }
//     { type: 'carStolen', amount, carId }
//
// Coordinate convention: the city is a flat ground plane, y = 0. Markers are
// named points { x, z } in metres, inside -250..250 on both axes. When
// deps.city is missing, the built-in DEFAULT_POINTS table below is used, so
// missions still work in a bare scene (shots, tests, early integration).
//
// Story (all original): Leo Marlow, a driver-for-hire in Marisol Bay, is
// pulled into the Marisol crew — Mara Solano (the boss), Rico (wheelman),
// June Park (lookout / hacker) and Theo (the kid who watches the streets).

import * as THREE from 'three';
import { FREE_ROAM } from './config.js';

/** How close the player (or their car) must be to count as "arrived". */
const ARRIVE_RADIUS = 6;
/** How close the player must be, on foot, to grab a package or a pickup. */
const GRAB_RADIUS = 3.5;
/** Seconds the player must stand still-ish inside a grab zone to finish it. */
const GRAB_HOLD_SECONDS = 2.5;
/** How close the player must stand to a photo spot to frame the shot. */
const PHOTO_RADIUS = 4;
/** Seconds of holding still at a photo spot before the shot pays out. */
const PHOTO_HOLD_SECONDS = FREE_ROAM.photoHoldSeconds;
/** A photo spot pays again this long after the last payout. */
const PHOTO_COOLDOWN_SECONDS = FREE_ROAM.photoCooldownSeconds;
/** A patrol counts as "too close" inside this distance, in metres. */
const PATROL_SPOT_RADIUS = 28;
/** Cash pickups come back this long after being collected. */
const PICKUP_RESPAWN_SECONDS = FREE_ROAM.pickupRespawnSeconds;
/** A jump only pays when the car is moving at least this fast (m/s). */
const STUNT_MIN_SPEED = FREE_ROAM.stuntMinSpeed;
/** Stealing the same car twice never pays twice. */
const CAR_THEFT_REWARD = FREE_ROAM.carTheftReward;

/** Fallback world points, used when no city module is wired in yet. */
export const DEFAULT_POINTS = {
  garage: { x: -120, z: -120 },
  pier: { x: -260, z: 60 },
  alley: { x: -60, z: -60 },
  plaza: { x: 30, z: 30 },
  marina: { x: 180, z: -60 },
  showroom: { x: 180, z: -60 },
  chopShop: { x: 180, z: 180 },
  bank: { x: 60, z: -180 },
  safehouse: { x: -180, z: 120 },
  hideout: { x: -180, z: 120 },
  rooftop: { x: 120, z: -180 },
  beach: { x: -250, z: 0 },
  dropoff: { x: 120, z: 60 },
  docks: { x: 215, z: -215 },
  warehouse: { x: 228, z: -230 },
  craneYard: { x: 202, z: -202 },
  gate: { x: 210, z: -192 },
  cache: { x: 224, z: -204 },
  jumpNorth: { x: 0, z: -215 },
  jumpSouth: { x: 0, z: 215 },
  jumpEast: { x: 215, z: 0 },
  jumpWest: { x: -215, z: 0 },
  jumpBeach: { x: -250, z: 60 },
  jumpMarina: { x: 180, z: 60 },
};

/** Where the scattered free-roam cash pickups sit, and what each is worth.
 *  `dx` / `dz` nudge each pickup a few metres off its landmark so it is a
 *  small detour to grab, not an automatic bonus for standing on a mission
 *  marker that happens to share the same named point. */
const CASH_PICKUP_SPOTS = [
  { point: 'plaza', amount: 75, dx: 14, dz: 8 },
  { point: 'beach', amount: 120, dx: -12, dz: 10 },
  { point: 'marina', amount: 100, dx: 10, dz: -14 },
  { point: 'alley', amount: 60, dx: -10, dz: -8 },
  { point: 'rooftop', amount: 150, dx: 12, dz: 12 },
  { point: 'pier', amount: 90, dx: -14, dz: -6 },
  { point: 'garage', amount: 50, dx: 8, dz: 14 },
  { point: 'safehouse', amount: 80, dx: -8, dz: -12 },
  { point: 'showroom', amount: 110, dx: -10, dz: 10 },
  { point: 'dropoff', amount: 65, dx: 12, dz: -10 },
];

/** The six stunt jumps: a name, a world point and the cash they pay. */
const STUNT_JUMPS = [
  { name: 'North Bridge Leap', point: 'jumpNorth', reward: 150 },
  { name: 'South Dune Jump', point: 'jumpSouth', reward: 150 },
  { name: 'East Pier Hop', point: 'jumpEast', reward: 200 },
  { name: 'West Hill Launch', point: 'jumpWest', reward: 200 },
  { name: 'Beach Dune Leap', point: 'jumpBeach', reward: 175 },
  { name: 'Marina Ramp', point: 'jumpMarina', reward: 175 },
];

/** Sunset photo spots: hold still in the marker and the shot pays out. */
const PHOTO_SPOTS = [
  { name: 'Sunset Pier', point: 'pier', reward: 120, dx: 6, dz: -8 },
  { name: 'Ferris Wheel Glow', point: 'jumpNorth', reward: 150, dx: -10, dz: 6 },
  { name: 'Plaza Fountain', point: 'plaza', reward: 80, dx: -12, dz: -10 },
  { name: 'Beach Golden Hour', point: 'beach', reward: 100, dx: 10, dz: -12 },
];

/**
 * The ten story missions. A step is one small job:
 *   kind 'driveTo'    — reach a marker while driving a car
 *   kind 'timedDrive' — reach a marker while driving, before the clock ends
 *   kind 'goTo'       — reach a marker on foot or in a car
 *   kind 'walkTo'     — reach a marker on foot (getting out matters)
 *   kind 'grab'       — stand in a small zone to pick something up
 *   kind 'carryTo'    — grab at `point`, then carry it to `dest`
 *   kind 'stealCar'   — take the marked car (main.js reports the steal)
 *   kind 'deliverCar' — bring the stolen car to a marker
 *   kind 'loseWanted' — get the wanted level back to zero
 *   kind 'reachSafe'  — reach the safehouse to finish the escape
 * A step may carry `needsWanted` (wanted level set when the step starts),
 * `maxWanted` (failing the mission when the level reaches it) or a
 * `timeLimit` in seconds. `dialogue` is the crew chatter shown with the step.
 */
export const MISSION_DEFINITIONS = [
  {
    id: 'first-fare',
    title: 'First Fare',
    reward: 800,
    briefing:
      'Mara: "Leo, the crew needs a driver tonight, not a taxi. Take the ' +
      'grey sedan from the garage to the pier. Smooth, no sirens, no heroes."',
    steps: [
      {
        id: 'get-car',
        kind: 'goTo',
        point: 'garage',
        text: 'Get in the grey sedan at the garage',
        dialogue: 'Rico: "Keys are in it. She purrs if you treat her right."',
      },
      {
        id: 'drive-pier',
        kind: 'driveTo',
        point: 'pier',
        text: 'Drive the getaway car to the pier marker',
        dialogue: 'Mara: "Pier, north end. Park inside the lights and kill the engine."',
      },
    ],
  },
  {
    id: 'the-pickup',
    title: 'The Pickup',
    reward: 1200,
    briefing:
      'June: "A package is waiting in the alley behind the plaza. Cops walk ' +
      'that block every few minutes, so stay on foot, stay calm, and do not ' +
      'let your wanted level climb past one star."',
    steps: [
      {
        id: 'fetch-package',
        kind: 'carryTo',
        point: 'alley',
        dest: 'plaza',
        text: 'Collect the package in the alley, then carry it to the plaza',
        dialogue: 'June: "Brown bag, under the blue awning. Grab it and walk away."',
      },
      {
        id: 'quiet-exit',
        kind: 'walkTo',
        point: 'plaza',
        maxWanted: 2,
        text: 'Slip away to the plaza without drawing heat (stay under 2 stars)',
        dialogue: 'Theo: "Patrol just turned the corner. Easy does it, Leo."',
      },
    ],
  },
  {
    id: 'hot-wheels',
    title: 'Hot Wheels',
    reward: 2000,
    briefing:
      'Rico: "A cherry-red coupe is parked by the marina, doors unlocked, ' +
      'owner asleep at the wheel of life. Take it, bring it to the chop ' +
      'shop, and do not scratch the paint. Scratches cost money."',
    steps: [
      {
        id: 'find-coupe',
        kind: 'goTo',
        point: 'marina',
        text: 'Find the red coupe parked at the marina',
        dialogue: 'Rico: "Red coupe, gold rims. You cannot miss her."',
      },
      {
        id: 'steal-coupe',
        kind: 'stealCar',
        point: 'marina',
        text: 'Steal the coupe (press F near it)',
        dialogue: 'Mara: "In and gone. Nobody saw a thing, right?"',
      },
      {
        id: 'deliver-chop',
        kind: 'deliverCar',
        point: 'chopShop',
        text: 'Deliver the coupe to the chop shop',
        dialogue: 'Rico: "Chop shop, south-west corner. Park her inside the lights."',
      },
    ],
  },
  {
    id: 'heat-wave',
    title: 'Heat Wave',
    reward: 2500,
    briefing:
      'Mara: "Somebody talked. The whole bay is looking for you now — three ' +
      'stars, Leo. Lose them. Break line of sight, change streets, and do ' +
      'not get caught. You have three minutes before they lock the bridges."',
    steps: [
      {
        id: 'lose-heat',
        kind: 'loseWanted',
        point: 'safehouse',
        needsWanted: 3,
        timeLimit: 180,
        text: 'Lose the 3-star wanted level (reach 0 stars)',
        dialogue: 'June: "They are sweeping the avenues. Alleyways, Leo. Alleyways."',
      },
    ],
  },
  {
    id: 'midnight-run',
    title: 'Midnight Run',
    reward: 550,
    briefing:
      'June: "A courier is waiting at the pier with a package the crew ' +
      'needs at the hideout before midnight. Drive it there fast — the ' +
      'clock is already running, and the streets are not empty."',
    steps: [
      {
        id: 'meet-courier',
        kind: 'goTo',
        point: 'pier',
        text: 'Meet the courier at the pier',
        dialogue: 'June: "He is by the pier lights, grey jacket. Do not keep him waiting."',
      },
      {
        id: 'race-hideout',
        kind: 'timedDrive',
        point: 'hideout',
        timeLimit: 75,
        text: 'Race the package to the hideout before the clock runs out',
        dialogue: 'Mara: "Seventy-five seconds, Leo. The hideout, west end. Go."',
      },
    ],
  },
  {
    id: 'the-getaway',
    title: 'The Getaway',
    reward: 700,
    briefing:
      'Rico: "The showroom on the east side keeps a supercar behind glass, ' +
      'and tonight the glass is already broken. Take it, and get it to the ' +
      'chop shop before the alarm brings every cruiser in the bay."',
    steps: [
      {
        id: 'reach-showroom',
        kind: 'goTo',
        point: 'showroom',
        text: 'Reach the showroom on the east side',
        dialogue: 'Rico: "Supercar, gold paint, behind the glass. She is yours."',
      },
      {
        id: 'take-supercar',
        kind: 'stealCar',
        point: 'showroom',
        text: 'Steal the supercar (press F near it)',
        dialogue: 'Mara: "Alarm is live. Do not admire her — drive her."',
      },
      {
        id: 'outrun-alarm',
        kind: 'timedDrive',
        point: 'chopShop',
        timeLimit: 90,
        needsWanted: 2,
        text: 'Outrun the alarm to the chop shop (90 seconds)',
        dialogue: 'June: "Two stars already. Ninety seconds to the chop shop, Leo."',
      },
    ],
  },
  {
    id: 'the-big-score',
    title: 'The Big Score',
    reward: 10000,
    briefing:
      'Mara: "The bank on the plaza keeps its cash in the back room, and ' +
      'tonight the back room is ours. Grab the money, and then run — the ' +
      'whole city will be on you at four stars. Get home to the safehouse."',
    steps: [
      {
        id: 'enter-bank',
        kind: 'walkTo',
        point: 'bank',
        text: 'Reach the bank on the plaza',
        dialogue: 'Theo: "Doors are open, lobby is empty. Go, go, go."',
      },
      {
        id: 'grab-cash',
        kind: 'grab',
        point: 'bank',
        needsWanted: 4,
        text: 'Grab the cash from the back room (stand in the marker)',
        dialogue: 'Mara: "That is the sound of ten thousand dollars. Now MOVE."',
      },
      {
        id: 'escape-home',
        kind: 'reachSafe',
        point: 'safehouse',
        text: 'Escape to the safehouse with the money',
        dialogue: 'June: "Four stars and counting. Take the beach road — fewer cruisers."',
      },
    ],
  },
  {
    id: 'night-shift',
    title: 'Night Shift at the Docks',
    reward: 900,
    briefing:
      'June: "The North Docks run a night shift that is not on any roster, ' +
      'and tonight the crew is short a driver. Report to the docks, pick up ' +
      'the crate from the warehouse, and run it to the dropoff before the ' +
      'yard gates close. The workers know the drill — do not make them wait."',
    steps: [
      {
        id: 'report-docks',
        kind: 'goTo',
        point: 'docks',
        text: 'Report to the North Docks',
        dialogue: 'June: "Gate is open, Leo. The yard is yours tonight."',
      },
      {
        id: 'fetch-crate',
        kind: 'walkTo',
        point: 'warehouse',
        text: 'Walk into the warehouse and find the crate',
        dialogue: 'Theo: "Third stack on the left, marked with a blue tag. Bring it out."',
      },
      {
        id: 'grab-crate',
        kind: 'grab',
        point: 'warehouse',
        text: 'Grab the crate from the warehouse floor (stand in the marker)',
        dialogue: 'Mara: "Careful with that one — it is worth more than the car you drove in."',
      },
      {
        id: 'run-dropoff',
        kind: 'timedDrive',
        point: 'dropoff',
        timeLimit: 100,
        text: 'Run the crate to the dropoff before the yard gates close (100 seconds)',
        dialogue: 'June: "One hundred seconds. The dropoff, east side. Go."',
      },
    ],
  },
  {
    id: 'storm-run',
    title: 'Storm Run',
    reward: 1400,
    briefing:
      'Mara: "A storm is rolling in off the bay and the harbour police are ' +
      'pulling back to the station — which means the crane yard is wide ' +
      'open. Take the flatbed parked under the big crane, run the load to ' +
      'the pier, and then lose whatever heat follows you. Rain makes the ' +
      'roads slick, Leo, so drive like the weather owes you money."',
    steps: [
      {
        id: 'reach-crane-yard',
        kind: 'driveTo',
        point: 'craneYard',
        text: 'Drive to the crane yard at the North Docks',
        dialogue: 'Rico: "Rain on the windscreen, hook swinging overhead. That is your flatbed."',
      },
      {
        id: 'take-flatbed',
        kind: 'stealCar',
        point: 'craneYard',
        text: 'Take the flatbed under the crane (press F near it)',
        dialogue: 'Mara: "She is loaded already. Do not ask what is in the back."',
      },
      {
        id: 'storm-drive',
        kind: 'timedDrive',
        point: 'pier',
        timeLimit: 90,
        needsWanted: 2,
        text: 'Run the load to the pier in the storm (90 seconds)',
        dialogue: 'June: "Two stars and the rain is getting worse. Ninety seconds, Leo."',
      },
      {
        id: 'lose-heat',
        kind: 'loseWanted',
        point: 'safehouse',
        text: 'Lose the heat and get back to the safehouse',
        dialogue: 'Theo: "Cut through the old town. They never patrol the old town in a storm."',
      },
    ],
  },
  {
    id: 'the-broker',
    title: 'The Broker',
    reward: 2000,
    briefing:
      'Theo: "There is a man in the alley who brokers jobs for half the ' +
      'crews in the bay, and he has a ledger that says too much. Pick the ' +
      'ledger up from him, carry it to the docks, and do not let the police ' +
      'take it off you. If the heat gets bad, lose it before you hand the ' +
      'ledger over — the docks do not take deliveries with cruisers behind them."',
    steps: [
      {
        id: 'meet-broker',
        kind: 'walkTo',
        point: 'alley',
        text: 'Meet the broker in the alley on foot',
        dialogue: 'Theo: "He is in the shadows by the dumpster. Grey coat, no hat."',
      },
      {
        id: 'carry-ledger',
        kind: 'carryTo',
        point: 'alley',
        dest: 'docks',
        text: 'Carry the ledger from the alley to the North Docks',
        dialogue: 'Broker: "Two thousand dollars of names in that book. Do not drop it."',
      },
      {
        id: 'docks-heat',
        kind: 'loseWanted',
        point: 'docks',
        needsWanted: 2,
        text: 'The police are on to the ledger — lose the heat at the docks',
        dialogue: 'Mara: "Two stars. Shake them before you hand anything over."',
      },
      {
        id: 'hand-over',
        kind: 'grab',
        point: 'docks',
        text: 'Hand the ledger over at the docks (stand in the marker)',
        dialogue: 'June: "Ledger delivered. Two thousand, clean. The broker sends his regards."',
      },
    ],
  },
];

/** Mission statuses, in the order a mission moves through them. */
export const MISSION_STATUS = {
  LOCKED: 'locked',
  AVAILABLE: 'available',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

function clonePoint(point) {
  return { x: point.x, z: point.z };
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Builds the glowing beacon shown at the current objective (three.js only). */
function buildMarkerMesh() {
  const group = new THREE.Group();
  group.name = 'MissionMarker';

  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc93c,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 26, 20, 1, true), beamMaterial);
  beam.position.y = 13;
  beam.name = 'MissionMarkerBeam';
  group.add(beam);

  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc93c,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 3.0, 32), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  ring.name = 'MissionMarkerRing';
  group.add(ring);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff3b0 }),
  );
  core.position.y = 1.0;
  core.name = 'MissionMarkerCore';
  group.add(core);

  group.userData.beam = beam;
  group.userData.ring = ring;
  group.userData.core = core;
  group.visible = false;
  return group;
}

/**
 * Creates the mission manager. See the header comment for the full contract.
 * The manager keeps its own mission state; the game loop drives it through
 * update() and reads objectives and the marker through the getters.
 */
export function createMissionManager(deps = {}) {
  const scene = deps.scene ?? null;
  const city = deps.city ?? null;
  const police = deps.police ?? null;
  const saveApi = deps.save ?? null;
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
  const onCash = typeof deps.onCash === 'function' ? deps.onCash : null;

  const marker = buildMarkerMesh();
  if (scene && typeof scene.add === 'function') scene.add(marker);

  /** missionId -> 'locked' | 'available' | 'active' | 'completed' | 'failed' */
  const statusById = new Map();
  /** missionId -> index of the step currently being attempted. */
  const stepIndexById = new Map();
  /** missionId -> seconds spent holding a grab zone, reset on leaving it. */
  const grabHoldById = new Map();
  /** missionId -> seconds left on a timed step, null when untimed. */
  const timeLeftById = new Map();
  /** missionId -> 0 while a carryTo step is still at the pickup, 1 once the
   *  package is in hand and the marker moves to the delivery point. */
  const carryPhaseById = new Map();

  const completedIds = [];
  let activeMissionId = null;
  let cashEarned = 0;
  let lastObjectiveText = '';
  let pulseTime = 0;
  let warnedThisStep = false;

  // Cash pickups: one live record per spot, with respawn timing.
  const pickups = CASH_PICKUP_SPOTS.map((spot) => ({
    point: spot.point,
    amount: spot.amount,
    dx: spot.dx ?? 0,
    dz: spot.dz ?? 0,
    position: null, // resolved lazily from the city / fallback table
    available: true,
    respawnIn: 0,
  }));
  // Photo spots: one live record per spot, with hold and cooldown timing.
  const photoSpots = PHOTO_SPOTS.map((spot) => ({
    name: spot.name,
    point: spot.point,
    reward: spot.reward,
    dx: spot.dx ?? 0,
    dz: spot.dz ?? 0,
    position: null, // resolved lazily from the city / fallback table
    holdSeconds: 0,
    cooldownLeft: 0,
  }));
  const stolenCarIds = new Set();
  const jumpsDoneRecently = new Map(); // jump name -> seconds until it pays again

  // ---- saved progress -------------------------------------------------
  function readSavedProgress() {
    if (!saveApi || typeof saveApi.loadSave !== 'function') return { completed: [], cash: 0 };
    try {
      const saved = saveApi.loadSave();
      return {
        completed: Array.isArray(saved?.missionsCompleted) ? saved.missionsCompleted : [],
        cash: typeof saved?.cash === 'number' ? saved.cash : 0,
      };
    } catch {
      return { completed: [], cash: 0 };
    }
  }

  function persistProgress() {
    if (!saveApi || typeof saveApi.updateSave !== 'function') return;
    try {
      saveApi.updateSave((saved) => {
        saved.missionsCompleted = [...completedIds];
      });
    } catch {
      // A failed write must never break the mission itself.
    }
  }

  function persistCash(amount) {
    let newTotal = null;
    if (saveApi && typeof saveApi.updateSave === 'function') {
      try {
        const updated = saveApi.updateSave((saved) => {
          if (typeof saveApi.addCashToSave === 'function') {
            const merged = saveApi.addCashToSave(saved, amount);
            saved.cash = merged.cash;
            saved.stats = merged.stats;
          } else {
            saved.cash = Math.max(0, (saved.cash ?? 0) + amount);
            if (saved.stats) saved.stats.cashEarned = (saved.stats.cashEarned ?? 0) + amount;
          }
        });
        newTotal = updated?.cash ?? null;
      } catch {
        newTotal = null;
      }
    }
    return newTotal;
  }

  // ---- world points ----------------------------------------------------
  function resolvePoint(name) {
    if (city && typeof city.getMarkerPoint === 'function') {
      try {
        const found = city.getMarkerPoint(name);
        if (found && typeof found.x === 'number' && typeof found.z === 'number') {
          return { x: found.x, z: found.z };
        }
      } catch {
        // Fall through to the built-in table.
      }
    }
    const fallback = DEFAULT_POINTS[name];
    return fallback ? clonePoint(fallback) : { x: 0, z: 0 };
  }

  function resolvePickupPositions() {
    for (const pickup of pickups) {
      if (!pickup.position) {
        const base = resolvePoint(pickup.point);
        pickup.position = { x: base.x + (pickup.dx ?? 0), z: base.z + (pickup.dz ?? 0) };
      }
    }
    for (const spot of photoSpots) {
      if (!spot.position) {
        const base = resolvePoint(spot.point);
        spot.position = { x: base.x + (spot.dx ?? 0), z: base.z + (spot.dz ?? 0) };
      }
    }
  }

  // ---- mission bookkeeping --------------------------------------------
  function definitionOf(id) {
    return MISSION_DEFINITIONS.find((def) => def.id === id) ?? null;
  }

  function firstIncompleteIndex() {
    for (let i = 0; i < MISSION_DEFINITIONS.length; i += 1) {
      if (statusById.get(MISSION_DEFINITIONS[i].id) !== MISSION_STATUS.COMPLETED) return i;
    }
    return MISSION_DEFINITIONS.length;
  }

  function refreshAvailability() {
    const openIndex = firstIncompleteIndex();
    MISSION_DEFINITIONS.forEach((def, index) => {
      const current = statusById.get(def.id);
      // Completed and active missions keep their status, and a failed
      // mission stays failed until the player explicitly retries it.
      if (
        current === MISSION_STATUS.COMPLETED ||
        current === MISSION_STATUS.ACTIVE ||
        current === MISSION_STATUS.FAILED
      ) {
        return;
      }
      statusById.set(def.id, index === openIndex ? MISSION_STATUS.AVAILABLE : MISSION_STATUS.LOCKED);
    });
  }

  /**
   * The single event channel. While update() is running, events are collected
   * into its return array instead of being sent straight to the listener, so
   * main.js never sees the same event twice (once returned, once via the
   * callback). Outside update(), events go straight to deps.onEvent.
   */
  let batchEvents = null;

  function emit(event) {
    if (batchEvents) {
      batchEvents.push(event);
      return;
    }
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        // A listener error must never stop the mission flow.
      }
    }
  }

  function payCash(amount, reason) {
    const gain = Math.max(0, Math.floor(amount));
    cashEarned += gain;
    const newTotal = persistCash(gain);
    if (onCash) {
      try {
        onCash(gain, reason);
      } catch {
        // Cash display errors stay outside the mission flow.
      }
    }
    emit({ type: 'cash', amount: gain, reason, newCashTotal: newTotal });
    return newTotal;
  }

  function currentStep() {
    if (!activeMissionId) return null;
    const def = definitionOf(activeMissionId);
    if (!def) return null;
    return def.steps[stepIndexById.get(activeMissionId) ?? 0] ?? null;
  }

  // The step's live target: for a carryTo step the marker starts at the
  // pickup point and moves to the delivery point once the package is held.
  function stepTarget(step) {
    if (!step || !step.point) return null;
    if (step.kind === 'carryTo' && step.dest && (carryPhaseById.get(activeMissionId) ?? 0) === 1) {
      return resolvePoint(step.dest);
    }
    return resolvePoint(step.point);
  }

  function placeMarkerAt(point) {
    if (!point) {
      marker.visible = false;
      return;
    }
    marker.position.set(point.x, 0, point.z);
    marker.visible = true;
  }

  function applyStepSideEffects(step) {
    if (!step) return;
    if (typeof step.needsWanted === 'number' && police && typeof police.setWanted === 'function') {
      try {
        police.setWanted(step.needsWanted);
      } catch {
        // The mission still runs when the police module is absent.
      }
    }
    const limit = typeof step.timeLimit === 'number' ? step.timeLimit : null;
    timeLeftById.set(activeMissionId, limit);
    grabHoldById.set(activeMissionId, 0);
    carryPhaseById.set(activeMissionId, 0);
    warnedThisStep = false;
  }

  function objectiveTextFor(step) {
    if (!step) return '';
    // A carryTo step shows different text once the package is in hand.
    if (step.kind === 'carryTo' && (carryPhaseById.get(activeMissionId) ?? 0) === 1) {
      return `Carry the package to ${step.dest}`;
    }
    return step.text;
  }

  function announceObjective() {
    const def = definitionOf(activeMissionId);
    const step = currentStep();
    if (!def || !step) return;
    const text = objectiveTextFor(step);
    if (text !== lastObjectiveText) {
      lastObjectiveText = text;
      emit({ type: 'objective', missionId: def.id, stepId: step.id, text });
    }
  }

  // ---- public: starting / finishing missions --------------------------
  function startMission(id) {
    const def = definitionOf(id);
    if (!def) return false;
    refreshAvailability();
    if (statusById.get(id) !== MISSION_STATUS.AVAILABLE) return false;
    if (activeMissionId) return false;
    activeMissionId = id;
    statusById.set(id, MISSION_STATUS.ACTIVE);
    stepIndexById.set(id, 0);
    placeMarkerAt(stepTarget(def.steps[0]));
    applyStepSideEffects(def.steps[0]);
    announceObjective();
    emit({ type: 'missionStarted', missionId: id, title: def.title, briefing: def.briefing });
    return true;
  }

  function completeStep() {
    const def = definitionOf(activeMissionId);
    const step = currentStep();
    if (!def || !step) return;
    emit({ type: 'stepComplete', missionId: def.id, stepId: step.id });
    const nextIndex = (stepIndexById.get(def.id) ?? 0) + 1;
    if (nextIndex >= def.steps.length) {
      completeMission(def);
      return;
    }
    stepIndexById.set(def.id, nextIndex);
    const next = def.steps[nextIndex];
    placeMarkerAt(stepTarget(next));
    applyStepSideEffects(next);
    announceObjective();
  }

  function completeMission(def) {
    statusById.set(def.id, MISSION_STATUS.COMPLETED);
    completedIds.push(def.id);
    activeMissionId = null;
    marker.visible = false;
    lastObjectiveText = '';
    persistProgress();
    const newTotal = payCash(def.reward, `Mission complete: ${def.title}`);
    refreshAvailability();
    emit({ type: 'missionComplete', missionId: def.id, title: def.title, reward: def.reward, newCashTotal: newTotal });
    // Exactly one unlock event: the next mission in line, if there is one.
    const unlocked = MISSION_DEFINITIONS.find((d) => statusById.get(d.id) === MISSION_STATUS.AVAILABLE);
    if (unlocked) {
      emit({ type: 'missionUnlocked', missionId: unlocked.id, title: unlocked.title });
    }
  }

  function failMission(reason) {
    if (!activeMissionId) return false;
    const def = definitionOf(activeMissionId);
    const id = activeMissionId;
    activeMissionId = null;
    statusById.set(id, MISSION_STATUS.FAILED);
    marker.visible = false;
    lastObjectiveText = '';
    emit({ type: 'missionFailed', missionId: id, title: def?.title ?? id, reason });
    return true;
  }

  function abortMission() {
    if (!activeMissionId) return false;
    const id = activeMissionId;
    activeMissionId = null;
    statusById.set(id, MISSION_STATUS.AVAILABLE);
    marker.visible = false;
    lastObjectiveText = '';
    refreshAvailability();
    emit({ type: 'missionAborted', missionId: id });
    return true;
  }

  function retryMission(id) {
    const def = definitionOf(id);
    if (!def || activeMissionId) return false;
    if (statusById.get(id) !== MISSION_STATUS.FAILED) return false;
    statusById.set(id, MISSION_STATUS.AVAILABLE);
    return startMission(id);
  }

  // ---- free-roam activities -------------------------------------------
  function collectNearbyPickups(playerPos) {
    resolvePickupPositions();
    const collected = [];
    if (!playerPos || typeof playerPos.x !== 'number' || typeof playerPos.z !== 'number') return collected;
    for (const pickup of pickups) {
      if (!pickup.available || !pickup.position) continue;
      if (distance2D(playerPos, pickup.position) <= GRAB_RADIUS) {
        pickup.available = false;
        pickup.respawnIn = PICKUP_RESPAWN_SECONDS;
        const newTotal = payCash(pickup.amount, 'Cash pickup');
        collected.push({ type: 'pickup', amount: pickup.amount, x: pickup.position.x, z: pickup.position.z });
        emit({ type: 'pickup', amount: pickup.amount, x: pickup.position.x, z: pickup.position.z, newCashTotal: newTotal });
      }
    }
    return collected;
  }

  // Sunset photo spots: hold still inside the marker and the shot pays
  // out. The hold resets the moment the player steps out of the frame.
  function updatePhotoSpots(dt, playerPos) {
    resolvePickupPositions();
    if (!playerPos || typeof playerPos.x !== 'number' || typeof playerPos.z !== 'number') return;
    for (const spot of photoSpots) {
      if (spot.cooldownLeft > 0) {
        spot.cooldownLeft = Math.max(0, spot.cooldownLeft - dt);
        continue;
      }
      if (!spot.position) continue;
      if (distance2D(playerPos, spot.position) <= PHOTO_RADIUS) {
        spot.holdSeconds += dt;
        if (spot.holdSeconds >= PHOTO_HOLD_SECONDS) {
          spot.holdSeconds = 0;
          spot.cooldownLeft = PHOTO_COOLDOWN_SECONDS;
          const newTotal = payCash(spot.reward, `Sunset photo: ${spot.name}`);
          emit({ type: 'photo', amount: spot.reward, spotName: spot.name, newCashTotal: newTotal });
        }
      } else {
        spot.holdSeconds = 0;
      }
    }
  }

  function registerStuntJump(jumpName, speed) {
    const jump = STUNT_JUMPS.find((j) => j.name === jumpName);
    if (!jump) return 0;
    if (typeof speed === 'number' && speed < STUNT_MIN_SPEED) return 0;
    if ((jumpsDoneRecently.get(jumpName) ?? 0) > 0) return 0;
    jumpsDoneRecently.set(jumpName, FREE_ROAM.stuntCooldownSeconds); // one payout per jump per cooldown
    const newTotal = payCash(jump.reward, `Stunt jump: ${jump.name}`);
    emit({ type: 'stunt', amount: jump.reward, jumpName: jump.name, newCashTotal: newTotal });
    return jump.reward;
  }

  function registerCarStolen(carId, modelName) {
    if (typeof carId !== 'string' || carId.length === 0) return 0;
    if (stolenCarIds.has(carId)) return 0;
    stolenCarIds.add(carId);
    const label = modelName ? `Stole a ${modelName}` : 'Stole a car';
    const newTotal = payCash(CAR_THEFT_REWARD, label);
    emit({ type: 'carStolen', amount: CAR_THEFT_REWARD, carId, modelName: modelName ?? null, newCashTotal: newTotal });
    return CAR_THEFT_REWARD;
  }

  // ---- per-frame update -------------------------------------------------
  function readWanted() {
    if (!police) return 0;
    try {
      if (typeof police.getWanted === 'function') return police.getWanted();
      if (typeof police.wantedLevel === 'number') return police.wantedLevel;
    } catch {
      return 0;
    }
    return 0;
  }

  function update(dt, ctx = {}) {
    const events = [];
    // While this runs, emit() collects into `events` instead of calling the
    // listener directly, so every event is reported exactly once.
    batchEvents = events;
    try {
      runUpdate(dt, ctx);
    } finally {
      batchEvents = null;
    }
    return events;
  }

  function runUpdate(dt, ctx) {
    const stepSeconds = Math.max(0, typeof dt === 'number' ? dt : 0);

    // Marker pulse, always cheap and always running while visible.
    pulseTime += stepSeconds;
    if (marker.visible) {
      const pulse = 1 + 0.12 * Math.sin(pulseTime * 4);
      marker.userData.ring.scale.set(pulse, pulse, 1);
      marker.userData.beam.material.opacity = 0.18 + 0.08 * Math.sin(pulseTime * 4);
      marker.userData.core.position.y = 1.0 + 0.4 * Math.sin(pulseTime * 3);
    }

    // Pickup respawn timers and stunt cooldowns tick in free roam too.
    for (const pickup of pickups) {
      if (!pickup.available && pickup.respawnIn > 0) {
        pickup.respawnIn -= stepSeconds;
        if (pickup.respawnIn <= 0) pickup.available = true;
      }
    }
    for (const [name, left] of jumpsDoneRecently) {
      const next = left - stepSeconds;
      if (next <= 0) jumpsDoneRecently.delete(name);
      else jumpsDoneRecently.set(name, next);
    }

    // Cash pickups are collected whenever the player walks or drives over
    // one. collectNearbyPickups() reports each one through emit(), which
    // lands in this update's event batch.
    if (ctx.playerPos) {
      collectNearbyPickups(ctx.playerPos);
      updatePhotoSpots(stepSeconds, ctx.playerPos);
    }

    // A stunt is reported by main.js when the car leaves a jump ramp; the
    // manager only checks the speed and the cooldown, then pays out.
    if (typeof ctx.stuntJump === 'string' && typeof ctx.speed === 'number') {
      registerStuntJump(ctx.stuntJump, ctx.speed);
    }

    // A steal reported by the vehicle module pays out once per car.
    if (typeof ctx.stolenCarId === 'string' && ctx.stolenCarId.length > 0) {
      registerCarStolen(ctx.stolenCarId, ctx.stolenCarModel);
    }

    // Being busted or wasted fails the mission in progress, if any.
    if ((ctx.busted === true || ctx.wasted === true) && activeMissionId) {
      const reason = ctx.busted === true ? 'Busted by the police' : 'Wasted';
      failMission(reason); // emits the missionFailed event into the batch
      return;
    }

    if (!activeMissionId) return;
    const def = definitionOf(activeMissionId);
    const step = currentStep();
    if (!def || !step) return;

    // Timed steps (Heat Wave, Midnight Run, The Getaway) fail when the
    // clock runs out.
    const timeLeft = timeLeftById.get(activeMissionId);
    if (typeof timeLeft === 'number') {
      const next = timeLeft - stepSeconds;
      timeLeftById.set(activeMissionId, next);
      if (next <= 0) {
        failMission('Out of time — the bridges locked down');
        return;
      }
    }

    // Quiet steps (The Pickup) fail when the wanted level climbs too high.
    if (typeof step.maxWanted === 'number') {
      const wanted = readWanted();
      if (wanted >= step.maxWanted) {
        failMission('Spotted — the patrols closed in');
        return;
      }
      if (wanted === step.maxWanted - 1 && !warnedThisStep) {
        warnedThisStep = true;
        emit({ type: 'warning', text: 'A patrol is watching you — stay calm and keep moving' });
      }
    }

    const playerPos = ctx.playerPos ?? null;
    const target = stepTarget(step);
    const inVehicle = ctx.inVehicle === true;

    switch (step.kind) {
      case 'driveTo': {
        if (playerPos && target && inVehicle && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
      case 'timedDrive': {
        // Same arrival check as driveTo; the clock above handles failure.
        if (playerPos && target && inVehicle && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
      case 'carryTo': {
        // Phase 0: stand in the pickup zone to grab the package. Phase 1:
        // carry it to the delivery marker (the target moved with the phase).
        const phase = carryPhaseById.get(activeMissionId) ?? 0;
        if (phase === 0) {
          const pickupPoint = resolvePoint(step.point);
          if (playerPos && distance2D(playerPos, pickupPoint) <= GRAB_RADIUS) {
            const held = (grabHoldById.get(def.id) ?? 0) + stepSeconds;
            grabHoldById.set(def.id, held);
            if (held >= GRAB_HOLD_SECONDS) {
              grabHoldById.set(def.id, 0);
              carryPhaseById.set(activeMissionId, 1);
              placeMarkerAt(stepTarget(step));
              announceObjective();
              emit({ type: 'stepComplete', missionId: def.id, stepId: `${step.id}-grabbed` });
            }
          } else {
            grabHoldById.set(def.id, 0);
          }
        } else if (playerPos && target && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
      case 'deliverCar': {
        const carrying = ctx.stolenCarDelivered === true || (inVehicle && ctx.carryingTargetCar === true);
        if (playerPos && target && carrying && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
      case 'stealCar': {
        if (ctx.stolenTargetCar === true) {
          completeStep();
        }
        break;
      }
      case 'grab': {
        if (playerPos && target && distance2D(playerPos, target) <= GRAB_RADIUS) {
          const held = (grabHoldById.get(def.id) ?? 0) + stepSeconds;
          grabHoldById.set(def.id, held);
          if (held >= GRAB_HOLD_SECONDS) {
            grabHoldById.set(def.id, 0);
            completeStep();
          }
        } else {
          grabHoldById.set(def.id, 0);
        }
        break;
      }
      case 'walkTo': {
        if (playerPos && target && !inVehicle && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
      case 'loseWanted': {
        if (readWanted() <= 0) {
          completeStep();
        }
        break;
      }
      case 'reachSafe': {
        if (playerPos && target && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
      case 'goTo':
      default: {
        if (playerPos && target && distance2D(playerPos, target) <= ARRIVE_RADIUS) {
          completeStep();
        }
        break;
      }
    }
  }

  // ---- getters for HUD / minimap / menus -------------------------------
  function getMissionList() {
    refreshAvailability();
    return MISSION_DEFINITIONS.map((def) => ({
      id: def.id,
      title: def.title,
      reward: def.reward,
      briefing: def.briefing,
      status: statusById.get(def.id),
      steps: def.steps.length,
      currentStep: def.id === activeMissionId ? (stepIndexById.get(def.id) ?? 0) + 1 : 0,
    }));
  }

  function getCompletedCount() {
    let done = 0;
    for (const status of statusById.values()) {
      if (status === MISSION_STATUS.COMPLETED) done += 1;
    }
    return done;
  }

  function getActiveMission() {
    if (!activeMissionId) return null;
    const def = definitionOf(activeMissionId);
    if (!def) return null;
    return { ...def, status: MISSION_STATUS.ACTIVE, stepIndex: stepIndexById.get(def.id) ?? 0 };
  }

  function getCurrentObjective() {
    const def = definitionOf(activeMissionId);
    const step = currentStep();
    if (!def || !step) {
      return {
        title: 'Free roam',
        text: 'Explore Marisol Bay — or open the phone (P) to start a mission',
        step: 0,
        steps: 0,
        missionId: null,
      };
    }
    return {
      title: def.title,
      text: objectiveTextFor(step),
      step: (stepIndexById.get(def.id) ?? 0) + 1,
      steps: def.steps.length,
      missionId: def.id,
      dialogue: step.dialogue ?? null,
      timeLeft:
        typeof timeLeftById.get(def.id) === 'number'
          ? Math.max(0, Math.ceil(timeLeftById.get(def.id)))
          : null,
    };
  }

  function getMarkerTarget() {
    const step = currentStep();
    if (!step) return { x: 0, z: 0, active: false };
    const target = stepTarget(step);
    return { x: target.x, z: target.z, active: true };
  }

  function getCashPickups() {
    resolvePickupPositions();
    return pickups.map((pickup) => ({
      point: pickup.point,
      amount: pickup.amount,
      x: pickup.position?.x ?? 0,
      z: pickup.position?.z ?? 0,
      available: pickup.available,
    }));
  }

  function getPhotoSpots() {
    resolvePickupPositions();
    return photoSpots.map((spot) => ({
      name: spot.name,
      point: spot.point,
      reward: spot.reward,
      x: spot.position?.x ?? 0,
      z: spot.position?.z ?? 0,
      ready: spot.cooldownLeft <= 0,
    }));
  }

  function getStateSnapshot() {
    return {
      activeMissionId,
      completedIds: [...completedIds],
      cashEarned,
      objective: getCurrentObjective(),
      marker: getMarkerTarget(),
      missions: getMissionList(),
    };
  }

  function dispose() {
    if (scene && typeof scene.remove === 'function') scene.remove(marker);
    for (const child of marker.children) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
  }

  // ---- initialise from the save ---------------------------------------
  const savedProgress = readSavedProgress();
  for (const id of savedProgress.completed) {
    if (definitionOf(id) && !completedIds.includes(id)) completedIds.push(id);
  }
  MISSION_DEFINITIONS.forEach((def) => {
    statusById.set(
      def.id,
      completedIds.includes(def.id) ? MISSION_STATUS.COMPLETED : MISSION_STATUS.LOCKED,
    );
    stepIndexById.set(def.id, 0);
    grabHoldById.set(def.id, 0);
    timeLeftById.set(def.id, null);
    carryPhaseById.set(def.id, 0);
  });
  refreshAvailability();
  resolvePickupPositions();

  return {
    definitions: MISSION_DEFINITIONS,
    stuntJumps: STUNT_JUMPS,
    photoSpots: PHOTO_SPOTS,
    marker,
    getMissionList,
    getCompletedCount,
    getActiveMission,
    getCurrentObjective,
    getMarkerTarget,
    getCashPickups,
    getPhotoSpots,
    getCashEarned: () => cashEarned,
    getCompletedIds: () => [...completedIds],
    getStateSnapshot,
    startMission,
    abortMission,
    retryMission,
    update,
    collectNearbyPickups,
    registerStuntJump,
    registerCarStolen,
    dispose,
  };
}
