// Solmar Bay — save game persistence (save.js)
//
// This module is the only place that touches localStorage. It stores the
// player's cash, which story missions are finished, best-ever statistics and
// a few settings, and it can wipe everything back to a fresh start. It knows
// nothing about the city, the player, the police or the missions: it only
// loads, validates, writes and resets one plain save object, so any other
// module can use it without pulling game logic in.
//
// Public interface (all functions are pure save/load helpers):
//   loadSave()            -> the saved object, or a fresh default when none
//                            exists / the stored data is damaged
//   saveSave(saveData)    -> writes a save object, returns true on success
//   updateSave(patch)     -> loads, applies patch(current) in place, saves,
//                            returns the updated save object
//   hasSave()             -> true when a readable save exists in localStorage
//   isStorageAvailable()  -> true when localStorage can actually be used
//   resetSave()           -> deletes the save and returns a fresh default
//   createDefaultSave()   -> a brand-new save object (also the shape contract)
//   recordBestRun(saveData, runStats) -> folds one session into best stats
//   exportSaveJSON() / importSaveJSON(text) -> backup / restore as text
//
// Save shape (version 1):
//   {
//     version: 1,
//     cash: number,                       // spendable cash in dollars
//     missionsCompleted: string[],        // mission ids, in completion order
//     best: { cash, missionsCompleted, playSeconds },
//     stats: { playSeconds, cashEarned, carsStolen, stunts, pickups,
//              timesBusted, timesWasted },
//     settings: { muted: boolean },
//     createdAt: string, updatedAt: string // ISO dates
//   }
//
// Notes for the integrator (main.js): call loadSave() once at boot, keep the
// returned object as the session's save, and call saveSave() (or updateSave())
// after missions, pickups and arrests. Best stats are updated with
// recordBestRun() when a session ends or a mission is completed.

export const SAVE_KEY = 'solmar-bay.save.v1';
export const SAVE_VERSION = 1;

/**
 * True when localStorage exists and can be written to. Browsers in private
 * mode (and non-browser runtimes such as Node) report false, and every
 * function below then falls back to in-memory defaults instead of throwing.
 */
export function isStorageAvailable() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const probe = '__solmar-bay-probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** A fresh save object. This is also the shape every other module may rely on. */
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

/** True for finite numbers only; anything else is treated as missing data. */
function isGoodNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Clamps a number into a sane range so a damaged save can never break the HUD. */
function clampNumber(value, fallback, min, max) {
  if (!isGoodNumber(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function cleanStringList(value) {
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

/**
 * Merges a raw parsed object onto the default shape, dropping unknown or
 * mistyped fields. A save from an older version is upgraded in place; a
 * missing or corrupt value falls back to its default instead of throwing.
 */
export function sanitizeSave(raw) {
  const clean = createDefaultSave();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return clean;

  clean.cash = clampNumber(raw.cash, 0, 0, 999999999);
  clean.missionsCompleted = cleanStringList(raw.missionsCompleted);

  if (raw.best !== null && typeof raw.best === 'object' && !Array.isArray(raw.best)) {
    clean.best.cash = clampNumber(raw.best.cash, 0, 0, 999999999);
    clean.best.missionsCompleted = clampNumber(raw.best.missionsCompleted, 0, 0, 100);
    clean.best.playSeconds = clampNumber(raw.best.playSeconds, 0, 0, 99999999);
  }
  if (raw.stats !== null && typeof raw.stats === 'object' && !Array.isArray(raw.stats)) {
    for (const key of Object.keys(clean.stats)) {
      clean.stats[key] = clampNumber(raw.stats[key], 0, 0, 99999999);
    }
  }
  if (raw.settings !== null && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
    clean.settings.muted = raw.settings.muted === true;
  }
  if (typeof raw.createdAt === 'string' && raw.createdAt.length > 0) {
    clean.createdAt = raw.createdAt;
  }
  // Any stored version number is accepted and then normalised to current:
  // the shape has not changed between versions, so no field migration is
  // needed beyond the sanitising above.
  clean.version = SAVE_VERSION;
  return clean;
}

/** Reads the raw stored text without parsing, for debugging or backup. */
function readStoredText() {
  if (!isStorageAvailable()) return null;
  try {
    return window.localStorage.getItem(SAVE_KEY);
  } catch {
    // localStorage can throw in private mode or when storage is disabled.
    return null;
  }
}

/**
 * Loads the save. Returns a fresh default when nothing is stored, the JSON
 * is broken, or storage is unavailable — never throws.
 */
export function loadSave() {
  const text = readStoredText();
  if (text === null || text === '') return createDefaultSave();
  try {
    return sanitizeSave(JSON.parse(text));
  } catch {
    return createDefaultSave();
  }
}

/**
 * Writes a save object to localStorage. The object is sanitised first, so
 * callers can pass a partially built save. Returns true when the write
 * landed, false when storage is unavailable or full.
 */
export function saveSave(saveData) {
  const clean = sanitizeSave(saveData);
  clean.updatedAt = new Date().toISOString();
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the current save, lets `patch` mutate it in place, then writes it
 * back. Returns the updated save object. When storage is unavailable the
 * patch still runs on the in-memory copy and the result is returned.
 */
export function updateSave(patch) {
  const current = loadSave();
  if (typeof patch === 'function') patch(current);
  saveSave(current);
  return current;
}

/** True when localStorage holds a save that parses into a valid shape. */
export function hasSave() {
  const text = readStoredText();
  if (text === null || text === '') return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Deletes the stored save and returns a fresh default object. The caller
 * should also reset its live game state (cash, mission progress) to match.
 */
export function resetSave() {
  if (isStorageAvailable()) {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch {
      // Removing a missing or blocked key is not an error for the player.
    }
  }
  return createDefaultSave();
}

/**
 * Folds one finished session into the save's best-ever statistics. `runStats`
 * is a partial stats object (same keys as save.stats); only the fields it
 * carries are counted. Returns the updated save object (not yet written —
 * call saveSave() afterwards, or use updateSave() around this).
 */
export function recordBestRun(saveData, runStats) {
  const save = sanitizeSave(saveData);
  const run = runStats !== null && typeof runStats === 'object' ? runStats : {};
  for (const key of Object.keys(save.stats)) {
    if (isGoodNumber(run[key])) save.stats[key] += Math.max(0, run[key]);
  }
  save.best.cash = Math.max(save.best.cash, save.cash);
  save.best.missionsCompleted = Math.max(
    save.best.missionsCompleted,
    save.missionsCompleted.length,
  );
  save.best.playSeconds = Math.max(save.best.playSeconds, save.stats.playSeconds);
  return save;
}

/**
 * Adds cash to a save object and records it in the lifetime earnings stat.
 * Returns the new cash total. Does not write to storage by itself.
 */
export function addCashToSave(saveData, amount) {
  const save = sanitizeSave(saveData);
  const gain = isGoodNumber(amount) ? Math.max(0, Math.floor(amount)) : 0;
  save.cash = clampNumber(save.cash + gain, 0, 0, 999999999);
  save.stats.cashEarned = clampNumber(save.stats.cashEarned + gain, 0, 0, 99999999);
  return save;
}

/** Serialises the current save as text, for a manual backup. */
export function exportSaveJSON() {
  return JSON.stringify(loadSave());
}

/**
 * Restores a save from text produced by exportSaveJSON(). Returns the
 * restored save object on success, or null when the text is not a save.
 */
export function importSaveJSON(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const restored = sanitizeSave(JSON.parse(text));
    saveSave(restored);
    return restored;
  } catch {
    return null;
  }
}
