// city.js — Solmar Bay procedural city builder: streets, buildings, beach and sky.
// buildCity(scene, options) fills a three.js scene with the whole playable world
// and hands back everything the other modules need to play in it: the road
// network (lanes traffic can follow and loops around each block), building
// colliders, walkable areas, car spawn spots, and named spawn points — the
// player start, the police station, and one marker position per mission place.
// Golden-hour lighting (low warm sun over the ocean, pale blue sky, light fog)
// is set up here too, so the city looks the same in every screenshot.
// The layout is seeded, so the same seed always builds the same city.
//
// Public interface
//   buildCity(scene, options?) -> world
//     options: { seed?: number, rng?: object, palms?: boolean, lamps?: boolean }
//     world: {
//       group, roads, lanes, trafficLoops, roadSegments, colliders,
//       walkableAreas, spawnPoints, missionMarkers, policeStation, carSpawns,
//       bounds, ocean, seed,
//       update(dt, time),           // gentle ocean / palm motion, call each frame
//       nearestRoadPoint(x, z),     // snap a position onto the closest road centre
//       isWalkable(x, z),           // true on sidewalks, plazas and the beach
//     }
//   spawnPoints: { playerStart, policeStation, beach, plaza, garage, ... }
//   missionMarkers: { garage, dropoff, package, showroom, 'chop-shop',
//                     hideout, bank, policeStation, beach, plaza }
//   A lane: { start:{x,z}, end:{x,z}, dir:{x,z}, axis:'x'|'z', road:number,
//             offset:number, length:number }
//   A traffic loop: [{x,z}, ...] closed rectangle of waypoints around one block.
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

// ------------------------------------------------------------------ materials
// One shared material per colour keeps the draw list small and the city cheap.
const materialCache = new Map();
function mat(color, roughness) {
  const key = color + ':' + (roughness === undefined ? 0.9 : roughness);
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: roughness === undefined ? 0.9 : roughness,
      metalness: 0.02,
    });
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

// ------------------------------------------------------------ facade textures
// A canvas texture of lit and dark windows, drawn once per building colour so
// towers do not look like flat coloured slabs from the street.
function facadeTexture(rng, baseColor, floors, cols) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + baseColor.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cellW = canvas.width / cols;
  const cellH = canvas.height / floors;
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const lit = rng.chance(0.28);
      ctx.fillStyle = lit ? '#ffd98a' : (rng.chance(0.5) ? '#2c3e50' : '#7fb8d9');
      const padX = cellW * 0.22;
      const padY = cellH * 0.25;
      ctx.fillRect(c * cellW + padX, f * cellH + padY, cellW - padX * 2, cellH - padY * 2);
    }
  }
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
  scene.add(new THREE.AmbientLight(0xffe0b3, LIGHTING.ambientIntensity));

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

  // ------------------------------------------------------- blocks and buildings
  const blockCenters = [-150, -90, -30, 30, 90, 150];
  const palmTrunks = [];
  const lampHeads = [];

  function addBuilding(cx, cz, w, d, height, colorHex) {
    const floors = Math.max(2, Math.round(height / 3.2));
    const cols = Math.max(2, Math.round(w / 4));
    const tex = facadeTexture(rng, colorHex, floors, cols);
    let material;
    if (tex) {
      material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.02 });
    } else {
      material = mat(colorHex, 0.9);
    }
    const body = boxMesh(w, height, d, material, cx, height / 2 + 0.12, cz);
    group.add(body);
    // Flat roof cap, slightly wider, in a muted tone.
    const roof = boxMesh(w + 0.6, 0.5, d + 0.6, mat(rng.pick(BUILDINGS.roofColors), 1), cx, height + 0.35, cz);
    group.add(roof);
    // Rooftop clutter on some buildings: a vent box, sometimes an antenna.
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
    colliders.push({
      minX: cx - w / 2, maxX: cx + w / 2,
      minZ: cz - d / 2, maxZ: cz + d / 2,
      height, kind: 'building',
    });
    return body;
  }

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
        addPalm(bx - 12, bz - 10);
        addPalm(bx + 12, bz + 8);
        addPalm(bx + 10, bz - 12);
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
        addPalm(bx - 16, bz - 14);
        addPalm(bx + 16, bz + 14);
        continue;
      }

      // The police-station block is built separately after this loop, so
      // skip it here — otherwise two buildings would overlap on one block.
      const isStationBlock = bx === -90 && bz === 150;
      if (isStationBlock) continue;

      // Normal block: one or two buildings filling most of the block.
      const inset = 4;
      const inner = slabSize - inset * 2;
      const tall = rng.chance(BUILDINGS.tallChance);
      const height = tall
        ? rng.range(BUILDINGS.towerMinHeight, BUILDINGS.towerMaxHeight)
        : rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight);
      if (rng.chance(0.45)) {
        // Two buildings side by side, split along x.
        const w1 = inner * rng.range(0.42, 0.55);
        const w2 = inner - w1 - 3;
        const h2 = tall ? height * 0.7 : rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight);
        addBuilding(bx - inner / 2 + w1 / 2, bz, w1, inner, height, rng.pick(BUILDING_COLORS));
        addBuilding(bx + inner / 2 - w2 / 2, bz, w2, inner, h2, rng.pick(BUILDING_COLORS));
      } else {
        addBuilding(bx, bz, inner, inner, height, rng.pick(BUILDING_COLORS));
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
  const station = addBuilding(stationX, stationZ, 30, 22, 14, 0xbfd9e8);
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
      palmTrunks.push(frond);
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

  function addRoadSign(x, z, text) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6),
      mat(0x8f979e, 0.6),
    );
    pole.position.set(x, 1.3, z);
    group.add(pole);
    const board = boxMesh(1.6, 1.0, 0.08, mat(0x2e6b34, 0.7), x, 2.7, z);
    group.add(board);
    void text;
  }

  // Palm-lined beachfront: a row of palms along the promenade, plus a few
  // colourful umbrellas planted in the sand.
  if (opts.palms !== false) {
    for (let z = -220; z <= 220; z += PROPS.palmSpacing) {
      addPalm(-232, z + rng.range(-3, 3));
    }
    for (let i = 0; i < 6; i++) {
      const ux = rng.range(-266, -246);
      const uz = rng.range(-180, 180);
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
    nearestRoadPoint,
    isWalkable,
    update(dt, time) {
      // Slow swell: the ocean plane breathes a little, palm fronds sway.
      if (ocean) ocean.position.y = -0.15 + Math.sin(time * 0.5) * 0.08;
      for (let i = 0; i < palmTrunks.length; i++) {
        palmTrunks[i].rotation.y = Math.sin(time * 0.7 + i) * 0.08;
      }
      void dt;
    },
  };
  return world;
}

export default buildCity;
