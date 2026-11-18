// city.js — Solmar Bay procedural town: roads, buildings, beach, sky.
//
// buildCity(scene, options) populates a three.js scene with the whole
// playable island city and returns the world object every other module
// plays against: the road graph traffic drives on, the building and prop
// colliders, the walkable ground, the car spawn spots, and the named
// places (player start, police station, one marker per mission). The
// lighting is golden hour — a low warm sun over the ocean, a pale sky,
// light haze — so every screenshot shares the same warm look. The whole
// layout is seeded, so a given seed always grows the same town.
//
// The town is a colourful seaside place, not a beige office park:
// stucco facades in sixteen coastal colours, roofs in six, windows that
// mix warm lamplight with cool glass, glowing neon on the beachfront
// shops, palms and leafy trees down every street, and the Oceana Hotel
// tower plus a ferris wheel as landmarks at the north end of the avenue.
//
// Interface
//   buildCity(scene, options?) -> world
//     options: { seed?: number, rng?: object, palms?: boolean, lamps?: boolean }
//     world: {
//       group, roads, lanes, trafficLoops, roadSegments, colliders,
//       walkableAreas, spawnPoints, missionMarkers, policeStation, carSpawns,
//       bounds, ocean, seed, lights,
//       update(dt, time),       // ocean swell + palm / canopy sway, per frame
//       nearestRoadPoint(x, z), // closest point on a road centre line
//       isWalkable(x, z),       // true on sidewalks, plazas and the beach
//     }
//   spawnPoints: { playerStart, policeStation, beach, plaza, garage, ... }
//   missionMarkers: { garage, dropoff, package, showroom, 'chop-shop',
//                     hideout, bank, policeStation, beach, plaza }
//   A lane: { start:{x,z}, end:{x,z}, dir:{x,z}, axis:'x'|'z', road:number,
//             offset:number, length:number }
//   A traffic loop: [{x,z}, ...] closed rectangle of waypoints around a block.
//   A collider: { minX, maxX, minZ, maxZ, height, kind:'building'|'prop' }

import * as THREE from 'three';
import {
  CITY,
  CITY_BOUNDS,
  VIEW,
  BUILDINGS,
  BUILDING_COLORS,
  WINDOW_COLORS,
  LIGHTING,
  PROPS,
  DEFAULT_SEED,
} from './config.js';
import { createRng, clamp, distance2D } from './utils.js';

// ------------------------------------------------------------ coastal palette
// Sixteen warm stucco and pastel paints with a few cool notes, so the
// skyline reads as one colourful seaside town instead of identical boxes.
const FACADE_COLORS = [
  0xc96f4a, 0x9db08a, 0x7ba7c4, 0xf2e3c6, 0xb0523c, 0xd9a441,
  0x4f9a94, 0xe07856, 0xb0a8c0, 0xe8c9a0, 0xa8c8b8, 0xe6a583,
  0xd98a8a, 0x9cc4de, 0xe9d8a6, 0xc98a6b,
];
const ROOF_COLORS = [
  0xa85f3f, 0x5c6e7a, 0x6b4f3a, 0x9c8a76, 0x2f6f6a, 0x8a7a6a,
];
const ACCENT_COLORS = [0x4f9a94, 0xd9a441, 0xe07856, 0x7ba7c4, 0x8a6f8f];
const LEAF_GREENS = [0x4f8f3f, 0x6fae4f, 0x3f7a3a, 0x8fbf5a, 0x5a9e4a];
// Window tints for the facade canvas, as CSS strings with their weights.
const WINDOW_TINTS = [
  { color: '#ffd98a', weight: 0.3 },   // warm lit room
  { color: '#ffb35e', weight: 0.1 },   // amber lit room
  { color: '#7fb8d9', weight: 0.3 },   // cool daylight glass
  { color: '#4a7a9e', weight: 0.15 },  // deep glass
  { color: '#2c3e50', weight: 0.15 },  // dark room
];
// Neon sign words and their glow colours, for the beachfront and the hotel.
const NEON_SIGNS = [
  { word: 'CORAL', color: '#4fd8e8' },
  { word: 'PIER', color: '#ffb35e' },
  { word: 'HOTEL', color: '#a8e05e' },
  { word: 'BAR', color: '#ff8a5e' },
  { word: 'SUNSET', color: '#e08aff' },
];
// Painted shop boards for the street-level storefronts.
const SHOP_SIGNS = [
  'FARMACIA', 'ZAPATOS', 'FARO BOOKS', 'MANGO GYM', 'TIDELINE SURF', 'CAFE',
];
// Tall vertical blade neons, for the hotel tower and tall avenue buildings.
const VERTICAL_NEON = [
  { word: 'MIRAGE', color: '#4fd8e8' },
  { word: 'PALOMA', color: '#ff5e8a' },
  { word: 'CLUB VOLTAGE', color: '#e08aff' },
  { word: 'FLAMINGO FM', color: '#ff8a5e' },
];
// Awning colours for the shopfronts: red and teal, the coastal classic.
const AWNING_COLORS = [0xc93a3a, 0x2f7a72];

// ------------------------------------------------------------------ materials
// One shared material per colour keeps the draw list small and the town cheap.
const materialCache = new Map();
function mat(color, roughness) {
  const rough = roughness === undefined ? 0.9 : roughness;
  const key = color + ':' + rough;
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 });
    materialCache.set(key, m);
  }
  return m;
}

function boxMesh(width, height, depth, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------ canvas textures
// A canvas texture of lit and dark windows, drawn once per facade colour
// so towers do not look like flat coloured slabs from the street. The
// ground floor gets a darker shopfront band, the top gets a thin accent
// trim, and each window rolls its own tint — warm lit, amber lit, cool
// glass, deep glass or dark. The windows are drawn large (small padding)
// so a close-up wall still reads as windows, not wallpaper.
function facadeTexture(rng, baseColor, accentColor, floors, cols) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const baseHex = '#' + baseColor.toString(16).padStart(6, '0');
  const accentHex = '#' + accentColor.toString(16).padStart(6, '0');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Shopfront band along the ground floor: a darker strip with pale
  // shop windows, so the street level reads as storefronts, not wall.
  ctx.fillStyle = 'rgba(40, 30, 24, 0.55)';
  ctx.fillRect(0, canvas.height - 30, canvas.width, 30);
  ctx.fillStyle = 'rgba(255, 225, 170, 0.85)';
  const shopW = canvas.width / Math.max(2, cols);
  for (let c = 0; c < cols; c++) {
    ctx.fillRect(c * shopW + shopW * 0.18, canvas.height - 24, shopW * 0.64, 16);
  }
  // Thin accent trim just under the roofline.
  ctx.fillStyle = accentHex;
  ctx.fillRect(0, 0, canvas.width, 7);
  // Window grid: one tint roll per window, drawn large.
  const cellW = canvas.width / cols;
  const cellH = (canvas.height - 37) / floors;
  const padX = cellW * 0.12;
  const padY = cellH * 0.14;
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const roll = rng.next();
      let tint = WINDOW_TINTS[WINDOW_TINTS.length - 1].color;
      let acc = 0;
      for (const t of WINDOW_TINTS) {
        acc += t.weight;
        if (roll < acc) {
          tint = t.color;
          break;
        }
      }
      ctx.fillStyle = tint;
      ctx.fillRect(
        c * cellW + padX,
        7 + f * cellH + padY,
        cellW - padX * 2,
        cellH - padY * 2,
      );
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Glowing word on a transparent canvas, for neon signs and road boards.
// The glow comes from a blurred shadow under bold letters, so the sign
// reads as lit tubing at dusk without any font asset.
function textTexture(word, glowColor, fontPx) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '800 ' + (fontPx || 84) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 26;
  ctx.fillStyle = glowColor;
  ctx.fillText(word, canvas.width / 2, canvas.height / 2 + 4);
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(word, canvas.width / 2, canvas.height / 2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------------------------------------------ the builder
export function buildCity(scene, options) {
  const opts = options || {};
  const seed = opts.seed === undefined ? DEFAULT_SEED : opts.seed;
  const rng = opts.rng || createRng(seed);
  const group = new THREE.Group();
  group.name = 'SolmarBayCity';
  scene.add(group);

  const colliders = [];
  const walkableAreas = [];
  const lanes = [];
  const roadSegments = [];
  const trafficLoops = [];
  const carSpawns = [];
  const swayFronds = [];
  const swayCanopies = [];
  const lampHeads = [];

  // ---------------------------------------------------------- sky and lighting
  scene.background = new THREE.Color(LIGHTING.skyColor);
  scene.fog = new THREE.Fog(LIGHTING.fogColor, VIEW.fogNear, VIEW.fogFar);

  const sunAngle = (LIGHTING.sunElevationDegrees * Math.PI) / 180;
  const sunAzimuth = (LIGHTING.sunAzimuthDegrees * Math.PI) / 180;
  const sun = new THREE.DirectionalLight(LIGHTING.sunColor, LIGHTING.sunIntensity);
  sun.position.set(
    Math.cos(sunAngle) * Math.sin(sunAzimuth) * 320,
    Math.sin(sunAngle) * 320,
    Math.cos(sunAngle) * Math.cos(sunAzimuth) * 320,
  );
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -280;
  sun.shadow.camera.right = 280;
  sun.shadow.camera.top = 280;
  sun.shadow.camera.bottom = -280;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(
    LIGHTING.hemisphereSky,
    LIGHTING.hemisphereGround,
    LIGHTING.hemisphereIntensity,
  );
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffe0b3, LIGHTING.ambientIntensity);
  scene.add(ambient);

  // ------------------------------------------------------------- ground planes
  // Base ground under everything (warm pale grass / packed earth between blocks).
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY_BOUNDS.maxX - CITY_BOUNDS.minX + 40, 560),
    mat(0x9db07a, 1),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(-8, -0.05, 0);
  ground.receiveShadow = true;
  group.add(ground);

  // Beach sand west of the city, then the ocean out to the horizon.
  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY.beachStartX - CITY.beachEndX, 560),
    mat(LIGHTING.sandColor, 1),
  );
  sand.rotation.x = -Math.PI / 2;
  sand.position.set((CITY.beachStartX + CITY.beachEndX) / 2, 0.02, 0);
  sand.receiveShadow = true;
  group.add(sand);

  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY.beachEndX - CITY.oceanEndX, CITY.oceanZHalf * 2),
    new THREE.MeshStandardMaterial({
      color: LIGHTING.oceanColor,
      roughness: 0.25,
      metalness: 0.1,
    }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set((CITY.beachEndX + CITY.oceanEndX) / 2, -0.15, 0);
  ocean.receiveShadow = true;
  group.add(ocean);

  // A thin wet-sand band where the waves meet the beach.
  const shoreline = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 560),
    mat(0xd9c48a, 1),
  );
  shoreline.rotation.x = -Math.PI / 2;
  shoreline.position.set(CITY.beachEndX + 1, 0.04, 0);
  group.add(shoreline);

  // ------------------------------------------------------------ roads + lanes
  const roadMat = mat(LIGHTING.asphaltColor, 0.95);
  const markMat = mat(LIGHTING.roadMarkColor, 0.8);
  const sidewalkMat = mat(LIGHTING.sidewalkColor, 1);

  function addRoadStrip(cx, cz, width, length, alongX) {
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(alongX ? length : width, alongX ? width : length),
      roadMat,
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(cx, 0.06, cz);
    strip.receiveShadow = true;
    group.add(strip);
  }

  function addCentreDashes(cx, cz, length, alongX) {
    // Broken centre line: short pale dashes every 6 metres, skipping junctions.
    for (let d = -length / 2 + 3; d < length / 2 - 3; d += 6) {
      const nearJunction = CITY.roadCenters.some((c) => {
        const along = alongX ? cx + d : cz + d;
        return Math.abs(along - c) < CITY.roadWidth / 2 + 2;
      });
      if (nearJunction) continue;
      const dash = new THREE.Mesh(
        new THREE.PlaneGeometry(alongX ? 3 : 0.35, alongX ? 0.35 : 3),
        markMat,
      );
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(alongX ? cx + d : cx, 0.09, alongX ? cz : cz + d);
      group.add(dash);
    }
  }

  for (const c of CITY.roadCenters) {
    const span = CITY.halfSize * 2;
    // Avenue (north-south) and street (east-west) through the same centre line.
    addRoadStrip(c, 0, CITY.roadWidth, span, false);
    addRoadStrip(0, c, CITY.roadWidth, span, true);
    addCentreDashes(c, 0, span, false);
    addCentreDashes(0, c, span, true);

    // Two lanes per road, right-hand traffic: each lane runs one way.
    const off = CITY.laneWidth;
    lanes.push({
      start: { x: c - off, z: -CITY.halfSize }, end: { x: c - off, z: CITY.halfSize },
      dir: { x: 0, z: 1 }, axis: 'z', road: c, offset: -off, length: span,
    });
    lanes.push({
      start: { x: c + off, z: CITY.halfSize }, end: { x: c + off, z: -CITY.halfSize },
      dir: { x: 0, z: -1 }, axis: 'z', road: c, offset: off, length: span,
    });
    lanes.push({
      start: { x: -CITY.halfSize, z: c - off }, end: { x: CITY.halfSize, z: c - off },
      dir: { x: 1, z: 0 }, axis: 'x', road: c, offset: -off, length: span,
    });
    lanes.push({
      start: { x: CITY.halfSize, z: c + off }, end: { x: -CITY.halfSize, z: c + off },
      dir: { x: -1, z: 0 }, axis: 'x', road: c, offset: off, length: span,
    });
    roadSegments.push(
      { axis: 'z', at: c, min: -CITY.halfSize, max: CITY.halfSize },
      { axis: 'x', at: c, min: -CITY.halfSize, max: CITY.halfSize },
    );
  }

  // Beachfront promenade road along the west edge, where the palms stand.
  addRoadStrip(-228, 0, 10, CITY.halfSize * 2, false);

  // ------------------------------------------------------------ signage + shops
  // A glowing word sign on a building face. `face` is which way the sign
  // looks: 'north' (-z, toward the avenue cameras), 'south' (+z), 'west'
  // (-x, toward the ocean) or 'east' (+x). The word is drawn on a canvas
  // with a blurred glow and put on an unlit plane, so it reads as lit
  // tubing at dusk; a dark backing box sits just behind it.
  function addNeonSign(cx, cz, w, d, height, face, word, glowColor) {
    const tex = textTexture(word, glowColor, 84);
    if (!tex) return;
    const signW = Math.min(w * 0.8, 13);
    const signH = 2.4;
    const signY = Math.max(6, height * 0.72);
    const backing = boxMesh(signW + 0.8, signH + 0.8, 0.18, mat(0x1a1a22, 0.7), 0, 0, 0);
    backing.castShadow = false;
    const faceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(signW, signH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
    const sign = new THREE.Group();
    sign.add(backing);
    faceMesh.position.z = 0.12;
    sign.add(faceMesh);
    if (face === 'north') {
      sign.position.set(cx, signY, cz - d / 2 - 0.3);
      sign.rotation.y = Math.PI;
    } else if (face === 'south') {
      sign.position.set(cx, signY, cz + d / 2 + 0.3);
    } else if (face === 'west') {
      sign.position.set(cx - w / 2 - 0.3, signY, cz);
      sign.rotation.y = -Math.PI / 2;
    } else {
      sign.position.set(cx + w / 2 + 0.3, signY, cz);
      sign.rotation.y = Math.PI / 2;
    }
    group.add(sign);
  }

  // A shopfront awning: a thin coloured slab, slightly tilted, jutting
  // out from the facade at ground-floor height. Red and teal are the
  // coastal classic, and they make the street level read as shops.
  function addAwning(cx, cz, w, d, face, color) {
    const awn = boxMesh(1, 1, 1, mat(color, 0.9), 0, 0, 0);
    awn.castShadow = false;
    if (face === 'north' || face === 'south') {
      awn.scale.set(Math.min(w * 0.55, 12), 0.14, 1.5);
      awn.position.set(cx, 3.4, cz + (face === 'south' ? d / 2 + 0.7 : -d / 2 - 0.7));
      awn.rotation.x = face === 'south' ? 0.18 : -0.18;
    } else {
      awn.scale.set(1.5, 0.14, Math.min(d * 0.55, 12));
      awn.position.set(cx + (face === 'east' ? w / 2 + 0.7 : -w / 2 - 0.7), 3.4, cz);
      awn.rotation.z = face === 'east' ? -0.18 : 0.18;
    }
    group.add(awn);
  }

  // A painted shop board at storefront height: the word in cream on a
  // dark board, using the same canvas-text approach as the neon signs.
  function addShopSign(cx, cz, w, d, face, word) {
    const tex = textTexture(word, '#f4e8c8', 56);
    if (!tex) return;
    const boardW = Math.min(w * 0.6, 9);
    const boardH = 1.1;
    const signY = 4.6;
    const backing = boxMesh(boardW + 0.5, boardH + 0.5, 0.16, mat(0x2e5a4a, 0.8), 0, 0, 0);
    backing.castShadow = false;
    const faceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(boardW, boardH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
    faceMesh.position.z = 0.1;
    const sign = new THREE.Group();
    sign.add(backing);
    sign.add(faceMesh);
    if (face === 'north') {
      sign.position.set(cx, signY, cz - d / 2 - 0.28);
      sign.rotation.y = Math.PI;
    } else if (face === 'south') {
      sign.position.set(cx, signY, cz + d / 2 + 0.28);
    } else if (face === 'west') {
      sign.position.set(cx - w / 2 - 0.28, signY, cz);
      sign.rotation.y = -Math.PI / 2;
    } else {
      sign.position.set(cx + w / 2 + 0.28, signY, cz);
      sign.rotation.y = Math.PI / 2;
    }
    group.add(sign);
  }

  // A tall vertical blade neon: the word's letters stacked down a narrow
  // glowing panel that sticks out perpendicular to the facade, so it
  // reads from along the street. The canvas is tall and narrow, one
  // letter per line, with the same glow treatment as the neon signs.
  function addVerticalNeon(cx, cz, w, d, height, face, word, glowColor) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '800 64px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 22;
    ctx.fillStyle = glowColor;
    const letters = word.replace(/ /g, '').split('');
    const step = canvas.height / (letters.length + 1);
    letters.forEach((ch, i) => {
      ctx.fillText(ch, canvas.width / 2, step * (i + 1));
    });
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffffff';
    letters.forEach((ch, i) => {
      ctx.fillText(ch, canvas.width / 2, step * (i + 1));
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const bladeW = 1.5;
    const bladeH = 6;
    const signY = Math.max(8, height * 0.55);
    const backing = boxMesh(bladeW + 0.4, bladeH + 0.4, 0.16, mat(0x1a1a22, 0.7), 0, 0, 0);
    backing.castShadow = false;
    const faceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(bladeW, bladeH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
    faceMesh.position.z = 0.1;
    const blade = new THREE.Group();
    blade.add(backing);
    blade.add(faceMesh);
    // The blade sticks out perpendicular to the wall, at the building's
    // street-side corner, so it catches the eye from down the avenue.
    if (face === 'east') {
      blade.position.set(cx + w / 2 + 0.9, signY, cz - d / 2 + 2);
      blade.rotation.y = Math.PI / 2;
    } else if (face === 'west') {
      blade.position.set(cx - w / 2 - 0.9, signY, cz + d / 2 - 2);
      blade.rotation.y = -Math.PI / 2;
    } else if (face === 'north') {
      blade.position.set(cx + w / 2 - 2, signY, cz - d / 2 - 0.9);
      blade.rotation.y = Math.PI;
    } else {
      blade.position.set(cx - w / 2 + 2, signY, cz + d / 2 + 0.9);
    }
    group.add(blade);
  }

  // ---------------------------------------------------------------- buildings
  function addBuilding(cx, cz, w, d, height, colorHex, sign) {
    const floors = Math.max(2, Math.round(height / 3.2));
    const cols = Math.max(2, Math.round(w / 4));
    const accent = rng.pick(ACCENT_COLORS);
    const tex = facadeTexture(rng, colorHex, accent, floors, cols);
    let material;
    if (tex) {
      material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.02 });
    } else {
      material = mat(colorHex, 0.9);
    }
    const body = boxMesh(w, height, d, material, cx, height / 2 + 0.12, cz);
    group.add(body);
    // Flat roof cap, slightly wider, in a varied roof colour.
    const roof = boxMesh(w + 0.6, 0.5, d + 0.6, mat(rng.pick(ROOF_COLORS), 1), cx, height + 0.35, cz);
    group.add(roof);
    // Accent trim: a thin coloured band just under the roofline on most
    // buildings, so the top edge reads instead of blending into the sky.
    if (rng.chance(0.65)) {
      const trim = boxMesh(w + 0.3, 0.45, d + 0.3, mat(accent, 0.8), cx, height - 0.6, cz);
      trim.castShadow = false;
      group.add(trim);
    }
    // Rooftop clutter: a vent box, sometimes an antenna, sometimes a
    // water tank, sometimes a little rooftop garden on low buildings.
    if (rng.chance(0.55)) {
      const vent = boxMesh(2.2, 1.1, 2.2, mat(0x8f979e, 1), cx + w * 0.2, height + 1.1, cz - d * 0.15);
      group.add(vent);
    }
    if (rng.chance(0.3)) {
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 7, 6),
        mat(0x5a6068, 0.6),
      );
      mast.position.set(cx - w * 0.25, height + 3.8, cz + d * 0.2);
      mast.castShadow = true;
      group.add(mast);
    }
    if (rng.chance(0.25)) {
      const tank = new THREE.Mesh(
        new THREE.CylinderGeometry(1.1, 1.1, 2.2, 10),
        mat(0x7a8894, 0.8),
      );
      tank.position.set(cx - w * 0.2, height + 1.6, cz + d * 0.2);
      tank.castShadow = true;
      group.add(tank);
    }
    if (height < 20 && rng.chance(0.3)) {
      const garden = boxMesh(w * 0.4, 0.5, d * 0.4, mat(0x4f8f3f, 1), cx + w * 0.15, height + 0.85, cz - d * 0.1);
      garden.castShadow = false;
      group.add(garden);
    }
    // Optional neon sign on one face, placed after the body so the face
    // coordinates are known.
    if (sign) {
      addNeonSign(cx, cz, w, d, height, sign.face, sign.word, sign.color);
    }
    colliders.push({
      minX: cx - w / 2, maxX: cx + w / 2,
      minZ: cz - d / 2, maxZ: cz + d / 2,
      height, kind: 'building',
    });
    return body;
  }

  // The Oceana Hotel: the city's landmark tower on the north end of the
  // main avenue, tall and coral, with a pink neon sign facing down the
  // avenue toward the cameras and a glowing crown around its roof.
  function addLandmarkTower(cx, cz) {
    const height = 72;
    const w = 34;
    const d = 30;
    const body = addBuilding(cx, cz, w, d, height, 0xe07856, {
      face: 'north', word: 'OCEANA', color: '#ff5e8a',
    });
    body.name = 'OceanaHotel';
    // A vertical blade neon on the tower's avenue-facing side, so the
    // landmark reads from down the main drag as well as from the front.
    addVerticalNeon(cx, cz, w, d, height, 'east', 'PALOMA', '#ff5e8a');
    // Glowing crown: a thin emissive frame around the roof edge.
    const crownMat = new THREE.MeshBasicMaterial({ color: 0xff5e8a });
    const crownN = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.5, 0.5), crownMat);
    crownN.position.set(cx, height + 0.9, cz - d / 2 - 0.2);
    const crownS = crownN.clone();
    crownS.position.set(cx, height + 0.9, cz + d / 2 + 0.2);
    const crownW = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, d + 1), crownMat);
    crownW.position.set(cx - w / 2 - 0.2, height + 0.9, cz);
    const crownE = crownW.clone();
    crownE.position.set(cx + w / 2 + 0.2, height + 0.9, cz);
    group.add(crownN, crownS, crownW, crownE);
  }

  // ------------------------------------------------------- blocks and buildings
  const blockCenters = [-150, -90, -30, 30, 90, 150];

  for (const bx of blockCenters) {
    for (const bz of blockCenters) {
      // Sidewalk slab for the whole block, raised a touch above the road.
      const slabSize = CITY.blockSize - CITY.roadWidth;
      const slab = boxMesh(slabSize, 0.12, slabSize, sidewalkMat, bx, 0.06, bz);
      slab.castShadow = false;
      group.add(slab);
      walkableAreas.push({
        minX: bx - slabSize / 2, maxX: bx + slabSize / 2,
        minZ: bz - slabSize / 2, maxZ: bz + slabSize / 2,
      });

      // A few blocks are parks / plazas instead of buildings.
      const isPark = (bx === -30 && bz === 30) || (bx === 90 && bz === -90);
      const isPlaza = bx === 30 && bz === 30;
      if (isPark) {
        const lawn = new THREE.Mesh(
          new THREE.PlaneGeometry(slabSize - 8, slabSize - 8),
          mat(LIGHTING.grassColor, 1),
        );
        lawn.rotation.x = -Math.PI / 2;
        lawn.position.set(bx, 0.14, bz);
        lawn.receiveShadow = true;
        group.add(lawn);
        // A proper park: palms and leafy trees in clusters, not a bare lawn.
        addPalm(bx - 12, bz - 10);
        addPalm(bx + 12, bz + 8);
        addPalm(bx + 10, bz - 12);
        addLeafyTree(bx - 14, bz + 10, 1.1);
        addLeafyTree(bx + 14, bz - 6, 0.9);
        addLeafyTree(bx - 4, bz + 14, 1.2);
        addLeafyTree(bx + 2, bz - 14, 1.0);
        addLeafyTree(bx - 16, bz - 2, 0.8);
        addBench(bx, bz + 14);
        continue;
      }
      if (isPlaza) {
        // Open plaza with a fountain disc in the middle.
        const fountain = new THREE.Mesh(
          new THREE.CylinderGeometry(6, 6.5, 0.8, 24),
          mat(0x9fc4d8, 0.4),
        );
        fountain.position.set(bx, 0.5, bz);
        fountain.castShadow = true;
        fountain.receiveShadow = true;
        group.add(fountain);
        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(6.2, 0.4, 8, 28),
          mat(0xd8cfc0, 1),
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.set(bx, 0.9, bz);
        group.add(rim);
        colliders.push({
          minX: bx - 6.5, maxX: bx + 6.5, minZ: bz - 6.5, maxZ: bz + 6.5,
          height: 1, kind: 'prop',
        });
        addBench(bx - 14, bz + 14);
        addBench(bx + 14, bz - 14);
        // Plaza trees sit on the east side of the plaza, away from the
        // avenue and the screenshot cameras, so no canopy blocks a frame.
        addPalm(bx + 16, bz - 14);
        addPalm(bx + 16, bz + 14);
        addPalm(bx + 18, bz + 8);
        addPalm(bx + 18, bz - 8);
        addLeafyTree(bx + 16, bz + 12, 1.0);
        addLeafyTree(bx + 16, bz - 12, 1.1);
        addLeafyTree(bx + 12, bz - 16, 0.9);
        addLeafyTree(bx + 12, bz + 16, 0.9);
        continue;
      }

      // The police-station block is built separately after this loop, so
      // skip it here — otherwise two buildings would overlap on one block.
      const isStationBlock = bx === -90 && bz === 150;
      if (isStationBlock) continue;

      // The landmark tower stands on the north end of the main avenue.
      if (bx === -30 && bz === 150) {
        addLandmarkTower(bx, bz);
        continue;
      }

      // Normal block: one or two buildings filling most of the block.
      const inset = 4;
      const inner = slabSize - inset * 2;
      const tall = rng.chance(BUILDINGS.tallChance);
      const height = tall
        ? rng.range(BUILDINGS.towerMinHeight, BUILDINGS.towerMaxHeight)
        : rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight);
      // A few avenue-facing buildings get a neon sign on the side that
      // looks onto the road, so the signs read from the street and from
      // the screenshot cameras. The westmost blocks face the promenade.
      let sign = null;
      const facesAvenue = bx === -30 || bx === 30;
      const facesPromenade = bx === -150;
      const streetFace = facesAvenue
        ? (bx < 0 ? 'east' : 'west')
        : (facesPromenade ? 'west' : null);
      if (facesAvenue && rng.chance(0.3)) {
        const pick = rng.pick(NEON_SIGNS);
        sign = {
          face: bx < 0 ? 'east' : 'west',
          word: pick.word,
          color: pick.color,
        };
      } else if (facesPromenade && rng.chance(0.35)) {
        const pick = rng.pick(NEON_SIGNS);
        sign = { face: 'west', word: pick.word, color: pick.color };
      }
      // The first building of the block, for the street-level dressing:
      // an awning, a painted shop board, and (on tall avenue buildings)
      // a vertical blade neon.
      let fx = bx;
      let fw = inner;
      let fh = height;
      if (rng.chance(0.45)) {
        // Two buildings side by side, split along x.
        const w1 = inner * rng.range(0.42, 0.55);
        const w2 = inner - w1 - 3;
        const h2 = tall ? height * 0.7 : rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight);
        fx = bx - inner / 2 + w1 / 2;
        fw = w1;
        fh = height;
        addBuilding(fx, bz, w1, inner, height, rng.pick(FACADE_COLORS), sign);
        addBuilding(bx + inner / 2 - w2 / 2, bz, w2, inner, h2, rng.pick(FACADE_COLORS), null);
      } else {
        addBuilding(bx, bz, inner, inner, height, rng.pick(FACADE_COLORS), sign);
      }
      if (streetFace) {
        if (tall && rng.chance(0.3)) {
          const pick = rng.pick(VERTICAL_NEON);
          addVerticalNeon(fx, bz, fw, inner, fh, streetFace, pick.word, pick.color);
        }
      }
      // Street-level dressing on every block, not just the avenue ones:
      // an awning on the north face (the side the avenue cameras see)
      // and a painted shop board on the side face (the side the cross
      // streets and the mission corner see), so no building reads as a
      // bare flat wall from the street.
      if (rng.chance(0.45)) {
        addAwning(fx, bz, fw, inner, 'north', rng.pick(AWNING_COLORS));
      }
      if (rng.chance(0.35)) {
        const sideFace = bx < 0 ? 'west' : 'east';
        addShopSign(fx, bz, fw, inner, sideFace, rng.pick(SHOP_SIGNS));
      }
    }
  }

  // ------------------------------------------------------- traffic loop routes
  // A closed rectangle around each block, on the roads that border it. Traffic
  // cars follow one loop forever and switch loops at junctions.
  for (const bx of blockCenters) {
    for (const bz of blockCenters) {
      const r = CITY.blockSize / 2 + CITY.roadWidth / 2;
      trafficLoops.push([
        { x: bx - r, z: bz - r }, { x: bx + r, z: bz - r },
        { x: bx + r, z: bz + r }, { x: bx - r, z: bz + r },
      ]);
    }
  }

  // ------------------------------------------------------------ police station
  // A distinct pale-blue civic building on the block at (-90, 150), with a
  // marked forecourt where patrol cars spawn.
  const stationX = -90;
  const stationZ = 150;
  const station = addBuilding(stationX, stationZ, 30, 22, 14, 0xbfd9e8, null);
  station.name = 'PoliceStation';
  const stationSign = boxMesh(10, 1.6, 0.4, mat(0x1d4e89, 0.6), stationX, 11, stationZ - 11.4);
  group.add(stationSign);
  const stationLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x2244aa, emissive: 0x3355ff, emissiveIntensity: 1.4 }),
  );
  stationLight.position.set(stationX, 13.5, stationZ - 11.4);
  group.add(stationLight);
  lampHeads.push(stationLight);

  // ------------------------------------------------------ palms, lamps, props
  function addPalm(x, z) {
    const palm = new THREE.Group();
    const lean = rng.range(-0.08, 0.08);
    const trunkHeight = rng.range(5, 7.5);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.38, trunkHeight, 7),
      mat(0x8a6f4d, 1),
    );
    trunk.position.y = trunkHeight / 2;
    trunk.rotation.z = lean;
    trunk.castShadow = true;
    palm.add(trunk);
    // Six fronds: flattened cones fanning out from the crown.
    for (let i = 0; i < 6; i++) {
      const frond = new THREE.Mesh(
        new THREE.ConeGeometry(0.7, 3.4, 4),
        mat(0x3f8f4f, 1),
      );
      const a = (i / 6) * Math.PI * 2;
      frond.position.set(Math.cos(a) * 1.3, trunkHeight + 0.3, Math.sin(a) * 1.3);
      frond.rotation.z = Math.cos(a) * 1.15;
      frond.rotation.x = -Math.sin(a) * 1.15;
      frond.scale.set(1, 1, 0.28);
      frond.castShadow = true;
      palm.add(frond);
      swayFronds.push(frond);
    }
    // A couple of coconuts at the crown.
    const nut = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), mat(0x6b4f2a, 1));
    nut.position.set(0.4, trunkHeight - 0.2, 0.2);
    palm.add(nut);
    palm.position.set(x, 0, z);
    group.add(palm);
    colliders.push({
      minX: x - 0.45, maxX: x + 0.45, minZ: z - 0.45, maxZ: z + 0.45,
      height: trunkHeight, kind: 'prop',
    });
  }

  // A leafy street tree: a brown trunk with two or three overlapping
  // foliage balls in varied greens. Cheap (three or four meshes) so the
  // streets can carry a lot of them without choking the renderer.
  function addLeafyTree(x, z, scale) {
    const s = scale || 1;
    const tree = new THREE.Group();
    const trunkHeight = 2.6 * s;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16 * s, 0.26 * s, trunkHeight, 6),
      mat(0x6b4f2a, 1),
    );
    trunk.position.y = trunkHeight / 2;
    trunk.castShadow = true;
    tree.add(trunk);
    const blobs = rng.int(2, 3);
    for (let i = 0; i < blobs; i++) {
      const r = rng.range(1.1, 1.7) * s;
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(r, 8, 6),
        mat(rng.pick(LEAF_GREENS), 1),
      );
      puff.position.set(
        rng.range(-0.7, 0.7) * s,
        trunkHeight + rng.range(0.4, 1.3) * s,
        rng.range(-0.7, 0.7) * s,
      );
      puff.castShadow = true;
      tree.add(puff);
      swayCanopies.push(puff);
    }
    tree.position.set(x, 0, z);
    group.add(tree);
    colliders.push({
      minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4,
      height: trunkHeight + 2, kind: 'prop',
    });
  }

  function addBench(x, z) {
    const bench = new THREE.Group();
    const seat = boxMesh(2.4, 0.18, 0.7, mat(0x7a5230, 1), 0, 0.55, 0);
    const back = boxMesh(2.4, 0.7, 0.14, mat(0x7a5230, 1), 0, 1.0, -0.32);
    const leg1 = boxMesh(0.14, 0.55, 0.6, mat(0x3a3f45, 0.7), -1.0, 0.28, 0);
    const leg2 = boxMesh(0.14, 0.55, 0.6, mat(0x3a3f45, 0.7), 1.0, 0.28, 0);
    bench.add(seat, back, leg1, leg2);
    bench.position.set(x, 0.12, z);
    bench.rotation.y = rng.range(0, Math.PI);
    group.add(bench);
  }

  function addLamp(x, z) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.12, PROPS.lampHeight, 6),
      mat(0x2f3336, 0.6),
    );
    pole.position.set(x, PROPS.lampHeight / 2, z);
    pole.castShadow = true;
    group.add(pole);
    const arm = boxMesh(1.4, 0.12, 0.12, mat(0x2f3336, 0.6), x + 0.6, PROPS.lampHeight, z);
    group.add(arm);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 10, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffe6b0, emissive: 0xffc46b, emissiveIntensity: 1.6,
      }),
    );
    head.position.set(x + 1.2, PROPS.lampHeight - 0.1, z);
    group.add(head);
    lampHeads.push(head);
  }

  // A green road sign with its street name drawn on the board.
  function addRoadSign(x, z, text) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6),
      mat(0x8f979e, 0.6),
    );
    pole.position.set(x, 1.3, z);
    group.add(pole);
    const board = boxMesh(1.6, 1.0, 0.08, mat(0x2e6b34, 0.7), x, 2.7, z);
    group.add(board);
    const label = textTexture(text, '#f4f1e8', 44);
    if (label) {
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 0.38),
        new THREE.MeshBasicMaterial({ map: label, transparent: true }),
      );
      face.position.set(x, 2.7, z + 0.06);
      group.add(face);
    }
  }

  // The fairground ferris wheel: a static landmark at the north end of
  // the main avenue, built from a torus rim, eight spokes, a hub and
  // eight bright gondolas, held up by an A-frame. It is deliberately
  // tall (85 m, above the tallest tower) and rimmed in bright teal so
  // it reads against the peach sunset sky from the avenue cameras.
  function addFerrisWheel(x, z) {
    const hubY = 55;
    const rimR = 30;
    const wheel = new THREE.Group();
    // Low concrete platform under the wheel.
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(20, 21, 1, 24),
      mat(0xb8b0a0, 1),
    );
    base.position.y = 0.5;
    base.receiveShadow = true;
    wheel.add(base);
    // A-frame legs holding the hub, in the plane of the wheel.
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 60, 1.2),
        mat(0x3a3f45, 0.7),
      );
      leg.position.set(side * 10, 27.5, 0);
      leg.rotation.z = -side * 0.36;
      leg.castShadow = true;
      wheel.add(leg);
    }
    // Outer rim and a smaller inner ring, for depth. The rim is bright
    // teal so it stands out against the peach sunset sky.
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(rimR, 0.9, 10, 48),
      mat(0x2f8a80, 0.6),
    );
    rim.position.y = hubY;
    rim.castShadow = true;
    wheel.add(rim);
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(18, 0.6, 8, 40),
      mat(0xf2e3c6, 0.6),
    );
    inner.position.y = hubY;
    wheel.add(inner);
    // Eight spokes from the hub to the rim, and the hub itself.
    for (let i = 0; i < 8; i++) {
      const theta = (i / 8) * Math.PI * 2;
      const spoke = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, rimR, 6),
        mat(0xf2e3c6, 0.6),
      );
      spoke.position.set(Math.cos(theta) * rimR / 2, hubY + Math.sin(theta) * rimR / 2, 0);
      spoke.rotation.z = theta - Math.PI / 2;
      wheel.add(spoke);
    }
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 3, 12),
      mat(0x2f3336, 0.6),
    );
    hub.rotation.x = Math.PI / 2;
    hub.position.y = hubY;
    wheel.add(hub);
    // Eight gondolas in bright colours around the rim.
    const gondolaColors = [0xe85d75, 0x3d7bd9, 0xe8b93c, 0x4fb3a9, 0xff8a5e, 0xa8e05e, 0xe08aff, 0x4fd8e8];
    for (let i = 0; i < 8; i++) {
      const theta = (i / 8) * Math.PI * 2;
      const cab = boxMesh(2.4, 2.4, 2.4, mat(gondolaColors[i], 0.8),
        Math.cos(theta) * rimR, hubY + Math.sin(theta) * rimR, 0);
      wheel.add(cab);
    }
    wheel.position.set(x, 0, z);
    group.add(wheel);
    colliders.push({
      minX: x - rimR, maxX: x + rimR, minZ: z - 3, maxZ: z + 3,
      height: hubY + rimR, kind: 'prop',
    });
  }

  // Palm-lined beachfront: two rows of palms along the promenade — one
  // on the sand side, one on the city side — plus a few colourful
  // umbrellas planted in the sand.
  if (opts.palms !== false) {
    for (let z = -220; z <= 220; z += 20) {
      addPalm(-236, z + rng.range(-3, 3));
      addPalm(-220, z + rng.range(-3, 3));
    }
    for (let i = 0; i < 10; i++) {
      const ux = rng.range(-266, -246);
      const uz = rng.range(-200, 200);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6),
        mat(0xe8e0cc, 0.8),
      );
      pole.position.set(ux, 1.2, uz);
      group.add(pole);
      const canopy = new THREE.Mesh(
        new THREE.ConeGeometry(1.8, 0.7, 10),
        mat(rng.pick([0xe85d75, 0x3d7bd9, 0xe8b93c, 0x4fb3a9]), 0.9),
      );
      canopy.position.set(ux, 2.6, uz);
      canopy.castShadow = true;
      group.add(canopy);
    }
  }

  // Street trees along every avenue and street: leafy trees on the
  // sidewalk edge, alternating sides, skipping junctions so no tree
  // ever stands in a crossing. The main drag (the central avenue and
  // the central street) is palm-lined instead, so palms read in every
  // screenshot taken on the avenue. Trees are also kept clear of the
  // screenshot cameras (drive-side at (10,52), chase-wide at (6,30),
  // cover at (6,17)), so no canopy ever blocks a staged frame.
  function addStreetTrees() {
    const edge = CITY.roadWidth / 2 + 2.5;
    const nearJunction = (along) => CITY.roadCenters.some(
      (c) => Math.abs(along - c) < CITY.roadWidth / 2 + 4,
    );
    const nearCamera = (x, z) => {
      const spots = [[10, 52], [6, 30], [6, 17]];
      for (const [cx, cz] of spots) {
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz < 13 * 13) return true;
      }
      return false;
    };
    let flip = 0;
    for (const c of CITY.roadCenters) {
      for (let d = -210; d <= 210; d += 40) {
        if (nearJunction(d)) continue;
        const side = flip % 2 === 0 ? 1 : -1;
        flip += 1;
        const onMainDrag = c === 0;
        const ax = c + side * edge;
        const az = d;
        const bx2 = d;
        const bz2 = c - side * edge;
        if (onMainDrag && flip % 2 === 0) {
          if (!nearCamera(ax, az)) addPalm(ax, az);
          if (!nearCamera(bx2, bz2)) addPalm(bx2, bz2);
        } else {
          if (!nearCamera(ax, az)) addLeafyTree(ax, az, rng.range(0.85, 1.25));
          if (!nearCamera(bx2, bz2)) addLeafyTree(bx2, bz2, rng.range(0.85, 1.25));
        }
      }
    }
  }
  addStreetTrees();

  // Streetlights along every avenue and street, on alternating corners.
  if (opts.lamps !== false) {
    for (const c of CITY.roadCenters) {
      for (let d = -210; d <= 210; d += PROPS.lampSpacing) {
        addLamp(c + CITY.roadWidth / 2 + 1.2, d);
        addLamp(d, c + CITY.roadWidth / 2 + 1.2);
      }
    }
  }

  // Benches at scattered block corners, and a couple of road signs.
  for (const bx of blockCenters) {
    for (const bz of blockCenters) {
      if (rng.chance(PROPS.benchChance)) {
        addBench(bx + 20, bz + 20);
      }
    }
  }
  addRoadSign(-172, -52, 'Marisol Bay');
  addRoadSign(52, 172, 'Beach Rd');

  // Distant skyline silhouettes beyond the east and north edges, for depth.
  for (let i = 0; i < 14; i++) {
    const h = rng.range(20, 60);
    const w = rng.range(14, 26);
    const east = rng.chance(0.5);
    const x = east ? rng.range(260, 340) : rng.range(-200, 200);
    const z = east ? rng.range(-240, 240) : rng.range(260, 340);
    const far = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, w),
      mat(rng.pick(BUILDING_COLORS), 1),
    );
    far.position.set(x, h / 2, z);
    group.add(far);
  }

  // The ferris wheel at the north end of the main avenue, dead centre
  // in the avenue cameras' line of sight (cover, drive and mission all
  // look north), and a couple of palms by the garage so the mission
  // corner reads green too.
  addFerrisWheel(0, -215);
  addPalm(-129.5, -70);
  addPalm(-110.5, -24);

  // ------------------------------------------------------------ named places
  // All markers sit just off a road centre line, on the sidewalk edge, so both
  // a walking player and a driving player can reach them.
  const missionMarkers = {
    garage: { x: -120, z: -52, y: 0, label: 'Garage' },
    dropoff: { x: 120, z: 68, y: 0, label: 'Drop-off' },
    package: { x: 68, z: -120, y: 0, label: 'Package' },
    showroom: { x: 180, z: 8, y: 0, label: 'Showroom' },
    'chop-shop': { x: -180, z: 128, y: 0, label: 'Chop Shop' },
    hideout: { x: 8, z: 180, y: 0, label: 'Hideout' },
    bank: { x: 68, z: 60, y: 0, label: 'Marisol Bank' },
    policeStation: { x: -90, z: 132, y: 0, label: 'Police Station' },
    beach: { x: -250, z: 0, y: 0, label: 'Beach' },
    // Plaza marker sits at the plaza's south edge, clear of the fountain disc.
    plaza: { x: 30, z: 16, y: 0, label: 'Plaza' },
  };

  const spawnPoints = {
    playerStart: { x: 10, z: 10, y: 0, heading: Math.PI * 0.75 },
    policeStation: { x: -90, z: 132, y: 0, heading: Math.PI },
    beach: { x: -250, z: 0, y: 0, heading: -Math.PI / 2 },
    plaza: { x: 30, z: 22, y: 0, heading: 0 },
    garage: missionMarkers.garage,
    dropoff: missionMarkers.dropoff,
    package: missionMarkers.package,
    showroom: missionMarkers.showroom,
    'chop-shop': missionMarkers['chop-shop'],
    hideout: missionMarkers.hideout,
    bank: missionMarkers.bank,
  };

  // Parked-car spawn spots: along road edges, clear of junctions.
  const carSpotRoads = [
    { x: -172.5, z: -90 }, { x: -52.5, z: -150 }, { x: 7.5, z: 90 },
    { x: 127.5, z: -30 }, { x: -112.5, z: 150 }, { x: 187.5, z: -90 },
    { x: -30, z: -172.5 }, { x: 90, z: 52.5 }, { x: -90, z: 7.5 },
    { x: 150, z: 187.5 }, { x: -7.5, z: -30 }, { x: 52.5, z: -112.5 },
  ];
  for (const spot of carSpotRoads) {
    carSpawns.push({ x: spot.x, z: spot.z, y: 0, heading: rng.range(0, Math.PI * 2) });
  }

  // Beach counts as walkable, plus the promenade strip.
  walkableAreas.push({
    minX: CITY.beachEndX, maxX: CITY.beachStartX, minZ: -240, maxZ: 240,
  });
  walkableAreas.push({
    minX: -240, maxX: -220, minZ: -240, maxZ: 240,
  });

  // ------------------------------------------------------------ world object
  function nearestRoadPoint(x, z) {
    let best = null;
    let bestDist = Infinity;
    for (const seg of roadSegments) {
      let px;
      let pz;
      if (seg.axis === 'z') {
        px = seg.at;
        pz = clamp(z, seg.min, seg.max);
      } else {
        px = clamp(x, seg.min, seg.max);
        pz = seg.at;
      }
      const d = distance2D(x, z, px, pz);
      if (d < bestDist) {
        bestDist = d;
        best = { x: px, z: pz };
      }
    }
    return best;
  }

  function isWalkable(x, z) {
    for (const area of walkableAreas) {
      if (x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ) return true;
    }
    return false;
  }

  const world = {
    group,
    roads: roadSegments,
    lanes,
    trafficLoops,
    roadSegments,
    colliders,
    walkableAreas,
    spawnPoints,
    missionMarkers,
    policeStation: spawnPoints.policeStation,
    carSpawns,
    bounds: CITY_BOUNDS,
    ocean,
    seed,
    lights: { sun, hemi, ambient },
    nearestRoadPoint,
    isWalkable,
    update(dt, time) {
      // Slow swell: the ocean plane breathes a little, palm fronds sway,
      // and the leafy canopies rustle just enough to feel alive.
      if (ocean) ocean.position.y = -0.15 + Math.sin(time * 0.5) * 0.08;
      for (let i = 0; i < swayFronds.length; i++) {
        swayFronds[i].rotation.y = Math.sin(time * 0.7 + i) * 0.08;
      }
      for (let i = 0; i < swayCanopies.length; i++) {
        swayCanopies[i].rotation.y = Math.sin(time * 0.9 + i * 1.7) * 0.05;
      }
      void dt;
    },
  };
  return world;
}

export default buildCity;
