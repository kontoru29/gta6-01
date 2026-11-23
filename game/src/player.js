// player.js — Leo Marlow on foot in Marisol Bay, rebuilt for Round 7.
//
// The on-foot half of the player. Leo is a small articulated figure built
// from plain three.js shapes: he walks the city on WASD, a third-person
// camera trails behind him, and E hands him to the vehicle system when he
// climbs into a car — and takes him back when he steps out. Driving,
// traffic and car theft live in vehicles.js; this file only owns the
// walking body.
//
// New this round: sprinting costs stamina. Running drains the meter,
// walking and standing refill it, and Leo cannot sprint again until it
// climbs back past the floor — so a chase on foot costs something
// instead of being free forever. The follow camera also eases a little
// further back as Leo picks up speed, so a sprint feels faster than a
// stroll. The stamina number is exposed as player.stamina for the HUD.
//
// The contract other modules rely on (every name and signature stays):
//   createPlayer(scene, options)
//     options.city     — city data; playerSpawn, bounds, buildingColliders.
//                        All optional; open ground is the fallback.
//     options.vehicles — the vehicle system, or attach later with
//                        bindVehicles.
//     Returns the player:
//       player.group            — THREE.Group in the scene; .position is
//                                 Leo's feet, .rotation.y his facing.
//       player.heading          — facing angle, radians, 0 faces -Z.
//       player.speed            — current ground speed, metres per second.
//       player.stamina          — sprint stamina, 0..100.
//       player.inVehicle        — true while Leo is inside a car.
//       player.vehicle          — the car he is in, or null.
//       player.bindVehicles(s)  — attach (or swap) the vehicle system.
//       player.update(dt, input, camera)
//                               — one frame of walking, animation and the
//                                 follow camera. input: { forward, back,
//                                 left, right, run, enterPressed,
//                                 lookDX, lookDY }.
//       player.enterVehicle(car) — hide Leo, mark him as driving. Boolean.
//       player.exitVehicle()    — step out ahead of the car. Boolean.
//       player.setPosition(x, z, heading) — teleport (spawn, mission staging).
//       player.isDriving()      — same as reading player.inVehicle.
//       player.dispose()        — take Leo's body out of the scene.
//
// Entering a car: on foot, E asks the vehicle system for the nearest car
// in reach; if one answers, the vehicle system takes over and this module
// hides Leo. E again while driving asks the vehicle system to park and
// hand Leo back, and he steps out in front of the car. Stealing with F is
// the vehicle system's job, not this file's.

import * as THREE from 'three';
import { PLAYER, STAMINA } from './config.js';
import { clamp } from './utils.js';

// Follow camera: trails behind Leo and eases into place instead of
// snapping, so turning never whips the view around.
const CAM_BEHIND = 7.5; // metres behind Leo's heels
const CAM_BEHIND_RUN = 9.0; // metres behind him at a full sprint
const CAM_HEIGHT = 3.4; // metres above the pavement
const CAM_LOOK_Y = 1.6; // metres up Leo's body the camera looks at
const CAM_LOOK_FWD = 2.5; // metres past Leo the camera aims at
const MOUSE_SENS = 0.0028; // radians of yaw per pixel of mouse travel
const DRIFT_DECAY = 0.9; // per second the mouse offset relaxes back to zero
const STEP_OUT_DIST = 2.4; // metres ahead of the car when stepping out

// Dust puffs: a tiny pre-made pool, created once at startup and reused —
// never allocated while the game runs. A puff lives half a second.
const POOL_SIZE = 8;
const PUFF_SPAN = 0.5; // seconds one puff lasts
const PUFF_EVERY = 0.12; // seconds between puffs while running
const PUFF_LIFT = 0.7; // metres per second a puff drifts up
const DUST_TINT = 0xcbb28a; // dry golden-hour dust

// Leo's look: a teal jacket over a pale shirt, dark jeans, warm skin,
// dark hair. An original character, drawn only from boxes and spheres.
const PALETTE = {
  skin: 0xc98d64,
  hair: 0x2b1d12,
  jacket: 0x1f7a6d,
  shirt: 0xf2ead8,
  jeans: 0x2e3d55,
  shoes: 0x3a2e22,
};

// ---------------------------------------------------------------------------
// The figure. Limbs hang from pivot groups at shoulders and hips, so the
// walk cycle can swing them like pendulums around those joints. Parts are
// listed as data (material, size, offset) and stamped out by one helper,
// which keeps the builder a flat list instead of nested code.
// ---------------------------------------------------------------------------
function assembleLeo() {
  const body = new THREE.Group();
  body.name = 'LeoMarlow';

  const skinMat = new THREE.MeshStandardMaterial({ color: PALETTE.skin, roughness: 0.75 });
  const hairMat = new THREE.MeshStandardMaterial({ color: PALETTE.hair, roughness: 0.9 });
  const jacketMat = new THREE.MeshStandardMaterial({ color: PALETTE.jacket, roughness: 0.85 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: PALETTE.shirt, roughness: 0.9 });
  const jeansMat = new THREE.MeshStandardMaterial({ color: PALETTE.jeans, roughness: 0.9 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: PALETTE.shoes, roughness: 0.8 });

  // One box, placed once, casting a shadow.
  function placeBox(material, size, at, parent) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // Jacket torso with a pale shirt panel down the front, then hips.
  placeBox(jacketMat, [0.52, 0.62, 0.3], [0, 1.18, 0], body);
  placeBox(shirtMat, [0.3, 0.5, 0.04], [0, 1.18, 0.16], body);
  placeBox(jeansMat, [0.5, 0.22, 0.3], [0, 0.82, 0], body);

  // Head: a skin sphere, a hair cap over the top half, and a fringe slab.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 20, 16), skinMat);
  head.position.set(0, 1.68, 0);
  head.castShadow = true;
  body.add(head);
  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.215, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hairMat,
  );
  hairCap.position.set(0, 1.72, -0.01);
  body.add(hairCap);
  placeBox(hairMat, [0.34, 0.08, 0.1], [0, 1.82, 0.14], body);

  // An arm is a pivot at the shoulder holding a jacket sleeve and a hand.
  function buildArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.31 * side, 1.44, 0);
    placeBox(jacketMat, [0.15, 0.52, 0.17], [0, -0.26, 0], pivot);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skinMat);
    hand.position.set(0, -0.55, 0);
    hand.castShadow = true;
    pivot.add(hand);
    body.add(pivot);
    return pivot;
  }

  // A leg is a pivot at the hip holding a jeans tube and a shoe.
  function buildLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * side, 0.74, 0);
    placeBox(jeansMat, [0.19, 0.6, 0.21], [0, -0.3, 0], pivot);
    placeBox(shoeMat, [0.2, 0.09, 0.32], [0, -0.64, 0.04], pivot);
    body.add(pivot);
    return pivot;
  }

  return {
    root: body,
    armLeft: buildArm(-1),
    armRight: buildArm(1),
    legLeft: buildLeg(-1),
    legRight: buildLeg(1),
  };
}

// ---------------------------------------------------------------------------
// Player factory
// ---------------------------------------------------------------------------
export function createPlayer(scene, options = {}) {
  const town = options.city || {};
  const limits = town.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const walls = town.buildingColliders || [];
  const start = town.playerSpawn || { x: 0, z: 12, heading: 0 };

  const figure = assembleLeo();
  const root = figure.root;
  root.position.set(start.x, 0, start.z);
  scene.add(root);

  // All mutable state in one place, so the methods below stay short.
  const state = {
    heading: start.heading || 0,
    speed: 0,
    stamina: STAMINA.max,
    sprinting: false, // set every frame in update; read via isSprinting
    cycle: 0, // walk-cycle phase; drives the limb swing
    drift: 0, // mouse-look offset from "straight behind Leo"
    inCar: false,
    car: null,
    vehicles: options.vehicles || null,
  };
  root.rotation.y = state.heading;

  const eye = new THREE.Vector3();

  // One scratch point, reused every frame: pushing Leo out of building
  // walls writes its answer here instead of allocating a fresh object.
  const wallOut = { x: 0, z: 0 };

  // Push a circle out of every building wall, in place. Closest point,
  // push out along the overlap, or out through the nearest face when the
  // centre is inside the box; the answer lands in `out`.
  function pushOutOfWalls(x, z, radius, out) {
    let px = x;
    let pz = z;
    for (const c of walls) {
      const nearX = clamp(px, c.minX, c.maxX);
      const nearZ = clamp(pz, c.minZ, c.maxZ);
      const dx = px - nearX;
      const dz = pz - nearZ;
      const distSq = dx * dx + dz * dz;
      if (distSq >= radius * radius) continue;
      if (distSq > 1e-9) {
        const dist = Math.sqrt(distSq);
        const push = radius - dist;
        px += (dx / dist) * push;
        pz += (dz / dist) * push;
      } else {
        const toLeft = px - c.minX + radius;
        const toRight = c.maxX - px + radius;
        const toTop = pz - c.minZ + radius;
        const toBottom = c.maxZ - pz + radius;
        const smallest = Math.min(toLeft, toRight, toTop, toBottom);
        if (smallest === toLeft) px = c.minX - radius;
        else if (smallest === toRight) px = c.maxX + radius;
        else if (smallest === toTop) pz = c.minZ - radius;
        else pz = c.maxZ + radius;
      }
    }
    out.x = px;
    out.z = pz;
  }

  // Dust pool: one shared puff shape, one small material per puff (made
  // once, here), each puff a mesh that starts hidden. Puffs are handed out
  // round-robin and fade back out — nothing is created while playing.
  const puffShape = new THREE.SphereGeometry(0.32, 8, 6);
  const puffs = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: DUST_TINT, transparent: true, opacity: 0, depthWrite: false,
    });
    const mesh = new THREE.Mesh(puffShape, material);
    mesh.visible = false;
    mesh.scale.set(1, 0.5, 1);
    scene.add(mesh);
    puffs.push({ mesh, material, life: 0 });
  }
  let puffCursor = 0;
  let puffTimer = 0;

  // Wake one pooled puff at Leo's feet. Cheap by design: the mesh and the
  // material already exist; this only flips numbers on them.
  function emitPuff(x, z) {
    const puff = puffs[puffCursor];
    puffCursor = (puffCursor + 1) % POOL_SIZE;
    puff.life = PUFF_SPAN;
    puff.mesh.position.set(x + (Math.random() - 0.5) * 0.5, 0.1, z + (Math.random() - 0.5) * 0.5);
    puff.mesh.scale.set(0.7, 0.35, 0.7);
    puff.mesh.visible = true;
    puff.material.opacity = 0.4;
  }

  // Age every live puff: it rises, swells and fades out, then hides.
  function agePuffs(dt) {
    for (const puff of puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.mesh.visible = false;
        puff.material.opacity = 0;
        continue;
      }
      const gone = 1 - puff.life / PUFF_SPAN;
      puff.mesh.position.y += PUFF_LIFT * dt;
      const size = 0.7 + gone * 1.1;
      puff.mesh.scale.set(size, size * 0.5, size);
      puff.material.opacity = 0.4 * (1 - gone);
    }
  }

  // Swing the limbs with the walk cycle while moving; ease them back to a
  // relaxed idle stance (arms slightly out, the bob gone) when still. A
  // touch of idle breathing keeps Leo from looking frozen on the menu.
  function playGait(dt, moving) {
    if (moving && state.speed > 0.1) {
      state.cycle += dt * state.speed * 2.0;
      const swing = Math.min(0.8, 0.3 + state.speed * 0.06);
      const wave = Math.sin(state.cycle);
      figure.legLeft.rotation.x = wave * swing;
      figure.legRight.rotation.x = -wave * swing;
      figure.armLeft.rotation.x = -wave * swing * 0.8;
      figure.armRight.rotation.x = wave * swing * 0.8;
      figure.armLeft.rotation.z = 0.08;
      figure.armRight.rotation.z = -0.08;
      root.position.y = Math.abs(Math.cos(state.cycle)) * 0.05;
    } else {
      const ease = Math.min(1, dt * 8);
      figure.legLeft.rotation.x *= 1 - ease;
      figure.legRight.rotation.x *= 1 - ease;
      figure.armLeft.rotation.x *= 1 - ease;
      figure.armRight.rotation.x *= 1 - ease;
      figure.armLeft.rotation.z += (0.08 - figure.armLeft.rotation.z) * ease;
      figure.armRight.rotation.z += (-0.08 - figure.armRight.rotation.z) * ease;
      root.position.y *= 1 - ease;
    }
  }

  // Chase the spot behind Leo with a damped lerp, then look a little past
  // him so the street ahead stays in frame. The camera eases further back
  // as Leo sprints, so running feels faster than strolling.
  function trackCamera(dt, camera) {
    if (!camera) return;
    const yaw = state.heading + state.drift;
    const speedShare = clamp(state.speed / PLAYER.runSpeed, 0, 1);
    const behind = CAM_BEHIND + (CAM_BEHIND_RUN - CAM_BEHIND) * speedShare;
    const behindX = Math.sin(yaw) * behind;
    const behindZ = Math.cos(yaw) * behind;
    eye.set(
      root.position.x + behindX,
      CAM_HEIGHT,
      root.position.z + behindZ,
    );
    camera.position.lerp(eye, Math.min(1, dt * 6));
    camera.lookAt(
      root.position.x - Math.sin(yaw) * CAM_LOOK_FWD,
      CAM_LOOK_Y,
      root.position.z - Math.cos(yaw) * CAM_LOOK_FWD,
    );
  }

  // --- the player object --------------------------------------------------
  const player = {
    group: root,

    get heading() {
      return state.heading;
    },
    get speed() {
      return state.speed;
    },
    get stamina() {
      return state.stamina;
    },
    get isSprinting() {
      return state.sprinting === true;
    },
    get inVehicle() {
      return state.inCar;
    },
    get vehicle() {
      return state.car;
    },

    bindVehicles(system) {
      state.vehicles = system;
    },

    isDriving() {
      return state.inCar;
    },

    setPosition(x, z, newHeading) {
      root.position.set(x, 0, z);
      if (typeof newHeading === 'number') {
        state.heading = newHeading;
        root.rotation.y = state.heading;
      }
      state.speed = 0;
    },

    enterVehicle(vehicle) {
      if (!vehicle || state.inCar) return false;
      state.inCar = true;
      state.car = vehicle;
      root.visible = false;
      state.speed = 0;
      return true;
    },

    exitVehicle() {
      if (!state.inCar || !state.car) return false;
      const car = state.car;
      // Step out in front of the car, where the street is, then make sure
      // the spot is inside the city and clear of building walls.
      const aheadX = -Math.sin(car.heading);
      const aheadZ = -Math.cos(car.heading);
      const steppedX = clamp(
        car.group.position.x + aheadX * STEP_OUT_DIST, limits.minX, limits.maxX,
      );
      const steppedZ = clamp(
        car.group.position.z + aheadZ * STEP_OUT_DIST, limits.minZ, limits.maxZ,
      );
      pushOutOfWalls(steppedX, steppedZ, PLAYER.radius, wallOut);
      root.position.set(wallOut.x, 0, wallOut.z);
      emitPuff(wallOut.x, wallOut.z);
      state.heading = car.heading;
      root.rotation.y = state.heading;
      root.visible = true;
      state.inCar = false;
      state.car = null;
      state.speed = 0;
      return true;
    },

    update(dt, input = {}, camera) {
      // Dust keeps ageing even while Leo is in a car.
      agePuffs(dt);

      // In a car Leo is hidden and the vehicle system drives; the only job
      // here is to catch "E to get out" and hand the request over.
      // Stamina refills while he sits, so he steps out ready to run.
      if (state.inCar) {
        state.stamina = Math.min(STAMINA.max, state.stamina + STAMINA.regenPerSecond * dt);
        if (input.enterPressed && state.vehicles
          && typeof state.vehicles.exitPlayerVehicle === 'function') {
          state.vehicles.exitPlayerVehicle();
        }
        return;
      }

      // Mouse look orbits the camera around Leo. The offset eases back to
      // straight-behind him, so the view never gets stuck sideways.
      // (lookDY is accepted for a future pitch control and ignored here —
      // the follow camera keeps a fixed height.)
      if (input.lookDX) state.drift -= input.lookDX * MOUSE_SENS;
      state.drift *= Math.max(0, 1 - dt * DRIFT_DECAY);

      // WASD moves relative to the camera: W walks away from the lens.
      const viewYaw = state.heading + state.drift;
      const forwardX = -Math.sin(viewYaw);
      const forwardZ = -Math.cos(viewYaw);
      const rightX = Math.cos(viewYaw);
      const rightZ = -Math.sin(viewYaw);

      let moveX = 0;
      let moveZ = 0;
      if (input.forward) {
        moveX += forwardX;
        moveZ += forwardZ;
      }
      if (input.back) {
        moveX -= forwardX;
        moveZ -= forwardZ;
      }
      if (input.right) {
        moveX += rightX;
        moveZ += rightZ;
      }
      if (input.left) {
        moveX -= rightX;
        moveZ -= rightZ;
      }
      const moving = moveX !== 0 || moveZ !== 0;
      if (moving) {
        const length = Math.hypot(moveX, moveZ);
        moveX /= length;
        moveZ /= length;
      }

      // Sprinting costs stamina: Shift runs only while the meter is above
      // the floor. An empty meter means walking until it refills past the
      // floor again, so a chase on foot costs something.
      const wantsRun = Boolean(input.run) && state.stamina > STAMINA.minToRun;
      const sprinting = moving && wantsRun;
      state.sprinting = sprinting;
      if (sprinting) {
        state.stamina = Math.max(0, state.stamina - STAMINA.drainPerSecond * dt);
      } else if (!moving || !input.run) {
        state.stamina = Math.min(STAMINA.max, state.stamina + STAMINA.regenPerSecond * dt);
      }

      // Instant response (no accel smoothing, no turn easing): the speed
      // and the facing snap to what the keys ask for, so Leo moves the
      // moment the player presses — never a beat late.
      const targetSpeed = moving ? (sprinting ? PLAYER.runSpeed : PLAYER.walkSpeed) : 0;
      state.speed = targetSpeed;

      if (moving) {
        state.heading = Math.atan2(-moveX, -moveZ);
        root.rotation.y = state.heading;

        const nextX = clamp(
          root.position.x + moveX * state.speed * dt, limits.minX, limits.maxX,
        );
        const nextZ = clamp(
          root.position.z + moveZ * state.speed * dt, limits.minZ, limits.maxZ,
        );
        pushOutOfWalls(nextX, nextZ, PLAYER.radius, wallOut);
        root.position.x = wallOut.x;
        root.position.z = wallOut.z;

        // Running kicks up dust at Leo's heels, a puff every beat.
        if (state.speed >= PLAYER.runSpeed) {
          puffTimer -= dt;
          if (puffTimer <= 0) {
            emitPuff(root.position.x, root.position.z);
            puffTimer = PUFF_EVERY;
          }
        } else {
          puffTimer = 0;
        }
      } else {
        puffTimer = 0;
      }

      playGait(dt, moving);

      // E to climb in: ask the vehicle system for the closest car in reach.
      if (input.enterPressed && state.vehicles
        && typeof state.vehicles.nearestEnterableVehicle === 'function') {
        const car = state.vehicles.nearestEnterableVehicle(root.position, PLAYER.enterCarRange);
        if (car && typeof state.vehicles.enterPlayerVehicle === 'function') {
          state.vehicles.enterPlayerVehicle(car);
        }
      }

      trackCamera(dt, camera);
    },

    dispose() {
      for (const puff of puffs) scene.remove(puff.mesh);
      scene.remove(root);
    },
  };

  return player;
}
