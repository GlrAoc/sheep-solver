#!/usr/bin/env node
/**
 * dfs_park.js - exact DFS that treats the "move out" prop as a first-class action.
 *
 * The faithful client model (mirrored 1:1 from bot.js, which was written against the
 * decompiled appservice bundle):
 *
 *   click board   refused while getCrushBlockNum() >= 7
 *   insert        getNewPosit(): the new card goes right AFTER the last card of the
 *                 same type, not at the end of the bar
 *   crush         when the hand holds 3 of a type they disappear; because of the insert
 *                 rule those three are always contiguous
 *   park          moveOutBlock(): hand.splice(0, min(3, len)) -> slot[r].push(card),
 *                 r = 0..take-1; slots are stacks
 *   tray click    the TOP card of a slot is interactive and goes back into the hand
 *                 through the same insert rule -> the tray is a real buffer, not a grave
 *   win           blocks == 0 AND hand == 0 AND tray == 0
 *
 *   node dfs_park.js <board.json> [maxSeconds] [nodeBudget] [randSeed]
 *
 * env:
 *   PLAN_OUT   output plan path (default <board>.park.plan.json)
 *   PARK_MAX   max park uses (default 1 - the in-game prop count is the real ceiling)
 *   PARK_MIN   smallest hand size worth parking from (default 6)
 *   HAND_MAX   hand cap (default 7)
 *   MEMO_BITS  memo table size as 2^n (default 25)
 *   TIGHT      1 = re-enable the old HMAX-1 cut (unsound with a park in hand)
 *   VERBOSE    1 = progress lines
 */
const fs = require('fs');

const boardPath = process.argv[2];
const MAX_S = parseFloat(process.argv[3] || '120');
const NODE_BUDGET = parseFloat(process.argv[4] || '4000000000');
const RSEED = parseInt(process.argv[5] || '12345', 10);
const HMAX = parseInt(process.env.HAND_MAX || '7', 10);
const PARK_MAX = parseInt(process.env.PARK_MAX || '1', 10);
const PARK_MIN = parseInt(process.env.PARK_MIN || '6', 10);
const MEMO_BITS = parseInt(process.env.MEMO_BITS || '25', 10);
const TIGHT = process.env.TIGHT === '1';
const VERBOSE = process.env.VERBOSE === '1';
if (VERBOSE) {
  console.error('[cfg] HMAX=' + HMAX + ' PARK_MAX=' + PARK_MAX + ' PARK_MIN=' + PARK_MIN +
    ' MEMO_BITS=' + MEMO_BITS + ' TIGHT=' + (TIGHT ? 1 : 0));
}

if (!boardPath) {
  console.error('usage: node dfs_park.js <board.json> [maxSeconds] [nodeBudget] [randSeed]');
  process.exit(1);
}
const outPath = process.env.PLAN_OUT ||
  boardPath.replace(/\.board\.json$/, '').replace(/\.json$/, '') + '.park.plan.json';

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const blocks = Array.isArray(board.blocks) ? board.blocks : board;
const n = blocks.length;
const SUB = 8;

const layer = new Int16Array(n), row = new Int16Array(n), rol = new Int16Array(n), type = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const b = blocks[i];
  layer[i] = b.layerNum; row[i] = b.rowNum; rol[i] = b.rolNum; type[i] = b.type;
}
// The plan packs the three parked types into one Int32 at 5 bits each (see pathExtra), so a
// board with more than 31 distinct types would silently produce a corrupt plan. Refuse instead.
{
  let mx = 0;
  for (let i = 0; i < n; i++) if (type[i] > mx) mx = type[i];
  if (mx > 31) {
    console.error('FATAL: max card type is ' + mx + ', the plan packs types at 5 bits (max 31). ' +
      'Widen the packing in pathExtra before running this board.');
    process.exit(2);
  }
}

// ---- coverage graph (CSR) ----
let edgeCount = 0;
for (let j = 0; j < n; j++) {
  for (let k = 0; k < n; k++) {
    if (k !== j && layer[j] > layer[k] &&
        Math.abs(row[j] - row[k]) < SUB && Math.abs(rol[j] - rol[k]) < SUB) edgeCount++;
  }
}
const invStart = new Int32Array(n + 1);
const invList = new Int32Array(edgeCount);
{
  let p = 0;
  for (let j = 0; j < n; j++) {
    invStart[j] = p;
    for (let k = 0; k < n; k++) {
      if (k !== j && layer[j] > layer[k] &&
          Math.abs(row[j] - row[k]) < SUB && Math.abs(rol[j] - rol[k]) < SUB) invList[p++] = k;
    }
  }
  invStart[n] = p;
}
const cover0 = new Uint8Array(n);
for (let j = 0; j < n; j++) for (let p = invStart[j]; p < invStart[j + 1]; p++) cover0[invList[p]]++;

const NT = 32;
const typeTotal = new Uint8Array(NT);
for (let i = 0; i < n; i++) typeTotal[type[i]]++;

// ---- Zobrist over the removed set ----
const Z1 = new Int32Array(n), Z2 = new Int32Array(n);
let s1 = 0x9e3779b9 | 0, s2 = 0x85ebca6b | 0;
for (let i = 0; i < n; i++) {
  s1 ^= s1 << 13; s1 |= 0; s1 ^= s1 >>> 17; s1 ^= s1 << 5; s1 |= 0; Z1[i] = s1;
  s2 ^= s2 << 13; s2 |= 0; s2 ^= s2 >>> 17; s2 ^= s2 << 5; s2 |= 0; Z2[i] = s2;
}

const removed = new Uint8Array(n);
const cnt = new Uint8Array(n);
let left = n, h1 = 0, h2 = 0;

// ---- hand bar and tray, both ordered ----
const handArr = new Uint8Array(HMAX + 4);
let handLen = 0;
const MAXD = PARK_MAX + 2;                       // per-slot stack depth cap
const slotArr = new Uint8Array(3 * MAXD);
const slotDepth = new Int32Array(3);
const inHand = new Uint8Array(NT);               // per-type count in hand
const inTray = new Uint8Array(NT);               // per-type count in tray
let trayTotal = 0;
let parks = 0;

// ---- clickable frontier ----
const clist = new Int32Array(n);
const cpos = new Int32Array(n).fill(-1);
const clickable = new Int32Array(NT);
let clen = 0;
function clAdd(i) { if (cpos[i] >= 0) return; cpos[i] = clen; clist[clen++] = i; clickable[type[i]]++; }
function clDel(i) {
  const p = cpos[i];
  if (p < 0) return;
  const last = clist[--clen];
  clist[p] = last; cpos[last] = p; cpos[i] = -1; clickable[type[i]]--;
}
function frontierReset() {
  clen = 0; cpos.fill(-1); clickable.fill(0);
  for (let i = 0; i < n; i++) if (cnt[i] === 0) clAdd(i);
}

// ---- memo ----
const MEMO_SIZE = 1 << MEMO_BITS, MEMO_MASK = MEMO_SIZE - 1;
const memo = new Float64Array(MEMO_SIZE);
let memoCount = 0;
let stateHash = 0;
function mix32(a, b, c) {
  let h = 2166136261 | 0;
  h = Math.imul(h ^ a, 16777619);
  h = Math.imul(h ^ b, 16777619);
  h = Math.imul(h ^ c, 16777619);
  return h >>> 0;
}
// hand order and slot stacks are tiny (<= HMAX + 3*MAXD entries), so hash them on demand.
// Order only ever matters through park, which always eats the three OLDEST cards: once the
// park budget is spent no future action can tell two orderings apart, so the key drops the
// sequence and keeps the multiset. That single merge is what keeps the table from drowning.
function stateWords() {
  let hh = 0x811c9dc5 | 0;
  if (parks >= PARK_MAX) {
    for (let t = 0; t < NT; t++) hh = Math.imul(hh ^ (inHand[t] + 1), 16777619);
    hh = Math.imul(hh ^ (handLen + 17), 16777619);
  } else {
    for (let i = 0; i < handLen; i++) hh = Math.imul(hh ^ (handArr[i] + 1), 16777619);
    hh = Math.imul(hh ^ (handLen + 17), 16777619);
  }
  for (let s = 0; s < 3; s++) {
    hh = Math.imul(hh ^ (slotDepth[s] + 31), 16777619);
    for (let d = 0; d < slotDepth[s]; d++) hh = Math.imul(hh ^ (slotArr[s * MAXD + d] + 1), 16777619);
  }
  hh = Math.imul(hh ^ (parks + 7), 16777619);
  return hh;
}
function keyNow() {
  const hs = stateWords();
  const a = mix32(h1, h2, hs);
  const b = mix32(h2, hs, h1);
  return (a * 2097152 + (b & 0x1FFFFF)) + 1;
}
function memoHas(k) { return memo[k & MEMO_MASK] === k; }
function memoAdd(k) { const i = k & MEMO_MASK; if (memo[i] !== k) { memo[i] = k; memoCount++; } }

// ---- search policy ----
let rnd = RSEED | 0;
function noise() { rnd ^= rnd << 13; rnd |= 0; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd |= 0; return (rnd >>> 0) / 4294967296; }
let W = { finish: 1000, open: 300, same: 40, unlock: 10, noise: 6, wide: 150, park: 400 };
function jitterWeights() {
  if (process.env.NOJIT === '1') return;
  const j = (x, p) => x * (1 + (noise() * 2 - 1) * p);
  W = {
    finish: 1000, open: j(300, 0.5), same: j(40, 0.6), unlock: j(10, 0.8),
    noise: 6, wide: j(150, 0.7), park: j(400, 0.6)
  };
}

// A path can be longer than the board: a park adds one step without consuming a card, and
// each park lets up to three tray cards come back (one step each). Anything indexed by path
// depth must therefore be sized n + 4*PARK_MAX, not n -- sizing it n+8 silently returned
// garbage candidate indices once a park had been used.
const MAXPATH = n + 4 * PARK_MAX + 8;
const candBuf = new Int32Array(MAXPATH * n);
const candScore = new Float64Array(n);
function candidates(depth) {
  const base = depth * n;
  let m = 0;
  const tight = handLen >= HMAX - 2;
  for (let c = 0; c < clen; c++) {
    const i = clist[c];
    const t = type[i];
    let sc;
    if (inTray[t] > 0 && inHand[t] === 1) sc = W.finish;         // tap the tray card right after
    else if (inHand[t] === 2) sc = W.finish;
    else if (inHand[t] === 1) sc = W.open + clickable[t] * W.same;
    else if (inTray[t] > 0) sc = W.open + clickable[t] * W.same;
    else sc = clickable[t] * W.same - (tight ? W.wide : 0);
    let un = 0;
    for (let p = invStart[i]; p < invStart[i + 1]; p++) if (cnt[invList[p]] === 1) un++;
    sc += un * W.unlock;
    sc += noise() * W.noise;
    let q = m++;
    while (q > 0 && candScore[q - 1] < sc) {
      candScore[q] = candScore[q - 1]; candBuf[base + q] = candBuf[base + q - 1]; q--;
    }
    candScore[q] = sc; candBuf[base + q] = i;
  }
  return m;
}

/** insert type t at index `at` */
function handInsertAt(t, at) {
  for (let i = handLen; i > at; i--) handArr[i] = handArr[i - 1];
  handArr[at] = t;
  handLen++;
  inHand[t]++;
  return at;
}
/** insert type t right after the last card of the same type (client getNewPosit) */
function handInsert(t) {
  let pos = handLen;
  for (let i = handLen - 1; i >= 0; i--) if (handArr[i] === t) { pos = i + 1; break; }
  return handInsertAt(t, pos);
}
function handRemoveAt(pos) {
  const t = handArr[pos];
  for (let i = pos; i < handLen - 1; i++) handArr[i] = handArr[i + 1];
  handLen--;
  inHand[t]--;
  return t;
}
/** same-type cards stay contiguous under handInsert, so a triple is one run of three */
function crushStart(t) {
  for (let i = 0; i <= handLen - 3; i++) {
    if (handArr[i] === t && handArr[i + 1] === t && handArr[i + 2] === t) return i;
  }
  return -1;
}

// undo record: how the card entered the hand, and where the triple started (if it fired)
//   cru < 0  -> the card simply sits at `pos`, so removal restores the bar
//   cru >= 0 -> the bar held exactly 2 of this type; re-inserting both at `cru` restores it
// one record per path depth, so the search never allocates during a dive
const recPos = new Int32Array(MAXPATH);
const recCru = new Int32Array(MAXPATH);
const recTyp = new Int32Array(MAXPATH);

const pathKind = new Int8Array(MAXPATH);   // 0 board click, 1 park, 2 tray tap
const pathVal = new Int32Array(MAXPATH);
const pathExtra = new Int32Array(MAXPATH); // park: 3 packed types; tray: the card type
let pathLen = 0;

/** click board block i; records how the hand changed so the bar can be restored exactly */
function clickBlock(i, depth) {
  const t = type[i];
  removed[i] = 1; cnt[i] = 255; left--;
  h1 ^= Z1[i]; h2 ^= Z2[i];
  clDel(i);
  for (let p = invStart[i]; p < invStart[i + 1]; p++) {
    const v = invList[p];
    if (cnt[v] > 0 && cnt[v] !== 255) { cnt[v]--; if (cnt[v] === 0) clAdd(v); }
  }
  const pos = handInsert(t);
  let cru = -1;
  if (inHand[t] === 3) {
    cru = crushStart(t);
    for (let q = 0; q < 3; q++) handRemoveAt(cru);
  }
  recPos[depth] = pos; recCru[depth] = cru; recTyp[depth] = t;
}

function unclickBlock(i, depth) {
  const t = type[i], pos = recPos[depth], cru = recCru[depth];
  // before the click the bar held exactly two of this type; putting two back at `cru`
  // rebuilds the original run, and the clicked card is the one that stays gone
  if (cru >= 0) { handInsertAt(t, cru); handInsertAt(t, cru); }
  else handRemoveAt(pos);
  for (let p = invStart[i]; p < invStart[i + 1]; p++) {
    const v = invList[p];
    if (cnt[v] !== 255) { if (cnt[v] === 0) clDel(v); cnt[v]++; }
  }
  clAdd(i);
  left++; removed[i] = 0; cnt[i] = 0;
  h1 ^= Z1[i]; h2 ^= Z2[i];
}

const parkBack = new Int32Array(3);

/** moveOutBlock(): the oldest <=3 hand cards go onto the three slots as stacks */
function doPark() {
  const take = Math.min(3, handLen);
  for (let k = 0; k < take; k++) {
    const t = handArr[0];
    for (let i = 0; i < handLen - 1; i++) handArr[i] = handArr[i + 1];
    handLen--; inHand[t]--;
    const s = k % 3;
    slotArr[s * MAXD + slotDepth[s]] = t;
    slotDepth[s]++; inTray[t]++; trayTotal++;
  }
  parks++;
  return take;
}

function undoPark(take) {
  parks--;
  for (let k = 0; k < take; k++) {
    const s = k % 3;
    slotDepth[s]--;
    const t = slotArr[s * MAXD + slotDepth[s]];
    inTray[t]--; trayTotal--;
    parkBack[k] = t;
  }
  for (let i = handLen - 1; i >= 0; i--) handArr[i + take] = handArr[i];
  for (let k = 0; k < take; k++) { handArr[k] = parkBack[k]; inHand[parkBack[k]]++; }
  handLen += take;
}

/** tap the top card of slot s: it returns to the bar through the normal insert rule */
function trayClick(s, depth) {
  slotDepth[s]--;
  const t = slotArr[s * MAXD + slotDepth[s]];
  inTray[t]--; trayTotal--;
  const pos = handInsert(t);
  let cru = -1;
  if (inHand[t] === 3) {
    cru = crushStart(t);
    for (let q = 0; q < 3; q++) handRemoveAt(cru);
  }
  recPos[depth] = pos; recCru[depth] = cru; recTyp[depth] = t;
}

function trayUnclick(s, depth) {
  const t = recTyp[depth], pos = recPos[depth], cru = recCru[depth];
  if (cru >= 0) { handInsertAt(t, cru); handInsertAt(t, cru); }
  else handRemoveAt(pos);
  slotArr[s * MAXD + slotDepth[s]] = t;
  slotDepth[s]++; inTray[t]++; trayTotal++;
}

let nodes = 0, bestLeft = n;
// DUMP_BEST=1: keep the deepest path found so far. A 7-slot DFS on a board that needs more
// room never solves, but its longest legal prefix is exactly what the park search wants to
// start from -- replaying it turns a 261-step problem into a ~90-step one.
const DUMP_BEST = process.env.DUMP_BEST === '1';
const bestKind = new Int8Array(MAXPATH);
const bestVal = new Int32Array(MAXPATH);
const bestExtra = new Int32Array(MAXPATH);
let bestLen = 0;
const t0 = Date.now();
let solved = false, abort = false, lastLog = 0;

function dfs() {
  if (solved || abort) return false;
  if ((++nodes & 2047) === 0) {
    const el = Date.now() - t0;
    if (el > MAX_S * 1000 || nodes > NODE_BUDGET) { abort = true; return false; }
    if (VERBOSE && el - lastLog > 5000) {
      lastLog = el;
      console.log('[dfs] ' + (el / 1000).toFixed(0) + 's nodes=' + nodes + ' depth=' + (n - left) +
        ' hand=' + handLen + ' tray=' + trayTotal + ' parks=' + parks + '/' + PARK_MAX +
        ' bestLeft=' + bestLeft + ' memo=' + memoCount);
    }
  }
  if (left === 0 && handLen === 0 && trayTotal === 0) { solved = true; return true; }
  if (left < bestLeft) {
    bestLeft = left;
    if (DUMP_BEST) {
      bestLen = pathLen;
      for (let q = 0; q < pathLen; q++) { bestKind[q] = pathKind[q]; bestVal[q] = pathVal[q]; bestExtra[q] = pathExtra[q]; }
    }
  }

  const k = keyNow();
  if (memoHas(k)) return false;

  const depth = pathLen;

  // ---- action 1: tap a tray card back; the ones that complete a pair go first ----
  if (handLen < HMAX) {
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 0; s < 3; s++) {
        if (slotDepth[s] === 0) continue;
        const t = slotArr[s * MAXD + slotDepth[s] - 1];
        const pairs = inHand[t] === 2;
        if ((pass === 0) !== pairs) continue;
        trayClick(s, depth);
        pathKind[pathLen] = 2; pathVal[pathLen] = s; pathExtra[pathLen] = recTyp[depth]; pathLen++;
        if (dfs()) return true;
        pathLen--;
        trayUnclick(s, depth);
        if (solved) return true;
        if (abort) return false;
      }
    }
  }

  // ---- action 2: click a board card ----
  if (handLen < HMAX) {
    // the old HMAX-1 cut is only sound once no park is left
    const tight = TIGHT && parks >= PARK_MAX && handLen >= HMAX - 1;
    if (!tight) {
      const base = depth * n;
      const m = candidates(depth);
      for (let c = 0; c < m; c++) {
        const i = candBuf[base + c];
        clickBlock(i, depth);
        pathKind[pathLen] = 0; pathVal[pathLen] = i; pathLen++;
        if (dfs()) return true;
        pathLen--;
        unclickBlock(i, depth);
        if (left < bestLeft) bestLeft = left;
        if (solved) return true;
        if (abort) return false;
      }
    }
  }

  // ---- action 3: park, tried last: clicks are what actually advance the board ----
  if (!solved && !abort && parks < PARK_MAX && handLen >= PARK_MIN) {
    const moved = (handArr[0]) | (handArr[1] << 5) | (handArr[2] << 10);
    const take = doPark();
    pathKind[pathLen] = 1; pathVal[pathLen] = take; pathExtra[pathLen] = moved; pathLen++;
    if (dfs()) return true;
    pathLen--;
    undoPark(take);
    if (solved) return true;
    if (abort) return false;
  }

  if (!solved && !abort) memoAdd(k);
  return false;
}

function resetRun() {
  removed.fill(0); cnt.set(cover0);
  handLen = 0; handArr.fill(0); inHand.fill(0); inTray.fill(0);
  slotDepth.fill(0); slotArr.fill(0); trayTotal = 0; parks = 0;
  left = n; h1 = 0; h2 = 0; pathLen = 0;
  frontierReset();
}

// ---- simulated in-game shuffle ----
// The client's shuffle permutes the TYPE of every block still on the board and leaves the
// layout alone, so "shuffle at step K" is exactly: replay K steps, then reassign the remaining
// type multiset at random. Modelling it here lets us answer the real question -- does shuffling
// at the pinch (with the bar already half full) rescue a board that is dead from the root?
const SHUFFLE_AT = parseInt(process.env.SHUFFLE_AT || '0', 10);
const SHUFFLE_SEED = parseInt(process.env.SHUFFLE_SEED || '1', 10);

function shuffleRemaining(seed) {
  let a = seed >>> 0;
  const rndL = function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idxs = [];
  for (let i = 0; i < n; i++) if (!removed[i]) idxs.push(i);
  const ts = idxs.map(function (i) { return type[i]; });
  for (let i = ts.length - 1; i > 0; i--) {
    const j = Math.floor(rndL() * (i + 1));
    const t = ts[i]; ts[i] = ts[j]; ts[j] = t;
  }
  for (let k = 0; k < idxs.length; k++) type[idxs[k]] = ts[k];
  // only the frontier bookkeeping depends on type; covers and the hand are untouched
  clickable.fill(0);
  for (let c = 0; c < clen; c++) clickable[type[clist[c]]]++;
  return idxs.length;
}

// ---- optional prefix replay ----
// A plan solved under a looser hand cap is legal at 7 slots up to the first pinch. Replaying
// that legal head puts the search right next to the pinch, which is exactly where the park
// has to be spent -- instead of making the DFS rediscover 150 clicks.
const PREFIX = process.env.PREFIX || '';
const PREFIX_MAX = parseInt(process.env.PREFIX_MAX || '0', 10);
const idToIdx = new Map();
for (let i = 0; i < n; i++) idToIdx.set(String(blocks[i].id), i);

function applyPrefix() {
  if (!PREFIX) return 0;
  // A missing prefix file must abort loudly: silently searching from the root burns the
  // whole budget and looks like "no solution" in the logs.
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(PREFIX, 'utf8'));
  } catch (e) {
    console.error('FATAL: PREFIX=' + PREFIX + ' cannot be read (' + e.code + '). ' +
      'Refusing to run a root search in its place.');
    process.exit(2);
  }
  let applied = 0;
  for (let s = 0; s < plan.length; s++) {
    if (PREFIX_MAX > 0 && applied >= PREFIX_MAX) break;
    const st = plan[s];
    if (st.kind !== 'board') continue;
    const idx = idToIdx.get(String(st.id));
    if (idx === undefined || removed[idx] || cnt[idx] !== 0) break;
    if (handLen >= HMAX) break;                  // the pinch: hand the rest to the search
    clickBlock(idx, pathLen);
    pathKind[pathLen] = 0; pathVal[pathLen] = idx; pathLen++;
    applied++;
  }
  return applied;
}

// Restarts are done by running several seeds in parallel (oneclick --seeds N). An in-process
// slice/restart used to live here; it never fired reliably (the bound was compared against a
// different clock than the one dfs() uses), and a solver that silently ignores its own time
// budget is worse than no budget. Costs one process per seed, buys determinism.
let ok = false;
resetRun();
jitterWeights();
if (PREFIX) {
  const pre = applyPrefix();
  if (pre === 0) {
    console.error('FATAL: PREFIX=' + PREFIX + ' replayed 0 steps -- the plan does not match ' +
      'this board (ids/types drifted or the very first click is already illegal).');
    process.exit(2);
  }
  if (!process.env.QUIET) {
    process.stderr.write('[prefix] replayed ' + pre + ' legal steps, hand=' + handLen +
      ' left=' + left + ' (search starts at the pinch)\n');
  }
}
if (SHUFFLE_AT > 0) {
  // The prefix replay above is what fixes "when": PREFIX_MAX trims it to the exact step we
  // want to shuffle at, and SHUFFLE_AT just switches the permutation on.
  const moved = shuffleRemaining(SHUFFLE_SEED);
  if (!process.env.QUIET) {
    process.stderr.write('[shuffle] at step ' + pathLen + ', permuted ' + moved +
      ' remaining blocks (hand=' + handLen + ', left=' + left + ')\n');
  }
}
ok = dfs();
const dt = ((Date.now() - t0) / 1000).toFixed(1);

if (ok) {
  const plan = [];
  for (let k = 0; k < pathLen; k++) {
    if (pathKind[k] === 0) {
      plan.push({ step: k, kind: 'board', id: blocks[pathVal[k]].id, type: type[pathVal[k]] });
    } else if (pathKind[k] === 1) {
      const take = pathVal[k], pk = pathExtra[k];
      const moved = [];
      for (let q = 0; q < take; q++) moved.push((pk >> (5 * q)) & 31);
      plan.push({ step: k, kind: 'park', moved });
    } else {
      plan.push({ step: k, kind: 'tray', slot: pathVal[k], type: pathExtra[k] });
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 1));
  const c = { board: 0, park: 0, tray: 0 };
  plan.forEach((p) => { c[p.kind]++; });
  console.log('SOLVED steps=' + plan.length + ' board=' + c.board + ' tray=' + c.tray +
    ' park=' + c.park + ' nodes=' + nodes + ' time=' + dt + 's rate=' +
    Math.round(nodes / (dt || 1) / 1000) + 'k/s -> ' + outPath);
  process.exit(0);
}

if (DUMP_BEST && bestLen > 0) {
  // The deepest legal prefix under this hand cap: feed it back with PREFIX= to continue
  // from the pinch instead of re-searching 261 steps every time.
  const plan = [];
  for (let k = 0; k < bestLen; k++) {
    if (bestKind[k] === 0) plan.push({ step: k, kind: 'board', id: blocks[bestVal[k]].id, type: type[bestVal[k]] });
    else if (bestKind[k] === 1) {
      const take = bestVal[k], pk = bestExtra[k], moved = [];
      for (let q = 0; q < take; q++) moved.push((pk >> (5 * q)) & 31);
      plan.push({ step: k, kind: 'park', moved });
    } else plan.push({ step: k, kind: 'tray', slot: bestVal[k], type: bestExtra[k] });
  }
  const pf = outPath.replace(/.plan.json$/, '') + '.prefix.json';
  fs.writeFileSync(pf, JSON.stringify(plan, null, 1));
  console.log('DUMPED deepest prefix steps=' + plan.length + ' left=' + bestLeft + ' -> ' + pf);
}

console.log('NO WIN nodes=' + nodes + ' time=' + dt + 's bestLeft=' + bestLeft + '/' + n +
  ' states=' + memoCount + ' rate=' + Math.round(nodes / (dt || 1) / 1000) + 'k/s budget hit (unknown)');
process.exit(3);
