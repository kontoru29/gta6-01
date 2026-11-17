// save.js — Solmar Bay save file: cash, mission progress and best runs,
// persisted in the browser's localStorage.
//
// The save file is the one place the game remembers anything between
// sessions. Its shape is deliberately small and boring: a version number,
// the cash balance, the list of finished mission ids, lifetime stats, the
// best run so far, and a settings block. Every function that touches the
// file goes through sanitizeSave(), so a hand-edited, truncated or
// half-written save can never crash the game — bad values are replaced
// with defaults and the game carries on.
//
// Nothing in here knows about missions, the police or the HUD. main.js and
// missions.js only use the exported helpers: loadSave(), saveSave(),
// updateSave(), addCashToSave(), hasSave(), resetSave() and
// createDefaultSave(). The JSON export/import pair is for a manual backup:
// a player can copy their save out as text and paste it back later.

// The storage key and the format version. The key is part of the contract
// with every save already out there: never rename it, or old saves strand.
export const SAVE_KEY = 'solmar-bay.save.v1';
export const SAVE_VERSION = 1;

// Caps that keep a runaway number from breaking the HUD or the save file.
const MAX_CASH = 999999999;
const MAX_LIFETIME_CASH = 99999999;
const MAX_STAT = 99999999;

// ---------------------------------------------------------------------------
// Storage access, wrapped so a missing or hostile localStorage never throws.
// ---------------------------------------------------------------------------

// The real localStorage, or null when the browser will not give us one
// (private mode, disabled storage, or a non-browser runtime).
function storageHandle() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isStorageAvailable() {
  const store = storageHandle();
  if (!store) return false;
  try {
    store.setItem('__solmar-bay-probe__', '1');
    store.removeItem('__solmar-bay-probe__');
    return true;
  } catch {
    return false;
  }
}

function readStoredText() {
  const store = storageHandle();
  if (!store) return null;
  try {
    return store.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

function writeStoredText(text) {
  const store = storageHandle();
  if (!store) return false;
  try {
    store.setItem(SAVE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

function clearStoredText() {
  const store = storageHandle();
  if (!store) return false;
  try {
    store.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Value cleaning: each helper turns "anything" into one safe value.
// ---------------------------------------------------------------------------

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function wholeOr(value, fallback, low, high) {
  const floored = Math.floor(finiteOr(value, fallback));
  if (floored < low) return low;
  if (floored > high) return high;
  return floored;
}

function textOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stringArrayOr(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

function objectOr(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------------------
// The default save: what a brand-new player starts with.
// ---------------------------------------------------------------------------

export function createDefaultSave() {
  const now = new Date().toISOString();
  return {
    version: SAVE_VERSION,
    cash: 0,
    missionsCompleted: [],
    best: { cash: 0, missionsCompleted: 0, playSeconds: 0 },
    stats: {
      playSeconds: 0,
      cashEarned: 0,
      carsStolen: 0,
      stunts: 0,
      pickups: 0,
      timesBusted: 0,
      timesWasted: 0,
    },
    settings: { muted: false },
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Sanitising: rebuild a save from a default, keeping only valid values.
// ---------------------------------------------------------------------------

export function sanitizeSave(raw) {
  const clean = createDefaultSave();
  const input = objectOr(raw);

  // The version is always ours: an old file upgrades silently, a bogus
  // one is treated as a fresh save with whatever else survived.
  clean.version = SAVE_VERSION;

  clean.cash = wholeOr(input.cash, 0, 0, MAX_CASH);
  clean.missionsCompleted = stringArrayOr(input.missionsCompleted);

  const bestIn = objectOr(input.best);
  clean.best.cash = wholeOr(bestIn.cash, 0, 0, MAX_CASH);
  clean.best.missionsCompleted = wholeOr(bestIn.missionsCompleted, 0, 0, 100);
  clean.best.playSeconds = wholeOr(bestIn.playSeconds, 0, 0, MAX_STAT);

  const statsIn = objectOr(input.stats);
  for (const key of Object.keys(clean.stats)) {
    clean.stats[key] = wholeOr(statsIn[key], 0, 0, MAX_STAT);
  }
  clean.stats.cashEarned = wholeOr(statsIn.cashEarned, 0, 0, MAX_LIFETIME_CASH);

  const settingsIn = objectOr(input.settings);
  clean.settings.muted = settingsIn.muted === true;

  clean.createdAt = textOr(input.createdAt, clean.createdAt);
  clean.updatedAt = textOr(input.updatedAt, clean.updatedAt);
  return clean;
}

// ---------------------------------------------------------------------------
// Load / save / update: the three calls the game actually makes.
// ---------------------------------------------------------------------------

export function loadSave() {
  const text = readStoredText();
  if (text === null || text === '') return createDefaultSave();
  try {
    return sanitizeSave(JSON.parse(text));
  } catch {
    return createDefaultSave();
  }
}

// Write a save object to localStorage. The object is sanitised first, so
// callers can pass a partially built save. Returns true when the write
// landed, false when storage is unavailable or full.
export function saveSave(saveData) {
  const clean = sanitizeSave(saveData);
  clean.updatedAt = new Date().toISOString();
  return writeStoredText(JSON.stringify(clean));
}

// Load, let `patch` mutate the save in place, then write it back. Returns
// the updated save object. When storage is unavailable the patch still
// runs on the in-memory copy and the result is returned.
export function updateSave(patch) {
  const current = loadSave();
  if (typeof patch === 'function') patch(current);
  saveSave(current);
  return current;
}

// True when localStorage holds a save that parses into a valid shape.
// A stray JSON object under the key does not count: a real save always
// carries a cash number or a missions list.
export function hasSave() {
  const text = readStoredText();
  if (text === null || text === '') return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return typeof parsed.cash === 'number' || Array.isArray(parsed.missionsCompleted);
  } catch {
    return false;
  }
}

// Wipe the stored save and hand back a fresh default (the game reloads
// right after calling this).
export function resetSave() {
  clearStoredText();
  return createDefaultSave();
}

// ---------------------------------------------------------------------------
// Stats helpers: fold one run's numbers into the lifetime save.
// ---------------------------------------------------------------------------

// Add one run's stats to the lifetime totals and refresh the best-run
// records. The returned save is not written to storage by itself.
export function recordBestRun(saveData, runStats) {
  const save = sanitizeSave(saveData);
  const run = objectOr(runStats);
  for (const key of Object.keys(save.stats)) {
    const gain = finiteOr(run[key], 0);
    if (gain > 0) {
      save.stats[key] = wholeOr(save.stats[key] + gain, save.stats[key], 0, MAX_STAT);
    }
  }
  save.best.cash = Math.max(save.best.cash, save.cash);
  save.best.missionsCompleted = Math.max(
    save.best.missionsCompleted,
    save.missionsCompleted.length,
  );
  save.best.playSeconds = Math.max(save.best.playSeconds, save.stats.playSeconds);
  return save;
}

// Add cash to a save object and count it toward lifetime earnings.
// Returns the updated save. Does not write to storage by itself.
export function addCashToSave(saveData, amount) {
  const save = sanitizeSave(saveData);
  const gain = finiteOr(amount, 0) > 0 ? Math.floor(amount) : 0;
  save.cash = wholeOr(save.cash + gain, save.cash, 0, MAX_CASH);
  save.stats.cashEarned = wholeOr(
    save.stats.cashEarned + gain, save.stats.cashEarned, 0, MAX_LIFETIME_CASH,
  );
  return save;
}

// ---------------------------------------------------------------------------
// Manual backup: the whole save as text, and back again.
// ---------------------------------------------------------------------------

export function exportSaveJSON() {
  return JSON.stringify(loadSave());
}

// Parse pasted backup text, store it if it is a valid save, and return the
// stored save — or null when the text is not a save at all.
export function importSaveJSON(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    const restored = sanitizeSave(parsed);
    saveSave(restored);
    return restored;
  } catch {
    return null;
  }
}
