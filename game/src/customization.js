// customization.js — Solmar Bay's garage and vehicle tuning, Round 8.
//
// Leo's rides used to be whatever he stole, as-is. Now the garage at
// (-120, -120) is a real shop: repaint the car in one of twelve colours,
// fit sport or muscle wheels, bolt on engine stages, and plate the car
// with armour — all bought with the cash Leo earns on jobs. Tuning is
// owned by Leo, not by one car: whatever he is driving when he leaves
// the garage carries his setup, and a fresh steal starts stock again
// until he swings by the garage.
//
// The garage is a DOM overlay (built by this module, styled by the
// shared overlay classes in index.html) opened with G near the garage
// marker. Buying goes through the cash callbacks main.js provides, so
// the garage never touches the cash balance directly, and every
// purchase is written into the save file the same frame.
//
// `createGarageSystem({ vehicles, save, hud, getCash, spendCash })`
// returns the overlay, the buy functions and the per-frame update that
// watches for Leo's car and re-applies his tuning to it.

export const GARAGE_POINT = { x: -120, z: -120 };
export const GARAGE_RADIUS = 12;

export const PAINT_JOBS = [
  { name: 'Cherry Red', hex: 0xd21f2b, price: 150 },
  { name: 'Sunset Orange', hex: 0xe86a1f, price: 150 },
  { name: 'Taxi Yellow', hex: 0xf2b234, price: 150 },
  { name: 'Lime', hex: 0x7ed07a, price: 150 },
  { name: 'Bay Teal', hex: 0x2f7fd0, price: 150 },
  { name: 'Ocean Blue', hex: 0x2a4a8a, price: 150 },
  { name: 'Royal Purple', hex: 0x6a3a8a, price: 200 },
  { name: 'Hot Pink', hex: 0xe83a8a, price: 200 },
  { name: 'Arctic White', hex: 0xf2f0e6, price: 200 },
  { name: 'Midnight Black', hex: 0x1a1e24, price: 250 },
  { name: 'Gold Flake', hex: 0xc9a227, price: 400 },
  { name: 'Chrome Silver', hex: 0xb8c0c8, price: 400 },
];

export const WHEEL_STYLES = [
  { id: 'street', name: 'Street', price: 0, accelBonus: 0, topSpeedBonus: 0, blurb: 'Stock steelies. Free, honest, slow.' },
  { id: 'sport', name: 'Sport', price: 400, accelBonus: 0.05, topSpeedBonus: 0.02, blurb: 'Light alloys. Quicker off the line.' },
  { id: 'muscle', name: 'Muscle', price: 900, accelBonus: 0.03, topSpeedBonus: 0.07, blurb: 'Wide rears. Top end for the long straights.' },
  { id: 'offroad', name: 'Off-Road', price: 700, accelBonus: 0.06, topSpeedBonus: -0.02, blurb: 'Knobbly tyres. Bite in the wet, drag on the dry.' },
];

export const ENGINE_STAGES = [
  { stage: 0, name: 'Stock', price: 0, topSpeedBonus: 0, accelBonus: 0 },
  { stage: 1, name: 'Stage 1 — Intake', price: 800, topSpeedBonus: 0.09, accelBonus: 0.08 },
  { stage: 2, name: 'Stage 2 — Turbo', price: 1600, topSpeedBonus: 0.18, accelBonus: 0.16 },
  { stage: 3, name: 'Stage 3 — Full Build', price: 3200, topSpeedBonus: 0.3, accelBonus: 0.26 },
];

export const ARMOR_STAGES = [
  { stage: 0, name: 'Stock Panels', price: 0, damageReduction: 0 },
  { stage: 1, name: 'Plated Doors', price: 600, damageReduction: 0.12 },
  { stage: 2, name: 'Armoured Shell', price: 1200, damageReduction: 0.24 },
  { stage: 3, name: 'Bulletproof', price: 2400, damageReduction: 0.36 },
];

function formatMoney(amount) {
  const n = Math.floor(amount || 0);
  return '$' + n.toLocaleString('en-US');
}

function cloneTuning(owned) {
  return {
    engine: owned.engine || 0,
    wheels: owned.wheels || 'street',
    armor: owned.armor || 0,
    paint: owned.paint || null,
  };
}

// Combine the owned upgrades into the tuning object the vehicle system
// reads: engine stage plus wheel bonuses, as multipliers.
export function tuningForOwned(owned) {
  const engine = ENGINE_STAGES[owned.engine || 0] || ENGINE_STAGES[0];
  const wheels = WHEEL_STYLES.find((w) => w.id === (owned.wheels || 'street'))
    || WHEEL_STYLES[0];
  const armor = ARMOR_STAGES[owned.armor || 0] || ARMOR_STAGES[0];
  return {
    engine: owned.engine || 0,
    wheels: owned.wheels || 'street',
    armor: owned.armor || 0,
    paint: owned.paint || null,
    topSpeedBonus: engine.topSpeedBonus + wheels.topSpeedBonus,
    accelBonus: engine.accelBonus + wheels.accelBonus,
    damageReduction: armor.damageReduction,
  };
}

export function createGarageSystem(deps = {}) {
  const vehicles = deps.vehicles || null;
  const saveApi = deps.save || null;
  const hud = deps.hud || null;
  const getCash = typeof deps.getCash === 'function' ? deps.getCash : () => 0;
  const spendCash = typeof deps.spendCash === 'function' ? deps.spendCash : () => false;
  const onChanged = typeof deps.onChanged === 'function' ? deps.onChanged : null;

  let open = false;
  let overlay = null;
  let lastTunedCar = null;
  let lastTunedKey = '';

  function readOwned() {
    try {
      const saved = saveApi && typeof saveApi.loadSave === 'function'
        ? saveApi.loadSave()
        : null;
      const garage = (saved && saved.garage) || {};
      return {
        paint: typeof garage.paint === 'number' ? garage.paint : null,
        wheels: typeof garage.wheels === 'string' ? garage.wheels : 'street',
        engine: typeof garage.engine === 'number' ? garage.engine : 0,
        armor: typeof garage.armor === 'number' ? garage.armor : 0,
      };
    } catch {
      return { paint: null, wheels: 'street', engine: 0, armor: 0 };
    }
  }

  function writeOwned(owned) {
    if (!saveApi || typeof saveApi.updateSave !== 'function') return;
    try {
      saveApi.updateSave((s) => {
        s.garage = {
          paint: owned.paint,
          wheels: owned.wheels,
          engine: owned.engine,
          armor: owned.armor,
        };
      });
    } catch { /* save failure must not break the shop */ }
    if (onChanged) {
      try { onChanged({ ...owned }); } catch { /* cosmetic */ }
    }
  }

  function notify(text, seconds = 3) {
    if (hud && typeof hud.notify === 'function') hud.notify(text, seconds);
  }

  function currentCar() {
    if (!vehicles) return null;
    return vehicles.playerCar || null;
  }

  // Put Leo's owned setup onto a car: paint first, then the tuning
  // multipliers the vehicle system reads every frame.
  function applyToCar(car) {
    if (!car || !vehicles) return false;
    const owned = readOwned();
    const tuning = tuningForOwned(owned);
    try {
      if (typeof vehicles.applyTuning === 'function') {
        vehicles.applyTuning(car, tuning);
      } else {
        car.tuning = tuning;
      }
    } catch { /* a car without the hook still takes the tuning object */ }
    if (owned.paint !== null && typeof vehicles.repaintCar === 'function') {
      try { vehicles.repaintCar(car, owned.paint); } catch { /* cosmetic */ }
    }
    return true;
  }

  function tuningKey(car) {
    const owned = readOwned();
    return [
      car.type || '',
      owned.paint,
      owned.wheels,
      owned.engine,
      owned.armor,
    ].join('|');
  }

  // --- buying ---------------------------------------------------------------
  function buyPaint(hex) {
    const job = PAINT_JOBS.find((p) => p.hex === hex);
    if (!job) return false;
    const owned = readOwned();
    if (owned.paint === hex) {
      notify('Already wearing ' + job.name, 2);
      return true;
    }
    if (!spendCash(job.price)) {
      notify('Not enough cash for ' + job.name + ' (' + formatMoney(job.price) + ')', 3);
      return false;
    }
    owned.paint = hex;
    writeOwned(owned);
    const car = currentCar();
    if (car) applyToCar(car);
    notify(job.name + ' paint fitted — ' + formatMoney(job.price), 3);
    render();
    return true;
  }

  function buyWheels(styleId) {
    const style = WHEEL_STYLES.find((w) => w.id === styleId);
    if (!style) return false;
    const owned = readOwned();
    if (owned.wheels === styleId) {
      notify('Already running ' + style.name + ' wheels', 2);
      return true;
    }
    if (!spendCash(style.price)) {
      notify('Not enough cash for ' + style.name + ' wheels (' + formatMoney(style.price) + ')', 3);
      return false;
    }
    owned.wheels = styleId;
    writeOwned(owned);
    const car = currentCar();
    if (car) applyToCar(car);
    notify(style.name + ' wheels fitted — ' + formatMoney(style.price), 3);
    render();
    return true;
  }

  function buyEngine() {
    const owned = readOwned();
    const next = owned.engine + 1;
    if (next >= ENGINE_STAGES.length) {
      notify('Engine is already maxed out', 2);
      return false;
    }
    const stage = ENGINE_STAGES[next];
    if (!spendCash(stage.price)) {
      notify('Not enough cash for ' + stage.name + ' (' + formatMoney(stage.price) + ')', 3);
      return false;
    }
    owned.engine = next;
    writeOwned(owned);
    const car = currentCar();
    if (car) applyToCar(car);
    notify(stage.name + ' fitted — ' + formatMoney(stage.price), 3);
    render();
    return true;
  }

  function buyArmor() {
    const owned = readOwned();
    const next = owned.armor + 1;
    if (next >= ARMOR_STAGES.length) {
      notify('Armour is already maxed out', 2);
      return false;
    }
    const stage = ARMOR_STAGES[next];
    if (!spendCash(stage.price)) {
      notify('Not enough cash for ' + stage.name + ' (' + formatMoney(stage.price) + ')', 3);
      return false;
    }
    owned.armor = next;
    writeOwned(owned);
    const car = currentCar();
    if (car) applyToCar(car);
    notify(stage.name + ' fitted — ' + formatMoney(stage.price), 3);
    render();
    return true;
  }

  function resetPaint() {
    const owned = readOwned();
    if (owned.paint === null) return true;
    owned.paint = null;
    writeOwned(owned);
    const car = currentCar();
    if (car) applyToCar(car);
    notify('Back to factory paint', 2);
    render();
    return true;
  }

  // --- overlay ------------------------------------------------------------------
  function buildOverlay() {
    if (typeof document === 'undefined') return null;
    const existing = document.getElementById('garage-overlay');
    if (existing) return existing;
    const root = document.createElement('div');
    root.id = 'garage-overlay';
    root.className = 'overlay hidden';
    root.innerHTML = `
      <div class="overlay-card">
        <h2>Garage — Rico's Shop</h2>
        <p>Leo's rides, tuned his way. Upgrades stick to Leo: whatever he
        is driving carries his setup. Prices are cash on the spot.</p>
        <div id="garage-cash"></div>
        <div id="garage-sections"></div>
        <div class="btn-row">
          <button id="btn-close-garage" class="secondary">Close (G)</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    const closeBtn = root.querySelector('#btn-close-garage');
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
    return root;
  }

  function hexCss(hex) {
    return '#' + hex.toString(16).padStart(6, '0');
  }

  function render() {
    if (!open) return;
    if (!overlay) overlay = buildOverlay();
    if (!overlay) return;
    const cashEl = overlay.querySelector('#garage-cash');
    if (cashEl) {
      cashEl.textContent = 'Cash: ' + formatMoney(getCash());
      cashEl.style.cssText = 'font-size:18px;font-weight:800;color:#ffc93c;margin-top:10px;';
    }
    const sections = overlay.querySelector('#garage-sections');
    if (!sections) return;
    const owned = readOwned();
    const car = currentCar();
    const carLabel = car ? (car.type || 'car') : 'no car';
    let html = '';
    html += '<h3 style="margin-top:14px;color:#ffc93c;">Paint — riding: ' + carLabel + '</h3>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">';
    for (const job of PAINT_JOBS) {
      const active = owned.paint === job.hex;
      html += `<button data-paint="${job.hex}" style="background:${hexCss(job.hex)};color:#101820;border:2px solid ${active ? '#fff' : 'rgba(255,255,255,0.3)'};padding:8px 10px;font-size:13px;">${job.name} ${formatMoney(job.price)}</button>`;
    }
    html += `<button data-paint-reset="1" style="background:transparent;color:#f4f1e8;border:2px solid #ffc93c;padding:8px 10px;font-size:13px;">Factory paint</button>`;
    html += '</div>';
    html += '<h3 style="margin-top:16px;color:#ffc93c;">Wheels</h3>';
    html += '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">';
    for (const style of WHEEL_STYLES) {
      const active = owned.wheels === style.id;
      html += `<button data-wheels="${style.id}" style="text-align:left;background:${active ? 'rgba(255,201,60,0.2)' : 'rgba(255,255,255,0.06)'};color:#f4f1e8;border:1px solid rgba(255,255,255,0.22);padding:10px 12px;font-size:14px;">${style.name} — ${formatMoney(style.price)}<br><span style="font-weight:400;font-size:12px;color:#cfe0d8;">${style.blurb}</span></button>`;
    }
    html += '</div>';
    const nextEngine = ENGINE_STAGES[owned.engine + 1];
    const nextArmor = ARMOR_STAGES[owned.armor + 1];
    html += '<h3 style="margin-top:16px;color:#ffc93c;">Engine — now: ' + ENGINE_STAGES[owned.engine].name + '</h3>';
    html += nextEngine
      ? `<button data-engine="1" style="background:#ffc93c;color:#101820;padding:10px 14px;font-size:14px;">${nextEngine.name} — ${formatMoney(nextEngine.price)}</button>`
      : '<p style="color:#7ed07a;">Maxed out. Nothing left to bolt on.</p>';
    html += '<h3 style="margin-top:16px;color:#ffc93c;">Armour — now: ' + ARMOR_STAGES[owned.armor].name + '</h3>';
    html += nextArmor
      ? `<button data-armor="1" style="background:#ffc93c;color:#101820;padding:10px 14px;font-size:14px;">${nextArmor.name} — ${formatMoney(nextArmor.price)}</button>`
      : '<p style="color:#7ed07a;">Maxed out. The car is a tank.</p>';
    sections.innerHTML = html;
    for (const btn of sections.querySelectorAll('[data-paint]')) {
      btn.addEventListener('click', () => buyPaint(Number(btn.getAttribute('data-paint'))));
    }
    for (const btn of sections.querySelectorAll('[data-paint-reset]')) {
      btn.addEventListener('click', () => resetPaint());
    }
    for (const btn of sections.querySelectorAll('[data-wheels]')) {
      btn.addEventListener('click', () => buyWheels(btn.getAttribute('data-wheels')));
    }
    for (const btn of sections.querySelectorAll('[data-engine]')) {
      btn.addEventListener('click', () => buyEngine());
    }
    for (const btn of sections.querySelectorAll('[data-armor]')) {
      btn.addEventListener('click', () => buyArmor());
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

  function isNearGarage(playerPos) {
    if (!playerPos) return false;
    const dx = playerPos.x - GARAGE_POINT.x;
    const dz = playerPos.z - GARAGE_POINT.z;
    return Math.hypot(dx, dz) < GARAGE_RADIUS;
  }

  function update(dt, ctx = {}) {
    void dt;
    if (!open) {
      // Keep Leo's setup on whatever he is driving: a fresh steal starts
      // stock, so re-apply the owned tuning the moment the car changes.
      const car = currentCar();
      if (car) {
        const key = tuningKey(car);
        if (car !== lastTunedCar || key !== lastTunedKey) {
          applyToCar(car);
          lastTunedCar = car;
          lastTunedKey = key;
        }
      } else {
        lastTunedCar = null;
        lastTunedKey = '';
      }
    }
    void ctx;
  }

  function getState() {
    const owned = readOwned();
    return {
      open,
      owned,
      tuning: tuningForOwned(owned),
      nearGarage: false,
      car: currentCar() ? currentCar().type : null,
      cash: getCash(),
    };
  }

  return {
    update,
    setOpen,
    isOpen: () => open,
    isNearGarage,
    applyToCar,
    buyPaint,
    buyWheels,
    buyEngine,
    buyArmor,
    resetPaint,
    getOwned: readOwned,
    getTuning: () => tuningForOwned(readOwned()),
    getState,
    get point() { return { ...GARAGE_POINT }; },
    get radius() { return GARAGE_RADIUS; },
  };
}

export default createGarageSystem;
