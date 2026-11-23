// combat.js — Solmar Bay hand-to-hand and pistol combat, rebuilt.
//
// Leo Marlow fights with his fists up close, a pistol at range, and —
// new this round — a shotgun: six pellets per shell, brutal up close,
// useless past a street's width. Shots are hitscan: a ray is cast from
// the muzzle, the nearest person or vehicle it crosses takes damage, a
// tracer line and a muzzle flash sell the shot, and every crime the
// fight causes is reported to the police system through one callback so
// this module never decides wanted levels itself. Ammo lives in a
// magazine plus a reserve pool per gun; R reloads, and an empty magazine
// clicks instead of firing. Punching is a short forward arc, so the
// player has to face the target. Nothing here loads a file or touches
// the network.
//
// Pistol damage falls off past forty metres now, so long shots sting
// less than point-blank ones. The shotgun's six pellets each roll their
// own ray: several can land on the same target, and the damage adds up.
//
// PUBLIC API — createCombatSystem(options) returns:
//   equipWeapon(name)           -> 'fists', 'pistol' or 'shotgun'; true if equipped
//   getWeapon()                 -> current weapon name
//   getAmmo()                   -> { inMagazine, reserve, reloading } for the current gun
//   shoot(origin, direction, targets) -> fire the current gun once; returns
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
//   reset()                     -> fists equipped, guns refilled, stats cleared
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
import { COMBAT } from './config.js';

// ---------------------------------------------------------------------------
// Weapon tuning — one table per weapon, so balance lives in one place.
// The shotgun's numbers come from config.js; the fists and pistol keep
// the values the game has always shipped with.
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
    falloffStart: 40, // past this range a pistol shot deals 60% damage
    falloffFactor: 0.6,
  },
  shotgun: {
    name: 'shotgun',
    displayName: 'Shotgun',
    damage: COMBAT.shotgunDamage,
    pellets: COMBAT.shotgunPellets,
    range: COMBAT.shotgunRange,
    magazineSize: COMBAT.shotgunMagazine,
    reserveStart: COMBAT.shotgunReserveStart,
    reserveMax: 60,
    cooldownSeconds: COMBAT.shotgunFireInterval,
    reloadSeconds: COMBAT.shotgunReloadTime,
    spreadRadians: COMBAT.shotgunSpread,
    tracerSeconds: 0.09,
  },
  // Round 8: the alley arsenal's stock. The SMG sprays close in, the
  // rifle reaches across a plaza, and the bat is a melee weapon — it
  // uses the punch path, not the shooting path.
  smg: {
    name: 'smg',
    displayName: 'SMG',
    damage: COMBAT.smgDamage,
    range: COMBAT.smgRange,
    magazineSize: COMBAT.smgMagazine,
    reserveStart: COMBAT.smgReserveStart,
    reserveMax: 240,
    cooldownSeconds: COMBAT.smgFireInterval,
    reloadSeconds: COMBAT.smgReloadTime,
    spreadRadians: COMBAT.smgSpread,
    tracerSeconds: 0.06,
  },
  rifle: {
    name: 'rifle',
    displayName: 'Rifle',
    damage: COMBAT.rifleDamage,
    range: COMBAT.rifleRange,
    magazineSize: COMBAT.rifleMagazine,
    reserveStart: COMBAT.rifleReserveStart,
    reserveMax: 90,
    cooldownSeconds: COMBAT.rifleFireInterval,
    reloadSeconds: COMBAT.rifleReloadTime,
    spreadRadians: COMBAT.rifleSpread,
    tracerSeconds: 0.1,
  },
  bat: {
    name: 'bat',
    displayName: 'Baseball Bat',
    damage: COMBAT.batDamage,
    range: COMBAT.batRange,
    arcRadians: 1.25,
    cooldownSeconds: COMBAT.batInterval,
    spreadRadians: 0,
    melee: true,
  },
};

const FLASH_SECONDS = 0.055;
const VEHICLE_DESTROY_BONUS_CRIME = 'shooting';

function clampValue(value, min, max) {
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
  // One magazine + reserve per gun, so switching weapons keeps its ammo.
  const ammoStores = {
    pistol: { inMagazine: WEAPONS.pistol.magazineSize, reserve: WEAPONS.pistol.reserveStart },
    shotgun: { inMagazine: WEAPONS.shotgun.magazineSize, reserve: WEAPONS.shotgun.reserveStart },
    smg: { inMagazine: WEAPONS.smg.magazineSize, reserve: WEAPONS.smg.reserveStart },
    rifle: { inMagazine: WEAPONS.rifle.magazineSize, reserve: WEAPONS.rifle.reserveStart },
  };
  // Round 8: the SMG, the rifle and the bat are bought at the alley
  // arsenal, so they stay locked until the shop unlocks them. Fists,
  // pistol and shotgun are Leo's from the start.
  const unlockedWeapons = new Set(['fists', 'pistol', 'shotgun']);
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

  function currentAmmoStore() {
    return ammoStores[currentWeapon] || null;
  }

  function announceAmmo() {
    if (onAmmoChanged) {
      const store = currentAmmoStore();
      onAmmoChanged({
        weapon: currentWeapon,
        inMagazine: store ? store.inMagazine : 0,
        reserve: store ? store.reserve : 0,
        reloading,
      });
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
    if (weaponName === 'fists' || weaponName === 'bat') return 'assault';
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

  function unlockWeapon(name) {
    if (!WEAPONS[name]) return false;
    unlockedWeapons.add(name);
    return true;
  }

  function isWeaponUnlocked(name) {
    return unlockedWeapons.has(name);
  }

  function equipWeapon(name) {
    if (!WEAPONS[name]) return false;
    // Round 8: the arsenal's weapons stay locked until Leo buys them.
    // The shop unlocks them through unlockWeapon; pressing 4, 5 or 6
    // on a fresh save is a no-op, not a bug.
    if (!unlockedWeapons.has(name)) return false;
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
    const store = currentAmmoStore();
    const weapon = WEAPONS[currentWeapon];
    if (!store || !weapon || !weapon.magazineSize) return false;
    if (reloading) return false;
    if (store.inMagazine >= weapon.magazineSize) return false;
    if (store.reserve <= 0) return false;
    reloading = true;
    reloadTimer = weapon.reloadSeconds;
    if (onReload) onReload({ started: true });
    announceAmmo();
    return true;
  }

  function emptyResult(reason) {
    return { fired: false, reason, hit: false, target: null, damage: 0, killed: false, point: null };
  }

  function shoot(originValue, directionValue, targets) {
    const origin = toVector3(originValue);
    const rawDirection = toVector3(directionValue);
    if (rawDirection.lengthSq() < 0.0001) return emptyResult('noTarget');
    if (currentWeapon === 'fists') return emptyResult('fists');
    if (reloading) return emptyResult('reloading');
    if (cooldown > 0) return emptyResult('cooldown');
    const store = currentAmmoStore();
    const weapon = WEAPONS[currentWeapon];
    if (!store || !weapon) return emptyResult('noTarget');
    if (store.inMagazine <= 0) {
      if (onShot) onShot({ fired: false, reason: 'empty' });
      return emptyResult('empty');
    }

    store.inMagazine -= 1;
    cooldown = weapon.cooldownSeconds;
    shotsFired += 1;

    // Spread: jitter the aim a little so long shots are not laser-perfect.
    const baseDirection = rawDirection.clone().normalize();
    const spread = weapon.spreadRadians;

    // The shotgun fires a spread of pellets, each on its own ray. Pellets
    // that land on the same target add their damage together, so a close
    // blast can drop a target in one shell while a far one just stings.
    const pelletCount = weapon.pellets || 1;
    const hitsByTarget = new Map();
    let nearestHit = null;
    let nearestDistance = Infinity;
    let farthestPoint = null;
    for (let p = 0; p < pelletCount; p += 1) {
      const direction = baseDirection.clone();
      direction.x += (random() - 0.5) * 2 * spread;
      direction.y += (random() - 0.5) * 2 * spread;
      direction.z += (random() - 0.5) * 2 * spread;
      direction.normalize();
      const pick = pickRayTarget(origin, direction, targets, weapon.range);
      if (pick.target) {
        const soFar = hitsByTarget.get(pick.target) || 0;
        hitsByTarget.set(pick.target, soFar + weapon.damage);
        if (pick.distance < nearestDistance) {
          nearestDistance = pick.distance;
          nearestHit = pick.target;
        }
        const point = origin.clone().addScaledVector(direction, pick.distance);
        if (!farthestPoint || pick.distance > farthestPoint.distance) {
          farthestPoint = { point, distance: pick.distance };
        }
      }
    }

    const endPoint = farthestPoint
      ? farthestPoint.point
      : origin.clone().addScaledVector(baseDirection, weapon.range);
    spawnTracer(origin.clone().addScaledVector(baseDirection, 0.6), endPoint);
    showMuzzleFlash(origin, baseDirection);

    // Firing a gun in the street is itself a crime — but only report it
    // once per shot: on a hit, finishAttack() below reports the hit/kill
    // crime instead, so a single shot never counts twice.
    if (hitsByTarget.size === 0) reportCrime('shooting', { hit: false });
    if (onShot) onShot({ fired: true, weapon: currentWeapon, point: endPoint, target: nearestHit });
    announceAmmo();

    // Pistol damage falls off past forty metres: long shots sting less.
    let totalDamage = 0;
    let firstTarget = null;
    let firstPoint = endPoint;
    let killedAny = false;
    let remainingHealth = null;
    for (const [target, damage] of hitsByTarget) {
      let dealt = damage;
      if (currentWeapon === 'pistol' && nearestDistance > weapon.falloffStart) {
        dealt = Math.round(damage * weapon.falloffFactor);
      }
      if (!firstTarget) {
        firstTarget = target;
        firstPoint = origin.clone().addScaledVector(baseDirection, nearestDistance);
      }
      totalDamage += dealt;
      const result = {
        fired: true,
        reason: 'ok',
        hit: true,
        target,
        damage: dealt,
        killed: false,
        remainingHealth: null,
        point: firstPoint,
      };
      finishAttack(result, target, currentWeapon, firstPoint);
      if (result.killed) killedAny = true;
      remainingHealth = result.remainingHealth;
    }

    if (hitsByTarget.size > 0) shotsHit += 1;
    return {
      fired: true,
      reason: 'ok',
      hit: hitsByTarget.size > 0,
      target: firstTarget,
      damage: totalDamage,
      killed: killedAny,
      remainingHealth,
      point: endPoint,
    };
  }

  function punch(originValue, facingValue, targets) {
    const origin = toVector3(originValue);
    const facing = toVector3(facingValue);
    if (facing.lengthSq() < 0.0001) return emptyResult('noTarget');
    // Fists are always available: a punch works whatever weapon is equipped.
    // Round 8: the bat is a melee weapon too, so the punch reads the
    // current weapon's melee stats (damage, range, arc, cooldown) when
    // Leo is holding it, and the hit is reported as a bat swing.
    if (cooldown > 0) return emptyResult('cooldown');
    const meleeName = currentWeapon === 'bat' ? 'bat' : 'fists';
    const weapon = WEAPONS[meleeName];
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
      const angle = Math.acos(clampValue(toTarget.dot(flatFacing), -1, 1));
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
      finishAttack(result, best, meleeName, result.point);
    }
    if (onShot) onShot({ fired: true, weapon: meleeName, point: result.point, target: best });
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
        const weapon = WEAPONS[currentWeapon];
        const store = currentAmmoStore();
        if (weapon && store) {
          const needed = weapon.magazineSize - store.inMagazine;
          const loaded = Math.min(needed, store.reserve);
          store.inMagazine += loaded;
          store.reserve -= loaded;
          if (onReload) onReload({ started: false, loaded });
        }
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

  function addAmmo(weaponOrAmount, amount) {
    // Two shapes: addAmmo(amount) tops up the gun in hand (the old
    // pickups path), addAmmo('smg', 60) tops up a named gun (the
    // arsenal shop). Fists and the bat take no ammo.
    let key;
    let qty;
    if (typeof weaponOrAmount === 'string') {
      key = weaponOrAmount;
      qty = amount || 0;
    } else {
      qty = weaponOrAmount || 0;
      key = currentWeapon;
    }
    const store = ammoStores[key];
    const weapon = WEAPONS[key];
    if (!store || !weapon) return 0;
    store.reserve = clampValue(store.reserve + Math.max(0, qty), 0, weapon.reserveMax);
    announceAmmo();
    return store.reserve;
  }

  function getAmmoFor(weaponId) {
    const store = ammoStores[weaponId];
    if (!store) return { inMagazine: 0, reserve: 0, reloading };
    return { inMagazine: store.inMagazine, reserve: store.reserve, reloading };
  }

  function reset() {
    currentWeapon = 'fists';
    ammoStores.pistol.inMagazine = WEAPONS.pistol.magazineSize;
    ammoStores.pistol.reserve = WEAPONS.pistol.reserveStart;
    ammoStores.shotgun.inMagazine = WEAPONS.shotgun.magazineSize;
    ammoStores.shotgun.reserve = WEAPONS.shotgun.reserveStart;
    ammoStores.smg.inMagazine = WEAPONS.smg.magazineSize;
    ammoStores.smg.reserve = WEAPONS.smg.reserveStart;
    ammoStores.rifle.inMagazine = WEAPONS.rifle.magazineSize;
    ammoStores.rifle.reserve = WEAPONS.rifle.reserveStart;
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
    get ammoInMagazine() {
      const store = currentAmmoStore();
      return store ? store.inMagazine : 0;
    },
    get reserveAmmo() {
      const store = currentAmmoStore();
      return store ? store.reserve : 0;
    },
    get reloading() { return reloading; },
    equipWeapon,
    unlockWeapon,
    isWeaponUnlocked,
    getWeapon: () => currentWeapon,
    getWeaponId: () => currentWeapon,
    getAmmo: () => {
      const store = currentAmmoStore();
      return {
        inMagazine: store ? store.inMagazine : 0,
        reserve: store ? store.reserve : 0,
        reloading,
      };
    },
    getAmmoFor,
    // Spare rounds across all four guns, for a future ammo HUD total.
    getTotalReserve: () => ammoStores.pistol.reserve + ammoStores.shotgun.reserve
      + ammoStores.smg.reserve + ammoStores.rifle.reserve,
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
