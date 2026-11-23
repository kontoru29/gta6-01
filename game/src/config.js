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
export const GAME_VERSION = 'Round 8';
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
// The sport coupe is the crew's favourite: quick, grippy, and common
// enough in traffic that a stolen one does not stand out at once.
export const CAR_TYPES = {
  sedan: { length: 4.4, width: 1.9, height: 1.35, topSpeed: 32, accel: 13, label: 'Sedan' },
  hatch: { length: 3.9, width: 1.8, height: 1.45, topSpeed: 29, accel: 15, label: 'Hatch' },
  coupe: { length: 4.3, width: 1.9, height: 1.2, topSpeed: 36, accel: 15, label: 'Coupe' },
  sport: { length: 4.3, width: 1.95, height: 1.18, topSpeed: 44, accel: 19, label: 'Sport' },
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

// Bright golden-hour paint for traffic and parked cars. The last three
// are new for Round 7: a teal sport paint, a sunset orange and a cream.
export const CAR_COLORS = [
  0xd94f3d, 0x3d7bd9, 0xe8b93c, 0xeeeee6, 0x2f3336, 0x7fb069,
  0xc96f9b, 0x4fb3a9, 0xe07b39, 0x8a7bd9, 0xb8c4cc, 0x5a8f5a,
  0x1f8a7a, 0xe86a2c, 0xf2e6c9,
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
  // Round 7 adds a close-range shotgun: six pellets per shell, brutal up
  // close, useless past a street's width. Found in the new missions.
  shotgunDamage: 18,
  shotgunPellets: 6,
  shotgunRange: 28,
  shotgunMagazine: 6,
  shotgunReserveStart: 30,
  shotgunFireInterval: 0.9,
  shotgunReloadTime: 2.2,
  shotgunSpread: 0.09,
  // Round 8 adds the alley arsenal: an SMG for close work, a rifle for
  // reaching across a plaza, and a bat for the quiet option.
  smgDamage: 14,
  smgRange: 34,
  smgMagazine: 30,
  smgReserveStart: 90,
  smgFireInterval: 0.11,
  smgReloadTime: 1.7,
  smgSpread: 0.05,
  rifleDamage: 55,
  rifleRange: 90,
  rifleMagazine: 6,
  rifleReserveStart: 30,
  rifleFireInterval: 0.85,
  rifleReloadTime: 2.6,
  rifleSpread: 0.005,
  batDamage: 28,
  batRange: 2.4,
  batInterval: 0.45,
};

// Sprint stamina: running drains it, walking and standing refill it. Leo
// cannot sprint again until it climbs back past the floor, so a chase
// costs something instead of being free forever.
export const STAMINA = {
  max: 100,
  drainPerSecond: 18,
  regenPerSecond: 12,
  minToRun: 25,
};

// ------------------------------------------------------------ the story
// Ten missions, in order. Rewards are dollars; the save file remembers
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
  {
    id: 'midnight-run',
    title: 'Midnight Run',
    brief: 'Smuggle the shipment from the pier to the hideout before the patrols close in.',
    reward: 550,
    markerKey: 'pier',
    targetKey: 'hideout',
  },
  {
    id: 'the-getaway',
    title: 'The Getaway',
    brief: 'The crew needs a clean sport coupe. Steal the marked one and bring it to the chop shop, fast.',
    reward: 700,
    markerKey: 'showroom',
    targetKey: 'chop-shop',
  },
  {
    id: 'night-shift',
    title: 'Night Shift at the Docks',
    brief: 'Report to the North Docks, fetch the crate from the warehouse and run it to the dropoff.',
    reward: 900,
    markerKey: 'docks',
    targetKey: 'dropoff',
  },
  {
    id: 'storm-run',
    title: 'Storm Run',
    brief: 'Take the flatbed from the crane yard in the storm and run the load to the pier, then lose the heat.',
    reward: 1400,
    markerKey: 'craneYard',
    targetKey: 'pier',
  },
  {
    id: 'the-broker',
    title: 'The Broker',
    brief: 'Carry the broker’s ledger from the alley to the North Docks and hand it over clean.',
    reward: 2000,
    markerKey: 'alley',
    targetKey: 'docks',
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

// ------------------------------------------------------------ districts
// The six named districts of Marisol Bay, each with its rectangle and its
// own building palette. The city builder paints each district from its
// own colours, so Downtown reads glassy and tall, Mercado reads low and
// warm, and Coral Shore reads pale and seaside.
export const DISTRICTS = [
  {
    name: 'BEACH', minX: -272, maxX: -228, minZ: -240, maxZ: 240,
    palette: [0xf2e3c6, 0xe8d29a, 0xf5d7d0],
  },
  {
    name: 'DOWNTOWN', minX: -60, maxX: 180, minZ: -240, maxZ: 0,
    palette: [0xbcd3e6, 0xd8c2b8, 0xe9d8a6],
  },
  {
    name: 'MERCADO', minX: -180, maxX: 60, minZ: 0, maxZ: 240,
    palette: [0xe8c9a0, 0xd9a679, 0xe6b8a2],
  },
  {
    name: 'CORAL SHORE', minX: -240, maxX: -180, minZ: -240, maxZ: 0,
    palette: [0xf5d7d0, 0xcfe0d8, 0xf7ead1],
  },
  {
    name: 'MARINA', minX: -60, maxX: 180, minZ: 180, maxZ: 240,
    palette: [0xa8c8b8, 0xbcd3e6, 0xf0c987],
  },
  {
    name: 'OLD TOWN', minX: -180, maxX: -60, minZ: -180, maxZ: 180,
    palette: [0xd9a679, 0x8a6f5c, 0xe9d8a6],
  },
  {
    name: 'NORTH DOCKS', minX: 192, maxX: 238, minZ: -238, maxZ: -192,
    palette: [0x8a8d90, 0xb8433a, 0x3a6db8],
  },
];

// Find the district a point sits in, or null outside the city.
export function districtAt(x, z) {
  for (const d of DISTRICTS) {
    if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) return d;
  }
  return null;
}

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
// road ahead stays in frame. The driving distance eases between the two
// factors as the car speeds up: close in when parking, open at speed.
export const CAMERA = {
  onFootDistance: 7.5,
  onFootHeight: 4.2,
  drivingDistance: 11,
  drivingHeight: 5,
  closeDistanceFactor: 0.72,
  farDistanceFactor: 0.28,
  lookAhead: 4,
  fov: 62,
  near: 0.1,
  cameraFar: 1600,
};

// Free-roam earnings, shared by the mission manager so the numbers live
// in one place: how fast a jump must be, how long a jump or a photo spot
// waits before it pays again, how long a held photo takes, how fast a
// collected cash pickup comes back, and what a stolen car fences for.
export const FREE_ROAM = {
  stuntMinSpeed: 24,
  stuntCooldownSeconds: 30,
  photoHoldSeconds: 3,
  photoCooldownSeconds: 60,
  pickupRespawnSeconds: 120,
  carTheftReward: 100,
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

// ------------------------------------------------------------ Round 8 systems
// Day and night, weather, the garage, the side jobs, the alley arsenal
// and the North Docks all tune from here. The weather module owns the
// clock and the sky; the garage, side activities and arsenal own their
// shops; the numbers below are the shared source of truth for prices,
// payouts and grip so the modules never disagree.

// A full day is 600 seconds of game time, split into dawn, day, dusk
// and night. The weather system blends the light between these stops.
export const WEATHER = {
  dayLengthSeconds: 600,
  startHour: 17,
  startMinute: 40,
  nightStartHour: 20,
  nightEndHour: 6,
  changeIntervalSeconds: 45,
  rainChance: 0.3,
  stormChance: 0.12,
  fogChance: 0.15,
  overcastChance: 0.35,
  rainGrip: 0.88,
  stormGrip: 0.78,
  fogVisibility: 140,
  stormVisibility: 180,
  rainParticles: 600,
  nightTopSpeedBonus: 0,
};

// The garage at (-120, -120): what a repaint, a set of wheels, an
// engine stage and an armour stage cost, and what each stage buys.
export const GARAGE = {
  point: { x: -120, z: -120 },
  radius: 12,
  paintPrices: { standard: 150, premium: 200, exotic: 400 },
  wheelPrices: { street: 0, sport: 400, muscle: 900, offroad: 700 },
  enginePrices: [0, 800, 1600, 3200],
  engineTopSpeedBonus: [0, 0.09, 0.18, 0.3],
  engineAccelBonus: [0, 0.08, 0.16, 0.26],
  armorPrices: [0, 600, 1200, 2400],
  armorDamageReduction: [0, 0.12, 0.24, 0.36],
};

// Side jobs: taxi fares from the plaza, courier runs from the garage,
// three street races and ten hidden packages around the city.
export const SIDE = {
  taxiPoint: 'plaza',
  taxiRadius: 14,
  taxiBasePay: 60,
  taxiPerMetre: 0.35,
  taxiTimeBonus: 40,
  courierPoint: 'garage',
  courierRadius: 10,
  courierBasePay: 100,
  courierPerMetre: 0.5,
  courierTimeBonus: 60,
  raceRewards: { 'plaza-loop': 300, 'beach-sprint': 350, 'docks-dash': 400 },
  raceParSeconds: { 'plaza-loop': 75, 'beach-sprint': 60, 'docks-dash': 70 },
  packageReward: 100,
  packageCount: 10,
};

// The alley arsenal at (-60, -60): hardware prices and ammo boxes.
export const ARSENAL = {
  point: { x: -60, z: -60 },
  radius: 10,
  weaponPrices: { bat: 300, smg: 1200, rifle: 2500 },
  ammoIncluded: { smg: 90, rifle: 30 },
  ammoPackPrices: { pistol: 40, shotgun: 80, smg: 60, rifle: 120 },
  ammoPackAmounts: { pistol: 24, shotgun: 16, smg: 60, rifle: 20 },
};

// The North Docks yard: where it sits, how many hands work it, and
// what the smuggler's cache pays.
export const DOCKS = {
  minX: 192, maxX: 238, minZ: -238, maxZ: -192,
  centreX: 215, centreZ: -215,
  points: {
    docks: { x: 215, z: -215 },
    warehouse: { x: 228, z: -230 },
    craneYard: { x: 202, z: -202 },
    gate: { x: 210, z: -192 },
    cache: { x: 224, z: -204 },
  },
  workerCount: 3,
  craneCount: 2,
  cacheReward: 150,
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
