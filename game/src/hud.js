// hud.js — Solmar Bay on-screen readouts and the top-down minimap.
//
// This module owns every pixel of the HUD and nothing else: it never moves
// the player, never changes the wanted level, never pays cash. main.js hands
// it a plain snapshot each frame (health, cash, stars, speed, weapon, the
// current objective, positions for the minimap) and this module paints it.
// The minimap is a round 2D canvas: roads as pale strips, the player as a
// white arrow, traffic as grey dots, police as blue dots, cash pickups as
// small gold dots, and the active mission marker as a pulsing gold diamond.

import { formatMoney, formatClock, formatSpeedKmh, clamp } from './utils.js';
import { CITY, MINIMAP } from './config.js';

// Minimap colours, as canvas fill strings (config keeps numbers for 3D).
const MAP_BG = '#16222e';
const MAP_ROAD = '#4a545e';
const MAP_ROAD_EDGE = '#5f6b76';
const MAP_SAND = '#c9a86a';
const MAP_WATER = '#1d5a74';
const MAP_BLOCK = '#232d38';
const MAP_PLAYER = '#ffffff';
const MAP_TRAFFIC = '#c8ccd2';
const MAP_POLICE = '#4f9dff';
const MAP_MISSION = '#ffd23c';
const MAP_PICKUP = '#ffcf5e';

function starRow(stars, maxStars) {
  let out = '';
  for (let i = 0; i < maxStars; i += 1) {
    out += i < stars ? '★' : '<span class="star-off">★</span>';
  }
  return out;
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
  // { health, cash, stars, speedMps, weaponName, ammoInMag, ammoReserve,
  //   reloading, clockHour, clockMinute, objective {title,text,step,steps,
  //   dialogue}, prompt, driving, aiming }
  update(snap, dt) {
    if (!snap) return;
    const step = dt || 0;
    if (this.healthBarEl) {
      const hp = clamp(snap.health || 0, 0, 100);
      this.healthBarEl.style.width = hp + '%';
      this.healthBarEl.classList.toggle('low', hp <= 30);
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
      const name = snap.weaponName === 'pistol' ? 'Pistol' : 'Fists';
      let ammo = '';
      if (snap.weaponName === 'pistol') {
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
  //   roads: [{axis, at, min, max}], worldRadius }
  drawMinimap(map, dt) {
    const ctx = this.minimapCtx;
    const canvas = this.minimapEl;
    if (!ctx || !canvas || !map) return;
    this.minimapPulse += dt || 0;
    const size = canvas.width;
    const half = size / 2;
    const radius = map.worldRadius || MINIMAP.worldRadius;
    const scale = half / radius;
    const toMapX = (x) => half + (x - map.playerX) * scale;
    const toMapY = (z) => half + (z - map.playerZ) * scale;

    ctx.clearRect(0, 0, size, size);
    // Round clip so the map stays a circle.
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, size, size);

    // Ocean on the west edge, sand strip beside it.
    const oceanX = toMapX(CITY.oceanEndX);
    const sandX = toMapX(CITY.beachStartX);
    ctx.fillStyle = MAP_WATER;
    ctx.fillRect(0, 0, Math.max(0, sandX), size);
    ctx.fillStyle = MAP_SAND;
    ctx.fillRect(Math.max(0, sandX), 0, Math.max(0, toMapX(CITY.beachEndX) - sandX), size);

    // City blocks as faint squares, then roads as pale strips.
    ctx.fillStyle = MAP_BLOCK;
    const blockCenters = [-150, -90, -30, 30, 90, 150];
    for (const bx of blockCenters) {
      for (const bz of blockCenters) {
        const px = toMapX(bx - 23);
        const py = toMapY(bz - 23);
        ctx.fillRect(px, py, 46 * scale, 46 * scale);
      }
    }
    const roads = map.roads || [];
    ctx.strokeStyle = MAP_ROAD_EDGE;
    ctx.lineCap = 'round';
    for (const road of roads) {
      ctx.lineWidth = Math.max(2, CITY.roadWidth * scale + 2);
      ctx.beginPath();
      if (road.axis === 'z') {
        ctx.moveTo(toMapX(road.at), toMapY(road.min));
        ctx.lineTo(toMapX(road.at), toMapY(road.max));
      } else {
        ctx.moveTo(toMapX(road.min), toMapY(road.at));
        ctx.lineTo(toMapX(road.max), toMapY(road.at));
      }
      ctx.stroke();
    }
    ctx.strokeStyle = MAP_ROAD;
    for (const road of roads) {
      ctx.lineWidth = Math.max(1, CITY.roadWidth * scale);
      ctx.beginPath();
      if (road.axis === 'z') {
        ctx.moveTo(toMapX(road.at), toMapY(road.min));
        ctx.lineTo(toMapX(road.at), toMapY(road.max));
      } else {
        ctx.moveTo(toMapX(road.min), toMapY(road.at));
        ctx.lineTo(toMapX(road.max), toMapY(road.at));
      }
      ctx.stroke();
    }

    const dot = (x, z, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(toMapX(x), toMapY(z), r, 0, Math.PI * 2);
      ctx.fill();
    };

    // Cash pickups first (under everything else), then traffic.
    for (const p of map.pickups || []) {
      if (p.available) dot(p.x, p.z, 2.5, MAP_PICKUP);
    }
    for (const car of map.traffic || []) {
      dot(car.x, car.z, 2.5, MAP_TRAFFIC);
    }
    // Mission marker: a pulsing gold diamond.
    if (map.marker && map.marker.active) {
      const pulse = 5 + Math.sin(this.minimapPulse * 4) * 1.5;
      const mx = toMapX(map.marker.x);
      const my = toMapY(map.marker.z);
      ctx.fillStyle = MAP_MISSION;
      ctx.beginPath();
      ctx.moveTo(mx, my - pulse);
      ctx.lineTo(mx + pulse, my);
      ctx.lineTo(mx, my + pulse);
      ctx.lineTo(mx - pulse, my);
      ctx.closePath();
      ctx.fill();
    }
    // Police blips on top of traffic so a chase reads at a glance.
    for (const unit of map.police || []) {
      dot(unit.x, unit.z, 3.5, MAP_POLICE);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(toMapX(unit.x), toMapY(unit.z), 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // The player: a white arrow pointing where Leo faces.
    const heading = map.playerHeading || 0;
    const px = half;
    const py = half;
    ctx.save();
    ctx.translate(px, py);
    // Screen y grows downward while world -z is "forward" (north, up on
    // the map), so the arrow turns by -heading to stay honest.
    ctx.rotate(-heading);
    ctx.fillStyle = MAP_PLAYER;
    ctx.strokeStyle = '#101820';
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
    ctx.restore();

    // North tick at the top edge of the circle.
    ctx.fillStyle = '#f4f1e8';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', half, 13);
  }
}

export default SolmarHud;
