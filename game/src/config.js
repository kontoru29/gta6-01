// config.js — Solmar Bay game tuning: every number other modules read lives here.
// One place to balance the city size, movement speeds, wanted levels, money,
// colours, lighting and view distance, so a tweak never means hunting through code.
// Plain data plus a few tiny derived values; no three.js import, no side effects.

export const GAME_TITLE = 'Solmar Bay';
export const GAME_SUBTITLE = 'A Marisol Bay story';
export const PROTAGONIST_NAME = 'Leo Marlow';
export const CREW_NAME = 'Marisol crew';

// ---------------------------------------------------------------- city layout
// The city is a square grid of blocks. Roads run north-south (avenues, along z)
// and east-west (streets, along x). The beach and ocean sit on the west edge
// (negative x), so the sunset light comes in over the water.
export const CITY = {
  halfSize: 240, // playable city spans x/z in [-240, 240]
  blockSize: 60, // one city block, edge to edge, in metres
  roadWidth: 14, // asphalt width of every road
  sidewalkWidth: 5, // pavement strip on each side of every road
  laneWidth: 3.5, // one traffic lane
  roadCenters: [-180, -120, -60, 0, 60, 120, 180], // centre lines, both axes
  groundY: 0,
  // Beach strip west of the city, then open ocean out to the horizon.
  beachStartX: -240, // sand begins at the city edge
  beachEndX: -272, // sand meets the water here
  oceanEndX: -900, // far edge of the water plane
  oceanZHalf: 900,
};

export const CITY_BOUNDS = {
  minX: -272,
  maxX: 240,
  minZ: -240,
  maxZ: 240,
};

// How far the camera can see before fog swallows the city.
export const VIEW = {
  fogNear: 140,
  fogFar: 620,
  cameraFar: 1600,
  skyTop: 0x7fb4dd,
  skyHorizon: 0xffd9a0,
};

// ------------------------------------------------------------- movement speeds
// Speeds are metres per second. Driving uses arcade acceleration, not a sim.
export const PLAYER = {
  walkSpeed: 4.2,
  runSpeed: 7.4,
  crouchSpeed: 2.2,
  jumpSpeed: 6.5,
  gravity: 18,
  radius: 0.45, // collision capsule radius
  height: 1.8,
  health: 100,
  maxHealth: 100,
  turnSpeed: 10, // radians per second, facing the move direction
  enterCarRange: 3.2, // how close to a car door to press E
  interactRange: 2.6, // how close to a pickup / marker to press F
};

export const CAR = {
  topSpeed: 34, // m/s, fastest street car (~122 km/h)
  cruiseSpeed: 16, // traffic cars cruise near this
  acceleration: 14,
  brakeDeceleration: 26,
  handbrakeDeceleration: 34,
  reverseSpeed: 10,
  steerAngle: 0.55, // max front-wheel angle, radians
  steerSpeed: 2.6,
  grip: 5.2, // how fast lateral slide is damped out
  trafficSpeed: 11,
  trafficGap: 9, // metres a traffic car keeps to the car ahead
  spawnAheadDistance: 55,
  despawnDistance: 130,
  maxTrafficCars: 14,
  stealTime: 1.4, // seconds the steal animation / prompt takes
};

// Car body styles the vehicle module can build from these numbers.
export const CAR_TYPES = {
  sedan: { length: 4.4, width: 1.9, height: 1.35, topSpeed: 32, accel: 13, label: 'Sedan' },
  hatch: { length: 3.9, width: 1.8, height: 1.45, topSpeed: 29, accel: 15, label: 'Hatch' },
  coupe: { length: 4.3, width: 1.9, height: 1.2, topSpeed: 36, accel: 15, label: 'Coupe' },
  van: { length: 5.0, width: 2.0, height: 1.9, topSpeed: 26, accel: 10, label: 'Van' },
  pickup: { length: 4.8, width: 2.0, height: 1.7, topSpeed: 30, accel: 12, label: 'Pickup' },
  police: { length: 4.5, width: 1.95, height: 1.4, topSpeed: 38, accel: 17, label: 'Patrol car' },
};

// Paint colours for traffic and parked cars (hex numbers, bright golden-hour set).
export const CAR_COLORS = [
  0xd94f3d, 0x3d7bd9, 0xe8b93c, 0xeeeee6, 0x2f3336, 0x7fb069,
  0xc96f9b, 0x4fb3a9, 0xe07b39, 0x8a7bd9, 0xb8c4cc, 0x5a8f5a,
];

// --------------------------------------------------------------- wanted levels
// Stars 0-5. Heat rises with crimes and falls when the player stays out of sight.
export const WANTED = {
  maxStars: 5,
  // Heat points needed to reach each star level (index = stars).
  thresholds: [0, 25, 60, 120, 200, 320],
  heatPerCrime: {
    stealCar: 30,
    shootPedestrian: 45,
    shootPolice: 70,
    hitPedestrian: 20,
    speedingNearPolice: 8,
    killPolice: 90,
  },
  heatDecayPerSecond: 2.2, // only while no police can see the player
  heatDecayInSightPerSecond: 0.4,
  policeSightRange: 55,
  policeSightRangeOnFoot: 34,
  // How many police units hunt the player at each star level (index = stars).
  policeCarsPerStar: [0, 1, 1, 2, 3, 4],
  policeFootPerStar: [0, 0, 1, 2, 3, 4],
  bustRange: 2.4, // an officer this close on foot busts the player
  bustTime: 2.0, // seconds inside bust range before the bust lands
  escapeRadius: 90, // get this far from every police unit to start cooling down
  wantedClearDelay: 6, // seconds hidden before stars start dropping
};

// --------------------------------------------------------------------- combat
export const COMBAT = {
  pistolDamage: 34,
  pistolRange: 60,
  pistolMagazine: 12,
  pistolReserveStart: 48,
  pistolFireInterval: 0.28, // seconds between shots
  pistolReloadTime: 1.4,
  punchDamage: 12,
  punchRange: 2.0,
  punchInterval: 0.45,
  pedestrianHealth: 40,
  policeHealth: 80,
  playerRegenDelay: 8, // seconds after last damage before slow regen
  playerRegenPerSecond: 6,
};

// ------------------------------------------------------------------- missions
// Five story missions. Rewards in dollars; the save module persists them.
export const MISSIONS = [
  {
    id: 'first-fare',
    title: 'First Fare',
    brief: 'Pick up the getaway car and drive it to the drop-off marker.',
    reward: 150,
    markerKey: 'garage',
    targetKey: 'dropoff',
  },
  {
    id: 'the-pickup',
    title: 'The Pickup',
    brief: 'Collect the package on foot and slip past the patrols.',
    reward: 220,
    markerKey: 'package',
    targetKey: 'package',
  },
  {
    id: 'hot-wheels',
    title: 'Hot Wheels',
    brief: 'Steal the marked coupe and deliver it to the chop shop.',
    reward: 350,
    markerKey: 'showroom',
    targetKey: 'chop-shop',
  },
  {
    id: 'heat-wave',
    title: 'Heat Wave',
    brief: 'Lose a 3-star wanted level. Break line of sight and lie low.',
    reward: 400,
    markerKey: 'hideout',
    targetKey: 'hideout',
    wantedOnStart: 3,
  },
  {
    id: 'the-big-score',
    title: 'The Big Score',
    brief: 'Grab the cash from the bank and escape with a 4-star wanted level.',
    reward: 900,
    markerKey: 'bank',
    targetKey: 'hideout',
    wantedOnStart: 4,
  },
];

export const MONEY = {
  startCash: 120,
  cashPickupValues: [25, 50, 50, 75, 100],
  cashPickupCount: 12,
  stuntJumpReward: 60,
  pedestrianDropChance: 0.25,
  pedestrianDropValue: 15,
};

// ------------------------------------------------------------ pedestrians / AI
export const PEDESTRIANS = {
  count: 26,
  walkSpeedMin: 0.9,
  walkSpeedMax: 1.7,
  fleeSpeed: 5.2,
  fleeRadius: 14, // gunshots / speeding cars inside this scare them
  sidewalkMargin: 1.2,
};

// ------------------------------------------------------------------ city look
// Building heights and colours. Warm stucco, pastel paint and glass, so the
// skyline reads bright and cheerful at golden hour, never grey.
export const BUILDINGS = {
  minHeight: 9,
  maxHeight: 46,
  tallChance: 0.22, // chance a building is a tower instead of a low block
  towerMinHeight: 42,
  towerMaxHeight: 78,
  minFootprint: 16,
  roofColors: [0x8a6f5c, 0x6f7d84, 0x9c8a76, 0x5c6e7a],
};

export const BUILDING_COLORS = [
  0xf2e3c6, 0xe8c9a0, 0xd9a679, 0xf5d7d0, 0xcfe0d8, 0xf7ead1,
  0xe6b8a2, 0xbcd3e6, 0xe9d8a6, 0xd8c2b8, 0xa8c8b8, 0xf0c987,
];

export const WINDOW_COLORS = {
  lit: 0xffd98a,
  dark: 0x2c3e50,
  glass: 0x7fb8d9,
};

// Street furniture and nature.
export const PROPS = {
  palmSpacing: 26, // metres between palms along the beach road
  lampSpacing: 30, // metres between streetlights along each road
  lampHeight: 6.5,
  benchChance: 0.35, // per block corner, roughly
  signChance: 0.5,
};

// ------------------------------------------------------------- golden-hour sky
// Low warm sun from the west (over the ocean), cool blue fill from the sky.
export const LIGHTING = {
  sunColor: 0xffb45e,
  sunIntensity: 2.6,
  sunElevationDegrees: 22, // low sun, long shadows
  sunAzimuthDegrees: 262, // almost due west, just south of it
  hemisphereSky: 0x9fc4e8,
  hemisphereGround: 0xc9a06a,
  hemisphereIntensity: 0.75,
  ambientIntensity: 0.25,
  fogColor: 0xf2c98f,
  skyColor: 0x8fc0e8,
  oceanColor: 0x2e7f9e,
  oceanDeepColor: 0x1d5a74,
  sandColor: 0xe8d29a,
  asphaltColor: 0x3a3f45,
  sidewalkColor: 0xb8b0a0,
  curbColor: 0x8f887a,
  grassColor: 0x7fae62,
  roadMarkColor: 0xf5e9c8,
};

// ------------------------------------------------------------------- gameplay
// Third-person follow camera: how far back and how high it sits, on foot and
// while driving (driving pulls the camera back so the road ahead stays visible).
export const CAMERA = {
  onFootDistance: 7.5,
  onFootHeight: 4.2,
  drivingDistance: 11,
  drivingHeight: 5,
  lookAhead: 4,
  fov: 62,
  near: 0.1,
};

// Minimap: a top-down canvas in the HUD corner, drawn from the city data.
export const MINIMAP = {
  sizePx: 190,
  worldRadius: 260, // metres shown from the player to each edge
  playerColor: 0xffffff,
  policeColor: 0x3d7bd9,
  missionColor: 0xffd23c,
  carColor: 0xe8e8e8,
};

export const GAMEPLAY = {
  missionMarkerRadius: 3.5, // drive / walk inside this to complete a leg
  markerBobHeight: 0.5,
  markerSpinSpeed: 1.2,
  stuntJumpSpeed: 18, // minimum speed to trigger a stunt jump reward
  timeScale: 1,
  dayLengthSeconds: 600, // cosmetic clock; the sun stays golden hour
  startHour: 17,
  startMinute: 40,
};

// Screenshot mode: fixed seeds so each staged shot renders identically.
export const SHOT_SEEDS = {
  cover: 101,
  drive: 202,
  chase: 303,
  mission: 404,
};
export const DEFAULT_SEED = 20261117;

// Small derived helpers other modules may use instead of recomputing.
export function roadCenter(index) {
  return CITY.roadCenters[index];
}

export function isOnRoad(x, z) {
  const half = CITY.roadWidth / 2;
  for (const c of CITY.roadCenters) {
    if (Math.abs(x - c) <= half) return true;
    if (Math.abs(z - c) <= half) return true;
  }
  return false;
}

export function clampToCity(x, z) {
  return {
    x: Math.max(CITY_BOUNDS.minX, Math.min(CITY_BOUNDS.maxX, x)),
    z: Math.max(CITY_BOUNDS.minZ, Math.min(CITY_BOUNDS.maxZ, z)),
  };
}

// Convert accumulated heat points into a star level (0-5) for the police module.
export function starsForHeat(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED.thresholds.length; i++) {
    if (heat >= WANTED.thresholds[i]) stars = i;
  }
  return Math.min(WANTED.maxStars, stars);
}
