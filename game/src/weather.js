// weather.js — Solmar Bay day/night cycle and live weather, Round 8.
//
// The bay used to sit in one endless golden hour. Now the clock runs:
// dawn breaks, the sun climbs, dusk burns orange, and night brings the
// lamps and the moon out. On top of the clock sits real weather — clear
// skies, overcast grey, rain, thunderstorms and sea fog — that drifts
// from one state to the next while Leo plays. Weather is not decoration
// only: rain and storms cut the grip of every car on the road, fog
// shortens sight lines, and night makes the city lamps and the police
// light bars read the way they should.
//
// The system owns the sky colour, the fog, the sun and hemisphere
// lights, and one recycled rain field (a single THREE.Points cloud of
// drops that fall past the player and loop back to the top, so the
// per-frame path allocates nothing). Lightning is a brief spike of the
// sun light plus a washed-out sky; thunder is left to the audio engine
// through the onLightning callback, which main.js wires to a low rumble.
//
// `update(dt, ctx)` takes the live clock and the player position from
// main.js: ctx = { hour, minute, playerPos }. Everything else is read
// through getters, so the HUD and the playtests can probe it without
// touching the scene.

import * as THREE from 'three';

export const WEATHER_PHASES = {
  NIGHT: 'night',
  DAWN: 'dawn',
  DAY: 'day',
  DUSK: 'dusk',
};

export const WEATHER_STATES = {
  CLEAR: 'clear',
  OVERCAST: 'overcast',
  RAIN: 'rain',
  STORM: 'storm',
  FOG: 'fog',
};

export const WEATHER_LABELS = {
  clear: 'Clear skies',
  overcast: 'Overcast',
  rain: 'Rain',
  storm: 'Thunderstorm',
  fog: 'Sea fog',
};

export const WEATHER_GRIP = {
  clear: 1.0,
  overcast: 0.98,
  rain: 0.88,
  storm: 0.8,
  fog: 0.95,
};

// How long a weather state holds before the dice roll again, in seconds
// of real play. Storms are short and violent; clear spells last longest.
const WEATHER_HOLD = {
  clear: { min: 150, max: 300 },
  overcast: { min: 90, max: 200 },
  rain: { min: 75, max: 160 },
  storm: { min: 40, max: 90 },
  fog: { min: 60, max: 130 },
};

// Next-weather weights from each state: rows sum to 1.
const WEATHER_TRANSITIONS = {
  clear: { clear: 0.45, overcast: 0.3, rain: 0.12, storm: 0.03, fog: 0.1 },
  overcast: { clear: 0.3, overcast: 0.35, rain: 0.2, storm: 0.05, fog: 0.1 },
  rain: { clear: 0.2, overcast: 0.35, rain: 0.25, storm: 0.15, fog: 0.05 },
  storm: { clear: 0.15, overcast: 0.3, rain: 0.4, storm: 0.1, fog: 0.05 },
  fog: { clear: 0.35, overcast: 0.3, rain: 0.1, storm: 0.02, fog: 0.23 },
};

// Sky, fog and light targets per phase of the day. Colours are hex;
// intensity is the sun's directional strength.
const PHASE_LIGHT = {
  night: {
    sky: 0x0d1b2e, fog: 0x0d1b2e, sun: 0x8fb4dd, sunIntensity: 0.35,
    hemiSky: 0x2a4a6a, hemiGround: 0x0c1410, hemiIntensity: 0.35,
    fogNear: 90, fogFar: 420,
  },
  dawn: {
    sky: 0xf2a56b, fog: 0xf0b48a, sun: 0xffb36b, sunIntensity: 1.6,
    hemiSky: 0xf2c49a, hemiGround: 0x8a6f5c, hemiIntensity: 0.6,
    fogNear: 120, fogFar: 520,
  },
  day: {
    sky: 0x7fb4dd, fog: 0xcfd8e2, sun: 0xfff2d0, sunIntensity: 2.4,
    hemiSky: 0xbfd9ff, hemiGround: 0x8a7a5c, hemiIntensity: 0.75,
    fogNear: 140, fogFar: 620,
  },
  dusk: {
    sky: 0xee8f6b, fog: 0xf0a878, sun: 0xff8a3d, sunIntensity: 2.0,
    hemiSky: 0xf2b48a, hemiGround: 0xd9985e, hemiIntensity: 0.7,
    fogNear: 120, fogFar: 520,
  },
};

// Weather tints multiply the phase light: rain darkens and cools the
// sky, fog washes it pale, storms go almost black at the edges.
const WEATHER_TINT = {
  clear: { sky: 0xffffff, fog: 0xffffff, sun: 1.0, hemi: 1.0, fogNearMul: 1.0, fogFarMul: 1.0 },
  overcast: { sky: 0xb8c0c8, fog: 0xc2c8cc, sun: 0.55, hemi: 0.85, fogNearMul: 0.8, fogFarMul: 0.7 },
  rain: { sky: 0x8fa0b0, fog: 0x9aa8b8, sun: 0.35, hemi: 0.7, fogNearMul: 0.65, fogFarMul: 0.55 },
  storm: { sky: 0x5a6a7a, fog: 0x6a7a8a, sun: 0.22, hemi: 0.55, fogNearMul: 0.5, fogFarMul: 0.4 },
  fog: { sky: 0xd8d8d0, fog: 0xdcdcd4, sun: 0.4, hemi: 0.8, fogNearMul: 0.3, fogFarMul: 0.35 },
};

const RAIN_DROPS = 700;
const RAIN_AREA = 70;
const RAIN_HEIGHT = 42;
const RAIN_FALL_SPEED = 26;
const RAIN_DRIFT = 4;

function phaseForHour(hour) {
  if (hour >= 5 && hour < 7) return WEATHER_PHASES.DAWN;
  if (hour >= 7 && hour < 17) return WEATHER_PHASES.DAY;
  if (hour >= 17 && hour < 19) return WEATHER_PHASES.DUSK;
  return WEATHER_PHASES.NIGHT;
}

function phaseBlend(hour) {
  // 0..1 across the dawn and dusk edges, so the light eases instead of
  // snapping. Inside day and night the blend is pinned at the ends.
  if (hour >= 5 && hour < 7) return (hour - 5) / 2;
  if (hour >= 17 && hour < 19) return 1 - (hour - 17) / 2;
  if (hour >= 7 && hour < 17) return 1;
  return 0;
}

function pickNextWeather(current, rng) {
  const table = WEATHER_TRANSITIONS[current] || WEATHER_TRANSITIONS.clear;
  let roll = rng();
  for (const key of Object.keys(table)) {
    roll -= table[key];
    if (roll <= 0) return key;
  }
  return WEATHER_STATES.CLEAR;
}

function holdSecondsFor(state, rng) {
  const range = WEATHER_HOLD[state] || WEATHER_HOLD.clear;
  return range.min + rng() * (range.max - range.min);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColorHex(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  ca.lerp(cb, t);
  return ca;
}

// Mix two hex colours by weight and return a THREE.Color. Allocated once
// per call is fine: this runs only while a transition is in flight.
function mixHex(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, t);
}

export function createWeatherSystem(deps = {}) {
  const scene = deps.scene || null;
  const world = deps.world || null;
  const rng = typeof deps.rng === 'function' ? deps.rng : Math.random;
  const onLightning = typeof deps.onLightning === 'function' ? deps.onLightning : null;
  const onWeatherChanged = typeof deps.onWeatherChanged === 'function'
    ? deps.onWeatherChanged
    : null;

  let hour = typeof deps.startHour === 'number' ? deps.startHour : 17;
  let minute = typeof deps.startMinute === 'number' ? deps.startMinute : 40;
  let phase = phaseForHour(hour);
  let weather = WEATHER_STATES.CLEAR;
  let weatherTimer = holdSecondsFor(weather, rng);
  let transition = 0; // 0 = settled, 1 = mid-change; counts down 1 -> 0
  let previousWeather = weather;
  let lightningTimer = 8 + rng() * 14;
  let lightningFlash = 0;
  let rainIntensity = 0;
  let totalSeconds = 0;

  // --- rain field -------------------------------------------------------
  // One Points cloud, drops recycled in place: a drop that falls below
  // the ground pops back to the top at a fresh random x/z, so the buffer
  // never reallocates and the rain follows the player around the city.
  let rainPoints = null;
  let rainPositions = null;
  let rainVelocities = null;
  if (scene) {
    try {
      rainPositions = new Float32Array(RAIN_DROPS * 3);
      rainVelocities = new Float32Array(RAIN_DROPS);
      for (let i = 0; i < RAIN_DROPS; i += 1) {
        rainPositions[i * 3] = (rng() - 0.5) * RAIN_AREA;
        rainPositions[i * 3 + 1] = rng() * RAIN_HEIGHT;
        rainPositions[i * 3 + 2] = (rng() - 0.5) * RAIN_AREA;
        rainVelocities[i] = RAIN_FALL_SPEED * (0.85 + rng() * 0.3);
      }
      const rainGeo = new THREE.BufferGeometry();
      rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
      const rainMat = new THREE.PointsMaterial({
        color: 0xaac4dd,
        size: 0.35,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      rainPoints = new THREE.Points(rainGeo, rainMat);
      rainPoints.visible = false;
      rainPoints.frustumCulled = false;
      rainPoints.name = 'RainField';
      scene.add(rainPoints);
    } catch {
      rainPoints = null;
      rainPositions = null;
      rainVelocities = null;
    }
  }

  function setWeather(next, instant = false) {
    if (!WEATHER_STATES[next.toUpperCase()] && !Object.values(WEATHER_STATES).includes(next)) {
      return false;
    }
    const target = Object.values(WEATHER_STATES).includes(next)
      ? next
      : WEATHER_STATES[next.toUpperCase()];
    if (target === weather) return true;
    previousWeather = weather;
    weather = target;
    weatherTimer = holdSecondsFor(weather, rng);
    transition = instant ? 0 : 1;
    if (onWeatherChanged) {
      try { onWeatherChanged(weather, previousWeather); } catch { /* cosmetic */ }
    }
    return true;
  }

  function rollWeather() {
    const next = pickNextWeather(weather, rng);
    setWeather(next, false);
  }

  function updateRain(dt, playerPos) {
    if (!rainPoints || !rainPositions) return;
    const target = (weather === WEATHER_STATES.RAIN || weather === WEATHER_STATES.STORM)
      ? (weather === WEATHER_STATES.STORM ? 1 : 0.75)
      : 0;
    // Ease the intensity toward the target so rain fades in and out
    // instead of popping.
    rainIntensity += (target - rainIntensity) * Math.min(1, dt * 0.8);
    rainPoints.visible = rainIntensity > 0.03;
    if (!rainPoints.visible) return;
    const px = playerPos ? playerPos.x : 0;
    const pz = playerPos ? playerPos.z : 0;
    rainPoints.position.set(px, 0, pz);
    rainPoints.material.opacity = 0.25 + rainIntensity * 0.35;
    const drift = weather === WEATHER_STATES.STORM ? RAIN_DRIFT * 2.2 : RAIN_DRIFT;
    for (let i = 0; i < RAIN_DROPS; i += 1) {
      let y = rainPositions[i * 3 + 1] - rainVelocities[i] * dt;
      if (y < 0) {
        y = RAIN_HEIGHT * (0.7 + rng() * 0.3);
        rainPositions[i * 3] = (rng() - 0.5) * RAIN_AREA;
        rainPositions[i * 3 + 2] = (rng() - 0.5) * RAIN_AREA;
      }
      rainPositions[i * 3 + 1] = y;
      rainPositions[i * 3] += drift * dt;
      if (rainPositions[i * 3] > RAIN_AREA / 2) rainPositions[i * 3] -= RAIN_AREA;
    }
    rainPoints.geometry.attributes.position.needsUpdate = true;
  }

  function updateLightning(dt) {
    if (weather !== WEATHER_STATES.STORM) {
      lightningFlash = 0;
      lightningTimer = 8 + rng() * 14;
      return;
    }
    lightningTimer -= dt;
    if (lightningTimer <= 0) {
      lightningFlash = 1;
      lightningTimer = 5 + rng() * 16;
      if (onLightning) {
        try { onLightning(); } catch { /* cosmetic */ }
      }
    }
    if (lightningFlash > 0) lightningFlash = Math.max(0, lightningFlash - dt * 7);
  }

  // Blend the phase light with the weather tint and push it into the
  // scene. The blend factor is the day blend (dawn/dusk easing) mixed
  // with the weather transition, so a storm rolling in at dusk darkens
  // the city smoothly instead of all at once.
  function applyLight() {
    if (!scene || !world || !world.lights) return;
    const dayBlend = phaseBlend(hour);
    const phaseKey = phase;
    const base = PHASE_LIGHT[phaseKey] || PHASE_LIGHT.day;
    const tint = WEATHER_TINT[weather] || WEATHER_TINT.clear;
    const prevTint = WEATHER_TINT[previousWeather] || WEATHER_TINT.clear;
    const mix = transition > 0 ? transition : 0;
    // The day/night edge blends night into dawn/day through the blend
    // factor; weather blends through the transition timer.
    const night = PHASE_LIGHT.night;
    const day = PHASE_LIGHT.day;
    const edgeSky = dayBlend < 0.5
      ? mixHex(night.sky, base.sky, dayBlend * 2)
      : mixHex(base.sky, day.sky, (dayBlend - 0.5) * 2);
    const edgeFog = dayBlend < 0.5
      ? mixHex(night.fog, base.fog, dayBlend * 2)
      : mixHex(base.fog, day.fog, (dayBlend - 0.5) * 2);
    const edgeSun = lerp(
      dayBlend < 0.5 ? night.sunIntensity : base.sunIntensity,
      dayBlend < 0.5 ? base.sunIntensity : day.sunIntensity,
      dayBlend < 0.5 ? dayBlend * 2 : (dayBlend - 0.5) * 2,
    );
    const edgeHemi = lerp(
      dayBlend < 0.5 ? night.hemiIntensity : base.hemiIntensity,
      dayBlend < 0.5 ? base.hemiIntensity : day.hemiIntensity,
      dayBlend < 0.5 ? dayBlend * 2 : (dayBlend - 0.5) * 2,
    );
    // Apply the weather tint by lerping each channel toward the tint
    // colour, weighted by the transition progress.
    const finalSky = new THREE.Color(edgeSky);
    const finalFog = new THREE.Color(edgeFog);
    if (mix > 0) {
      const tintSkyColor = new THREE.Color(tint.sky);
      const prevSkyColor = new THREE.Color(prevTint.sky);
      finalSky.copy(prevSkyColor).lerp(tintSkyColor, 1 - mix);
      finalSky.lerp(new THREE.Color(edgeSky), 0.35);
      const tintFogColor = new THREE.Color(tint.fog);
      const prevFogColor = new THREE.Color(prevTint.fog);
      finalFog.copy(prevFogColor).lerp(tintFogColor, 1 - mix);
      finalFog.lerp(new THREE.Color(edgeFog), 0.35);
    } else {
      finalSky.lerp(new THREE.Color(tint.sky), 0.3);
      finalFog.lerp(new THREE.Color(tint.fog), 0.3);
    }
    if (scene.background && scene.background.isColor) {
      scene.background.copy(finalSky);
      if (lightningFlash > 0) {
        scene.background.lerp(new THREE.Color(0xffffff), lightningFlash * 0.55);
      }
    }
    if (scene.fog && scene.fog.color) {
      scene.fog.color.copy(finalFog);
      const nearBase = lerp(base.fogNear, night.fogNear, 1 - dayBlend);
      const farBase = lerp(base.fogFar, night.fogFar, 1 - dayBlend);
      const nearMul = lerp(prevTint.fogNearMul, tint.fogNearMul, 1 - mix);
      const farMul = lerp(prevTint.fogFarMul, tint.fogFarMul, 1 - mix);
      scene.fog.near = nearBase * nearMul;
      scene.fog.far = farBase * farMul;
    }
    const lights = world.lights;
    if (lights.sun) {
      const sunBase = lerpColorHex(base.sun, night.sun, 1 - dayBlend);
      lights.sun.color.copy(sunBase);
      let intensity = edgeSun * lerp(prevTint.sun, tint.sun, 1 - mix);
      if (lightningFlash > 0) intensity += lightningFlash * 5;
      lights.sun.intensity = intensity;
    }
    if (lights.hemi) {
      lights.hemi.intensity = edgeHemi * lerp(prevTint.hemi, tint.hemi, 1 - mix);
      const hemiSky = mixHex(base.hemiSky, night.hemiSky, 1 - dayBlend);
      lights.hemi.color.copy(hemiSky);
      const hemiGround = mixHex(base.hemiGround, night.hemiGround, 1 - dayBlend);
      lights.hemi.groundColor.copy(hemiGround);
    }
  }

  function getTemperature() {
    // A bay town: warm by day, cooler at night, colder under rain.
    const dayWarmth = Math.sin(((hour - 6) / 24) * Math.PI * 2) * 6;
    let temp = 24 + dayWarmth;
    if (weather === WEATHER_STATES.RAIN) temp -= 4;
    if (weather === WEATHER_STATES.STORM) temp -= 6;
    if (weather === WEATHER_STATES.FOG) temp -= 2;
    if (weather === WEATHER_STATES.OVERCAST) temp -= 2;
    return Math.round(temp);
  }

  function update(dt, ctx = {}) {
    const step = Math.max(0, dt || 0);
    totalSeconds += step;
    if (typeof ctx.hour === 'number') hour = ctx.hour;
    if (typeof ctx.minute === 'number') minute = ctx.minute;
    const nextPhase = phaseForHour(hour);
    if (nextPhase !== phase) phase = nextPhase;
    weatherTimer -= step;
    if (weatherTimer <= 0) rollWeather();
    if (transition > 0) transition = Math.max(0, transition - step / 6);
    updateLightning(step);
    updateRain(step, ctx.playerPos || null);
    applyLight();
  }

  function getState() {
    return {
      phase,
      weather,
      weatherName: WEATHER_LABELS[weather] || weather,
      phaseName: phase,
      hour,
      minute,
      grip: WEATHER_GRIP[weather] || 1,
      temperature: getTemperature(),
      raining: weather === WEATHER_STATES.RAIN || weather === WEATHER_STATES.STORM,
      night: phase === WEATHER_PHASES.NIGHT,
      rainIntensity,
      lightning: lightningFlash,
    };
  }

  return {
    update,
    setWeather,
    getPhase: () => phase,
    getPhaseName: () => phase,
    getWeather: () => weather,
    getWeatherName: () => WEATHER_LABELS[weather] || weather,
    getGripFactor: () => WEATHER_GRIP[weather] || 1,
    getTemperature,
    isNight: () => phase === WEATHER_PHASES.NIGHT,
    isRaining: () => weather === WEATHER_STATES.RAIN || weather === WEATHER_STATES.STORM,
    getState,
    get rainIntensity() { return rainIntensity; },
    get lightningFlash() { return lightningFlash; },
    dispose() {
      if (rainPoints && scene) {
        try {
          scene.remove(rainPoints);
          rainPoints.geometry.dispose();
          rainPoints.material.dispose();
        } catch { /* teardown only */ }
      }
    },
  };
}

export default createWeatherSystem;
