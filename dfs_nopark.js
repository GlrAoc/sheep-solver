#!/usr/bin/env node
/**
 * dfs_nopark.js - exact depth-first solver for 羊了个羊 with NO props.
 *
 * Legal actions, per the decompiled client:
 *   board click   removeCardNode refuses when getCrushBlockNum() >= 7
 *                 (script-bundle-game.js: `getCrushBlockNum()>=7?e.reductionBlock():...`),
 *                 so any uncovered block may be clicked while the hand holds <= 6 cards.
 *   no parking    moveOutBlock() is PropType.remove ("move out"), gated by
 *                 checkPropUseLimit(PropType.remove) + userData.prop_remove >= 1,
 *                 so it is a prop and is never generated here.
 *
 * State = (removed set, per-type hand counts). Failed states go into a direct-mapped
 * table, so the search either finds a win or refutes the reachable tree.
 *
 *   node dfs_nopark.js <board.json> [maxSeconds] [nodeBudget] [randSeed]
 *
 * env:
 *   PLAN_OUT    output plan path
 *   SLICE_MS    >0 = time-sliced restarts that keep the failure table
 *   HAND_MAX    search with a different hand cap (diagnostics only; the client is 7)
 *   VERBOSE     1 = per-run log lines
 */

const fs = require('fs');

const boardPath = process.argv[2];
const MAX_S = parseFloat(process.argv[3] || '120');
const NODE_BUDGET = parseFloat(process.argv[4] || '40000000');
const RSEED = parseInt(process.argv[5] || '12345', 10);
const SLICE_MS = parseFloat(process.env.SLICE_MS || '0');
const HMAX = parseInt(process.env.HAND_MAX || '7', 10);
const VERBOSE = process.env.VERBOSE === '1';

if (!boardPath) {
  console.error('usage: node dfs_nopark.js <board.json> [maxSeconds] [nodeBudget] [randSeed]');
  process.exit(1);
}

const outPath = process.env.PLAN_OUT || (boardPath.replace(/\.board\.json$/, '')
  .replace(/\.json$/, '') + '.nopark.plan.json');

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const blocks = board.blocks;
const n = blocks.length;
const SUB = 8;

const layer = new Int16Array(n), row = new Int16Array(n), rol = new Int16Array(n), type = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const b = blocks[i];
  layer[i] = b.layerNum; row[i] = b.rowNum; rol[i] = b.rolNum; type[i] = b.type;
}

// ---- coverage graph in CSR form (flat arrays: no per-node array iteration) ----
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
for (let j = 0; j < n; j++) {
  for (let p = invStart[j]; p < invStart[j + 1]; p++) cover0[invList[p]]++;
}

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
const hand = new Uint8Array(NT);
let handSize = 0;
let left = n;
let h1 = 0, h2 = 0;

// ---- clickable frontier: dense list + position index, maintained incrementally ----
// Without this every expansion rescans all n blocks, which dominates the runtime.
const clist = new Int32Array(n);
const cpos = new Int32Array(n).fill(-1);
const clickable = new Int32Array(NT);
let clen = 0;

function clAdd(i) {
  if (cpos[i] >= 0) return;
  cpos[i] = clen;
  clist[clen++] = i;
  clickable[type[i]]++;
}

function clDel(i) {
  const p = cpos[i];
  if (p < 0) return;
  const last = clist[--clen];
  clist[p] = last;
  cpos[last] = p;
  cpos[i] = -1;
  clickable[type[i]]--;
}

function frontierReset() {
  clen = 0;
  cpos.fill(-1);
  clickable.fill(0);
  for (let i = 0; i < n; i++) if (cnt[i] === 0) clAdd(i);
}

// ---- failure table: direct mapped, 53-bit state key, sound by full-key compare ----
const MEMO_SIZE = 1 << 25, MEMO_MASK = MEMO_SIZE - 1;
const memo = new Float64Array(MEMO_SIZE);
let memoCount = 0;

function mix32(a, b, c) {
  let h = 2166136261 | 0;
  h = Math.imul(h ^ a, 16777619);
  h = Math.imul(h ^ b, 16777619);
  h = Math.imul(h ^ c, 16777619);
  return h >>> 0;
}

function keyNow() {
  let hk = 0;
  for (let t = 0; t < NT; t++) hk = (Math.imul(hk, 31) + hand[t]) | 0;
  const a = mix32(h1, h2, hk);
  const b = mix32(h2, hk, h1);
  return (a * 2097152 + (b & 0x1FFFFF)) + 1;   // 53-bit, never 0
}

function memoHas(k) { return memo[k & MEMO_MASK] === k; }
function memoAdd(k) {
  const i = k & MEMO_MASK;
  if (memo[i] !== k) { memo[i] = k; memoCount++; }
}

// ---- per-restart search policy; weights get jittered so restarts differ in kind ----
let rnd = RSEED | 0;
function noise() {
  rnd ^= rnd << 13; rnd |= 0; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd |= 0;
  return (rnd >>> 0) / 4294967296;
}

let W = { finish: 1000, open: 300, same: 40, unlock: 10, noise: 6, wide: 150 };
function jitterWeights() {
  if (process.env.NOJIT === '1') return;
  const j = (x, p) => x * (1 + (noise() * 2 - 1) * p);
  W = {
    finish: 1000,
    open: j(300, 0.5),
    same: j(40, 0.6),
    unlock: j(10, 0.8),
    noise: 6,
    wide: j(150, 0.7)
  };
}

// Candidate results must survive the recursive call, so each depth gets its own slice:
// a single shared buffer gets clobbered by the child frame and the parent then clicks a
// block that is no longer free.
const candBuf = new Int32Array(n * (n + 2));
const candScore = new Float64Array(n);

function candidates(depth) {
  const base = depth * n;
  let m = 0;
  for (let c = 0; c < clen; c++) {
    const i = clist[c];
    const t = type[i];
    let sc;
    if (hand[t] === 2) sc = W.finish;
    else if (hand[t] === 1) sc = W.open + clickable[t] * W.same;
    else sc = clickable[t] * W.same - (handSize >= 5 ? W.wide : 0);
    // blocks that uncover something score a little higher
    let un = 0;
    for (let p = invStart[i]; p < invStart[i + 1]; p++) if (cnt[invList[p]] === 1) un++;
    sc += un * W.unlock;
    sc += noise() * W.noise;
    // insertion into a sorted-by-score list (candidate sets are small)
    let q = m++;
    while (q > 0 && candScore[q - 1] < sc) {
      candScore[q] = candScore[q - 1];
      candBuf[base + q] = candBuf[base + q - 1];
      q--;
    }
    candScore[q] = sc; candBuf[base + q] = i;
  }
  return m;
}

const pathIdx = new Int32Array(n);
let pathLen = 0;

function clickBlock(i) {
  const t = type[i];
  removed[i] = 1; cnt[i] = 255; left--;
  h1 ^= Z1[i]; h2 ^= Z2[i];
  clDel(i);
  for (let p = invStart[i]; p < invStart[i + 1]; p++) {
    const v = invList[p];
    if (cnt[v] > 0 && cnt[v] !== 255) {
      cnt[v]--;
      if (cnt[v] === 0) clAdd(v);
    }
  }
  hand[t]++; handSize++;
  let triple = false;
  if (hand[t] === 3) { hand[t] = 0; handSize -= 3; triple = true; }
  return triple;
}

function unclickBlock(i, triple) {
  const t = type[i];
  if (triple) { hand[t] = 3; handSize += 3; }
  hand[t]--; handSize--;
  for (let p = invStart[i]; p < invStart[i + 1]; p++) {
    const v = invList[p];
    if (cnt[v] !== 255) {
      if (cnt[v] === 0) clDel(v);
      cnt[v]++;
    }
  }
  clAdd(i);
  left++; removed[i] = 0; cnt[i] = 0;
  h1 ^= Z1[i]; h2 ^= Z2[i];
}

let nodes = 0;
let bestLeft = n;
const t0 = Date.now();
let solved = false;
let abort = false;
let lastLog = 0;
let sliceOut = false;
let sliceEnd = Infinity;

function canFinishNow() {
  for (let c = 0; c < clen; c++) if (hand[type[clist[c]]] === 2) return true;
  return false;
}

function dfs() {
  if (solved || abort) return false;
  if ((++nodes & 2047) === 0) {
    const el = Date.now() - t0;
    if (el > MAX_S * 1000 || nodes > NODE_BUDGET) { abort = true; return false; }
    if (el > sliceEnd) { sliceOut = true; return false; }
    if (VERBOSE && el - lastLog > 5000) {
      lastLog = el;
      console.log('[dfs] ' + (el / 1000).toFixed(0) + 's nodes=' + nodes +
        ' depth=' + (n - left) + ' bestLeft=' + bestLeft + ' memo=' + memoCount +
        ' restart=' + restarts);
    }
  }
  if (left === 0 && handSize === 0) { solved = true; return true; }
  if (handSize >= HMAX) return false;
  if (left < bestLeft) bestLeft = left;

  const k = keyNow();
  if (memoHas(k)) return false;

  if (handSize < HMAX && !(handSize >= HMAX - 1 && !canFinishNow())) {
    const depth = pathLen;
    const base = depth * n;
    const m = candidates(depth);
    for (let c = 0; c < m; c++) {
      const i = candBuf[base + c];
      const tr = clickBlock(i);
      pathIdx[pathLen++] = i;
      if (dfs()) return true;
      pathLen--;
      unclickBlock(i, tr);
      if (left < bestLeft) bestLeft = left;
      if (solved) return true;
      if (abort || sliceOut) return false;   // interrupted: never memoise a partial subtree
    }
  }

  if (!solved && !abort && !sliceOut) memoAdd(k);
  return false;
}

function resetRun() {
  removed.fill(0);
  cnt.set(cover0);
  hand.fill(0);
  handSize = 0; left = n; h1 = 0; h2 = 0;
  pathLen = 0;
  sliceOut = false;
  frontierReset();
}

// Replaying the legal head of a plan found under a looser hand cap puts the search
// straight into the endgame region instead of making it rediscover 144 clicks.
const PREFIX = process.env.PREFIX || '';
const PREFIX_STEPS = parseInt(process.env.PREFIX_STEPS || '0', 10);
const idToIdx = new Map();
for (let i = 0; i < n; i++) idToIdx.set(String(blocks[i].id), i);

function applyPrefix() {
  if (!PREFIX || PREFIX_STEPS <= 0) return true;
  const plan = JSON.parse(fs.readFileSync(PREFIX, 'utf8'));
  const k = Math.min(PREFIX_STEPS, plan.length);
  for (let s = 0; s < k; s++) {
    const idx = idToIdx.get(String(plan[s].id));
    if (idx === undefined) { console.error('prefix step ' + s + ': unknown id ' + plan[s].id); return false; }
    if (removed[idx]) { console.error('prefix step ' + s + ': block already gone'); return false; }
    if (cnt[idx] !== 0) { console.error('prefix step ' + s + ': block is covered'); return false; }
    if (handSize >= HMAX) { console.error('prefix step ' + s + ': hand full, prefix is not ' + HMAX + '-legal'); return false; }
    clickBlock(idx);
    pathIdx[pathLen++] = idx;
  }
  return true;
}

let restarts = 0;
let ok = false;
let exhausted = false;
while (true) {
  resetRun();
  jitterWeights();
  sliceEnd = SLICE_MS > 0 ? (Date.now() - t0 + SLICE_MS) : Infinity;
  if (restarts) rnd = (RSEED + restarts * 7919) | 0;
  if (!applyPrefix()) { console.log('PREFIX INVALID - nothing searched'); process.exit(4); }
  if (dfs()) { ok = true; break; }
  if (abort) break;
  if (!sliceOut) { exhausted = true; break; }   // whole reachable tree refuted
  restarts++;
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
if (ok) {
  const plan = [];
  for (let k = 0; k < pathLen; k++) {
    const i = pathIdx[k];
    plan.push({ step: k, kind: 'board', id: blocks[i].id, type: type[i] });
  }
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 1));
  console.log('SOLVED steps=' + plan.length + ' nodes=' + nodes + ' time=' + dt +
    's restarts=' + restarts + ' rate=' + Math.round(nodes / (dt || 1) / 1000) + 'k/s -> ' + outPath);
  process.exit(0);
}

console.log('NO WIN nodes=' + nodes + ' time=' + dt + 's bestLeft=' + bestLeft + '/' + n +
  ' states=' + memoCount + ' restarts=' + restarts +
  ' rate=' + Math.round(nodes / (dt || 1) / 1000) + 'k/s' +
  (exhausted ? ' EXHAUSTED (proved unsolvable, no props)' : ' budget hit (unknown)'));
process.exit(exhausted ? 2 : 3);
