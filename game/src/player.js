// player.js — Leo Marlow on foot in Solmar Bay.
//
// This module owns everything about the player while he is walking around
// Marisol Bay: his procedural humanoid body (built from plain three.js
// shapes, no imported art), his walk and run animation, WASD movement with
// a third-person camera that follows behind him, and getting in and out of
// cars with the E key. Driving itself lives in vehicles.js; this module only
// hands control over to a car and takes it back again.
//
// Public interface (what main.js and the other modules call):
//   createPlayer(scene, options)
//     options.city      — the city module's data (playerSpawn, bounds,
//                         buildingColliders); every field is optional and
//                         a sane open-ground default is used when missing.
//     options.vehicles  — the vehicle system from vehicles.js, or null;
//                         call player.bindVehicles(system) later instead.
//     Returns a player object:
//       player.group            — the THREE.Group in the scene (its
//                                 .position is the player's feet on the ground)
//       player.heading          — facing angle in radians (0 = facing -Z)
//       player.speed            — current ground speed in metres/second
//       player.inVehicle        — true while Leo is driving / riding
//       player.vehicle          — the car he is in, or null
//       player.bindVehicles(s)  — attach (or swap) the vehicle system
//       player.update(dt, input, camera)
//                               — one frame: move, animate, follow the
//                                 camera; input is { forward, back, left,
//                                 right, run, enterPressed, lookDX, lookDY }
//       player.enterVehicle(vehicle) — put Leo in the driver's seat
//       player.exitVehicle()    — step out beside the car, back on foot
//       player.setPosition(x, z, heading) — teleport (spawns, mission staging)
//       player.isDriving()      — same as reading player.inVehicle
//       player.dispose()        — remove the body from the scene
//
// How entering a car works: when E is pressed on foot, the player asks the
// vehicle system for the nearest car he can enter (parked or in traffic,
// within reach). If one is found he fades out of the walking world and the
// vehicle system takes over the driving. Pressing E again while driving
// parks the car, steps Leo out on the pavement side and hands control back
// here. The F key (stealing) is handled by vehicles.js, not here.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning — kept here (not in config.js) so this module also works on its own
// while the city agent's config is still being written. The integrator may
// move these numbers into config.js later; the values are the same either way.
// ---------------------------------------------------------------------------
const WALK_SPEED = 4.2; // metres per second, casual stroll
const RUN_SPEED = 8.5; // metres per second, holding Shift
const ACCELERATION = 26.0; // how fast Leo reaches his target speed
const TURN_RATE = 9.0; // radians per second the body turns toward movement
const ENTER_RANGE = 3.4; // how close Leo must be to a car to press E
const EXIT_SIDE_OFFSET = 2.4; // metres to the side of the car when stepping out
const CAMERA_DISTANCE = 7.5; // metres behind Leo
const CAMERA_HEIGHT = 3.4; // metres above his feet
const CAMERA_LOOK_HEIGHT = 1.6; // metres up the body the camera aims at

// Leo's look: teal jacket, dark jeans, warm skin, dark hair — original
// character, drawn only from boxes and spheres.
const SKIN_COLOR = 0xc98d64;
const HAIR_COLOR = 0x2b1d12;
const JACKET_COLOR = 0x1f7a6d;
const SHIRT_COLOR = 0xf2ead8;
const JEANS_COLOR = 0x2e3d55;
const SHOE_COLOR = 0x3a2e22;

// ---------------------------------------------------------------------------
// Procedural humanoid — a small articulated figure made of boxes, spheres and
// cylinders. The limbs are grouped at their shoulder/hip pivots so the walk
// animation can swing them like a pendulum.
// ---------------------------------------------------------------------------
function buildLeoBody() {
  const body = new THREE.Group();
  body.name = 'LeoMarlow';

  const skin = new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.75 });
  const hair = new THREE.MeshStandardMaterial({ color: HAIR_COLOR, roughness: 0.9 });
  const jacket = new THREE.MeshStandardMaterial({ color: JACKET_COLOR, roughness: 0.85 });
  const shirt = new THREE.MeshStandardMaterial({ color: SHIRT_COLOR, roughness: 0.9 });
  const jeans = new THREE.MeshStandardMaterial({ color: JEANS_COLOR, roughness: 0.9 });
  const shoe = new THREE.MeshStandardMaterial({ color: SHOE_COLOR, roughness: 0.8 });

  const addBox = (material, w, h, d, x, y, z, parent) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Torso: jacket over a pale shirt front.
  addBox(jacket, 0.52, 0.62, 0.3, 0, 1.18, 0, body);
  addBox(shirt, 0.3, 0.5, 0.04, 0, 1.18, 0.16, body);
  // Hips.
  addBox(jeans, 0.5, 0.22, 0.3, 0, 0.82, 0, body);
  // Head: skin sphere with a dark hair cap and a simple fringe.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 20, 16), skin);
  head.position.set(0, 1.68, 0);
  head.castShadow = true;
  body.add(head);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.215, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  hairCap.position.set(0, 1.72, -0.01);
  body.add(hairCap);
  addBox(hair, 0.34, 0.08, 0.1, 0, 1.82, 0.14, body);

  // Arms: pivot groups at the shoulders so they can swing while walking.
  const makeArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.31 * side, 1.44, 0);
    addBox(jacket, 0.15, 0.52, 0.17, 0, -0.26, 0, pivot);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skin);
    hand.position.set(0, -0.55, 0);
    hand.castShadow = true;
    pivot.add(hand);
    body.add(pivot);
    return pivot;
  };

  // Legs: pivot groups at the hips, with a shoe box at the bottom of each.
  const makeLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * side, 0.74, 0);
    addBox(jeans, 0.19, 0.6, 0.21, 0, -0.3, 0, pivot);
    addBox(shoe, 0.2, 0.09, 0.32, 0, -0.64, 0.04, pivot);
    body.add(pivot);
    return pivot;
  };

  return {
    group: body,
    leftArm: makeArm(-1),
    rightArm: makeArm(1),
    leftLeg: makeLeg(-1),
    rightLeg: makeLeg(1),
    torso: body,
  };
}

// ---------------------------------------------------------------------------
// Player factory
// ---------------------------------------------------------------------------
export function createPlayer(scene, options = {}) {
  const city = options.city || {};
  const bounds = city.bounds || { minX: -190, maxX: 190, minZ: -190, maxZ: 190 };
  const colliders = city.buildingColliders || [];
  const spawn = city.playerSpawn || { x: 0, z: 12, heading: 0 };

  const parts = buildLeoBody();
  const group = parts.group;
  group.position.set(spawn.x, 0, spawn.z);
  scene.add(group);

  let vehicles = options.vehicles || null;
  let heading = spawn.heading || 0;
  let speed = 0;
  let walkPhase = 0; // advances with distance walked; drives limb swing
  let cameraYawOffset = 0; // mouse-look offset from "directly behind Leo"
  let inVehicle = false;
  let currentVehicle = null;

  const tmpMove = new THREE.Vector3();

  // --- helpers ------------------------------------------------------------

  // Keep Leo out of building footprints: cheap circle-vs-AABB push-out.
  function resolveBuildingCollision(nextX, nextZ) {
    const radius = 0.45;
    for (const box of colliders) {
      const closestX = Math.max(box.minX, Math.min(nextX, box.maxX));
      const closestZ = Math.max(box.minZ, Math.min(nextZ, box.maxZ));
      const dx = nextX - closestX;
      const dz = nextZ - closestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < radius * radius && distSq > 0.000001) {
        const dist = Math.sqrt(distSq);
        nextX = closestX + (dx / dist) * radius;
        nextZ = closestZ + (dz / dist) * radius;
      } else if (distSq <= 0.000001) {
        // Dead centre inside a box (should not happen): shove him out south.
        nextZ = box.maxZ + radius;
      }
    }
    return { x: nextX, z: nextZ };
  }

  function clampToBounds(x, z) {
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
      z: Math.max(bounds.minZ, Math.min(bounds.maxZ, z)),
    };
  }

  // Swing arms and legs opposite each other; bob the body a little with
  // each step. Faster when running.
  function animateWalk(dt, moving) {
    if (moving && speed > 0.1) {
      walkPhase += dt * speed * 1.9;
      const swing = Math.min(0.85, 0.35 + speed * 0.05);
      const s = Math.sin(walkPhase);
      parts.leftLeg.rotation.x = s * swing;
      parts.rightLeg.rotation.x = -s * swing;
      parts.leftArm.rotation.x = -s * swing * 0.8;
      parts.rightArm.rotation.x = s * swing * 0.8;
      parts.leftArm.rotation.z = 0.08;
      parts.rightArm.rotation.z = -0.08;
      group.position.y = Math.abs(Math.cos(walkPhase)) * 0.05;
    } else {
      // Ease back to a relaxed idle stance: limbs return to neutral and
      // the arms hang slightly out from the body.
      const ease = Math.min(1, dt * 8);
      parts.leftLeg.rotation.x *= 1 - ease;
      parts.rightLeg.rotation.x *= 1 - ease;
      parts.leftArm.rotation.x *= 1 - ease;
      parts.rightArm.rotation.x *= 1 - ease;
      parts.leftArm.rotation.z += (0.08 - parts.leftArm.rotation.z) * ease;
      parts.rightArm.rotation.z += (-0.08 - parts.rightArm.rotation.z) * ease;
      group.position.y *= 1 - ease;
    }
  }

  // --- public API ---------------------------------------------------------

  const player = {
    group,
    get heading() {
      return heading;
    },
    get speed() {
      return speed;
    },
    get inVehicle() {
      return inVehicle;
    },
    get vehicle() {
      return currentVehicle;
    },

    bindVehicles(system) {
      vehicles = system;
    },

    isDriving() {
      return inVehicle;
    },

    setPosition(x, z, newHeading) {
      group.position.set(x, 0, z);
      if (typeof newHeading === 'number') {
        heading = newHeading;
        group.rotation.y = heading;
      }
      speed = 0;
    },

    enterVehicle(vehicle) {
      if (!vehicle || inVehicle) return false;
      inVehicle = true;
      currentVehicle = vehicle;
      group.visible = false;
      speed = 0;
      return true;
    },

    exitVehicle() {
      if (!inVehicle || !currentVehicle) return false;
      const car = currentVehicle;
      // Step out on the driver's side (left of the car's heading).
      const sideX = Math.cos(car.heading + Math.PI / 2);
      const sideZ = -Math.sin(car.heading + Math.PI / 2);
      const out = clampToBounds(
        car.group.position.x + sideX * EXIT_SIDE_OFFSET,
        car.group.position.z + sideZ * EXIT_SIDE_OFFSET,
      );
      const clear = resolveBuildingCollision(out.x, out.z);
      group.position.set(clear.x, 0, clear.z);
      heading = car.heading;
      group.rotation.y = heading;
      group.visible = true;
      inVehicle = false;
      currentVehicle = null;
      speed = 0;
      return true;
    },

    update(dt, input = {}, camera) {
      // While driving, Leo is hidden inside the car; the vehicle system
      // moves him. Only handle "E to get out" here.
      if (inVehicle) {
        if (input.enterPressed && vehicles && typeof vehicles.exitPlayerVehicle === 'function') {
          vehicles.exitPlayerVehicle();
        }
        return;
      }

      // Mouse look: orbit the camera around Leo; the offset eases back to
      // directly-behind him so the camera never gets stuck sideways.
      // (lookDY is accepted for a future pitch control and ignored here —
      // the follow camera keeps a fixed height.)
      if (input.lookDX) cameraYawOffset -= input.lookDX * 0.0028;
      cameraYawOffset *= Math.max(0, 1 - dt * 0.9);

      // Movement is relative to the camera: W walks away from the camera.
      const camYaw = heading + cameraYawOffset;
      const forwardX = -Math.sin(camYaw);
      const forwardZ = -Math.cos(camYaw);
      const rightX = Math.cos(camYaw);
      const rightZ = -Math.sin(camYaw);

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
        const len = Math.hypot(moveX, moveZ);
        moveX /= len;
        moveZ /= len;
      }

      const targetSpeed = moving ? (input.run ? RUN_SPEED : WALK_SPEED) : 0;
      // Accelerate toward the target speed at a fixed rate, so Leo speeds
      // up and slows down over a few steps instead of snapping.
      if (speed < targetSpeed) speed = Math.min(targetSpeed, speed + ACCELERATION * dt);
      else if (speed > targetSpeed) speed = Math.max(targetSpeed, speed - ACCELERATION * 1.4 * dt);

      if (moving) {
        // Face where we are going, turning smoothly instead of snapping.
        const targetHeading = Math.atan2(-moveX, -moveZ);
        let diff = targetHeading - heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        heading += THREE.MathUtils.clamp(diff, -TURN_RATE * dt, TURN_RATE * dt);
        group.rotation.y = heading;

        tmpMove.set(moveX * speed * dt, 0, moveZ * speed * dt);
        const next = clampToBounds(
          group.position.x + tmpMove.x,
          group.position.z + tmpMove.z,
        );
        const clear = resolveBuildingCollision(next.x, next.z);
        group.position.x = clear.x;
        group.position.z = clear.z;
      }

      animateWalk(dt, moving);

      // E to get in: ask the vehicle system for the closest enterable car.
      if (input.enterPressed && vehicles && typeof vehicles.nearestEnterableVehicle === 'function') {
        const car = vehicles.nearestEnterableVehicle(group.position, ENTER_RANGE);
        if (car && typeof vehicles.enterPlayerVehicle === 'function') {
          vehicles.enterPlayerVehicle(car);
        }
      }

      // Third-person follow camera: behind Leo, looking slightly ahead.
      if (camera) {
        const camYawNow = heading + cameraYawOffset;
        const camX = group.position.x + Math.sin(camYawNow) * CAMERA_DISTANCE;
        const camZ = group.position.z + Math.cos(camYawNow) * CAMERA_DISTANCE;
        const desired = new THREE.Vector3(camX, CAMERA_HEIGHT, camZ);
        camera.position.lerp(desired, Math.min(1, dt * 6));
        camera.lookAt(
          group.position.x - Math.sin(camYawNow) * 2.5,
          CAMERA_LOOK_HEIGHT,
          group.position.z - Math.cos(camYawNow) * 2.5,
        );
      }
    },

    dispose() {
      scene.remove(group);
    },
  };

  return player;
}
