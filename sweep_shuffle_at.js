// Sweep "shuffle at step K": replay the deepest legal prefix up to K, permute the remaining
// types, then search with the real hand cap. This is the actual in-game loop we would run --
// play as far as the client allows, shuffle at the pinch, keep going -- modelled offline so we
// can measure whether it ever wins before touching the phone.
//
// usage: node sweep_shuffle_at.js <board> <prefixPlan> <K,...> <shuffleSeeds> <sec> [handMax] [parkMax]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;
const NODE = process.execPath;

const board = process.argv[2];
const prefix = process.argv[3];
const KS = (process.argv[4] || '120').split(',').map(Number);
const SEEDS = parseInt(process.argv[5] || '6', 10);
const SEC = process.argv[6] || '15';
const HMAX = process.argv[7] || '7';
const PMAX = process.argv[8] || '1';

const JOBS = Math.max(2, os.cpus().length - 2);

const tasks = [];
for (const k of KS) {
  for (let i = 0; i < SEEDS; i++) {
    tasks.push({ k, seed: 7000 + i * 131 });
  }
}

function runOne(t) {
  return new Promise((resolve) => {
    const out = path.join(DIR, `.sa_${t.k}_${t.seed}.plan.json`);
    try { fs.unlinkSync(out); } catch (e) {}
    const t0 = Date.now();
    const env = Object.assign({}, process.env, {
      SHUFFLE_AT: '1',
      SHUFFLE_SEED: String(t.seed),
      HAND_MAX: HMAX,
      PARK_MAX: PMAX,
      MEMO_BITS: '25',
      PLAN_OUT: out
    });
    // K=0 means "shuffle at the very start"; PREFIX_MAX=0 would be read as "no limit" and
    // silently replay the whole prefix, so only pass a prefix when K>0.
    if (t.k > 0) { env.PREFIX = prefix; env.PREFIX_MAX = String(t.k); }
    const p = spawn(NODE, ['dfs_park.js', board, SEC, '4000000000', String(t.seed)], {
      cwd: DIR,
      env
    });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
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
      const ms = /bestLeft=(\d+)/.exec(buf);
      const hs = /\[shuffle\] at step (\d+).*left=(\d+)/.exec(err);
      resolve({
        k: t.k, seed: t.seed, ok, steps, park,
        bestLeft: ms ? +ms[1] : null,
        atStep: hs ? +hs[1] : null, leftAtShuffle: hs ? +hs[2] : null,
        ms: Date.now() - t0
      });
    });
  });
}

(async function main() {
  console.log(`shuffle-at sweep: board=${board} K=${KS.join(',')} seeds=${SEEDS} ` +
    `budget=${SEC}s hand=${HMAX} park=${PMAX}`);
  let next = 0, done = 0, wins = 0;
  const results = [];

  await new Promise((resolveAll) => {
    let running = 0;
    function pump() {
      while (running < JOBS && next < tasks.length) {
        const t = tasks[next++];
        running++;
        runOne(t).then((r) => {
          running--; done++;
          results.push(r);
          if (r.ok) {
            wins++;
            console.log(`[WIN] K=${r.k} seed=${r.seed} steps=${r.steps} park=${r.park} ` +
              `${(r.ms / 1000).toFixed(1)}s`);
          } else if (done % 8 === 0) {
            console.log(`[   ] ${done}/${tasks.length} wins=${wins} ` +
              `last K=${r.k} bestLeft=${r.bestLeft} leftAtShuffle=${r.leftAtShuffle}`);
          }
          pump();
        });
      }
      if (running === 0 && next >= tasks.length) resolveAll();
    }
    pump();
  });

  console.log(`\nRESULT: ${wins}/${tasks.length} winnable (hand=${HMAX} park=${PMAX})`);
  const byK = new Map();
  results.forEach((r) => {
    const e = byK.get(r.k) || { n: 0, w: 0, best: 999 };
    e.n++; if (r.ok) e.w++;
    if (r.bestLeft !== null && r.bestLeft < e.best) e.best = r.bestLeft;
    byK.set(r.k, e);
  });
  [...byK.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, e]) => {
    console.log(`  K=${k}: ${e.w}/${e.n} wins, closest miss bestLeft=${e.best}`);
  });
  fs.writeFileSync(path.join(DIR, '.sa_results.json'), JSON.stringify(results, null, 1));
  results.forEach((r) => {
    if (!r.ok) { try { fs.unlinkSync(path.join(DIR, `.sa_${r.k}_${r.seed}.plan.json`)); } catch (e) {} }
  });
  process.exit(0);
})();
