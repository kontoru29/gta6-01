// config.js — every tuning number for Solmar Bay, in one place.
//
// The game balances on these values: the city layout, how fast Leo and
// the cars move, how the wanted level grows, what missions pay, what the
// crowd looks like, and how the golden-hour light is set up. Modules
// import the tables they need; this file itself is only data plus four
// tiny helpers, and it never touches three.js.

// --------------------------------------------------------------- who / where
export const GAME_TITLE = 'Solmar Bay';
export const GAME_SUBTITLE = 'A Marisol Bay story';
export const PROTAGONIST_NAME = 'Leo Marlow';
export const CREW_NAME = 'Marisol crew';

// The city is a square grid: avenues run along z, streets along x. The
// beach and the ocean sit to the west (negative x), which is why the low
// sun comes in off the water in the evening.
export const CITY = {
  halfSize: 240,
  blockSize: 60,
  roadWidth: 14,
  sidewalkWidth: 5,
  laneWidth: 3.5,
  roadCenters: [-180, -120, -60, 0, 60, 120, 180],
  groundY: 0,
  beachStartX: -240,
  beachEndX: -272,
  oceanEndX: -900,
  oceanZHalf: 900,
};

export const CITY_BOUNDS = {
  minX: -272,
  maxX: 240,
  minZ: -240,
  maxZ: 240,
};

export const VIEW = {
  fogNear: 140,
  fogFar: 620,
  cameraFar: 1600,
  skyTop: 0x7fb4dd,
  skyHorizon: 0xffd9a0,
};

// ------------------------------------------------------------ moving around
// All speeds are metres per second. Driving stays arcade, never a sim.
export const PLAYER = {
  walkSpeed: 4.2,
  runSpeed: 7.4,
  crouchSpeed: 2.2,
  jumpSpeed: 6.5,
  gravity: 18,
  radius: 0.45,
  height: 1.8,
  health: 100,
  maxHealth: 100,
  turnSpeed: 10,
  enterCarRange: 3.2,
  interactRange: 2.6,
};

export const CAR = {
  topSpeed: 34,
  cruiseSpeed: 16,
  acceleration: 14,
  brakeDeceleration: 26,
  handbrakeDeceleration: 34,
  reverseSpeed: 10,
  steerAngle: 0.55,
  steerSpeed: 2.6,
  grip: 5.2,
  trafficSpeed: 11,
  trafficGap: 9,
  spawnAheadDistance: 55,
  despawnDistance: 130,
  maxTrafficCars: 14,
  stealTime: 1.4,
};

// Every body style the vehicle builder can stamp out, with its footprint
// and its pace. Roadster and supercar sit at the quick end of the list.
export const CAR_TYPES = {
  sedan: { length: 4.4, width: 1.9, height: 1.35, topSpeed: 32, accel: 13, label: 'Sedan' },
  hatch: { length: 3.9, width: 1.8, height: 1.45, topSpeed: 29, accel: 15, label: 'Hatch' },
  coupe: { length: 4.3, width: 1.9, height: 1.2, topSpeed: 36, accel: 15, label: 'Coupe' },
  van: { length: 5.0, width: 2.0, height: 1.9, topSpeed: 26, accel: 10, label: 'Van' },
  pickup: { length: 4.8, width: 2.0, height: 1.7, topSpeed: 30, accel: 12, label: 'Pickup' },
  police: { length: 4.5, width: 1.95, height: 1.4, topSpeed: 38, accel: 17, label: 'Patrol car' },
  roadster: { length: 4.2, width: 1.9, height: 1.15, topSpeed: 48, accel: 20, label: 'Roadster' },
  supercar: { length: 4.4, width: 2.0, height: 1.1, topSpeed: 52, accel: 22, label: 'Supercar' },
};

// Sports cars and motorbikes: how rare they are in traffic and how fast
// they go. These numbers must stay in step with vehicles.js and police.js.
export const VEHICLES = {
  sportTrafficChance: 0.12,
  sportParkedChance: 0.15,
  bikeCruiseSpeed: 16,
  bikeTopSpeed: 21,
  bikeTrafficCount: 5,
  bikeWeave: 1.6,
  policeBikeTopSpeed: 33,
  policeBikeTurnRate: 3.6,
};

// Bright golden-hour paint for traffic and parked cars.
export const CAR_COLORS = [
  0xd94f3d, 0x3d7bd9, 0xe8b93c, 0xeeeee6, 0x2f3336, 0x7fb069,
  0xc96f9b, 0x4fb3a9, 0xe07b39, 0x8a7bd9, 0xb8c4cc, 0x5a8f5a,
];

// ------------------------------------------------------------ wanted level
// Stars 0-5. Heat climbs with crimes and cools when Leo stays out of
// sight; the police force at each star level is listed per index.
export const WANTED = {
  maxStars: 5,
  thresholds: [0, 25, 60, 120, 200, 320],
  heatPerCrime: {
    stealCar: 30,
    shootPedestrian: 45,
    shootPolice: 70,
    hitPedestrian: 20,
    speedingNearPolice: 8,
    killPolice: 90,
  },
  heatDecayPerSecond: 2.2,
  heatDecayInSightPerSecond: 0.4,
  policeSightRange: 55,
  policeSightRangeOnFoot: 34,
  policeCarsPerStar: [0, 1, 1, 2, 3, 4],
  policeFootPerStar: [0, 0, 1, 2, 3, 4],
  policeBikesPerStar: [0, 0, 1, 1, 2, 2],
  bustRange: 2.4,
  bustTime: 2.0,
  escapeRadius: 90,
  wantedClearDelay: 6,
};

// ------------------------------------------------------------ combat numbers
export const COMBAT = {
  pistolDamage: 34,
  pistolRange: 60,
  pistolMagazine: 12,
  pistolReserveStart: 48,
  pistolFireInterval: 0.28,
  pistolReloadTime: 1.4,
  punchDamage: 12,
  punchRange: 2.0,
  punchInterval: 0.45,
  pedestrianHealth: 40,
  policeHealth: 80,
  playerRegenDelay: 8,
  playerRegenPerSecond: 6,
};

// ------------------------------------------------------------ the story
// Five missions, in order. Rewards are dollars; the save file remembers
// which ones are finished.
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

// ------------------------------------------------------------ the crowd
export const PEDESTRIANS = {
  count: 26,
  walkSpeedMin: 0.9,
  walkSpeedMax: 1.7,
  fleeSpeed: 5.2,
  fleeRadius: 14,
  sidewalkMargin: 1.2,
};

// ------------------------------------------------------------ buildings
// Warm stucco, pastel paint and glass — the skyline stays bright at
// golden hour instead of turning grey.
export const BUILDINGS = {
  minHeight: 9,
  maxHeight: 46,
  tallChance: 0.22,
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

export const PROPS = {
  palmSpacing: 26,
  lampSpacing: 30,
  lampHeight: 6.5,
  benchChance: 0.35,
  signChance: 0.5,
};

// ------------------------------------------------------------ light + camera
// Low warm sun from the west, over the ocean; cool blue fill from above.
export const LIGHTING = {
  sunColor: 0xffb45e,
  sunIntensity: 2.6,
  sunElevationDegrees: 22,
  sunAzimuthDegrees: 262,
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

// On foot the camera hangs close; driving pulls it back so more of the
// road ahead stays in frame.
export const CAMERA = {
  onFootDistance: 7.5,
  onFootHeight: 4.2,
  drivingDistance: 11,
  drivingHeight: 5,
  lookAhead: 4,
  fov: 62,
  near: 0.1,
};

export const MINIMAP = {
  sizePx: 190,
  worldRadius: 260,
  playerColor: 0xffffff,
  policeColor: 0x3d7bd9,
  missionColor: 0xffd23c,
  carColor: 0xe8e8e8,
};

export const GAMEPLAY = {
  missionMarkerRadius: 3.5,
  markerBobHeight: 0.5,
  markerSpinSpeed: 1.2,
  stuntJumpSpeed: 18,
  timeScale: 1,
  dayLengthSeconds: 600,
  startHour: 17,
  startMinute: 40,
};

// Fixed seeds so every staged screenshot renders the same way twice.
export const SHOT_SEEDS = {
  cover: 101,
  drive: 202,
  chase: 303,
  mission: 404,
};
export const DEFAULT_SEED = 20261117;

// ------------------------------------------------------------ small helpers
// The centre line of a road, by grid index.
export function roadCenter(index) {
  return CITY.roadCenters[index];
}

// True when a point sits on an avenue or a street.
export function isOnRoad(x, z) {
  const half = CITY.roadWidth / 2;
  for (const c of CITY.roadCenters) {
    if (Math.abs(x - c) <= half) return true;
    if (Math.abs(z - c) <= half) return true;
  }
  return false;
}

// Pull a point back inside the city rectangle.
export function clampToCity(x, z) {
  return {
    x: Math.max(CITY_BOUNDS.minX, Math.min(CITY_BOUNDS.maxX, x)),
    z: Math.max(CITY_BOUNDS.minZ, Math.min(CITY_BOUNDS.maxZ, z)),
  };
}

// Turn accumulated heat points into a star level, 0 to 5.
export function starsForHeat(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED.thresholds.length; i += 1) {
    if (heat >= WANTED.thresholds[i]) stars = i;
  }
  return Math.min(WANTED.maxStars, stars);
}
