// player.js — Leo Marlow on foot in Marisol Bay.
//
// This module is the on-foot half of the player. It builds Leo as a small
// articulated figure out of plain three.js shapes, moves him around the
// city with WASD, keeps a third-person camera trailing behind him, and
// hands him over to the vehicle system when he climbs into a car (E) and
// takes him back when he steps out again. Driving physics, traffic and
// car theft live in vehicles.js; this file only owns the walking body.
//
// What other modules call (the contract — keep every name and signature):
//   createPlayer(scene, options)
//     options.city     — city data; playerSpawn, bounds, buildingColliders.
//                        Everything is optional; open ground is the fallback.
//     options.vehicles — the vehicle system, or attach later with bindVehicles.
//     Returns the player:
//       player.group            — THREE.Group in the scene; .position is Leo's
//                                 feet on the ground, .rotation.y his facing.
//       player.heading          — facing angle, radians, 0 faces -Z.
//       player.speed            — current ground speed, metres per second.
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
// Entering a car: on foot, E asks the vehicle system for the nearest car in
// reach; if one answers, the vehicle system takes over and this module hides
// Leo. E again while driving asks the vehicle system to park and hand Leo
// back, and he steps out in front of the car. Stealing with F is the
// vehicle system's job, not this file's.

import * as THREE from 'three';
import { PLAYER } from './config.js';
import {
  clamp,
  lerpAngle,
  moveTowards,
  resolveCircleColliders,
} from './utils.js';

// Follow-camera geometry and feel. The camera trails behind Leo and eases
// toward its spot instead of snapping, so turning never whips the view.
const FOLLOW_DISTANCE = 7.5; // metres behind Leo's heels
const FOLLOW_HEIGHT = 3.4; // metres above the pavement
const AIM_HEIGHT = 1.6; // metres up Leo's body the camera looks at
const LOOK_AHEAD = 2.5; // metres in front of Leo the camera aims past
const MOUSE_SENSITIVITY = 0.0028; // radians of yaw per pixel of mouse travel
const YAW_DRIFT_RECOVERY = 0.9; // per second the mouse offset eases back
const ACCELERATION = 26; // metres per second squared, speeding up
const BRAKING = 36; // metres per second squared, slowing down
const EXIT_FORWARD_OFFSET = 2.4; // metres ahead of the car when stepping out

// Leo's look: a teal jacket over a pale shirt, dark jeans, warm skin and
// dark hair. An original character, drawn only from boxes and spheres.
const LEO_COLORS = {
  skin: 0xc98d64,
  hair: 0x2b1d12,
  jacket: 0x1f7a6d,
  shirt: 0xf2ead8,
  jeans: 0x2e3d55,
  shoes: 0x3a2e22,
};

// ---------------------------------------------------------------------------
// The figure: a small articulated humanoid. Every limb hangs from a pivot
// group at its shoulder or hip, so the walk cycle can swing the limbs like
// pendulums around those joints.
// ---------------------------------------------------------------------------
function makeLeoFigure() {
  const root = new THREE.Group();
  root.name = 'LeoMarlow';

  const skinMat = new THREE.MeshStandardMaterial({ color: LEO_COLORS.skin, roughness: 0.75 });
  const hairMat = new THREE.MeshStandardMaterial({ color: LEO_COLORS.hair, roughness: 0.9 });
  const jacketMat = new THREE.MeshStandardMaterial({ color: LEO_COLORS.jacket, roughness: 0.85 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: LEO_COLORS.shirt, roughness: 0.9 });
  const jeansMat = new THREE.MeshStandardMaterial({ color: LEO_COLORS.jeans, roughness: 0.9 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: LEO_COLORS.shoes, roughness: 0.8 });

  // One box, placed once, casting a shadow. Everything below is built from
  // this helper so the figure stays a flat list of parts, not nested code.
  function box(material, size, at, parent) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // Jacket torso with a pale shirt panel down the front, then hips.
  box(jacketMat, [0.52, 0.62, 0.3], [0, 1.18, 0], root);
  box(shirtMat, [0.3, 0.5, 0.04], [0, 1.18, 0.16], root);
  box(jeansMat, [0.5, 0.22, 0.3], [0, 0.82, 0], root);

  // Head: a skin sphere, a hair cap over the top half, and a fringe slab.
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 20, 16), skinMat);
  head.position.set(0, 1.68, 0);
  head.castShadow = true;
  root.add(head);
  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.215, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hairMat,
  );
  hairCap.position.set(0, 1.72, -0.01);
  root.add(hairCap);
  box(hairMat, [0.34, 0.08, 0.1], [0, 1.82, 0.14], root);

  // An arm is a pivot at the shoulder holding a jacket sleeve and a hand.
  function buildArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.31 * side, 1.44, 0);
    box(jacketMat, [0.15, 0.52, 0.17], [0, -0.26, 0], pivot);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skinMat);
    hand.position.set(0, -0.55, 0);
    hand.castShadow = true;
    pivot.add(hand);
    root.add(pivot);
    return pivot;
  }

  // A leg is a pivot at the hip holding a jeans tube and a shoe.
  function buildLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * side, 0.74, 0);
    box(jeansMat, [0.19, 0.6, 0.21], [0, -0.3, 0], pivot);
    box(shoeMat, [0.2, 0.09, 0.32], [0, -0.64, 0.04], pivot);
    root.add(pivot);
    return pivot;
  }

  return {
    root,
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

  const figure = makeLeoFigure();
  const root = figure.root;
  root.position.set(start.x, 0, start.z);
  scene.add(root);

  // All mutable state in one place, so the methods below stay short.
  const rig = {
    heading: start.heading || 0,
    speed: 0,
    cycle: 0, // walk-cycle phase; drives the limb swing
    yawDrift: 0, // mouse-look offset from "straight behind Leo"
    inCar: false,
    car: null,
    vehicles: options.vehicles || null,
  };
  root.rotation.y = rig.heading;

  const scratch = new THREE.Vector3();

  // Keep a point inside the city rectangle.
  function keepInCity(x, z) {
    return {
      x: clamp(x, limits.minX, limits.maxX),
      z: clamp(z, limits.minZ, limits.maxZ),
    };
  }

  // Swing the limbs with the walk cycle while moving; ease them back to a
  // relaxed idle stance (arms slightly out, a little bob gone) when still.
  // A touch of idle breathing keeps Leo from looking frozen on the menu.
  function stepWalkCycle(dt, moving) {
    if (moving && rig.speed > 0.1) {
      rig.cycle += dt * rig.speed * 2.0;
      const swing = Math.min(0.8, 0.3 + rig.speed * 0.06);
      const wave = Math.sin(rig.cycle);
      figure.legLeft.rotation.x = wave * swing;
      figure.legRight.rotation.x = -wave * swing;
      figure.armLeft.rotation.x = -wave * swing * 0.8;
      figure.armRight.rotation.x = wave * swing * 0.8;
      figure.armLeft.rotation.z = 0.08;
      figure.armRight.rotation.z = -0.08;
      root.position.y = Math.abs(Math.cos(rig.cycle)) * 0.05;
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
  // him so the street ahead stays in frame.
  function followWithCamera(dt, camera) {
    if (!camera) return;
    const yaw = rig.heading + rig.yawDrift;
    const behindX = Math.sin(yaw) * FOLLOW_DISTANCE;
    const behindZ = Math.cos(yaw) * FOLLOW_DISTANCE;
    scratch.set(
      root.position.x + behindX,
      FOLLOW_HEIGHT,
      root.position.z + behindZ,
    );
    camera.position.lerp(scratch, Math.min(1, dt * 6));
    camera.lookAt(
      root.position.x - Math.sin(yaw) * LOOK_AHEAD,
      AIM_HEIGHT,
      root.position.z - Math.cos(yaw) * LOOK_AHEAD,
    );
  }

  // --- the player object --------------------------------------------------
  const player = {
    group: root,

    get heading() {
      return rig.heading;
    },
    get speed() {
      return rig.speed;
    },
    get inVehicle() {
      return rig.inCar;
    },
    get vehicle() {
      return rig.car;
    },

    bindVehicles(system) {
      rig.vehicles = system;
    },

    isDriving() {
      return rig.inCar;
    },

    setPosition(x, z, newHeading) {
      root.position.set(x, 0, z);
      if (typeof newHeading === 'number') {
        rig.heading = newHeading;
        root.rotation.y = rig.heading;
      }
      rig.speed = 0;
    },

    enterVehicle(vehicle) {
      if (!vehicle || rig.inCar) return false;
      rig.inCar = true;
      rig.car = vehicle;
      root.visible = false;
      rig.speed = 0;
      return true;
    },

    exitVehicle() {
      if (!rig.inCar || !rig.car) return false;
      const car = rig.car;
      // Step out in front of the car, where the street is, then make sure
      // the spot is inside the city and clear of building walls.
      const aheadX = -Math.sin(car.heading);
      const aheadZ = -Math.cos(car.heading);
      const stepped = keepInCity(
        car.group.position.x + aheadX * EXIT_FORWARD_OFFSET,
        car.group.position.z + aheadZ * EXIT_FORWARD_OFFSET,
      );
      const clear = resolveCircleColliders(stepped.x, stepped.z, PLAYER.radius, walls);
      root.position.set(clear.x, 0, clear.z);
      rig.heading = car.heading;
      root.rotation.y = rig.heading;
      root.visible = true;
      rig.inCar = false;
      rig.car = null;
      rig.speed = 0;
      return true;
    },

    update(dt, input = {}, camera) {
      // In a car Leo is hidden and the vehicle system drives; the only job
      // here is to catch "E to get out" and hand the request over.
      if (rig.inCar) {
        if (input.enterPressed && rig.vehicles
          && typeof rig.vehicles.exitPlayerVehicle === 'function') {
          rig.vehicles.exitPlayerVehicle();
        }
        return;
      }

      // Mouse look orbits the camera around Leo. The offset eases back to
      // straight-behind him, so the view never gets stuck sideways.
      // (lookDY is accepted for a future pitch control and ignored here —
      // the follow camera keeps a fixed height.)
      if (input.lookDX) rig.yawDrift -= input.lookDX * MOUSE_SENSITIVITY;
      rig.yawDrift *= Math.max(0, 1 - dt * YAW_DRIFT_RECOVERY);

      // WASD moves relative to the camera: W walks away from the lens.
      const viewYaw = rig.heading + rig.yawDrift;
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

      // Ease the speed toward its target instead of snapping, so Leo
      // speeds up and slows down over a few steps.
      const targetSpeed = moving ? (input.run ? PLAYER.runSpeed : PLAYER.walkSpeed) : 0;
      rig.speed = moveTowards(rig.speed, targetSpeed, (targetSpeed > rig.speed ? ACCELERATION : BRAKING) * dt);

      if (moving) {
        // Turn to face the direction of travel, smoothly, never snapping.
        const targetHeading = Math.atan2(-moveX, -moveZ);
        rig.heading = lerpAngle(rig.heading, targetHeading, PLAYER.turnSpeed * dt);
        root.rotation.y = rig.heading;

        const next = keepInCity(
          root.position.x + moveX * rig.speed * dt,
          root.position.z + moveZ * rig.speed * dt,
        );
        const clear = resolveCircleColliders(next.x, next.z, PLAYER.radius, walls);
        root.position.x = clear.x;
        root.position.z = clear.z;
      }

      stepWalkCycle(dt, moving);

      // E to climb in: ask the vehicle system for the closest car in reach.
      if (input.enterPressed && rig.vehicles
        && typeof rig.vehicles.nearestEnterableVehicle === 'function') {
        const car = rig.vehicles.nearestEnterableVehicle(root.position, PLAYER.enterCarRange);
        if (car && typeof rig.vehicles.enterPlayerVehicle === 'function') {
          rig.vehicles.enterPlayerVehicle(car);
        }
      }

      followWithCamera(dt, camera);
    },

    dispose() {
      scene.remove(root);
    },
  };

  return player;
}
