// district.js — Solmar Bay's North Docks, Round 8.
//
// The north-east corner of the map used to be empty ground between the
// last road and the city wall. Now it works for a living: the North
// Docks, a container port where the Marisol crew moves its less legal
// cargo after dark. A concrete apron, three rows of stacked shipping
// containers in faded shipping-line colours, two gantry cranes whose
// hooks sway in the wind, a warehouse with a rusted roof, dock lamps
// that buzz on at night, a fenced gate, and dock workers walking the
// yard on their rounds. A smuggler's cache glows between the stacks
// for anyone who finds it.
//
// The yard is pure scenery plus three things the rest of the game can
// use: fixed points for the new night-shift missions (docks, warehouse,
// crane yard, gate), a walking worker population the police and the
// player can run into, and a cache pickup that pays out. Nothing here
// moves the player or blocks a road: the yard sits in the open corner
// past the last road, clear of the building grid, and its props carry
// no colliders, so a chase can cut straight through the stacks.
//
// `createDistrictSystem({ scene, world })` builds the yard once and
// returns an update loop plus the point table. `update(dt, ctx)` takes
// `{ night }` so the lamps only burn after dark.

import * as THREE from 'three';

// The yard's footprint, in the open north-east corner past the last road
// (x = 180) and the last northern road (z = -180). The building grid
// stops at block centre 150, so nothing here overlaps a building.
export const DOCKS_YARD = {
  minX: 192, maxX: 238, minZ: -238, maxZ: -192,
  centreX: 215, centreZ: -215,
};

export const DOCK_POINTS = {
  docks: { x: 215, z: -215 },
  warehouse: { x: 228, z: -230 },
  craneYard: { x: 202, z: -202 },
  gate: { x: 193, z: -193 },
  cache: { x: 224, z: -204 },
  pierEnd: { x: 236, z: -236 },
};

const CONTAINER_COLORS = [
  0xb8433a, 0x3a6db8, 0x3a8a4a, 0xd8a03a, 0x8a5aa8, 0x5aa8a0, 0xc26a2a, 0x6a7a8a,
];

const WORKER_SHIRTS = [0xe8b93c, 0x4fd8e8, 0xff5a4e, 0x7ed07a];

function makeMaterial(color, roughness = 0.85, metalness = 0.1) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function makeGlowMaterial(color, intensity = 1.4) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.5,
  });
}

export function createDistrictSystem(deps = {}) {
  const scene = deps.scene || null;
  const world = deps.world || null;
  const group = new THREE.Group();
  group.name = 'NorthDocks';

  const cranes = [];
  const workers = [];
  const lamps = [];
  let cacheDisc = null;
  let cacheGlow = null;
  let totalSeconds = 0;

  // --- ground -----------------------------------------------------------------
  // A concrete apron slightly above the grass, with painted bay lines so
  // the yard reads as a working port instead of a grey slab.
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(46, 0.3, 46),
    makeMaterial(0x8a8d90, 0.95, 0),
  );
  apron.position.set(DOCKS_YARD.centreX, 0.15, DOCKS_YARD.centreZ);
  apron.receiveShadow = true;
  apron.name = 'DocksApron';
  group.add(apron);

  const bayLineMat = makeMaterial(0xe8b93c, 0.9, 0);
  for (let i = 0; i < 4; i += 1) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(40, 0.05, 0.5), bayLineMat);
    line.position.set(
      DOCKS_YARD.centreX,
      0.33,
      DOCKS_YARD.minZ + 8 + i * 11,
    );
    group.add(line);
  }

  // --- container rows ----------------------------------------------------------
  // Three rows of 40-foot boxes, two high in places, colours pulled from
  // the shipping-line palette. Each box is one mesh with its own
  // material so the rows read as mixed cargo, not one flat wall.
  const containerGeo = new THREE.BoxGeometry(6.1, 2.6, 2.6);
  const containerRows = [
    { z: -228, count: 5, stack: [2, 1, 2, 1, 2] },
    { z: -217, count: 5, stack: [1, 2, 1, 2, 1] },
    { z: -206, count: 4, stack: [2, 2, 1, 2] },
  ];
  let colorCursor = 0;
  for (const row of containerRows) {
    for (let i = 0; i < row.count; i += 1) {
      const x = DOCKS_YARD.minX + 6 + i * 8.5;
      const levels = row.stack[i] || 1;
      for (let level = 0; level < levels; level += 1) {
        const colour = CONTAINER_COLORS[colorCursor % CONTAINER_COLORS.length];
        colorCursor += 1;
        const box = new THREE.Mesh(
          containerGeo,
          makeMaterial(colour, 0.8, 0.25),
        );
        box.position.set(x, 1.45 + level * 2.65, row.z);
        box.castShadow = true;
        box.receiveShadow = true;
        box.name = `Container_${Math.round(x)}_${Math.round(row.z)}_L${level}`;
        group.add(box);
        // Corrugation ribs on the long faces, so the boxes are not flat
        // slabs at dusk: five thin vertical ribs per visible face.
        const ribMat = makeMaterial(colour, 0.8, 0.25);
        for (let rib = 0; rib < 5; rib += 1) {
          const ribMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.12, 2.5, 0.14),
            ribMat,
          );
          ribMesh.position.set(x - 2.4 + rib * 1.2, 1.45 + level * 2.65, row.z + 1.34);
          group.add(ribMesh);
        }
      }
    }
  }

  // --- gantry cranes ------------------------------------------------------------
  // Two portal cranes straddling the middle row: four legs, a top beam,
  // a jib that reaches over the yard, and a hook block on a cable that
  // sways gently. The hook sway is the yard's slow heartbeat.
  function buildCrane(baseX, baseZ, height) {
    const crane = new THREE.Group();
    crane.position.set(baseX, 0, baseZ);
    crane.name = `GantryCrane_${Math.round(baseX)}`;
    const steel = makeMaterial(0xd8a03a, 0.6, 0.5);
    const darkSteel = makeMaterial(0x4a4a4a, 0.7, 0.4);
    const legGeo = new THREE.BoxGeometry(0.9, height, 0.9);
    const legOffsets = [
      [-4, -3], [4, -3], [-4, 3], [4, 3],
    ];
    for (const [ox, oz] of legOffsets) {
      const leg = new THREE.Mesh(legGeo, steel);
      leg.position.set(ox, height / 2, oz);
      leg.castShadow = true;
      crane.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(11, 1.1, 8.2), steel);
    beam.position.set(0, height + 0.5, 0);
    beam.castShadow = true;
    crane.add(beam);
    const jib = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 26), darkSteel);
    jib.position.set(0, height + 0.4, -9);
    jib.castShadow = true;
    crane.add(jib);
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.0, 2.4),
      makeMaterial(0x2f4a6a, 0.6, 0.3),
    );
    cab.position.set(0, height - 1.2, 2);
    crane.add(cab);
    const cableGeo = new THREE.CylinderGeometry(0.05, 0.05, 9, 6);
    const cableMat = makeMaterial(0x22262e, 0.9, 0);
    const cable = new THREE.Mesh(cableGeo, cableMat);
    cable.position.set(0, height - 4.5, -16);
    crane.add(cable);
    const hook = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.0, 1.0),
      makeMaterial(0x8a1f1f, 0.6, 0.4),
    );
    hook.position.set(0, height - 9.2, -16);
    hook.castShadow = true;
    crane.add(hook);
    const hookLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 8),
      makeGlowMaterial(0xff5a4e, 2.0),
    );
    hookLight.position.set(0, height - 8.4, -16);
    crane.add(hookLight);
    crane.userData.hook = hook;
    crane.userData.cable = cable;
    crane.userData.hookLight = hookLight;
    crane.userData.swayPhase = baseX * 0.7 + baseZ * 0.3;
    crane.userData.hookBaseY = height - 9.2;
    group.add(crane);
    cranes.push(crane);
    return crane;
  }
  buildCrane(206, -224, 16);
  buildCrane(226, -206, 18);

  // --- warehouse ------------------------------------------------------------------
  // A big rust-roofed warehouse on the yard's east side, with a sliding
  // door, a sign band and a loading dock step. The night-shift missions
  // send Leo here.
  const warehouse = new THREE.Group();
  warehouse.position.set(228, 0, -230);
  warehouse.name = 'DocksWarehouse';
  const wallMat = makeMaterial(0x9a8a7a, 0.85, 0.05);
  const walls = new THREE.Mesh(new THREE.BoxGeometry(14, 7, 10), wallMat);
  walls.position.y = 3.5;
  walls.castShadow = true;
  walls.receiveShadow = true;
  warehouse.add(walls);
  const roofMat = makeMaterial(0x7a3a2a, 0.8, 0.3);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(15, 0.8, 11), roofMat);
  roof.position.y = 7.4;
  roof.castShadow = true;
  warehouse.add(roof);
  const roofRidge = new THREE.Mesh(new THREE.BoxGeometry(15.4, 0.5, 1.2), roofMat);
  roofRidge.position.y = 8.0;
  warehouse.add(roofRidge);
  const doorMat = makeMaterial(0x3a4a5a, 0.7, 0.5);
  const door = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 0.3), doorMat);
  door.position.set(0, 2.5, 5.05);
  warehouse.add(door);
  for (let rib = 0; rib < 6; rib += 1) {
    const ribMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 4.8, 0.1), doorMat);
    ribMesh.position.set(-2.5 + rib * 1.0, 2.5, 5.22);
    warehouse.add(ribMesh);
  }
  const signMat = makeGlowMaterial(0xe8b93c, 1.1);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(10, 1.1, 0.3), signMat);
  sign.position.set(0, 6.2, 5.05);
  warehouse.add(sign);
  const dockStep = new THREE.Mesh(
    new THREE.BoxGeometry(10, 0.6, 3),
    makeMaterial(0x6a6d70, 0.95, 0),
  );
  dockStep.position.set(0, 0.3, 6.4);
  dockStep.receiveShadow = true;
  warehouse.add(dockStep);
  // Crates and a barrel by the door, so the warehouse reads as worked.
  const crateMat = makeMaterial(0x8a6f5c, 0.9, 0);
  for (const [cx, cz, size] of [[-5.5, 6.8, 1.4], [-4.0, 7.0, 1.0], [5.2, 6.8, 1.6]]) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), crateMat);
    crate.position.set(cx, size / 2, cz);
    crate.castShadow = true;
    warehouse.add(crate);
  }
  const barrelMat = makeMaterial(0x3a6db8, 0.7, 0.4);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.3, 12), barrelMat);
  barrel.position.set(4.2, 0.65, 7.0);
  barrel.castShadow = true;
  warehouse.add(barrel);
  group.add(warehouse);

  // --- dock lamps ------------------------------------------------------------------
  // Tall lamp posts around the yard. Their heads glow warm at night and
  // dim by day; the update loop drives the emissive intensity.
  function buildLamp(x, z) {
    const lamp = new THREE.Group();
    lamp.position.set(x, 0, z);
    const poleMat = makeMaterial(0x2a2e33, 0.7, 0.5);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 7.5, 8), poleMat);
    pole.position.y = 3.75;
    pole.castShadow = true;
    lamp.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 1.6), poleMat);
    arm.position.set(0, 7.4, 0.7);
    lamp.add(arm);
    const headMat = makeGlowMaterial(0xffd9a0, 0.4);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.5), headMat);
    head.position.set(0, 7.3, 1.4);
    lamp.add(head);
    lamp.userData.headMat = headMat;
    group.add(lamp);
    lamps.push(lamp);
    return lamp;
  }
  buildLamp(196, -196);
  buildLamp(234, -196);
  buildLamp(196, -234);
  buildLamp(234, -234);
  buildLamp(215, -215);

  // --- perimeter fence and gate ------------------------------------------------------
  // A chain-link run along the yard's south and west edges with a gate
  // where the road meets the yard. The fence is thin boxes with gaps,
  // so it reads as a fence without costing a texture.
  const fenceMat = makeMaterial(0x7a8a92, 0.6, 0.6);
  function fenceRun(x0, z0, x1, z1) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const run = new THREE.Mesh(new THREE.BoxGeometry(len, 2.4, 0.12), fenceMat);
    run.position.set((x0 + x1) / 2, 1.2, (z0 + z1) / 2);
    run.rotation.y = -Math.atan2(dz, dx);
    group.add(run);
    const posts = Math.floor(len / 4);
    for (let i = 0; i <= posts; i += 1) {
      const t = posts === 0 ? 0 : i / posts;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), fenceMat);
      post.position.set(x0 + dx * t, 1.3, z0 + dz * t);
      group.add(post);
    }
  }
  fenceRun(192, -192, 192, -238);
  fenceRun(192, -238, 238, -238);
  fenceRun(238, -238, 238, -208);
  // The gate: two posts and an open frame on the south edge, where the
  // road from the city reaches the yard.
  const gatePostMat = makeMaterial(0xe8b93c, 0.6, 0.4);
  for (const gx of [206, 214]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.4, 0.5), gatePostMat);
    post.position.set(gx, 1.7, -192);
    post.castShadow = true;
    group.add(post);
  }
  const gateBeam = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.5, 0.4), gatePostMat);
  gateBeam.position.set(210, 3.4, -192);
  group.add(gateBeam);
  const gateSign = new THREE.Mesh(
    new THREE.BoxGeometry(6, 1.0, 0.2),
    makeGlowMaterial(0x4fd8e8, 0.9),
  );
  gateSign.position.set(210, 2.6, -192);
  group.add(gateSign);

  // --- dock workers -------------------------------------------------------------------
  // Three yard hands in hi-vis shirts walking slow loops between the
  // stacks. They are simple figures — body, head, legs, a hard hat —
  // and they pause at the ends of their loops like real workers do.
  function buildWorker(shirtColor, loopPoints) {
    const worker = new THREE.Group();
    worker.name = 'DockWorker';
    const shirt = makeMaterial(shirtColor, 0.85, 0);
    const skin = makeMaterial(0xd9a679, 0.8, 0);
    const pants = makeMaterial(0x2a3a48, 0.85, 0);
    const hat = makeMaterial(0xf2b234, 0.6, 0.2);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), shirt);
    body.position.y = 1.15;
    body.castShadow = true;
    worker.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), skin);
    head.position.y = 1.85;
    head.castShadow = true;
    worker.add(head);
    const hardHat = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), hat);
    hardHat.position.y = 1.92;
    worker.add(hardHat);
    for (const side of [-0.18, 0.18]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.7, 0.28), pants);
      leg.position.set(side, 0.35, 0);
      worker.add(leg);
    }
    for (const side of [-0.42, 0.42]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.22), shirt);
      arm.position.set(side, 1.15, 0);
      worker.add(arm);
    }
    worker.userData.loop = loopPoints;
    worker.userData.loopIndex = 0;
    worker.userData.pauseLeft = 0;
    worker.userData.walkSpeed = 1.1 + Math.random() * 0.4;
    if (loopPoints.length > 0) {
      worker.position.set(loopPoints[0].x, 0, loopPoints[0].z);
    }
    group.add(worker);
    workers.push(worker);
    return worker;
  }
  buildWorker(WORKER_SHIRTS[0], [
    { x: 198, z: -210 }, { x: 214, z: -210 }, { x: 214, z: -226 }, { x: 198, z: -226 },
  ]);
  buildWorker(WORKER_SHIRTS[1], [
    { x: 220, z: -200 }, { x: 232, z: -200 }, { x: 232, z: -214 }, { x: 220, z: -214 },
  ]);
  buildWorker(WORKER_SHIRTS[2], [
    { x: 200, z: -232 }, { x: 210, z: -232 }, { x: 210, z: -238 }, { x: 200, z: -238 },
  ]);

  // --- smuggler's cache ------------------------------------------------------------------
  // A glowing disc and a crate between the stacks: the yard's hidden
  // pickup. The side-activity system watches the player's distance to
  // it; this module only builds it and spins the disc.
  const cache = new THREE.Group();
  cache.position.set(DOCK_POINTS.cache.x, 0, DOCK_POINTS.cache.z);
  cache.name = 'SmugglersCache';
  cacheDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.12, 20),
    makeGlowMaterial(0x4fd8e8, 1.2),
  );
  cacheDisc.position.y = 0.9;
  cache.add(cacheDisc);
  cacheGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 10, 8),
    makeGlowMaterial(0x7df3ff, 1.8),
  );
  cacheGlow.position.y = 1.5;
  cache.add(cacheGlow);
  const cacheCrate = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    makeMaterial(0x5a3a2a, 0.9, 0),
  );
  cacheCrate.position.y = 0.6;
  cacheCrate.castShadow = true;
  cache.add(cacheCrate);
  group.add(cache);

  if (scene) scene.add(group);
  void world;

  function updateWorkers(dt) {
    for (const worker of workers) {
      const loop = worker.userData.loop;
      if (!loop || loop.length < 2) continue;
      if (worker.userData.pauseLeft > 0) {
        worker.userData.pauseLeft -= dt;
        continue;
      }
      const target = loop[worker.userData.loopIndex];
      const dx = target.x - worker.position.x;
      const dz = target.z - worker.position.z;
      const dist = Math.hypot(dx, dz);
      const speed = worker.userData.walkSpeed;
      if (dist < 0.4) {
        worker.userData.loopIndex = (worker.userData.loopIndex + 1) % loop.length;
        worker.userData.pauseLeft = 1.5 + Math.random() * 2.5;
        continue;
      }
      const step = Math.min(dist, speed * dt);
      worker.position.x += (dx / dist) * step;
      worker.position.z += (dz / dist) * step;
      worker.rotation.y = Math.atan2(dx, dz);
      // A walking bob, so the figures read as walking, not sliding.
      worker.position.y = Math.abs(Math.sin(totalSeconds * 6 + worker.userData.loopIndex)) * 0.05;
    }
  }

  function updateCranes() {
    for (const crane of cranes) {
      const phase = crane.userData.swayPhase + totalSeconds * 0.5;
      const sway = Math.sin(phase) * 0.9;
      const hook = crane.userData.hook;
      const cable = crane.userData.cable;
      if (hook) {
        hook.position.x = sway;
        hook.position.y = crane.userData.hookBaseY + Math.sin(phase * 1.7) * 0.5;
      }
      if (cable) {
        cable.position.x = sway / 2;
        cable.rotation.z = Math.sin(phase) * 0.06;
      }
      if (crane.userData.hookLight) {
        crane.userData.hookLight.material.emissiveIntensity =
          1.4 + Math.sin(totalSeconds * 3 + crane.userData.swayPhase) * 0.8;
      }
    }
  }

  function updateLamps(night) {
    for (const lamp of lamps) {
      const mat = lamp.userData.headMat;
      if (!mat) continue;
      const target = night ? 2.2 : 0.35;
      mat.emissiveIntensity += (target - mat.emissiveIntensity) * 0.08;
    }
  }

  function update(dt, ctx = {}) {
    const step = Math.max(0, dt || 0);
    totalSeconds += step;
    updateWorkers(step);
    updateCranes();
    updateLamps(Boolean(ctx.night));
    if (cacheDisc) {
      cacheDisc.rotation.y += step * 1.4;
      cacheDisc.position.y = 0.9 + Math.sin(totalSeconds * 2) * 0.12;
    }
    if (cacheGlow) {
      const pulse = 1.4 + Math.sin(totalSeconds * 3) * 0.5;
      cacheGlow.material.emissiveIntensity = pulse;
      cacheGlow.scale.setScalar(1 + Math.sin(totalSeconds * 3) * 0.08);
    }
  }

  function getState() {
    return {
      yard: DOCKS_YARD,
      points: DOCK_POINTS,
      workers: workers.length,
      cranes: cranes.length,
      lamps: lamps.length,
      cacheAt: { x: DOCK_POINTS.cache.x, z: DOCK_POINTS.cache.z },
    };
  }

  return {
    update,
    getDockPoints: () => ({ ...DOCK_POINTS }),
    getBounds: () => ({ ...DOCKS_YARD }),
    getState,
    get group() { return group; },
    get workers() { return workers; },
    dispose() {
      if (scene) {
        try { scene.remove(group); } catch { /* teardown only */ }
      }
    },
  };
}

export default createDistrictSystem;
