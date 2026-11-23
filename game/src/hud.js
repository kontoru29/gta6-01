// hud.js — Solmar Bay screen readouts and the round minimap, rebuilt.
//
// Everything on screen that is not the 3D world lives here: the cash
// total, the wanted stars, the clock, the health bar, the sprint stamina
// bar, the current weapon and ammo, the speedometer, the mission
// objective card, the little banner and toast lines, and the circular
// minimap. The module is deliberately dumb: main.js hands it a plain
// snapshot every frame and it paints it. It never moves the player,
// never changes the wanted level, never spends money.
//
// The minimap is a top-down sketch of Marisol Bay on a 2D canvas: the
// ocean and beach on the west edge, the promenade, the city blocks (green
// parks, the plaza fountain, the police station, the ferris-wheel
// landmark, ordinary blocks with building footprints), roads with dashed
// centrelines, district names, and the live markers on top — Leo as a
// white arrow, traffic as grey dots, police as blue dots, the helicopter
// as a red dot, cash pickups as gold dots, photo spots as cyan dots, and
// the mission objective as a pulsing gold diamond.

import { formatMoney, formatClock, formatSpeedKmh, clamp } from './utils.js';
import { CITY, MINIMAP } from './config.js';

// --- palette ---------------------------------------------------------------
// Canvas colour strings. The numeric versions for the 3D scene live in
// config.js; these are the 2D twins.
const INK = '#101820';
const PALETTE = {
  bg: '#16222e',
  road: '#4a545e',
  roadEdge: '#5f6b76',
  roadDash: '#8a94a0',
  sand: '#c9a86a',
  water: '#1d5a74',
  wave: '#7fb8d9',
  block: '#232d38',
  footprintA: '#31404e',
  footprintB: '#3a3f45',
  footprintC: '#4a3a30',
  park: '#3f7a3a',
  parkTree: '#6fae4f',
  plaza: '#b8b0a0',
  station: '#7fa8c8',
  landmark: '#c96f4a',
  promenade: '#5f6b76',
  player: '#ffffff',
  traffic: '#c8ccd2',
  police: '#4f9dff',
  heli: '#ff5a4e',
  mission: '#ffd23c',
  pickup: '#ffcf5e',
  photo: '#4fd8e8',
  ring: '#e8e4d8',
};

// District names in world coordinates, for the minimap labels.
const DISTRICTS = [
  { x: -248, z: 0, name: 'BEACH' },
  { x: 60, z: -60, name: 'DOWNTOWN' },
  { x: -120, z: 60, name: 'MERCADO' },
  { x: -180, z: -180, name: 'CORAL SHORE' },
  { x: 60, z: 210, name: 'MARINA' },
  { x: -120, z: 0, name: 'OLD TOWN' },
];
// The ferris wheel landmark, in world coordinates.
const WHEEL = { x: 0, z: -215 };

// The fixed city grid, so the minimap can draw blocks, parks and the
// plaza without any extra data from main.js.
const BLOCK_AXES = [-150, -90, -30, 30, 90, 150];

function blockType(bx, bz) {
  if ((bx === -30 && bz === 30) || (bx === 90 && bz === -90)) return 'park';
  if (bx === 30 && bz === 30) return 'plaza';
  if (bx === -90 && bz === 150) return 'station';
  if (bx === -30 && bz === 150) return 'landmark';
  return 'normal';
}

// A stable 0..1 value for a block, from its coordinates, so neighbouring
// blocks get different footprint shades without any stored state.
function blockSeed(bx, bz) {
  const raw = Math.abs(Math.sin(bx * 12.9898 + bz * 78.233) * 43758.5453);
  return raw - Math.floor(raw);
}

// A row of five stars, filled up to the current wanted level.
function starRow(stars, maxStars) {
  let row = '';
  for (let i = 0; i < maxStars; i += 1) {
    row += i < stars ? '★' : '<span class="star-off">★</span>';
  }
  return row;
}

// --- minimap paint helpers -------------------------------------------------
// Each paints one layer onto `ctx`. `g` carries the shared geometry:
// { ctx, half, scale, toX, toY } where toX/toY turn world coordinates
// into canvas pixels centred on the player.

function paintSeaAndSand(g, map) {
  const { ctx, half, scale, toX, toY } = g;
  const size = half * 2;
  const sandX = toX(CITY.beachStartX);
  const waterEdgeX = toX(CITY.beachEndX);
  ctx.fillStyle = PALETTE.water;
  ctx.fillRect(0, 0, Math.max(0, waterEdgeX), size);
  ctx.fillStyle = PALETTE.sand;
  ctx.fillRect(Math.max(0, waterEdgeX), 0, Math.max(0, sandX - waterEdgeX), size);
  // A pale line where the water meets the beach.
  ctx.strokeStyle = PALETTE.wave;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(waterEdgeX, 0);
  ctx.lineTo(waterEdgeX, size);
  ctx.stroke();
  void map;
  void toY;
}

function paintPromenade(g) {
  const { ctx, scale, toX, toY } = g;
  // The beachfront promenade: a pale strip just east of the sand.
  const promX = toX(-228);
  ctx.strokeStyle = PALETTE.promenade;
  ctx.lineWidth = Math.max(2, 10 * scale);
  ctx.beginPath();
  ctx.moveTo(promX, toY(-CITY.halfSize));
  ctx.lineTo(promX, toY(CITY.halfSize));
  ctx.stroke();
  // A row of tiny palm dots along the promenade.
  ctx.fillStyle = PALETTE.parkTree;
  for (let z = -220; z <= 220; z += 20) {
    ctx.beginPath();
    ctx.arc(toX(-232), toY(z), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintOneBlock(g, bx, bz) {
  const { ctx, scale, toX, toY } = g;
  const kind = blockType(bx, bz);
  const blockSize = CITY.blockSize - CITY.roadWidth;
  const px = toX(bx - blockSize / 2);
  const py = toY(bz - blockSize / 2);
  const pw = blockSize * scale;
  if (kind === 'park') {
    ctx.fillStyle = PALETTE.park;
    ctx.fillRect(px, py, pw, pw);
    // A few tree dots scattered on the lawn.
    ctx.fillStyle = PALETTE.parkTree;
    const spots = [[-12, -10], [12, 8], [10, -12], [-14, 10], [2, -14]];
    for (const [ox, oz] of spots) {
      ctx.beginPath();
      ctx.arc(toX(bx + ox), toY(bz + oz), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (kind === 'plaza') {
    ctx.fillStyle = PALETTE.plaza;
    ctx.fillRect(px, py, pw, pw);
    // The fountain disc in the middle of the plaza.
    ctx.fillStyle = PALETTE.water;
    ctx.beginPath();
    ctx.arc(toX(bx), toY(bz), 6 * scale, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (kind === 'station') {
    ctx.fillStyle = PALETTE.station;
    ctx.fillRect(px, py, pw, pw);
    return;
  }
  if (kind === 'landmark') {
    ctx.fillStyle = PALETTE.landmark;
    ctx.fillRect(px, py, pw, pw);
    return;
  }
  // Ordinary block: a dark slab with one or two building footprints
  // inset, shaded by the block's stable seed so neighbours differ.
  ctx.fillStyle = PALETTE.block;
  ctx.fillRect(px, py, pw, pw);
  const seed = blockSeed(bx, bz);
  const shade = seed < 0.33 ? PALETTE.footprintA
    : (seed < 0.66 ? PALETTE.footprintB : PALETTE.footprintC);
  ctx.fillStyle = shade;
  const inset = 8 * scale;
  if (seed < 0.45) {
    // Two buildings side by side.
    const halfW = (pw - inset * 2 - 2 * scale) / 2;
    ctx.fillRect(px + inset, py + inset, halfW, pw - inset * 2);
    ctx.fillRect(px + inset + halfW + 2 * scale, py + inset, halfW, pw - inset * 2);
  } else {
    ctx.fillRect(px + inset, py + inset, pw - inset * 2, pw - inset * 2);
  }
}

function paintBlocks(g) {
  for (const bx of BLOCK_AXES) {
    for (const bz of BLOCK_AXES) {
      paintOneBlock(g, bx, bz);
    }
  }
}

function paintRoads(g, map) {
  const { ctx, scale, toX, toY } = g;
  const roads = map.roads || [];
  // One pass per style: a darker edge, the road itself, then a dashed
  // centreline so each road reads as a road, not a grey band.
  const trace = (road) => {
    ctx.beginPath();
    if (road.axis === 'z') {
      ctx.moveTo(toX(road.at), toY(road.min));
      ctx.lineTo(toX(road.at), toY(road.max));
    } else {
      ctx.moveTo(toX(road.min), toY(road.at));
      ctx.lineTo(toX(road.max), toY(road.at));
    }
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.roadEdge;
  ctx.lineWidth = Math.max(2, CITY.roadWidth * scale + 2);
  for (const road of roads) trace(road);
  ctx.strokeStyle = PALETTE.road;
  ctx.lineWidth = Math.max(1, CITY.roadWidth * scale);
  for (const road of roads) trace(road);
  ctx.strokeStyle = PALETTE.roadDash;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  for (const road of roads) trace(road);
  ctx.setLineDash([]);
}

function paintLabels(g) {
  const { ctx, toX, toY } = g;
  // District names, small with a dark outline so they stay legible over
  // the blocks, and the ferris wheel as a coral ring so the north edge
  // reads on the map.
  ctx.font = 'bold 8px sans-serif';
  ctx.textAlign = 'center';
  for (const label of DISTRICTS) {
    const lx = toX(label.x);
    const ly = toY(label.z);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(16, 24, 32, 0.85)';
    ctx.strokeText(label.name, lx, ly);
    ctx.fillStyle = 'rgba(244, 241, 232, 0.9)';
    ctx.fillText(label.name, lx, ly);
  }
  ctx.strokeStyle = PALETTE.landmark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(toX(WHEEL.x), toY(WHEEL.z), 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = PALETTE.landmark;
  ctx.beginPath();
  ctx.arc(toX(WHEEL.x), toY(WHEEL.z), 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function paintMarkers(g, map, pulse) {
  const { ctx, toX, toY } = g;
  const dot = (x, z, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(toX(x), toY(z), r, 0, Math.PI * 2);
    ctx.fill();
  };
  const ringedDot = (x, z, r, color, ringColor) => {
    dot(x, z, r, color);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(toX(x), toY(z), r, 0, Math.PI * 2);
    ctx.stroke();
  };
  // Cash pickups first (under everything else), then photo spots, then
  // traffic with a dark outline so the dots read against the pale roads.
  for (const p of map.pickups || []) {
    if (p.available) dot(p.x, p.z, 2.5, PALETTE.pickup);
  }
  for (const spot of map.photoSpots || []) {
    if (spot.ready) dot(spot.x, spot.z, 2, PALETTE.photo);
  }
  for (const car of map.traffic || []) {
    ringedDot(car.x, car.z, 2.5, PALETTE.traffic, INK);
  }
  // Mission marker: a pulsing gold diamond with a white outline and a
  // faint outer ring, so the objective is unmissable.
  if (map.marker && map.marker.active) {
    const size = 5 + Math.sin(pulse * 4) * 1.5;
    const mx = toX(map.marker.x);
    const my = toY(map.marker.z);
    ctx.strokeStyle = 'rgba(255, 210, 60, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mx, my, size + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = PALETTE.mission;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, my - size);
    ctx.lineTo(mx + size, my);
    ctx.lineTo(mx, my + size);
    ctx.lineTo(mx - size, my);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // Police blips on top of traffic so a chase reads at a glance. The
  // helicopter is a bigger red dot — the one unit that never leaves.
  for (const unit of map.police || []) {
    if (unit.kind === 'heli') {
      ringedDot(unit.x, unit.z, 4.5, PALETTE.heli, '#ffffff');
    } else {
      ringedDot(unit.x, unit.z, 3.5, PALETTE.police, '#ffffff');
    }
  }
}

function paintPlayer(g, map) {
  const { ctx, half, toX, toY } = g;
  // The player: a white arrow pointing where Leo faces, with a soft
  // outer glow ring so it pops against the map.
  const heading = map.playerHeading || 0;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(half, half, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.translate(half, half);
  // Screen y grows downward while world -z is "forward" (north, up on
  // the map), so the arrow turns by -heading to stay honest.
  ctx.rotate(-heading);
  ctx.fillStyle = PALETTE.player;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(5.5, 6);
  ctx.lineTo(0, 3);
  ctx.lineTo(-5.5, 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  void toX;
  void toY;
}

export class SolmarHud {
  constructor(doc) {
    this.doc = doc || document;
    const byId = (id) => this.doc.getElementById(id);
    this.root = byId('hud');
    this.cashEl = byId('hud-cash');
    this.wantedEl = byId('hud-wanted');
    this.clockEl = byId('hud-clock');
    this.healthBarEl = byId('hud-health-bar');
    this.staminaBarEl = byId('hud-stamina-bar');
    this.staminaWrapEl = byId('hud-stamina-bar-wrap');
    this.weaponEl = byId('hud-weapon');
    this.speedEl = byId('hud-speed');
    this.objectiveTitleEl = byId('hud-objective-title');
    this.objectiveTextEl = byId('hud-objective-text');
    this.objectiveStepEl = byId('hud-objective-step');
    this.objectiveDialogueEl = byId('hud-objective-dialogue');
    this.notifyEl = byId('hud-notify-text');
    this.promptEl = byId('hud-prompt');
    this.toastEl = byId('hud-toast');
    this.crosshairEl = byId('crosshair');
    this.minimapEl = byId('minimap');
    this.minimapCtx = this.minimapEl ? this.minimapEl.getContext('2d') : null;

    this.notifyTimer = 0;
    this.toastTimer = 0;
    this.lastObjectiveKey = '';
    this.lastCash = null;
    this.lastStars = -1;
    this.minimapPulse = 0;
  }

  show() {
    if (this.root) this.root.classList.add('visible');
  }

  hide() {
    if (this.root) this.root.classList.remove('visible');
  }

  // One frame of HUD painting. `snap` is a plain object from main.js:
  // { health, stamina, cash, stars, speedMps, weaponName, ammoInMag,
  //   ammoReserve, reloading, clockHour, clockMinute, objective
  //   {title,text,step,steps,dialogue}, prompt, driving, aiming }
  update(snap, dt) {
    if (!snap) return;
    const step = dt || 0;
    if (this.healthBarEl) {
      const hp = clamp(snap.health || 0, 0, 100);
      this.healthBarEl.style.width = hp + '%';
      this.healthBarEl.classList.toggle('low', hp <= 30);
    }
    if (this.staminaBarEl) {
      const stamina = clamp(snap.stamina ?? 100, 0, 100);
      this.staminaBarEl.style.width = stamina + '%';
      this.staminaBarEl.classList.toggle('low', stamina <= 25);
      if (this.staminaWrapEl) {
        this.staminaWrapEl.setAttribute('aria-valuenow', String(Math.round(stamina)));
      }
    }
    if (this.cashEl && snap.cash !== this.lastCash) {
      this.cashEl.textContent = formatMoney(snap.cash || 0);
      this.lastCash = snap.cash;
    }
    if (this.wantedEl && snap.stars !== this.lastStars) {
      this.wantedEl.innerHTML = starRow(snap.stars || 0, 5);
      this.lastStars = snap.stars;
    }
    if (this.clockEl) {
      this.clockEl.textContent = formatClock(snap.clockHour || 17, snap.clockMinute || 40);
    }
    if (this.weaponEl) {
      const name = snap.weaponName === 'pistol' ? 'Pistol'
        : snap.weaponName === 'shotgun' ? 'Shotgun' : 'Fists';
      let ammo = '';
      if (snap.weaponName === 'pistol' || snap.weaponName === 'shotgun') {
        ammo = ` <span class="ammo">${snap.ammoInMag} / ${snap.ammoReserve}</span>`;
        if (snap.reloading) ammo += ' — reloading…';
      }
      this.weaponEl.innerHTML = name + ammo;
    }
    if (this.speedEl) {
      const kmh = snap.driving ? formatSpeedKmh(snap.speedMps || 0) : 0;
      this.speedEl.innerHTML = kmh + ' <span class="unit">km/h</span>';
    }
    const obj = snap.objective || {};
    const objKey = (obj.title || '') + '|' + (obj.text || '') + '|' + (obj.step || 0);
    if (objKey !== this.lastObjectiveKey) {
      this.lastObjectiveKey = objKey;
      if (this.objectiveTitleEl) this.objectiveTitleEl.textContent = obj.title || 'Free roam';
      if (this.objectiveTextEl) this.objectiveTextEl.textContent = obj.text || '';
      if (this.objectiveStepEl) {
        this.objectiveStepEl.textContent =
          obj.steps ? `Step ${obj.step || 1} of ${obj.steps}` : '';
      }
      if (this.objectiveDialogueEl) {
        this.objectiveDialogueEl.textContent = obj.dialogue || '';
      }
    }
    if (this.promptEl) {
      this.promptEl.innerHTML = snap.prompt || '';
    }
    if (this.crosshairEl) {
      this.crosshairEl.classList.toggle('visible', Boolean(snap.aiming));
    }
    if (this.notifyTimer > 0) {
      this.notifyTimer -= step;
      if (this.notifyTimer <= 0 && this.notifyEl) this.notifyEl.textContent = '';
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= step;
      if (this.toastTimer <= 0 && this.toastEl) this.toastEl.textContent = '';
    }
  }

  // A banner line near the bottom of the screen, shown for a few seconds.
  notify(text, seconds) {
    if (!this.notifyEl) return;
    this.notifyEl.textContent = text || '';
    this.notifyTimer = seconds || 4;
  }

  // A short line near the top of the screen (mission complete, warnings).
  toast(text, seconds) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text || '';
    this.toastTimer = seconds || 3;
  }

  clearNotify() {
    if (this.notifyEl) this.notifyEl.textContent = '';
    this.notifyTimer = 0;
  }

  // --- Minimap ------------------------------------------------------------
  // `map` is a plain object from main.js:
  // { playerX, playerZ, playerHeading, driving, traffic: [{x,z}],
  //   police: [{x,z,kind}], marker: {x,z,active}, pickups: [{x,z,available}],
  //   photoSpots: [{x,z,ready}], roads: [{axis, at, min, max}], worldRadius }
  drawMinimap(map, dt) {
    const ctx = this.minimapCtx;
    const canvas = this.minimapEl;
    if (!ctx || !canvas || !map) return;
    this.minimapPulse += dt || 0;
    const size = canvas.width;
    const half = size / 2;
    const radius = map.worldRadius || MINIMAP.worldRadius;
    const scale = half / radius;
    const toX = (x) => half + (x - map.playerX) * scale;
    const toY = (z) => half + (z - map.playerZ) * scale;
    const g = { ctx, half, scale, toX, toY };

    ctx.clearRect(0, 0, size, size);
    // Round clip so the map stays a circle.
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(0, 0, size, size);

    paintSeaAndSand(g, map);
    paintPromenade(g);
    paintBlocks(g);
    paintRoads(g, map);
    paintLabels(g);
    paintMarkers(g, map, this.minimapPulse);
    paintPlayer(g, map);
    ctx.restore();

    // Thin ring border around the whole circle, then the north tick.
    ctx.strokeStyle = PALETTE.ring;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(half, half, half - 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#f4f1e8';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', half, 13);
  }
}

export default SolmarHud;
