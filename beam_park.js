#!/usr/bin/env node
/**
 * beam_park.js - beam search over the real client rules, props included.
 *
 * Why beam and not DFS: this class of board sits right at the capacity limit, and a DFS
 * spends its whole budget inside the first dead subtree it walks into. A beam keeps the W
 * most promising states per ply, so a plan that only exists along a narrow corridor of
 * decisions still survives to the end.
 *
 * Rules are exactly the ones verify_plan3.js enforces:
 *   click  legal only while |hand| < 7 -> insert after the last same type -> 3 collapse
 *   park   hand[0..min(3,len)] onto slots 0..2 (stacks); one park = one prop use
 *   tray   the TOP card of a slot goes back into the hand, same insert rule
 *   win    board empty AND hand empty AND all three slots empty
 *
 *   node beam_park.js <board.json> [width] [maxPlys]
 *
 * env: HAND_MAX(7) PARK_MAX(1) PARK_MIN(6) PLAN_OUT
 */
const fs = require('fs');

const boardPath = process.argv[2];
const WIDTH = parseInt(process.argv[3] || '2500', 10);
const MAX_PLYS = parseInt(process.argv[4] || '6000', 10);
const HMAX = parseInt(process.env.HAND_MAX || '7', 10);
const PARK_MAX = parseInt(process.env.PARK_MAX || '1', 10);
const PARK_MIN = parseInt(process.env.PARK_MIN || '6', 10);

if (!boardPath) { console.error('usage: node beam_park.js <board.json> [width] [maxPlys]'); process.exit(1); }
const outPath = process.env.PLAN_OUT ||
  boardPath.replace(/\.board\.json$/, '').replace(/\.json$/, '') + '.beam.plan.json';

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const blocks = Array.isArray(board.blocks) ? board.blocks : board;
const n = blocks.length;
const SUB = 8;
const NT = 32;
const MAXD = PARK_MAX + 2;

const layer = new Int16Array(n), row = new Int16Array(n), rol = new Int16Array(n), type = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const b = blocks[i];
  layer[i] = b.layerNum; row[i] = b.rowNum; rol[i] = b.rolNum; type[i] = b.type;
}

const covers = Array.from({ length: n }, () => []);
const cover0 = new Uint8Array(n);
for (let j = 0; j < n; j++) {
  for (let k = 0; k < n; k++) {
    if (k === j) continue;
    if (layer[j] > layer[k] && Math.abs(row[j] - row[k]) < SUB && Math.abs(rol[j] - rol[k]) < SUB) {
      covers[j].push(k);
      cover0[k]++;
    }
  }
}

// ---- packed state ----
// [0, REM_BYTES)            removed bits
// [REM_BYTES, +n)           cover count per block (255 = gone)
// hand / slots / depths / parks / handLen / removedCount
const REM = (n + 7) >> 3;
const HAND_OFF = REM + n;
const SLOT_OFF = HAND_OFF + HMAX + 2;
const DEPTH_OFF = SLOT_OFF + 3 * MAXD;
const OFF_PARKS = DEPTH_OFF + 3;
const OFF_HLEN = DEPTH_OFF + 4;
const OFF_RC_LO = DEPTH_OFF + 5;
const OFF_RC_HI = DEPTH_OFF + 6;
const SIZE = DEPTH_OFF + 7;

const getRemoved = (s, i) => (s[i >> 3] >> (i & 7)) & 1;
const getHand = (s, k) => s[HAND_OFF + k];
const getDepth = (s, sl) => s[DEPTH_OFF + sl];
const getSlot = (s, sl, d) => s[SLOT_OFF + sl * MAXD + d];
const hlen = (s) => s[OFF_HLEN];
const parks = (s) => s[OFF_PARKS];
const rc = (s) => s[OFF_RC_LO] | (s[OFF_RC_HI] << 8);
const setRc = (s, v) => { s[OFF_RC_LO] = v & 255; s[OFF_RC_HI] = (v >> 8) & 255; };
const trayTotal = (s) => getDepth(s, 0) + getDepth(s, 1) + getDepth(s, 2);

function initialState() {
  const s = new Uint8Array(SIZE);
  for (let i = 0; i < n; i++) s[REM + i] = cover0[i];
  setRc(s, 0);
  return s;
}

/** insert t into the hand of `c` following getNewPosit(); collapses a triple in place */
function handAdd(c, t) {
  const L = c[OFF_HLEN];
  let pos = L;
  for (let k = L - 1; k >= 0; k--) if (getHand(c, k) === t) { pos = k + 1; break; }
  for (let k = L; k > pos; k--) c[HAND_OFF + k] = c[HAND_OFF + k - 1];
  c[HAND_OFF + pos] = t;
  let cnt = 0;
  for (let k = 0; k <= L; k++) if (getHand(c, k) === t) cnt++;
  if (cnt === 3) {
    let w = 0, dropped = 0;
    for (let k = 0; k <= L; k++) {
      if (getHand(c, k) === t && dropped < 3) { dropped++; continue; }
      c[HAND_OFF + w++] = c[HAND_OFF + k];
    }
    c[OFF_HLEN] = L + 1 - 3;
  } else {
    c[OFF_HLEN] = L + 1;
  }
}

function apply(s, act) {
  const c = s.slice();
  if (act.k === 0) {
    const i = act.v;
    c[i >> 3] |= 1 << (i & 7);
    c[REM + i] = 255;
    for (const v of covers[i]) if (c[REM + v] && c[REM + v] !== 255) c[REM + v]--;
    setRc(c, rc(s) + 1);
    handAdd(c, type[i]);
    return c;
  }
  if (act.k === 1) {
    const L = hlen(c);
    const take = Math.min(3, L);
    const moved = [];
    for (let k = 0; k < take; k++) moved.push(getHand(c, k));
    for (let k = 0; k < L - take; k++) c[HAND_OFF + k] = c[HAND_OFF + k + take];
    c[OFF_HLEN] = L - take;
    for (let k = 0; k < take; k++) {
      const sl = k % 3, d = getDepth(c, sl);
      c[SLOT_OFF + sl * MAXD + d] = moved[k];
      c[DEPTH_OFF + sl] = d + 1;
    }
    c[OFF_PARKS] = parks(s) + 1;
    act.moved = moved;
    return c;
  }
  const sl = act.v, d = getDepth(c, sl);
  const t = getSlot(c, sl, d - 1);
  c[DEPTH_OFF + sl] = d - 1;
  handAdd(c, t);
  act.t = t;
  return c;
}

/** cheap exact key: only the parts that can differ */
function keyOf(s) {
  let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
  for (let i = 0; i < REM; i++) { h1 = Math.imul(h1 ^ s[i], 16777619); h2 = Math.imul(h2 + s[i], 2246822519); }
  for (let i = REM; i < REM + n; i++) { h1 = Math.imul(h1 ^ s[i], 16777619); h2 = Math.imul(h2 + s[i], 2246822519); }
  for (let i = HAND_OFF; i < SIZE; i++) { h1 = Math.imul(h1 ^ s[i], 16777619); h2 = Math.imul(h2 + s[i], 2246822519); }
  return (h1 >>> 0).toString(36) + ':' + (h2 >>> 0).toString(36);
}

/** lower is better */
function score(s) {
  const L = hlen(s), T = trayTotal(s);
  const seen = new Int32Array(NT);
  let distinct = 0, pairs = 0;
  for (let k = 0; k < L; k++) {
    const t = getHand(s, k);
    if (!seen[t]) distinct++;
    seen[t]++;
  }
  for (let t = 0; t < NT; t++) if (seen[t] === 2) pairs++;
  return (n - rc(s)) * 100 + (L + T) * 35 + distinct * 25 - pairs * 60;
}

const clickables = (s) => {
  const out = [];
  for (let i = 0; i < n; i++) if (!getRemoved(s, i) && s[REM + i] === 0) out.push(i);
  return out;
};

// ---- driver ----
let level = [initialState()];
const allActs = [], allPar = [];
const t0 = Date.now();

for (let ply = 0; ply < MAX_PLYS; ply++) {
  const next = [], nextActs = [], nextPar = [];
  const seen = new Set();

  for (let si = 0; si < level.length; si++) {
    const s = level[si];
    if (rc(s) === n && hlen(s) === 0 && trayTotal(s) === 0) {
      const path = [];
      let idx = si, p = ply;
      while (p > 0) { path.push(allActs[p - 1][idx]); idx = allPar[p - 1][idx]; p--; }
      path.reverse();
      const plan = path.map((a, k) => {
        if (a.k === 0) return { step: k, kind: 'board', id: blocks[a.v].id, type: type[a.v] };
        if (a.k === 1) return { step: k, kind: 'park', moved: a.moved };
        return { step: k, kind: 'tray', slot: a.v, type: a.t };
      });
      fs.writeFileSync(outPath, JSON.stringify(plan, null, 1));
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const c = { board: 0, park: 0, tray: 0 };
      plan.forEach((q) => { c[q.kind]++; });
      console.log(`SOLVED steps=${plan.length} board=${c.board} tray=${c.tray} park=${c.park}` +
        ` plies=${ply} beam=${level.length} time=${dt}s -> ${outPath}`);
      process.exit(0);
    }

    const L = hlen(s);
    const cands = [];
    if (L < HMAX) {
      for (let sl = 0; sl < 3; sl++) {
        const d = getDepth(s, sl);
        if (!d) continue;
        const t = getSlot(s, sl, d - 1);
        let have = 0;
        for (let k = 0; k < L; k++) if (getHand(s, k) === t) have++;
        cands.push({ k: 2, v: sl, pref: have === 2 ? 4 : (have === 1 ? 1 : 0) });
      }
    }
    for (const i of (L < HMAX ? clickables(s) : [])) {
      const t = type[i];
      let have = 0;
      for (let k = 0; k < L; k++) if (getHand(s, k) === t) have++;
      cands.push({ k: 0, v: i, pref: have === 2 ? 5 : (have === 1 ? 3 : 0) });
    }
    if (parks(s) < PARK_MAX && L >= PARK_MIN) cands.push({ k: 1, v: 0, pref: L >= HMAX ? 6 : 0 });

    cands.sort((a, b) => b.pref - a.pref);

    for (const a of cands) {
      const ns = apply(s, a);
      const kk = keyOf(ns);
      if (seen.has(kk)) continue;
      seen.add(kk);
      next.push(ns); nextActs.push(a); nextPar.push(si);
    }
  }

  if (!next.length) {
    if (process.env.DBG) process.stderr.write(`[beam] dry at ply=${ply} level=${level.length}\n`);
    break;
  }

  const scored = next.map((s, i) => ({ i, sc: score(s) }));
  scored.sort((a, b) => a.sc - b.sc);
  const keep = Math.min(WIDTH, scored.length);
  const lvl = new Array(keep), lac = new Array(keep), lpar = new Int32Array(keep);
  for (let q = 0; q < keep; q++) {
    const o = scored[q].i;
    lvl[q] = next[o]; lac[q] = nextActs[o]; lpar[q] = nextPar[o];
  }
  allActs.push(lac); allPar.push(lpar);
  level = lvl;

  if ((ply & 15) === 0) {
    process.stderr.write(`[beam] ply=${ply} states=${level.length} best=${scored[0].sc} ` +
      `t=${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }
  if (Date.now() - t0 > 240000) { process.stderr.write('[beam] time cap\n'); break; }
}

console.log('NO WIN (beam exhausted)');
process.exit(2);
