// combat.js — Solmar Bay hand-to-hand and pistol combat.
//
// Leo Marlow fights with his fists up close and a pistol at range. Shots are
// hitscan: a ray is cast from the muzzle, the nearest person or vehicle it
// crosses takes damage, a tracer line and a muzzle flash sell the shot, and
// every crime the fight causes is reported to the police system through one
// callback so this module never decides wanted levels itself. Ammo lives in
// a magazine plus a reserve pool; R reloads, and an empty magazine clicks
// instead of firing. Punching is a short forward arc, so the player has to
// face the target. Nothing here loads a file or touches the network.
//
// PUBLIC API — createCombatSystem(options) returns:
//   equipWeapon(name)           -> 'fists' or 'pistol'; returns true if equipped
//   getWeapon()                 -> current weapon name
//   getAmmo()                   -> { inMagazine, reserve, reloading }
//   shoot(origin, direction, targets) -> fire the pistol once; returns
//                                  { fired, reason, hit, target, damage,
//                                    killed, point } — reason is one of
//                                  'ok' | 'cooldown' | 'reloading' |
//                                  'empty' | 'fists' | 'noTarget'
//   punch(origin, facing, targets)    -> swing the fists; returns the same
//                                  result shape as shoot()
//   reload()                    -> start a reload; returns true if one started
//   addAmmo(amount)             -> add reserve rounds (pickups, mission rewards)
//   reportTheft(vehicle)        -> report a stolen car as a crime; returns true
//   update(dt)                  -> advance cooldowns, reloads, tracers, flash
//   getStats()                  -> { shotsFired, shotsHit, kills, crimes }
//   reset()                     -> fists equipped, pistol refilled, stats cleared
//   dispose()                   -> remove tracers and flash from the scene
//   currentWeapon / ammoInMagazine / reserveAmmo  -> live read-only getters
//
// Targets are plain objects, so any module can offer them:
//   { id, kind, position, radius, health, alive, takeDamage(amount, point),
//     isPolice }
// kind is 'pedestrian' | 'police' | 'vehicle' | 'prop'. position is a
// THREE.Vector3 or { x, y, z }; radius defaults to 0.6; a target with
// takeDamage() is hurt through that function, otherwise its health number
// is reduced directly. A target whose health reaches 0 counts as killed
// (vehicles count as destroyed). Combat reports crimes through
// options.onCrime(type, details) — the police module turns those into stars.
// Options: { scene, onCrime, onShot, onHit, onKill, onReload, onAmmoChanged,
//            onWeaponChanged, random, tracerColor }
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Weapon tuning — one table per weapon, so balance lives in one place.
// ---------------------------------------------------------------------------

export const WEAPONS = {
  fists: {
    name: 'fists',
    displayName: 'Fists',
    damage: 14,
    range: 2.3,
    arcRadians: 1.25, // about 72 degrees — the punch must roughly face the target
    cooldownSeconds: 0.42,
    spreadRadians: 0,
  },
  pistol: {
    name: 'pistol',
    displayName: 'Pistol',
    damage: 34,
    range: 95,
    magazineSize: 12,
    reserveStart: 48,
    reserveMax: 144,
    cooldownSeconds: 0.26,
    reloadSeconds: 1.4,
    spreadRadians: 0.022,
    tracerSeconds: 0.07,
  },
};

const FLASH_SECONDS = 0.055;
const VEHICLE_DESTROY_BONUS_CRIME = 'shooting';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toVector3(value) {
  if (!value) return new THREE.Vector3();
  if (value.isVector3) return value.clone();
  return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
}

// Ray–sphere test: does the ray from origin along direction (unit length)
// pass within radius of centre before maxRange? Returns the distance along
// the ray, or null. Targets are treated as spheres, which is forgiving at
// street-fight ranges and needs no mesh or raycaster.
function raySphereDistance(origin, direction, centre, radius, maxRange) {
  const toCentre = new THREE.Vector3().subVectors(centre, origin);
  const along = toCentre.dot(direction);
  if (along < 0 || along > maxRange) return null;
  const closest = new THREE.Vector3().copy(origin).addScaledVector(direction, along);
  const miss = closest.distanceTo(centre);
  if (miss > radius) return null;
  const halfChord = Math.sqrt(Math.max(0, radius * radius - miss * miss));
  return Math.max(0, along - halfChord);
}

// ---------------------------------------------------------------------------
// The combat system.
// ---------------------------------------------------------------------------

export function createCombatSystem(options = {}) {
  const scene = options.scene || null;
  const random = options.random || Math.random;
  const onCrime = options.onCrime || null;
  const onShot = options.onShot || null;
  const onHit = options.onHit || null;
  const onKill = options.onKill || null;
  const onReload = options.onReload || null;
  const onAmmoChanged = options.onAmmoChanged || null;
  const onWeaponChanged = options.onWeaponChanged || null;

  let currentWeapon = 'fists';
  let ammoInMagazine = WEAPONS.pistol.magazineSize;
  let reserveAmmo = WEAPONS.pistol.reserveStart;
  let cooldown = 0;
  let reloading = false;
  let reloadTimer = 0;
  let flashTimer = 0;
  let shotsFired = 0;
  let shotsHit = 0;
  let kills = 0;
  let crimesReported = 0;

  // --- Visuals: one reusable tracer line pool and one muzzle flash. -------
  const tracers = [];
  const tracerMaterial = new THREE.LineBasicMaterial({
    color: options.tracerColor ?? 0xffd76a,
    transparent: true,
    opacity: 0.9,
  });
  let flashLight = null;
  let flashMesh = null;
  if (scene) {
    flashLight = new THREE.PointLight(0xffc861, 0, 9, 2);
    flashLight.visible = false;
    scene.add(flashLight);
    flashMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95 }),
    );
    flashMesh.visible = false;
    scene.add(flashMesh);
  }

  function reportCrime(type, details) {
    crimesReported += 1;
    if (onCrime) onCrime(type, details || {});
  }

  function announceAmmo() {
    if (onAmmoChanged) {
      onAmmoChanged({ weapon: currentWeapon, inMagazine: ammoInMagazine, reserve: reserveAmmo, reloading });
    }
  }

  function showMuzzleFlash(origin, direction) {
    if (!scene) return;
    const flashPoint = origin.clone().addScaledVector(direction, 0.7);
    flashPoint.y += 0.05;
    if (flashLight) {
      flashLight.position.copy(flashPoint);
      flashLight.intensity = 26;
      flashLight.visible = true;
    }
    if (flashMesh) {
      flashMesh.position.copy(flashPoint);
      flashMesh.visible = true;
    }
    flashTimer = FLASH_SECONDS;
  }

  function spawnTracer(from, to) {
    if (!scene) return;
    let tracer = tracers.find((t) => !t.visible);
    if (!tracer) {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      tracer = new THREE.Line(geometry, tracerMaterial.clone());
      tracer.visible = false;
      tracer.userData.life = 0;
      scene.add(tracer);
      tracers.push(tracer);
    }
    const positions = tracer.geometry.attributes.position;
    positions.setXYZ(0, from.x, from.y, from.z);
    positions.setXYZ(1, to.x, to.y, to.z);
    positions.needsUpdate = true;
    tracer.material.opacity = 0.9;
    tracer.visible = true;
    tracer.userData.life = WEAPONS.pistol.tracerSeconds;
  }

  function hideTracer(tracer) {
    tracer.visible = false;
    tracer.userData.life = 0;
  }

  // Find the nearest living target the ray hits, ignoring dead ones.
  function pickRayTarget(origin, direction, targets, maxRange) {
    let best = null;
    let bestDistance = Infinity;
    for (const target of targets || []) {
      if (!target || target.alive === false) continue;
      const centre = toVector3(target.position);
      // Targets stand on the ground (position.y is their feet), so aim at
      // chest height for people and at the centre of mass for vehicles.
      if (target.kind === 'pedestrian' || target.kind === 'police') centre.y += 1.2;
      const radius = target.radius || (target.kind === 'vehicle' ? 1.4 : 0.6);
      const hitDistance = raySphereDistance(origin, direction, centre, radius, maxRange);
      if (hitDistance !== null && hitDistance < bestDistance) {
        bestDistance = hitDistance;
        best = target;
      }
    }
    return { target: best, distance: bestDistance };
  }

  function crimeTypeForKill(target) {
    if (target.kind === 'police' || target.isPolice) return 'killPolice';
    if (target.kind === 'vehicle') return VEHICLE_DESTROY_BONUS_CRIME;
    if (target.kind === 'pedestrian') return 'killPedestrian';
    return 'shooting';
  }

  function crimeTypeForHit(target, weaponName) {
    if (weaponName === 'fists') return 'assault';
    if (target.kind === 'police' || target.isPolice) return 'shooting';
    if (target.kind === 'pedestrian') return 'shooting';
    return 'shooting';
  }

  // Hurt one target through its own takeDamage() when it has one, else by
  // lowering its health number. Returns { killed, remainingHealth }.
  function applyDamage(target, amount, hitPoint) {
    if (!target) return { killed: false, remainingHealth: 0 };
    let remaining;
    if (typeof target.takeDamage === 'function') {
      remaining = target.takeDamage(amount, hitPoint);
      if (typeof remaining !== 'number') remaining = (target.health ?? 0);
    } else if (typeof target.health === 'number') {
      target.health = Math.max(0, target.health - amount);
      remaining = target.health;
    } else {
      remaining = 0;
    }
    const killed = remaining <= 0;
    if (killed) {
      if (typeof target.alive !== 'undefined') target.alive = false;
      kills += 1;
      // A police unit or vehicle killed by raw health loss still needs its
      // mesh taken out of the scene; the owning module (police / vehicles)
      // removes it from its own lists when it sees alive === false, and an
      // optional onDestroyed hook lets it react immediately.
      if (target.group && scene) scene.remove(target.group);
      if (typeof target.onDestroyed === 'function') target.onDestroyed();
    }
    return { killed, remainingHealth: Math.max(0, remaining) };
  }

  function finishAttack(result, target, weaponName, hitPoint) {
    if (!result.hit || !target) return result;
    const outcome = applyDamage(target, result.damage, hitPoint);
    result.killed = outcome.killed;
    result.remainingHealth = outcome.remainingHealth;
    if (onHit) onHit({ target, damage: result.damage, killed: outcome.killed, point: hitPoint, weapon: weaponName });
    if (outcome.killed) {
      const killCrime = crimeTypeForKill(target);
      reportCrime(killCrime, { targetId: target.id ?? null, kind: target.kind });
      if (onKill) onKill({ target, weapon: weaponName, point: hitPoint });
    } else {
      reportCrime(crimeTypeForHit(target, weaponName), { targetId: target.id ?? null, kind: target.kind });
    }
    return result;
  }

  // -- Public API -----------------------------------------------------------

  function equipWeapon(name) {
    if (name !== 'fists' && name !== 'pistol') return false;
    if (name === currentWeapon) return true;
    if (reloading) {
      reloading = false;
      reloadTimer = 0;
    }
    currentWeapon = name;
    cooldown = Math.max(cooldown, 0.15);
    if (onWeaponChanged) onWeaponChanged(currentWeapon);
    announceAmmo();
    return true;
  }

  function reload() {
    const weapon = WEAPONS.pistol;
    if (currentWeapon !== 'pistol') return false;
    if (reloading) return false;
    if (ammoInMagazine >= weapon.magazineSize) return false;
    if (reserveAmmo <= 0) return false;
    reloading = true;
    reloadTimer = weapon.reloadSeconds;
    if (onReload) onReload({ started: true });
    announceAmmo();
    return true;
  }

  function shoot(originValue, directionValue, targets) {
    const origin = toVector3(originValue);
    const rawDirection = toVector3(directionValue);
    if (rawDirection.lengthSq() < 0.0001) {
      return { fired: false, reason: 'noTarget', hit: false, target: null, damage: 0, killed: false, point: null };
    }
    if (currentWeapon !== 'pistol') {
      return { fired: false, reason: 'fists', hit: false, target: null, damage: 0, killed: false, point: null };
    }
    if (reloading) {
      return { fired: false, reason: 'reloading', hit: false, target: null, damage: 0, killed: false, point: null };
    }
    if (cooldown > 0) {
      return { fired: false, reason: 'cooldown', hit: false, target: null, damage: 0, killed: false, point: null };
    }
    if (ammoInMagazine <= 0) {
      if (onShot) onShot({ fired: false, reason: 'empty' });
      return { fired: false, reason: 'empty', hit: false, target: null, damage: 0, killed: false, point: null };
    }

    const weapon = WEAPONS.pistol;
    ammoInMagazine -= 1;
    cooldown = weapon.cooldownSeconds;
    shotsFired += 1;

    // Spread: jitter the aim a little so long shots are not laser-perfect.
    const direction = rawDirection.clone().normalize();
    const spread = weapon.spreadRadians;
    direction.x += (random() - 0.5) * 2 * spread;
    direction.y += (random() - 0.5) * 2 * spread;
    direction.z += (random() - 0.5) * 2 * spread;
    direction.normalize();

    const pick = pickRayTarget(origin, direction, targets, weapon.range);
    const endPoint = pick.target
      ? origin.clone().addScaledVector(direction, pick.distance)
      : origin.clone().addScaledVector(direction, weapon.range);
    spawnTracer(origin.clone().addScaledVector(direction, 0.6), endPoint);
    showMuzzleFlash(origin, direction);

    // Firing a gun in the street is itself a crime — but only report it
    // once per shot: on a hit, finishAttack() below reports the hit/kill
    // crime instead, so a single shot never counts twice.
    if (!pick.target) reportCrime('shooting', { hit: false });
    if (onShot) onShot({ fired: true, weapon: 'pistol', point: endPoint, target: pick.target });
    announceAmmo();

    const result = {
      fired: true,
      reason: 'ok',
      hit: Boolean(pick.target),
      target: pick.target || null,
      damage: pick.target ? weapon.damage : 0,
      killed: false,
      remainingHealth: null,
      point: endPoint,
    };
    if (pick.target) {
      shotsHit += 1;
      finishAttack(result, pick.target, 'pistol', endPoint);
    }
    return result;
  }

  function punch(originValue, facingValue, targets) {
    const origin = toVector3(originValue);
    const facing = toVector3(facingValue);
    if (facing.lengthSq() < 0.0001) {
      return { fired: false, reason: 'noTarget', hit: false, target: null, damage: 0, killed: false, point: null };
    }
    // Fists are always available: a punch works whatever weapon is equipped.
    if (cooldown > 0) {
      return { fired: false, reason: 'cooldown', hit: false, target: null, damage: 0, killed: false, point: null };
    }
    const weapon = WEAPONS.fists;
    cooldown = weapon.cooldownSeconds;
    facing.normalize();

    // Nearest living target inside range and inside the forward arc.
    let best = null;
    let bestDistance = Infinity;
    for (const target of targets || []) {
      if (!target || target.alive === false) continue;
      const centre = toVector3(target.position);
      const toTarget = new THREE.Vector3().subVectors(centre, origin);
      toTarget.y = 0;
      const distance = toTarget.length();
      if (distance > weapon.range) continue;
      if (distance > 0.01) toTarget.normalize();
      const flatFacing = new THREE.Vector3(facing.x, 0, facing.z).normalize();
      const angle = Math.acos(clamp(toTarget.dot(flatFacing), -1, 1));
      if (angle > weapon.arcRadians) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = target;
      }
    }

    const result = {
      fired: true,
      reason: 'ok',
      hit: Boolean(best),
      target: best || null,
      damage: best ? weapon.damage : 0,
      killed: false,
      remainingHealth: null,
      point: best ? toVector3(best.position) : origin.clone().addScaledVector(facing, weapon.range),
    };
    if (best) {
      // A punch that lands is an assault even before anyone dies.
      finishAttack(result, best, 'fists', result.point);
    }
    if (onShot) onShot({ fired: true, weapon: 'fists', point: result.point, target: best });
    return result;
  }

  function reportTheft(vehicle) {
    reportCrime('carTheft', { vehicleId: vehicle?.id ?? null, kind: vehicle?.kind ?? 'vehicle' });
    return true;
  }

  function update(dt) {
    // Timers only, no physics, so the full dt is consumed (capped at 1 s
    // against tab-switch stalls). The game loop feeds ~1/60 s steps.
    const step = Math.min(Math.max(dt, 0), 1);
    if (cooldown > 0) cooldown = Math.max(0, cooldown - step);
    if (reloading) {
      reloadTimer -= step;
      if (reloadTimer <= 0) {
        reloading = false;
        const weapon = WEAPONS.pistol;
        const needed = weapon.magazineSize - ammoInMagazine;
        const loaded = Math.min(needed, reserveAmmo);
        ammoInMagazine += loaded;
        reserveAmmo -= loaded;
        if (onReload) onReload({ started: false, loaded });
        announceAmmo();
      }
    }
    if (flashTimer > 0) {
      flashTimer -= step;
      if (flashTimer <= 0) {
        if (flashLight) { flashLight.visible = false; flashLight.intensity = 0; }
        if (flashMesh) flashMesh.visible = false;
      }
    }
    for (const tracer of tracers) {
      if (!tracer.visible) continue;
      tracer.userData.life -= step;
      tracer.material.opacity = Math.max(0, (tracer.userData.life / WEAPONS.pistol.tracerSeconds) * 0.9);
      if (tracer.userData.life <= 0) hideTracer(tracer);
    }
  }

  function addAmmo(amount) {
    reserveAmmo = clamp(reserveAmmo + Math.max(0, amount), 0, WEAPONS.pistol.reserveMax);
    announceAmmo();
    return reserveAmmo;
  }

  function reset() {
    currentWeapon = 'fists';
    ammoInMagazine = WEAPONS.pistol.magazineSize;
    reserveAmmo = WEAPONS.pistol.reserveStart;
    cooldown = 0;
    reloading = false;
    reloadTimer = 0;
    flashTimer = 0;
    shotsFired = 0;
    shotsHit = 0;
    kills = 0;
    crimesReported = 0;
    for (const tracer of tracers) hideTracer(tracer);
    if (flashLight) flashLight.visible = false;
    if (flashMesh) flashMesh.visible = false;
    announceAmmo();
  }

  function dispose() {
    for (const tracer of tracers) {
      if (scene) scene.remove(tracer);
      tracer.geometry.dispose();
      tracer.material.dispose();
    }
    tracers.length = 0;
    if (scene) {
      if (flashLight) scene.remove(flashLight);
      if (flashMesh) scene.remove(flashMesh);
    }
  }

  return {
    get currentWeapon() { return currentWeapon; },
    get ammoInMagazine() { return ammoInMagazine; },
    get reserveAmmo() { return reserveAmmo; },
    get reloading() { return reloading; },
    equipWeapon,
    getWeapon: () => currentWeapon,
    getAmmo: () => ({ inMagazine: ammoInMagazine, reserve: reserveAmmo, reloading }),
    shoot,
    punch,
    reload,
    addAmmo,
    reportTheft,
    update,
    getStats: () => ({ shotsFired, shotsHit, kills, crimes: crimesReported }),
    reset,
    dispose,
  };
}
