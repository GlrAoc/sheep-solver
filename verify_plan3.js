#!/usr/bin/env node
/**
 * verify_plan3.js - replays a beam3 plan against a board and asserts every step is legal.
 *
 *   node verify_plan3.js <board.json> <plan.json>
 *
 * Deliberately re-implemented from the decompiled client, not shared with the solver:
 *   - a block may be clicked only when every block stacked above it is gone
 *   - a click is refused when getCrushBlockNum() >= 7  (hand has no lingering triple => that is |hand|)
 *   - the new card is inserted after the last card of the same type; three of a type collapse
 *   - moveOutBlock() splices the first min(3,|hand|) cards off the hand and pushes card k into slot k
 *   - of each slot only the last (top) card is interactive
 *   - win = nothing left on the board, in the hand, or in the three slots
 */
const fs = require('fs');

const boardPath = process.argv[2];
const planPath = process.argv[3];
if (!boardPath || !planPath) { console.error('usage: node verify_plan3.js <board.json> <plan.json> [--at N] [--dump out.json]'); process.exit(2); }

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const AT = argOf('--at') !== null ? parseInt(argOf('--at'), 10) : -1;
const DUMP = argOf('--dump');

const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const blocks = board.blocks;
const n = blocks.length;
const D = 8;

const byId = new Map();
blocks.forEach((b, i) => byId.set(b.id, i));

const alive = new Array(n).fill(true);
const above = new Array(n).fill(0);   // blocks sitting on top of i
for (let j = 0; j < n; j++) {
  for (let k = 0; k < n; k++) {
    if (j === k) continue;
    const a = blocks[j], b = blocks[k];
    if (a.layerNum > b.layerNum && Math.abs(a.rowNum - b.rowNum) < D && Math.abs(a.rolNum - b.rolNum) < D) {
      above[k]++;
    }
  }
}
// removal -> decrement `above` for everything the removed block was covering
const covers = new Array(n);
for (let i = 0; i < n; i++) covers[i] = [];
for (let j = 0; j < n; j++) {
  for (let k = 0; k < n; k++) {
    if (j === k) continue;
    const a = blocks[j], b = blocks[k];
    if (a.layerNum > b.layerNum && Math.abs(a.rowNum - b.rowNum) < D && Math.abs(a.rolNum - b.rolNum) < D) {
      covers[j].push(k);
    }
  }
}

let hand = Array.isArray(board.hand) ? board.hand.slice() : [];
const tray = [[], [], []];
if (Array.isArray(board.traySlots)) {
  for (let k = 0; k < 3; k++) tray[k] = (board.traySlots[k] || []).slice();
}

function addCard(t) {
  let pos = hand.length;
  for (let i = hand.length - 1; i >= 0; i--) if (hand[i] === t) { pos = i + 1; break; }
  hand.splice(pos, 0, t);
  const same = hand.filter((v) => v === t);
  if (same.length >= 3) {
    let dropped = 0;
    hand = hand.filter((v) => (v === t && dropped++ < 3 ? false : true));
    return true;
  }
  return false;
}
function crushNum() { return hand.length; }   // never holds a triple, so this is the client value

let wins = 0;
for (let i = 0; i < plan.length; i++) {
  const s = plan[i];
  if (s.step !== i) { console.error('FAIL step index mismatch at ' + i); process.exit(1); }

  if (s.kind === 'board') {
    const idx = byId.get(s.id);
    if (idx === undefined) { console.error('FAIL step ' + i + ': unknown block ' + s.id); process.exit(1); }
    if (!alive[idx]) { console.error('FAIL step ' + i + ': block ' + s.id + ' already removed'); process.exit(1); }
    if (above[idx] !== 0) { console.error('FAIL step ' + i + ': block ' + s.id + ' is covered by ' + above[idx]); process.exit(1); }
    if (blocks[idx].type !== s.type) { console.error('FAIL step ' + i + ': type mismatch on ' + s.id); process.exit(1); }
    if (crushNum() >= 7) { console.error('FAIL step ' + i + ': hand ' + hand.length + ' refuses the click'); process.exit(1); }
    alive[idx] = false;
    for (const v of covers[idx]) above[v]--;
    addCard(blocks[idx].type);
  } else if (s.kind === 'tray') {
    const stack = tray[s.slot];
    if (!stack || !stack.length) { console.error('FAIL step ' + i + ': slot ' + s.slot + ' is empty'); process.exit(1); }
    const top = stack[stack.length - 1];
    if (top !== s.type) { console.error('FAIL step ' + i + ': slot ' + s.slot + ' top is ' + top + ', plan says ' + s.type); process.exit(1); }
    if (crushNum() >= 7) { console.error('FAIL step ' + i + ': hand ' + hand.length + ' refuses the tray pull'); process.exit(1); }
    stack.pop();
    addCard(top);
  } else if (s.kind === 'park') {
    if (!hand.length) { console.error('FAIL step ' + i + ': park with an empty hand'); process.exit(1); }
    const take = Math.min(3, hand.length);
    const moved = hand.splice(0, take);
    const got = moved.join(',');
    if (got !== s.moved.join(',')) { console.error('FAIL step ' + i + ': park moved [' + got + '] but plan says [' + s.moved + ']'); process.exit(1); }
    for (let k = 0; k < take; k++) tray[k].push(moved[k]);
  } else {
    console.error('FAIL step ' + i + ': unknown kind ' + s.kind);
    process.exit(1);
  }

  if (AT >= 0 && i + 1 === AT) {
    const rest = [];
    for (let q = 0; q < n; q++) if (alive[q]) rest.push(blocks[q]);
    const out = {
      levelKey: board.levelKey,
      note: 'mid-game dump after ' + AT + ' steps of ' + planPath,
      blocks: rest,
      hand: hand.slice(),
      traySlots: [tray[0].slice(), tray[1].slice(), tray[2].slice()]
    };
    const target = DUMP || 'midgame.board.json';
    fs.writeFileSync(target, JSON.stringify(out, null, 1));
    console.log('mid-game dump -> ' + target + '  (board=' + rest.length + ' hand=' + hand.length +
      ' tray=' + (tray[0].length + tray[1].length + tray[2].length) + ')');
    process.exit(0);
  }
}

const leftOnBoard = alive.filter(Boolean).length;
const trayLen = tray[0].length + tray[1].length + tray[2].length;
console.log('steps        : ' + plan.length);
console.log('board left   : ' + leftOnBoard);
console.log('hand         : [' + hand.join(',') + ']');
console.log('tray slots   : ' + tray.map((x) => '[' + x.join(',') + ']').join(' '));
if (leftOnBoard === 0 && hand.length === 0 && trayLen === 0) {
  console.log('RESULT       : WIN - every step legal, all 3 containers empty');
  process.exit(0);
}
console.log('RESULT       : INCOMPLETE');
process.exit(1);
