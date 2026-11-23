// main.ts — Solmar Bay's entrypoint for make.fun's "Make GTA 6" bounty.
//
// The game is plain static files a desktop browser loads offline: the
// game/ folder beside this file (game/index.html and its ES modules, with
// three.js vendored under game/vendor/), no network requests anywhere.
// This program's only job is handing that folder in. It copies game/ and
// screenshots/ into /output and writes /output/dossier.json, the summary
// the judge reads, using the vendored make.fun library. Node 22, standard
// library only, nothing to install.
//
// The game itself: Leo Marlow, a driver-for-hire in the fictional coastal
// city of Marisol Bay at golden hour. Drive and steal cars, dodge a 0-5
// star wanted level and the patrols it brings, fight on foot with fists,
// a pistol, a shotgun, an SMG, a rifle or a bat, and work ten story
// missions for the Marisol crew — First Fare, The Pickup, Hot Wheels,
// Heat Wave, Midnight Run, The Getaway, The Big Score, Night Shift at the
// Docks, Storm Run and The Broker — with a HUD, a round minimap, a sprint
// stamina bar, synthesised sound, a start screen and a localStorage save
// that now keeps three backup slots. Round 8 adds a full day and night
// cycle with clear, overcast, rain, storm and fog weather that changes
// the light and the grip, the North Docks container port with cranes and
// yard hands, a garage that paints and tunes Leo's cars, taxi fares and
// courier runs, three street races, ten hidden packages and an alley
// arsenal. Four deterministic screenshots live in screenshots/ (the
// first by name is the cover), staged with ?shot=<name>: cover, drive,
// chase and mission, each showing several systems at once.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for
// /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';
import { GAME_TITLE, GAME_VERSION } from './game/src/config.js';

// The directory this file lives in, and where the entry goes.
const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Count the files under a directory, recursively, for the summary line.
function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else total += 1;
  }
  return total;
}

mkdirSync(outDir, { recursive: true });
cpSync(join(here, 'game'), join(outDir, 'game'), { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
} else {
  console.warn('warning: no screenshots/ folder beside main.ts, the dossier ships without shots');
}

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes
// the bytes; the rest refuse an entry the scorer would refuse — more than
// 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48
// MiB of game files in all, or a path under game/ over 1000 bytes. game/
// counts beside /output's own 1000-entry cap, its screenshots/ and its
// dossier.json.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

const gameFiles = countFiles(join(outDir, 'game'));
const shotFiles = countFiles(join(outDir, 'screenshots'));
console.log(`${GAME_TITLE} ${GAME_VERSION} handed in: ${gameFiles} game files, ${shotFiles} screenshots -> ${outDir}`);
