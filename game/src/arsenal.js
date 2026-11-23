// arsenal.js — Solmar Bay's alley weapon shop, Round 8.
//
// Leo's fists, pistol and shotgun got him through the first jobs, but
// the Marisol crew is arming up, and so is Leo. Down the alley at
// (-60, -60) a fence sells hardware out of a van: an SMG for close
// work, a rifle for reaching across a plaza, and a baseball bat for
// when Leo wants the quiet option. Ammo is sold by the box, and the
// shop remembers what Leo owns in the save file, so a weapon bought
// once stays his.
//
// The shop is a DOM overlay (built by this module, styled by the shared
// overlay classes in index.html) opened with B near the alley marker.
// Buying goes through the cash callbacks main.js provides and through
// the combat system's own addAmmo, so the shop never writes a balance
// or an ammo count directly. The combat system decides whether a
// weapon exists; this module only sells what combat knows.
//
// `createArsenalSystem({ combat, save, hud, getCash, spendCash })`
// returns the overlay, the buy functions and the near-shop check.

export const ARSENAL_POINT = { x: -60, z: -60 };
export const ARSENAL_RADIUS = 10;

export const SHOP_WEAPONS = [
  {
    id: 'bat', name: 'Baseball Bat', price: 300,
    blurb: 'Quiet, reliable, never runs out of ammo. Closes distance fast.',
    damage: 28, rate: 2.2, range: 2.4,
  },
  {
    id: 'smg', name: 'Compact SMG', price: 1200,
    blurb: 'Sprays close in. Thirty rounds a mag, gone in a breath.',
    damage: 14, rate: 9, range: 34,
    ammoIncluded: 90,
  },
  {
    id: 'rifle', name: 'Scoped Rifle', price: 2500,
    blurb: 'Reaches across a plaza. One clean shot does the talking.',
    damage: 55, rate: 1.2, range: 90,
    ammoIncluded: 30,
  },
];

export const AMMO_PACKS = [
  { weapon: 'pistol', name: 'Pistol mags', price: 40, amount: 24, blurb: 'Two boxes of 9mm.' },
  { weapon: 'shotgun', name: 'Shotgun shells', price: 80, amount: 16, blurb: 'Buckshot, eight to a box.' },
  { weapon: 'smg', name: 'SMG drums', price: 60, amount: 60, blurb: 'Two drums, sixty rounds.' },
  { weapon: 'rifle', name: 'Rifle rounds', price: 120, amount: 20, blurb: 'A box of long-range rounds.' },
];

function formatMoney(amount) {
  return '$' + Math.floor(amount || 0).toLocaleString('en-US');
}

export function createArsenalSystem(deps = {}) {
  const combat = deps.combat || null;
  const saveApi = deps.save || null;
  const hud = deps.hud || null;
  const getCash = typeof deps.getCash === 'function' ? deps.getCash : () => 0;
  const spendCash = typeof deps.spendCash === 'function' ? deps.spendCash : () => false;
  const onChanged = typeof deps.onChanged === 'function' ? deps.onChanged : null;

  let open = false;
  let overlay = null;

  function readOwned() {
    try {
      const saved = saveApi && typeof saveApi.loadSave === 'function'
        ? saveApi.loadSave()
        : null;
      const arsenal = (saved && saved.arsenal) || {};
      const owned = Array.isArray(arsenal.owned) ? arsenal.owned : [];
      return owned.filter((id) => typeof id === 'string');
    } catch {
      return [];
    }
  }

  function writeOwned(owned) {
    if (!saveApi || typeof saveApi.updateSave !== 'function') return;
    try {
      saveApi.updateSave((s) => {
        s.arsenal = { owned: [...owned] };
      });
    } catch { /* save failure must not break the shop */ }
    if (onChanged) {
      try { onChanged([...owned]); } catch { /* cosmetic */ }
    }
  }

  function notify(text, seconds = 3) {
    if (hud && typeof hud.notify === 'function') hud.notify(text, seconds);
  }

  function ammoCount(weaponId) {
    if (!combat) return 0;
    // getAmmoFor returns one gun's store; the plain getAmmo only ever
    // describes the gun in hand, which would show the wrong number for
    // anything Leo is not holding.
    if (typeof combat.getAmmoFor === 'function') {
      try {
        const store = combat.getAmmoFor(weaponId);
        return (store && typeof store.reserve === 'number') ? store.reserve : 0;
      } catch { return 0; }
    }
    if (combat.ammoStores && combat.ammoStores[weaponId] !== undefined) {
      return combat.ammoStores[weaponId].reserve || 0;
    }
    return 0;
  }

  function currentWeaponName() {
    if (!combat) return 'fists';
    if (typeof combat.getWeaponId === 'function') {
      try { return combat.getWeaponId() || 'fists'; } catch { return 'fists'; }
    }
    if (combat.currentWeapon && combat.currentWeapon.id) return combat.currentWeapon.id;
    return 'fists';
  }

  // --- buying ------------------------------------------------------------------
  function buyWeapon(weaponId) {
    const item = SHOP_WEAPONS.find((w) => w.id === weaponId);
    if (!item) return false;
    const owned = readOwned();
    if (owned.includes(weaponId)) {
      notify('Already own the ' + item.name + ' — press ' + keyForWeapon(weaponId) + ' to draw it', 2);
      return true;
    }
    if (!spendCash(item.price)) {
      notify('Not enough cash for the ' + item.name + ' (' + formatMoney(item.price) + ')', 3);
      return false;
    }
    owned.push(weaponId);
    writeOwned(owned);
    if (combat && typeof combat.addAmmo === 'function' && item.ammoIncluded) {
      try { combat.addAmmo(weaponId, item.ammoIncluded); } catch { /* ammo is a bonus */ }
    }
    // Buying unlocks the weapon in the combat system first — equipping
    // a locked weapon is a no-op by design, so the unlock comes first.
    if (combat && typeof combat.unlockWeapon === 'function') {
      try { combat.unlockWeapon(weaponId); } catch { /* already unlocked */ }
    }
    if (combat && typeof combat.equipWeapon === 'function') {
      try { combat.equipWeapon(weaponId); } catch { /* equipping is a bonus */ }
    }
    notify(item.name + ' bought — ' + formatMoney(item.price) + '. It is yours now.', 4);
    render();
    return true;
  }

  function buyAmmo(weaponId) {
    const pack = AMMO_PACKS.find((p) => p.weapon === weaponId);
    if (!pack) return false;
    if (weaponId !== 'pistol' && weaponId !== 'shotgun' && !readOwned().includes(weaponId)) {
      notify('Buy the ' + weaponId + ' first — the fence will not sell ammo for a gun you do not own', 3);
      return false;
    }
    if (!spendCash(pack.price)) {
      notify('Not enough cash for ' + pack.name + ' (' + formatMoney(pack.price) + ')', 3);
      return false;
    }
    if (combat && typeof combat.addAmmo === 'function') {
      try { combat.addAmmo(weaponId, pack.amount); } catch { /* best effort */ }
    }
    notify(pack.name + ' — ' + formatMoney(pack.price), 3);
    render();
    return true;
  }

  function keyForWeapon(weaponId) {
    if (weaponId === 'smg') return '4';
    if (weaponId === 'rifle') return '5';
    if (weaponId === 'bat') return '6';
    return '?';
  }

  // --- overlay --------------------------------------------------------------------
  function buildOverlay() {
    if (typeof document === 'undefined') return null;
    const existing = document.getElementById('arsenal-overlay');
    if (existing) return existing;
    const root = document.createElement('div');
    root.id = 'arsenal-overlay';
    root.className = 'overlay hidden';
    root.innerHTML = `
      <div class="overlay-card">
        <h2>Alley Arsenal — The Fence</h2>
        <p>No receipts, no questions. What you buy is yours. Draw the SMG
        with 4, the rifle with 5, the bat with 6.</p>
        <div id="arsenal-cash"></div>
        <div id="arsenal-sections"></div>
        <div class="btn-row">
          <button id="btn-close-arsenal" class="secondary">Close (B)</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    const closeBtn = root.querySelector('#btn-close-arsenal');
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
    return root;
  }

  function render() {
    if (!open) return;
    if (!overlay) overlay = buildOverlay();
    if (!overlay) return;
    const cashEl = overlay.querySelector('#arsenal-cash');
    if (cashEl) {
      cashEl.textContent = 'Cash: ' + formatMoney(getCash()) + '  ·  In hand: ' + currentWeaponName();
      cashEl.style.cssText = 'font-size:18px;font-weight:800;color:#ffc93c;margin-top:10px;';
    }
    const sections = overlay.querySelector('#arsenal-sections');
    if (!sections) return;
    const owned = readOwned();
    let html = '<h3 style="margin-top:14px;color:#ffc93c;">Hardware</h3>';
    html += '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">';
    for (const item of SHOP_WEAPONS) {
      const hasIt = owned.includes(item.id);
      const line = hasIt
        ? 'Owned — press ' + keyForWeapon(item.id) + ' to draw it'
        : formatMoney(item.price) + ' — buy';
      html += `<button data-weapon="${item.id}" style="text-align:left;background:${hasIt ? 'rgba(126,208,122,0.15)' : 'rgba(255,255,255,0.06)'};color:#f4f1e8;border:1px solid rgba(255,255,255,0.22);padding:10px 12px;font-size:14px;"><strong>${item.name}</strong> — ${line}<br><span style="font-weight:400;font-size:12px;color:#cfe0d8;">${item.blurb} Damage ${item.damage}, range ${item.range}m${item.ammoIncluded ? ', includes ' + item.ammoIncluded + ' rounds' : ''}.</span></button>`;
    }
    html += '</div>';
    html += '<h3 style="margin-top:16px;color:#ffc93c;">Ammo</h3>';
    html += '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">';
    for (const pack of AMMO_PACKS) {
      const count = ammoCount(pack.weapon);
      html += `<button data-ammo="${pack.weapon}" style="text-align:left;background:rgba(255,255,255,0.06);color:#f4f1e8;border:1px solid rgba(255,255,255,0.22);padding:10px 12px;font-size:14px;"><strong>${pack.name}</strong> — ${formatMoney(pack.price)}<br><span style="font-weight:400;font-size:12px;color:#cfe0d8;">${pack.blurb} In reserve now: ${count}.</span></button>`;
    }
    html += '</div>';
    sections.innerHTML = html;
    for (const btn of sections.querySelectorAll('[data-weapon]')) {
      btn.addEventListener('click', () => buyWeapon(btn.getAttribute('data-weapon')));
    }
    for (const btn of sections.querySelectorAll('[data-ammo]')) {
      btn.addEventListener('click', () => buyAmmo(btn.getAttribute('data-ammo')));
    }
  }

  function setOpen(value) {
    const next = Boolean(value);
    if (next === open) return open;
    open = next;
    if (!overlay) overlay = buildOverlay();
    if (overlay) overlay.classList.toggle('hidden', !open);
    if (open) render();
    return open;
  }

  function isNearShop(playerPos) {
    if (!playerPos) return false;
    const dx = playerPos.x - ARSENAL_POINT.x;
    const dz = playerPos.z - ARSENAL_POINT.z;
    return Math.hypot(dx, dz) < ARSENAL_RADIUS;
  }

  function update(dt, ctx = {}) {
    void dt;
    void ctx;
  }

  function getState() {
    return {
      open,
      owned: readOwned(),
      cash: getCash(),
      inHand: currentWeaponName(),
      ammo: {
        pistol: ammoCount('pistol'),
        shotgun: ammoCount('shotgun'),
        smg: ammoCount('smg'),
        rifle: ammoCount('rifle'),
      },
    };
  }

  return {
    update,
    setOpen,
    isOpen: () => open,
    isNearShop,
    buyWeapon,
    buyAmmo,
    getOwned: readOwned,
    getState,
    get point() { return { ...ARSENAL_POINT }; },
    get radius() { return ARSENAL_RADIUS; },
  };
}

export default createArsenalSystem;
