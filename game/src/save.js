// save.js — Solmar Bay's save file: cash, missions, best runs, rebuilt.
//
// Everything the game remembers between sessions lives in one small JSON
// blob in localStorage: a version, the cash balance, finished mission ids,
// lifetime stats, the best run so far and a settings block. main.js and
// missions.js only ever touch the exported helpers below.
//
// Safety is the whole point. A save that was hand-edited, truncated or
// half-written must never crash the game, so every value is cleaned on
// the way in and anything bad quietly becomes a default. Every storage
// call is wrapped too: a missing or hostile localStorage (private mode,
// storage off, a non-browser runtime) just makes the functions fall back
// to an in-memory save.
//
// New this round: every write rotates three backup slots first, so a
// half-written save never strands a story — loading falls back to the
// newest readable backup when the main slot is corrupt. The stats also
// count sunset photos now, alongside stunts and pickups.

// The key is a contract with every save already out there — never rename
// it, or old saves strand.
export const SAVE_KEY = 'solmar-bay.save.v1';
export const SAVE_VERSION = 1;

// Three backup slots, newest first. A write shifts the old slots down
// and stores the previous main save in slot one.
const BACKUP_COUNT = 3;
const BACKUP_KEY = (slot) => `${SAVE_KEY}.bak${slot}`;

// Ceilings so a runaway number can't break the HUD or bloat the file.
const CASH_CAP = 999999999;
const LIFETIME_CAP = 99999999;
const STAT_CAP = 99999999;
const BEST_MISSIONS_CAP = 100;

// -------------------------------------------------------------- storage
function storage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isStorageAvailable() {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem('__solmar-bay-probe__', '1');
    store.removeItem('__solmar-bay-probe__');
    return true;
  } catch {
    return false;
  }
}

function fetchText(key) {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function storeText(key, text) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

function clearText(key) {
  const store = storage();
  if (!store) return false;
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// Shift the backups down one slot and store the current main save as the
// newest backup. Best-effort: a failed rotation never blocks the write.
function rotateBackups() {
  const store = storage();
  if (!store) return;
  try {
    const current = store.getItem(SAVE_KEY);
    if (current === null || current === '') return;
    for (let slot = BACKUP_COUNT; slot > 1; slot -= 1) {
      const older = store.getItem(BACKUP_KEY(slot - 1));
      if (older !== null) store.setItem(BACKUP_KEY(slot), older);
      else store.removeItem(BACKUP_KEY(slot));
    }
    store.setItem(BACKUP_KEY(1), current);
  } catch {
    // Backups are a safety net, not a requirement.
  }
}

// ------------------------------------------------------------ value guards
// Each one turns "anything at all" into one safe value of the right kind.
function toNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toClampedInt(value, fallback, low, high) {
  const n = Math.floor(toNumber(value, fallback));
  if (n < low) return low;
  if (n > high) return high;
  return n;
}

function toText(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function toIdArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const kept = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && !seen.has(entry)) {
      seen.add(entry);
      kept.push(entry);
    }
  }
  return kept;
}

function toObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

// --------------------------------------------------------------- defaults
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
      photosTaken: 0,
      timesBusted: 0,
      timesWasted: 0,
    },
    settings: { muted: false },
    createdAt: now,
    updatedAt: now,
  };
}

// -------------------------------------------------------------- sanitising
// Rebuild a save from a fresh default, keeping only values that check out.
// An old file upgrades silently to the current version; a bogus one comes
// back as a fresh save with whatever else survived.
export function sanitizeSave(raw) {
  const clean = createDefaultSave();
  const input = toObject(raw);

  clean.version = SAVE_VERSION;
  clean.cash = toClampedInt(input.cash, 0, 0, CASH_CAP);
  clean.missionsCompleted = toIdArray(input.missionsCompleted);

  const bestIn = toObject(input.best);
  clean.best.cash = toClampedInt(bestIn.cash, 0, 0, CASH_CAP);
  clean.best.missionsCompleted = toClampedInt(bestIn.missionsCompleted, 0, 0, BEST_MISSIONS_CAP);
  clean.best.playSeconds = toClampedInt(bestIn.playSeconds, 0, 0, STAT_CAP);

  const statsIn = toObject(input.stats);
  for (const key of Object.keys(clean.stats)) {
    clean.stats[key] = toClampedInt(statsIn[key], 0, 0, STAT_CAP);
  }
  clean.stats.cashEarned = toClampedInt(statsIn.cashEarned, 0, 0, LIFETIME_CAP);

  const settingsIn = toObject(input.settings);
  clean.settings.muted = settingsIn.muted === true;

  clean.createdAt = toText(input.createdAt, clean.createdAt);
  clean.updatedAt = toText(input.updatedAt, clean.updatedAt);
  return clean;
}

// Try to parse one stored slot into a save; null when the slot is empty
// or does not parse.
function parseSlot(key) {
  const text = fetchText(key);
  if (text === null || text === '') return null;
  try {
    return sanitizeSave(JSON.parse(text));
  } catch {
    return null;
  }
}

// ----------------------------------------------------- load / save / update
export function loadSave() {
  // The main slot first; a corrupt main save falls back to the newest
  // readable backup, so a half-written write never strands a story.
  const main = parseSlot(SAVE_KEY);
  if (main) return main;
  for (let slot = 1; slot <= BACKUP_COUNT; slot += 1) {
    const backup = parseSlot(BACKUP_KEY(slot));
    if (backup) return backup;
  }
  return createDefaultSave();
}

// Write a save object to storage. It is sanitised first, so callers may
// hand in a half-built save. True when the write landed, false when the
// storage is unavailable or full.
export function saveSave(saveData) {
  const clean = sanitizeSave(saveData);
  clean.updatedAt = new Date().toISOString();
  rotateBackups();
  return storeText(SAVE_KEY, JSON.stringify(clean));
}

// Load, let `patch` change the save in place, then write it back. Returns
// the updated save. When storage is unavailable the patch still runs on
// the in-memory copy and the result is returned.
export function updateSave(patch) {
  const current = loadSave();
  if (typeof patch === 'function') patch(current);
  saveSave(current);
  return current;
}

// True when storage holds a save that parses into a real shape. A stray
// JSON object under the key does not count: a genuine save always carries
// a cash number or a missions list.
export function hasSave() {
  const text = fetchText(SAVE_KEY);
  if (text === null || text === '') return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return typeof parsed.cash === 'number' || Array.isArray(parsed.missionsCompleted);
  } catch {
    return false;
  }
}

// Wipe the stored save and its backups, and hand back a fresh default.
// The game reloads right after calling this.
export function resetSave() {
  clearText(SAVE_KEY);
  for (let slot = 1; slot <= BACKUP_COUNT; slot += 1) clearText(BACKUP_KEY(slot));
  return createDefaultSave();
}

// ---------------------------------------------------------- run statistics
// Fold one run's numbers into the lifetime totals and refresh the best-run
// records. Only positive gains count. The returned save is not written to
// storage by itself.
export function recordBestRun(saveData, runStats) {
  const save = sanitizeSave(saveData);
  const run = toObject(runStats);
  for (const key of Object.keys(save.stats)) {
    const gain = toNumber(run[key], 0);
    if (gain > 0) {
      save.stats[key] = toClampedInt(save.stats[key] + gain, save.stats[key], 0, STAT_CAP);
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

// Add cash to a save object and count it toward lifetime earnings. Only
// positive amounts count, and they are floored. Returns the updated save;
// does not write to storage by itself.
export function addCashToSave(saveData, amount) {
  const save = sanitizeSave(saveData);
  const gain = toNumber(amount, 0) > 0 ? Math.floor(amount) : 0;
  save.cash = toClampedInt(save.cash + gain, save.cash, 0, CASH_CAP);
  save.stats.cashEarned = toClampedInt(
    save.stats.cashEarned + gain, save.stats.cashEarned, 0, LIFETIME_CAP,
  );
  return save;
}

// ------------------------------------------------------------ manual backup
export function exportSaveJSON() {
  return JSON.stringify(loadSave());
}

// Parse pasted backup text, store it when it is a valid save, and return
// the stored save — or null when the text is not a save at all.
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

// Which backup slots hold a save that still parses, newest first. A
// future restore menu can offer these; today it is a health check for the
// rotation: a slot that never parses is a slot the rotation never filled.
export function listBackups() {
  const found = [];
  for (let slot = 1; slot <= BACKUP_COUNT; slot += 1) {
    if (parseSlot(BACKUP_KEY(slot))) found.push(slot);
  }
  return found;
}
