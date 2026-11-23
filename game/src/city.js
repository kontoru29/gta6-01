// city.js — Marisol Bay, built from scratch in Round 7.
//
// This is a fresh build of the city: same streets, same tuning tables,
// a different hand. Six districts now paint the town in their own
// colours (Downtown glassy, Mercado warm, Coral Shore pale, Marina
// blue-green, Old Town brick, the Beach pale sand), a pier reaches into
// the ocean, the marina holds boats, and the streets carry bus stops,
// hydrants, billboards and neon signs the old build never had.
//
// The shape main.js relies on stays the same: buildCity(scene, options)
// returns a world with lanes, mission markers, colliders, car spawns,
// bounds, spawn points, a nearest-road lookup, the road segments the
// minimap draws, a per-frame update, and the lights the sunset staging
// warms. Everything below is new text written for this round.

import * as THREE from 'three';
import {
  CITY,
  CITY_BOUNDS,
  VIEW,
  BUILDINGS,
  BUILDING_COLORS,
  WINDOW_COLORS,
  PROPS,
  LIGHTING,
  DISTRICTS,
  districtAt,
} from './config.js';
import { createRng, clamp, distance2D } from './utils.js';

// --- shared scratch -------------------------------------------------------
// One material per colour, cached by key, so the town stays cheap to draw.
function materialCache() {
  const store = new Map();
  return {
    standard(hex, roughness, metalness) {
      const key = `s:${hex}:${roughness}:${metalness}`;
      let found = store.get(key);
      if (!found) {
        found = new THREE.MeshStandardMaterial({
          color: hex,
          roughness: roughness ?? 0.9,
          metalness: metalness ?? 0,
        });
        store.set(key, found);
      }
      return found;
    },
    basic(hex) {
      const key = `b:${hex}`;
      let found = store.get(key);
      if (!found) {
        found = new THREE.MeshBasicMaterial({ color: hex });
        store.set(key, found);
      }
      return found;
    },
    glowing(hex, glowHex, strength) {
      const key = `e:${hex}:${glowHex}:${strength}`;
      let found = store.get(key);
      if (!found) {
        found = new THREE.MeshStandardMaterial({
          color: hex,
          emissive: glowHex,
          emissiveIntensity: strength ?? 1,
          roughness: 0.7,
        });
        store.set(key, found);
      }
      return found;
    },
  };
}

// A box dropped into a parent group, casting a shadow. Returns the mesh.
function dropBox(parent, material, w, h, d, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// A cylinder dropped into a parent group. Returns the mesh.
function dropCylinder(parent, material, topR, bottomR, height, segments, x, y, z) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(topR, bottomR, height, segments),
    material,
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// The city builder.
// ---------------------------------------------------------------------------
export function buildCity(scene, options = {}) {
  const seed = options.seed ?? 20261117;
  const rng = createRng(seed);
  const mats = materialCache();
  const root = new THREE.Group();
  root.name = 'MarisolBay';
  scene.add(root);

  // --- sky, fog and light -------------------------------------------------
  scene.background = new THREE.Color(LIGHTING.skyColor);
  scene.fog = new THREE.Fog(LIGHTING.fogColor, VIEW.fogNear, VIEW.fogFar);

  const sunElevation = (LIGHTING.sunElevationDegrees * Math.PI) / 180;
  const sunAzimuth = (LIGHTING.sunAzimuthDegrees * Math.PI) / 180;
  const sun = new THREE.DirectionalLight(LIGHTING.sunColor, LIGHTING.sunIntensity);
  sun.position.set(
    Math.cos(sunElevation) * Math.sin(sunAzimuth) * 400,
    Math.sin(sunElevation) * 400,
    Math.cos(sunElevation) * Math.cos(sunAzimuth) * 400,
  );
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -320;
  sun.shadow.camera.right = 320;
  sun.shadow.camera.top = 320;
  sun.shadow.camera.bottom = -320;
  sun.shadow.camera.far = 1200;
  scene.add(sun);

  const hemi = new THREE.HemisphereLight(
    LIGHTING.hemisphereSky,
    LIGHTING.hemisphereGround,
    LIGHTING.hemisphereIntensity,
  );
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffffff, LIGHTING.ambientIntensity);
  scene.add(ambient);

  // --- ground, beach and ocean --------------------------------------------
  const groundMat = mats.standard(LIGHTING.grassColor, 1, 0);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY.halfSize * 2 + 560, CITY.halfSize * 2 + 560),
    groundMat,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(-40, -0.05, 0);
  ground.receiveShadow = true;
  root.add(ground);

  // The beach: a pale sand strip on the west edge, then the ocean plane.
  const sandMat = mats.standard(LIGHTING.sandColor, 1, 0);
  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY.beachEndX - CITY.beachStartX + 40, CITY.halfSize * 2 + 40),
    sandMat,
  );
  sand.rotation.x = -Math.PI / 2;
  sand.position.set((CITY.beachStartX + CITY.beachEndX) / 2 - 10, 0.02, 0);
  sand.receiveShadow = true;
  root.add(sand);

  const oceanMat = new THREE.MeshStandardMaterial({
    color: LIGHTING.oceanColor,
    roughness: 0.25,
    metalness: 0.1,
  });
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(700, 1900),
    oceanMat,
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(CITY.oceanEndX + 350, -0.4, 0);
  ocean.receiveShadow = false;
  root.add(ocean);

  // A darker deep-water band far out, so the horizon reads in layers.
  const deepMat = mats.basic(LIGHTING.oceanDeepColor);
  const deep = new THREE.Mesh(new THREE.PlaneGeometry(300, 1900), deepMat);
  deep.rotation.x = -Math.PI / 2;
  deep.position.set(CITY.oceanEndX - 220, -0.6, 0);
  root.add(deep);

  // --- road network ---------------------------------------------------------
  // Avenues run north-south (along z) at each road centre x; streets run
  // east-west (along x) at each road centre z. Every crossing is an
  // intersection. Lanes are the driving paths; roadSegments are the
  // straight lines the minimap draws.
  const lanes = [];
  const roadSegments = [];
  const asphaltMat = mats.standard(LIGHTING.asphaltColor, 0.95, 0);
  const sidewalkMat = mats.standard(LIGHTING.sidewalkColor, 1, 0);
  const curbMat = mats.standard(LIGHTING.curbColor, 1, 0);
  const markMat = mats.basic(LIGHTING.roadMarkColor);

  for (const at of CITY.roadCenters) {
    // Avenue strip (north-south).
    const avenue = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY.roadWidth, CITY.halfSize * 2),
      asphaltMat,
    );
    avenue.rotation.x = -Math.PI / 2;
    avenue.position.set(at, 0.03, 0);
    avenue.receiveShadow = true;
    root.add(avenue);
    // Street strip (east-west).
    const street = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY.halfSize * 2, CITY.roadWidth),
      asphaltMat,
    );
    street.rotation.x = -Math.PI / 2;
    street.position.set(0, 0.03, at);
    street.receiveShadow = true;
    root.add(street);

    // Sidewalk ribbons on both sides of each road.
    for (const side of [-1, 1]) {
      const walkA = new THREE.Mesh(
        new THREE.PlaneGeometry(CITY.sidewalkWidth, CITY.halfSize * 2),
        sidewalkMat,
      );
      walkA.rotation.x = -Math.PI / 2;
      walkA.position.set(at + side * (CITY.roadWidth / 2 + CITY.sidewalkWidth / 2), 0.04, 0);
      walkA.receiveShadow = true;
      root.add(walkA);
      const walkB = new THREE.Mesh(
        new THREE.PlaneGeometry(CITY.halfSize * 2, CITY.sidewalkWidth),
        sidewalkMat,
      );
      walkB.rotation.x = -Math.PI / 2;
      walkB.position.set(0, 0.04, at + side * (CITY.roadWidth / 2 + CITY.sidewalkWidth / 2));
      walkB.receiveShadow = true;
      root.add(walkB);
    }

    // Dashed centre lines down each road.
    for (let d = -CITY.halfSize + 12; d < CITY.halfSize - 12; d += 24) {
      const dashA = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 10), markMat);
      dashA.rotation.x = -Math.PI / 2;
      dashA.position.set(at, 0.06, d);
      root.add(dashA);
      const dashB = new THREE.Mesh(new THREE.PlaneGeometry(10, 0.5), markMat);
      dashB.rotation.x = -Math.PI / 2;
      dashB.position.set(d, 0.06, at);
      root.add(dashB);
    }

    // Lanes and minimap segments for this avenue and street. A lane's dir
    // is a unit vector along the driving direction.
    const half = CITY.halfSize;
    lanes.push(
      { start: { x: at, z: -half }, end: { x: at, z: half }, points: [{ x: at, z: -half }, { x: at, z: half }], dir: { x: 0, z: 1 }, axis: 'z', road: at, offset: 0, length: half * 2 },
      { start: { x: at, z: half }, end: { x: at, z: -half }, points: [{ x: at, z: half }, { x: at, z: -half }], dir: { x: 0, z: -1 }, axis: 'z', road: at, offset: 0, length: half * 2 },
      { start: { x: -half, z: at }, end: { x: half, z: at }, points: [{ x: -half, z: at }, { x: half, z: at }], dir: { x: 1, z: 0 }, axis: 'x', road: at, offset: 0, length: half * 2 },
      { start: { x: half, z: at }, end: { x: -half, z: at }, points: [{ x: half, z: at }, { x: -half, z: at }], dir: { x: -1, z: 0 }, axis: 'x', road: at, offset: 0, length: half * 2 },
    );
    roadSegments.push({ axis: 'z', at, min: -half, max: half });
    roadSegments.push({ axis: 'x', at, min: -half, max: half });
  }

  // The beachfront promenade: a pale strip just east of the sand.
  const promMat = mats.standard(0xcbb28a, 1, 0);
  const promenade = new THREE.Mesh(
    new THREE.PlaneGeometry(10, CITY.halfSize * 2),
    promMat,
  );
  promenade.rotation.x = -Math.PI / 2;
  promenade.position.set(-228, 0.05, 0);
  promenade.receiveShadow = true;
  root.add(promenade);

  // Kerb lines where the roads meet the blocks, so the street edges read.
  for (const at of CITY.roadCenters) {
    for (const side of [-1, 1]) {
      const kerbA = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, CITY.halfSize * 2),
        curbMat,
      );
      kerbA.rotation.x = -Math.PI / 2;
      kerbA.position.set(at + side * (CITY.roadWidth / 2 + CITY.sidewalkWidth + 0.4), 0.05, 0);
      root.add(kerbA);
      const kerbB = new THREE.Mesh(
        new THREE.PlaneGeometry(CITY.halfSize * 2, 0.8),
        curbMat,
      );
      kerbB.rotation.x = -Math.PI / 2;
      kerbB.position.set(0, 0.05, at + side * (CITY.roadWidth / 2 + CITY.sidewalkWidth + 0.4));
      root.add(kerbB);
    }
  }

  // --- buildings, by district ----------------------------------------------
  // Block centres sit midway between the road centres. Most blocks hold
  // one to four stucco buildings; a few are special: two parks, the
  // central plaza with its fountain, the police station, and the ferris
  // wheel landmark at the north end. Each building takes its paint from
  // its district's palette, so the districts read at a glance.
  const colliders = [];
  const walkableAreas = [];
  const trafficLoops = [];
  const blockCentres = [-150, -90, -30, 30, 90, 150];
  const roofMat = (hex) => mats.standard(hex, 0.95, 0);
  const litWindowMat = mats.glowing(0x2c3e50, WINDOW_COLORS.lit, 1.4);
  const darkWindowMat = mats.standard(WINDOW_COLORS.dark, 0.6, 0.2);
  const glassWindowMat = mats.standard(WINDOW_COLORS.glass, 0.25, 0.5);

  function specialBlock(bx, bz) {
    if ((bx === -30 && bz === 30) || (bx === 90 && bz === -90)) return 'park';
    if (bx === 30 && bz === 30) return 'plaza';
    if (bx === -90 && bz === 150) return 'station';
    if (bx === -30 && bz === 150) return 'landmark';
    return null;
  }

  function raiseBuilding(cx, cz, footprint, height, facadeHex, roofHex) {
    const halfFoot = footprint / 2;
    const body = dropBox(
      root, mats.standard(facadeHex, 0.9, 0),
      footprint, height, footprint, cx, height / 2, cz,
    );
    void body;
    // A flat roof slab in a darker tone, slightly wider than the walls.
    dropBox(
      root, roofMat(roofHex),
      footprint + 1.2, 0.8, footprint + 1.2, cx, height + 0.4, cz,
    );
    // A rooftop box (stairs bulkhead or AC unit) for silhouette variety.
    if (rng.chance(0.6)) {
      dropBox(
        root, mats.standard(0x6f7d84, 0.95, 0),
        footprint * 0.3, 1.6, footprint * 0.3,
        cx + rng.range(-footprint * 0.2, footprint * 0.2), height + 1.4,
        cz + rng.range(-footprint * 0.2, footprint * 0.2),
      );
    }
    // Lit and dark windows on the street-facing side: a few glowing
    // panes per floor, so the facade reads as rooms, not a flat slab.
    const floors = Math.max(1, Math.floor(height / 4));
    const cols = Math.max(2, Math.floor(footprint / 6));
    for (let f = 0; f < floors; f += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (!rng.chance(0.45)) continue;
        const wx = cx - halfFoot + ((c + 0.5) / cols) * footprint;
        const wy = 2.5 + f * 4;
        const pane = new THREE.Mesh(
          new THREE.PlaneGeometry(1.6, 2.2),
          rng.chance(0.5) ? litWindowMat : (rng.chance(0.5) ? darkWindowMat : glassWindowMat),
        );
        pane.position.set(wx, wy, cz + halfFoot + 0.06);
        root.add(pane);
      }
    }
    colliders.push({
      minX: cx - halfFoot, maxX: cx + halfFoot,
      minZ: cz - halfFoot, maxZ: cz + halfFoot,
      height, kind: 'building',
    });
  }

  function plantPark(bx, bz) {
    const size = CITY.blockSize - CITY.roadWidth;
    const lawnMat = mats.standard(0x4f8f3f, 1, 0);
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(size, size), lawnMat);
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(bx, 0.05, bz);
    lawn.receiveShadow = true;
    root.add(lawn);
    walkableAreas.push({
      minX: bx - size / 2, maxX: bx + size / 2,
      minZ: bz - size / 2, maxZ: bz + size / 2,
    });
    // A few leafy trees and a bench, scattered by the seeded RNG.
    const leafMat = mats.standard(0x6fae4f, 1, 0);
    const trunkMat = mats.standard(0x6b4a2f, 1, 0);
    for (let i = 0; i < 5; i += 1) {
      const tx = bx + rng.range(-size / 2 + 6, size / 2 - 6);
      const tz = bz + rng.range(-size / 2 + 6, size / 2 - 6);
      dropCylinder(root, trunkMat, 0.3, 0.4, 2.4, 8, tx, 1.2, tz);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 8), leafMat);
      crown.position.set(tx, 3.6, tz);
      crown.castShadow = true;
      root.add(crown);
    }
    dropBox(root, mats.standard(0x8a6f5c, 1, 0), 3.2, 0.5, 1.0, bx + 8, 0.35, bz - 6);
  }

  function layPlaza(bx, bz) {
    const size = CITY.blockSize - CITY.roadWidth;
    const plazaMat = mats.standard(0xb8b0a0, 1, 0);
    const plaza = new THREE.Mesh(new THREE.PlaneGeometry(size, size), plazaMat);
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(bx, 0.05, bz);
    plaza.receiveShadow = true;
    root.add(plaza);
    walkableAreas.push({
      minX: bx - size / 2, maxX: bx + size / 2,
      minZ: bz - size / 2, maxZ: bz + size / 2,
    });
    // The fountain: a round basin with a pale water disc.
    dropCylinder(root, mats.standard(0x8f887a, 1, 0), 5, 5.6, 0.9, 20, bx, 0.45, bz);
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(4.4, 20),
      mats.standard(0x7fb8d9, 0.3, 0.2),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(bx, 0.95, bz);
    root.add(water);
    dropCylinder(root, mats.standard(0xb8b0a0, 1, 0), 0.5, 0.8, 2.2, 10, bx, 1.8, bz);
  }

  for (const bx of blockCentres) {
    for (const bz of blockCentres) {
      const kind = specialBlock(bx, bz);
      if (kind === 'park') { plantPark(bx, bz); continue; }
      if (kind === 'plaza') { layPlaza(bx, bz); continue; }
      if (kind === 'station') {
        // The police station: a low pale block with a blue sign band.
        raiseBuilding(bx, bz, 34, 12, 0x7fa8c8, 0x5c6e7a);
        dropBox(root, mats.glowing(0x2f4a6a, 0x4f9dff, 1.2), 12, 1.6, 0.4, bx, 9, bz + 17.2);
        continue;
      }
      if (kind === 'landmark') {
        // The landmark block stays open for the ferris wheel, raised later.
        walkableAreas.push({
          minX: bx - 20, maxX: bx + 20, minZ: bz - 20, maxZ: bz + 20,
        });
        continue;
      }
      // Ordinary block: one tall building or two smaller ones.
      const district = districtAt(bx, bz);
      const palette = district ? district.palette : BUILDING_COLORS;
      const roofPick = BUILDINGS.roofColors[Math.floor(rng.next() * BUILDINGS.roofColors.length)];
      if (rng.chance(0.4)) {
        const tall = rng.chance(BUILDINGS.tallChance);
        const height = tall
          ? rng.range(BUILDINGS.towerMinHeight, BUILDINGS.towerMaxHeight)
          : rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight);
        raiseBuilding(bx, bz, rng.range(24, 34), height, palette[Math.floor(rng.next() * palette.length)], roofPick);
      } else {
        const first = rng.range(16, 22);
        const second = rng.range(16, 22);
        raiseBuilding(
          bx - 10, bz - 8, first, rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight),
          palette[Math.floor(rng.next() * palette.length)], roofPick,
        );
        raiseBuilding(
          bx + 10, bz + 8, second, rng.range(BUILDINGS.minHeight, BUILDINGS.maxHeight),
          palette[Math.floor(rng.next() * palette.length)], roofPick,
        );
      }
      // A closed traffic loop around this block, for patrols and taxis.
      const inset = CITY.blockSize / 2 + CITY.roadWidth / 2;
      trafficLoops.push([
        { x: bx - inset, z: bz - inset },
        { x: bx + inset, z: bz - inset },
        { x: bx + inset, z: bz + inset },
        { x: bx - inset, z: bz + inset },
      ]);
    }
  }

  // Sidewalk rectangles are walkable too.
  for (const at of CITY.roadCenters) {
    for (const side of [-1, 1]) {
      const off = side * (CITY.roadWidth / 2 + CITY.sidewalkWidth / 2);
      walkableAreas.push({
        minX: at + off - CITY.sidewalkWidth / 2, maxX: at + off + CITY.sidewalkWidth / 2,
        minZ: -CITY.halfSize, maxZ: CITY.halfSize,
      });
      walkableAreas.push({
        minX: -CITY.halfSize, maxX: CITY.halfSize,
        minZ: at + off - CITY.sidewalkWidth / 2, maxZ: at + off + CITY.sidewalkWidth / 2,
      });
    }
  }
  // The beach is walkable.
  walkableAreas.push({
    minX: CITY.beachEndX, maxX: CITY.beachStartX, minZ: -CITY.halfSize, maxZ: CITY.halfSize,
  });

  // --- street props -----------------------------------------------------------
  // Palms along the promenade, lamps down every road, benches, bus stops,
  // hydrants and billboards. Props are cheap boxes and cylinders; only
  // the palms sway, so only they are tracked for the per-frame update.
  const swayPalms = [];
  const bobbingBoats = [];
  let ferrisWheel = null;

  function growPalm(x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const trunkMat = mats.standard(0x7a5c3a, 1, 0);
    const trunk = dropCylinder(group, trunkMat, 0.22, 0.34, 7.5, 8, 0, 3.75, 0);
    trunk.rotation.z = 0.08;
    const leafMat = mats.standard(0x4f8f3f, 1, 0);
    const crown = new THREE.Group();
    crown.position.set(0.5, 7.6, 0);
    for (let i = 0; i < 6; i += 1) {
      const frond = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 2.6), leafMat);
      const angle = (i / 6) * Math.PI * 2;
      frond.position.set(Math.sin(angle) * 1.1, 0, Math.cos(angle) * 1.1);
      frond.rotation.y = angle;
      frond.rotation.x = 0.5;
      frond.castShadow = true;
      crown.add(frond);
    }
    group.add(crown);
    root.add(group);
    swayPalms.push(crown);
    colliders.push({ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5, height: 1, kind: 'prop' });
  }

  function raiseLamp(x, z) {
    dropCylinder(root, mats.standard(0x2f3336, 0.7, 0.4), 0.09, 0.12, PROPS.lampHeight, 8, x, PROPS.lampHeight / 2, z);
    const headMat = mats.glowing(0x3a3f45, 0xffd98a, 1.6);
    dropBox(root, headMat, 0.7, 0.25, 0.35, x, PROPS.lampHeight + 0.1, z);
  }

  function placeBench(x, z, heading) {
    const bench = new THREE.Group();
    bench.position.set(x, 0, z);
    bench.rotation.y = heading;
    dropBox(bench, mats.standard(0x8a6f5c, 1, 0), 2.6, 0.12, 0.7, 0, 0.5, 0);
    dropBox(bench, mats.standard(0x8a6f5c, 1, 0), 2.6, 0.9, 0.12, 0, 0.95, -0.32);
    dropBox(bench, mats.standard(0x3a3f45, 0.8, 0.2), 0.14, 0.5, 0.6, -1.1, 0.25, 0);
    dropBox(bench, mats.standard(0x3a3f45, 0.8, 0.2), 0.14, 0.5, 0.6, 1.1, 0.25, 0);
    root.add(bench);
  }

  function placeBusStop(x, z) {
    const stop = new THREE.Group();
    stop.position.set(x, 0, z);
    dropBox(stop, mats.standard(0x2f3336, 0.8, 0.2), 0.12, 2.6, 0.12, -1.4, 1.3, 0);
    dropBox(stop, mats.standard(0x2f3336, 0.8, 0.2), 0.12, 2.6, 0.12, 1.4, 1.3, 0);
    dropBox(stop, mats.standard(0x4f9a94, 0.4, 0.3), 3.2, 0.15, 1.2, 0, 2.7, 0);
    dropBox(stop, mats.standard(0x7fb8d9, 0.3, 0.4), 3.0, 1.4, 0.08, 0, 1.6, -0.5);
    root.add(stop);
  }

  function placeHydrant(x, z) {
    dropCylinder(root, mats.standard(0xd21f2b, 0.6, 0.2), 0.22, 0.26, 0.7, 10, x, 0.35, z);
  }

  function raiseBillboard(x, z, heading, glowHex) {
    const board = new THREE.Group();
    board.position.set(x, 0, z);
    board.rotation.y = heading;
    dropBox(board, mats.standard(0x2f3336, 0.8, 0.2), 0.5, 14, 0.5, -2.5, 7, 0);
    dropBox(board, mats.standard(0x2f3336, 0.8, 0.2), 0.5, 14, 0.5, 2.5, 7, 0);
    dropBox(board, mats.glowing(0x16222e, glowHex, 1.1), 7, 4, 0.4, 0, 15, 0);
    root.add(board);
    colliders.push({ minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.6, maxZ: z + 0.6, height: 14, kind: 'prop' });
  }

  // Palms down the promenade and a few on the beach.
  for (let z = -220; z <= 220; z += PROPS.palmSpacing) {
    growPalm(-232, z);
    if (rng.chance(0.5)) growPalm(-244, z + 12);
  }
  // Lamps down every avenue and street, alternating sides.
  for (const at of CITY.roadCenters) {
    for (let d = -210; d <= 210; d += PROPS.lampSpacing) {
      raiseLamp(at + CITY.roadWidth / 2 + 2.5, d);
      raiseLamp(d, at - CITY.roadWidth / 2 - 2.5);
    }
  }
  // Benches at the plaza and the parks, bus stops at four crossings.
  placeBench(24, 24, 0);
  placeBench(36, 38, Math.PI / 2);
  placeBench(-36, 24, Math.PI);
  placeBench(84, -96, 0);
  placeBusStop(-128, 8);
  placeBusStop(68, -128);
  placeBusStop(128, 68);
  placeBusStop(-68, 128);
  // Hydrants near the corners.
  placeHydrant(-128, -52);
  placeHydrant(128, 52);
  placeHydrant(52, 128);
  placeHydrant(-52, -128);
  // Two billboards over the avenues, glowing warm at dusk.
  raiseBillboard(60, -210, 0, 0xff8a5e);
  raiseBillboard(-60, 210, Math.PI, 0x4fd8e8);
  // Neon panels on the beachfront buildings, facing the promenade.
  const neonMatA = mats.glowing(0x16222e, 0x4fd8e8, 1.5);
  const neonMatB = mats.glowing(0x16222e, 0xff5e8a, 1.5);
  dropBox(root, neonMatA, 0.3, 1.4, 6, -168, 9, -60);
  dropBox(root, neonMatB, 0.3, 1.4, 5, -168, 7, 60);
  dropBox(root, neonMatA, 0.3, 1.2, 4, -168, 11, 180);

  // --- landmarks --------------------------------------------------------------
  // The ferris wheel at the north end of the central avenue: two legs, a
  // rim, spokes and gondolas. It turns slowly in update().
  function raiseFerrisWheel(x, z) {
    const wheel = new THREE.Group();
    wheel.position.set(x, 0, z);
    const legMat = mats.standard(0x8a7bd9, 0.6, 0.3);
    const legL = dropBox(wheel, legMat, 0.8, 22, 0.8, -4, 11, 0);
    legL.rotation.z = 0.2;
    const legR = dropBox(wheel, legMat, 0.8, 22, 0.8, 4, 11, 0);
    legR.rotation.z = -0.2;
    const rimMat = mats.standard(0xc96f4a, 0.5, 0.4);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(10, 0.5, 8, 28), rimMat);
    rim.position.set(0, 22, 0);
    rim.castShadow = true;
    wheel.add(rim);
    const spokeMat = mats.standard(0x3a3f45, 0.7, 0.2);
    for (let i = 0; i < 6; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.35, 20, 0.35), spokeMat);
      spoke.position.set(0, 22, 0);
      spoke.rotation.z = (i / 6) * Math.PI;
      wheel.add(spoke);
    }
    const gondolaMat = mats.glowing(0xf2e3c6, 0xffd98a, 0.8);
    const gondolas = new THREE.Group();
    gondolas.position.set(0, 22, 0);
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      const car = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.4), gondolaMat);
      car.position.set(Math.sin(angle) * 10, Math.cos(angle) * 10, 0);
      car.castShadow = true;
      gondolas.add(car);
    }
    wheel.add(gondolas);
    root.add(wheel);
    ferrisWheel = gondolas;
    colliders.push({ minX: x - 6, maxX: x + 6, minZ: z - 6, maxZ: z + 6, height: 24, kind: 'prop' });
  }
  raiseFerrisWheel(0, -215);

  // The pier: a wooden deck out over the water with posts, at the west edge.
  function layPier(z) {
    const deckMat = mats.standard(0x8a6f5c, 1, 0);
    for (let x = -272; x >= -330; x -= 6) {
      dropBox(root, deckMat, 6, 0.5, 8, x, 0.6, z);
      dropCylinder(root, mats.standard(0x5c4632, 1, 0), 0.3, 0.3, 2.5, 8, x - 2.5, -0.5, z - 3.5);
      dropCylinder(root, mats.standard(0x5c4632, 1, 0), 0.3, 0.3, 2.5, 8, x - 2.5, -0.5, z + 3.5);
    }
  }
  layPier(60);

  // Marina boats: simple hulls with a mast, bobbing in the water.
  function floatBoat(x, z, heading, hullHex) {
    const boat = new THREE.Group();
    boat.position.set(x, 0.1, z);
    boat.rotation.y = heading;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 8), mats.standard(hullHex, 0.6, 0.2));
    hull.position.y = 0.4;
    hull.castShadow = true;
    boat.add(hull);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 8), mats.standard(0x8f887a, 0.9, 0));
    mast.position.y = 3;
    boat.add(mast);
    root.add(boat);
    bobbingBoats.push({ group: boat, phase: rng.next() * Math.PI * 2, baseY: 0.1 });
  }
  floatBoat(-300, 30, 0.4, 0xf2e3c6);
  floatBoat(-310, 90, -0.3, 0x7fb8d9);
  floatBoat(-295, -40, 0.9, 0xd94f3d);

  // --- markers, spawns and lookups -------------------------------------------
  const missionMarkers = {
    garage: { x: -120, z: -120 },
    dropoff: { x: 120, z: 60 },
    package: { x: -60, z: -60 },
    plaza: { x: 30, z: 30 },
    showroom: { x: 180, z: -60 },
    'chop-shop': { x: 180, z: 180 },
    bank: { x: 60, z: -180 },
    hideout: { x: -180, z: 120 },
    policeStation: { x: -90, z: 150 },
    beach: { x: -250, z: 0 },
    pier: { x: -260, z: 60 },
    // Round 8: the North Docks yard, in the open north-east corner past
    // the last road. The new missions and the side jobs name these
    // points, and the marker lookup in main.js maps them through.
    docks: { x: 215, z: -215 },
    warehouse: { x: 228, z: -230 },
    craneYard: { x: 202, z: -202 },
    gate: { x: 210, z: -192 },
    cache: { x: 224, z: -204 },
  };

  const spawnPoints = {
    playerStart: { x: 0, z: 14, heading: 0.1 },
    policeStation: { x: -90, z: 150 },
    beach: { x: -250, z: 0 },
    plaza: { x: 30, z: 30 },
    garage: { x: -120, z: -120 },
  };

  // Parked-car spots along the kerbs, on real roads, for the vehicle system.
  const carSpawns = [
    { x: 12.5, z: -2, heading: Math.PI / 2 },
    { x: -12.5, z: -6, heading: Math.PI / 2 },
    { x: 12.5, z: -12, heading: Math.PI / 2 },
    { x: -56.5, z: 42.5, heading: Math.PI / 2 },
    { x: 56.5, z: -42.5, heading: -Math.PI / 2 },
    { x: -116.5, z: -90, heading: 0 },
    { x: 116.5, z: 90, heading: Math.PI },
    { x: 3.5, z: 78, heading: Math.PI },
    { x: -3.5, z: -80, heading: 0 },
    { x: 183.5, z: 30, heading: Math.PI / 2 },
    { x: -183.5, z: -30, heading: -Math.PI / 2 },
    { x: 63.5, z: 120, heading: 0 },
    { x: -63.5, z: -120, heading: Math.PI },
    { x: 123.5, z: -60, heading: Math.PI / 2 },
  ];

  // Closest point on any road centre line. Roads span the whole city, so
  // there is always an answer; points outside the grid clamp to its edge.
  function nearestRoadPoint(x, z) {
    const cx = clamp(x, -CITY.halfSize, CITY.halfSize);
    const cz = clamp(z, -CITY.halfSize, CITY.halfSize);
    let best = null;
    let bestDist = Infinity;
    for (const at of CITY.roadCenters) {
      const candidates = [
        { x: at, z: cz },
        { x: cx, z: at },
      ];
      for (const point of candidates) {
        const d = distance2D(x, z, point.x, point.z);
        if (d < bestDist) {
          bestDist = d;
          best = point;
        }
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

  // --- per-frame life ---------------------------------------------------------
  function update(dt, time) {
    const t = time || 0;
    if (ferrisWheel) ferrisWheel.rotation.z = t * 0.12;
    for (const boat of bobbingBoats) {
      boat.group.position.y = boat.baseY + Math.sin(t * 0.8 + boat.phase) * 0.18;
      boat.group.rotation.z = Math.sin(t * 0.6 + boat.phase) * 0.02;
    }
    for (let i = 0; i < swayPalms.length; i += 1) {
      swayPalms[i].rotation.z = Math.sin(t * 0.9 + i * 1.7) * 0.05;
    }
    void dt;
  }

  return {
    group: root,
    roads: roadSegments,
    lanes,
    trafficLoops,
    roadSegments,
    colliders,
    buildingColliders: colliders,
    walkableAreas,
    spawnPoints,
    missionMarkers,
    policeStation: { x: -90, z: 150 },
    carSpawns,
    bounds: CITY_BOUNDS,
    ocean,
    seed,
    lights: { sun, hemi },
    update,
    nearestRoadPoint,
    isWalkable,
    // Which named district a ground point sits in (config's lookup, so
    // the HUD and missions read the same districts the buildings use).
    districtAt,
  };
}

export default buildCity;
