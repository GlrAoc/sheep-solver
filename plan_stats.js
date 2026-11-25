#!/usr/bin/env node
/**
 * plan_stats.js - describe a click plan without touching the board.
 *
 * Legal click order is checked by verify_plan3.js; this only answers "how many cards
 * does the hand have to hold at once", which is the one number that decides whether a
 * plan can be played with the client's 7-slot hand at all.
 *
 *   node plan_stats.js <plan.json>
 */

const fs = require('fs');

const p = process.argv[2];
if (!p) {
  console.error('usage: node plan_stats.js <plan.json>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!Array.isArray(plan)) {
  console.error('plan is not an array');
  process.exit(1);
}

let hand = [];
const peakByType = {};
let peak = 0, peakStep = -1, peakHand = [], triples = 0, clicks = 0;
let peakBefore = 0, peakBeforeStep = -1;

for (const s of plan) {
  if (s.kind && s.kind !== 'board') {
    console.error('FAIL: plan contains a non-board action (' + s.kind + ') at step ' + s.step);
    process.exit(1);
  }
  clicks++;

  // The client refuses a click when getCrushBlockNum() >= 7, i.e. on the hand as it
  // stands BEFORE the card is added. That pre-click size is the binding constraint.
  const before = hand.length;
  if (before > peakBefore) { peakBefore = before; peakBeforeStep = s.step; }

  hand.push(s.type);

  let same = 0;
  for (const v of hand) if (v === s.type) same++;
  if (same >= 3) {
    let dropped = 0;
    hand = hand.filter((v) => !(v === s.type && dropped++ < 3));
    triples++;
  }

  if (hand.length > peak) {
    peak = hand.length;
    peakStep = s.step;
    peakHand = hand.slice();
    const m = {};
    for (const v of hand) m[v] = (m[v] || 0) + 1;
    for (const k in m) peakByType[k] = m[k];
  }
}

console.log('steps        : ' + clicks);
console.log('triples      : ' + triples);
console.log('peak hand    : ' + peakBefore + ' before a click' +
  (peakBeforeStep >= 0 ? ' (step ' + peakBeforeStep + ')' : '') +
  ', ' + peak + ' after a click' +
  (peakStep >= 0 ? ' (step ' + peakStep + ')' : ''));
if (peak > 0) {
  console.log('peak contents: ' + peakHand.length + ' cards, types ' +
    JSON.stringify(peakByType));
}
console.log('final hand   : ' + hand.length + (hand.length ? ' -> ' + JSON.stringify(hand) : ''));
console.log('7-slot legal : ' + (peakBefore <= 6
  ? 'YES (click never sees a 7-card hand)'
  : 'NO - the click at step ' + peakBeforeStep + ' sees ' + peakBefore +
    ' cards, the client refuses at 7'));
