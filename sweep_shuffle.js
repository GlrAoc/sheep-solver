// Offline shuffle sweep.
//
// The client's shuffle (chessboard.updateBlockArea -> mapShuffle) permutes the TYPE of every
// remaining block and leaves the layout untouched. So a shuffle is exactly "keep (layer,row,rol),
// reassign the multiset of types at random".
//
// That means we can search over shuffles offline: generate N layouts with the same geometry and
// the same per-type counts, then ask the solver whether any of them is winnable inside the real
// hand cap. A high enough hit rate turns "shuffle and retry" into a bounded, predictable loop
// instead of a gamble.
//
// usage: node sweep_shuffle.js <board.json> <variants> <secPerVariant> [HAND_MAX] [PARK_MAX] [jobParallel]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;
const NODE = process.execPath;

const boardFile = process.argv[2];
const VARIANTS = parseInt(process.argv[3] || '60', 10);
const SEC = process.argv[4] || '8';
const HMAX = process.argv[5] || '7';
const PMAX = process.argv[6] || '0';
const JOBS = parseInt(process.argv[7] || String(Math.max(2, os.cpus().length - 2)), 10);

if (!boardFile) {
  console.error('usage: node sweep_shuffle.js <board.json> [variants] [sec] [handMax] [parkMax] [jobs]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
const base = Array.isArray(raw) ? raw : raw.blocks;
if (!base.length) { console.error('no blocks in ' + boardFile); process.exit(1); }

// 1) every variant must keep the exact type multiset: the client only permutes, never invents
const types = base.map((b) => b.type);
const counts = new Map();
types.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
const bad = [...counts.entries()].filter(([, v]) => v % 3);
if (bad.length) {
  console.error('type counts are not multiples of 3: ' + JSON.stringify(bad));
  process.exit(1);
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeVariant(seed) {
  const rnd = mulberry(seed);
  const arr = types.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  const blocks = base.map((b, i) => ({
    id: b.id, layerNum: b.layerNum, rowNum: b.rowNum, rolNum: b.rolNum, type: arr[i]
  }));
  const f = path.join(DIR, `.shuf_${seed}.board.json`);
  fs.writeFileSync(f, JSON.stringify({ blocks }));
  return f;
}

function runOne(vf, seed) {
  return new Promise((resolve) => {
    const out = path.join(DIR, `.shuf_${seed}.plan.json`);
    try { fs.unlinkSync(out); } catch (e) {}
    const t0 = Date.now();
    const p = spawn(NODE, ['dfs_park.js', vf, SEC, '20000000000', String(seed)], {
      cwd: DIR,
      env: Object.assign({}, process.env, {
        HAND_MAX: HMAX, PARK_MAX: PMAX, MEMO_BITS: '25', PLAN_OUT: out, QUIET: '1'
      })
    });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', () => {});
    p.on('close', () => {
      const ok = fs.existsSync(out);
      let steps = 0, park = 0;
      if (ok) {
        try {
          const plan = JSON.parse(fs.readFileSync(out, 'utf8'));
          steps = plan.length;
          park = plan.filter((s) => s.kind === 'park').length;
        } catch (e) {}
      }
      const m = /bestLeft=(\d+)/.exec(buf);
      resolve({ seed, ok, steps, park, bestLeft: m ? +m[1] : null, ms: Date.now() - t0 });
    });
  });
}

(async function main() {
  console.log(`sweep: ${boardFile} blocks=${base.length} types=${counts.size} ` +
    `variants=${VARIANTS} budget=${SEC}s hand=${HMAX} park=${PMAX} jobs=${JOBS}`);

  const seeds = [];
  for (let i = 0; i < VARIANTS; i++) seeds.push(1000 + i * 37);

  const files = seeds.map((s) => makeVariant(s));

  let next = 0, done = 0, wins = 0;
  const results = [];

  await new Promise((resolveAll) => {
    let running = 0;
    function pump() {
      while (running < JOBS && next < files.length) {
        const idx = next++;
        running++;
        runOne(files[idx], seeds[idx]).then((r) => {
          running--; done++;
          results.push(r);
          if (r.ok) {
            wins++;
            console.log(`[WIN ] seed=${r.seed} steps=${r.steps} park=${r.park} ` +
              `${(r.ms / 1000).toFixed(1)}s  (${wins}/${done})`);
          } else if (done % 10 === 0) {
            console.log(`[    ] ${done}/${files.length} done, wins=${wins}, best=${r.bestLeft}`);
          }
          pump();
        });
      }
      if (running === 0 && next >= files.length) resolveAll();
    }
    pump();
  });

  console.log(`\nRESULT: ${wins}/${files.length} variants winnable ` +
    `(${((wins / files.length) * 100).toFixed(1)}%) with hand=${HMAX} park=${PMAX}`);

  const best = results.filter((r) => !r.ok && r.bestLeft !== null)
    .sort((a, b) => a.bestLeft - b.bestLeft).slice(0, 5);
  if (best.length) {
    console.log('closest misses (fewest blocks left): ' +
      best.map((r) => `seed=${r.seed}:${r.bestLeft}`).join(', '));
  }

  // keep the winning layouts, drop the rest: they are only useful if we need to replay one
  results.forEach((r) => {
    const vf = path.join(DIR, `.shuf_${r.seed}.board.json`);
    if (!r.ok) { try { fs.unlinkSync(vf); } catch (e) {} }
  });
  fs.writeFileSync(path.join(DIR, '.shuf_results.json'), JSON.stringify(results, null, 1));
  process.exit(0);
})();
