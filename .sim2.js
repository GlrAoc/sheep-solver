#!/usr/bin/env node
/**
 * .sim2.js - independent executor for a board plan, written from the client rules only.
 *
 * Deliberately a second implementation (plain arrays, no shared code with dfs_park.js)
 * so a plan is only accepted when both agree.
 *
 * Rules:
 *   insert  getNewPosit(): a new card goes right AFTER the last card of the same type
 *   crush   the hand holding 3 of a type eliminates them (they are contiguous)
 *   click   refused while getCrushBlockNum() >= 7
 *   park    moveOutBlock(): hand.splice(0, min(3,len)) -> slot[k % 3].push(card)
 *   tray    tapping the TOP card of a slot puts it back into the hand
 *   win     blocks == 0 AND hand == 0 AND tray == 0
 *
 *   node .sim2.js <plan.json> <board.json> [parkMax]
 */
const fs = require('fs');

const planPath = process.argv[2];
const boardPath = process.argv[3];
const PARK_MAX = process.argv[4] === undefined ? 99 : +process.argv[4];

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
const blocks = Array.isArray(board.blocks) ? board.blocks : board;

const typeOf = new Map();
for (const b of blocks) typeOf.set(String(b.id), b.type);

const HMAX = 7;
const PARK_AT = process.env.PARK_AT === undefined ? HMAX : +process.env.PARK_AT;

function run() {
  const hand = [];
  const slots = [[], [], []];
  let parks = 0, peak = 0, peakStep = -1, triples = 0, trayPeak = 0, stepNow = -1;
  const events = [];

  function insert(t) {
    let pos = hand.length;
    for (let i = hand.length - 1; i >= 0; i--) if (hand[i] === t) { pos = i + 1; break; }
    hand.splice(pos, 0, t);
    if (hand.length > peak) { peak = hand.length; peakStep = stepNow; }
    const c = hand.filter((x) => x === t).length;
    if (c === 3) {
      let dropped = 0;
      for (let i = 0; i < hand.length && dropped < 3; ) {
        if (hand[i] === t) { hand.splice(i, 1); dropped++; } else i++;
      }
      triples++;
      return true;
    }
    return false;
  }

  for (let s = 0; s < plan.length; s++) {
    const step = plan[s];
    const kind = step.kind;
    stepNow = s;

    if (kind === 'park') {
      if (!hand.length) return { ok: false, err: `park at ${s} with empty hand`, peak, triples };
      if (parks >= PARK_MAX) return { ok: false, err: `park at ${s} over parkMax=${PARK_MAX}`, peak, triples };
      const take = Math.min(3, hand.length);
      const moved = hand.splice(0, take);
      for (let k = 0; k < take; k++) slots[k % 3].push(moved[k]);
      parks++;
      const tp = slots.reduce((a, x) => a + x.length, 0);
      if (tp > trayPeak) trayPeak = tp;
      events.push({ at: s, act: 'park', cards: moved.slice() });
      continue;
    }

    if (kind === 'tray') {
      const sl = slots[step.slot];
      if (!sl || !sl.length) return { ok: false, err: `tray tap at ${s}: slot ${step.slot} empty`, peak, triples };
      if (hand.length >= HMAX) return { ok: false, err: `tray tap at ${s}: hand full`, peak, triples };
      const t = sl.pop();
      insert(t);
      events.push({ at: s, act: 'tray', slot: step.slot, type: t });
      continue;
    }

    const id = String(step.id);
    const t = typeOf.get(id);
    if (t === undefined) return { ok: false, err: `unknown id ${id} at ${s}`, peak, triples };

    // AUTOPULL=1: a tray top that completes a pair is always worth taking back --
    // it frees three slots instead of one
    if (process.env.AUTOPULL === '1') {
      for (let pass = 0; pass < 3; pass++) {
        let pulled = false;
        for (let sl = 0; sl < 3; sl++) {
          const st = slots[sl];
          if (!st.length) continue;
          const top = st[st.length - 1];
          const have = hand.filter((x) => x === top).length;
          if (have === 2 && hand.length < HMAX) {
            st.pop(); insert(top); pulled = true;
            events.push({ at: s, act: 'autopull', slot: sl, type: top });
            break;
          }
        }
        if (!pulled) break;
      }
    }

    if (hand.length >= PARK_AT) {
      // AUTOPARK=1: repair a plan that was solved under a looser hand cap by parking
      // exactly when the client would refuse the click. PARK_AT lets the sweep park
      // earlier than full: the three oldest cards are the ones that must survive the trip,
      // so parking at 5 or 6 can free room before the head of the bar turns valuable.
      if (process.env.AUTOPARK === '1' && parks < PARK_MAX) {
        const take = Math.min(3, hand.length);
        const moved = hand.splice(0, take);
        for (let k = 0; k < take; k++) slots[k % 3].push(moved[k]);
        parks++;
        events.push({ at: s, act: 'autopark', cards: moved.slice() });
      } else {
        return { ok: false, err: `click at ${s} refused: hand holds ${hand.length}`, peak, triples };
      }
    }

    insert(t);
    if (hand.length > peak) { peak = hand.length; peakStep = s; }
  }

  const trayLeft = slots.reduce((a, x) => a + x.length, 0);
  return {
    ok: hand.length === 0 && trayLeft === 0,
    handLeft: hand.length, trayLeft, peak, peakStep, trayPeak, parks, triples, events,
    hand: hand.slice(), slots: slots.map((x) => x.slice())
  };
}

const r = run();
console.log(`plan=${planPath.split(/[\\/]/).pop()} steps=${plan.length} parkMax=${PARK_MAX}`);
console.log(`  ok=${r.ok} peakHand=${r.peak}(step ${r.peakStep}) peakTray=${r.trayPeak || 0} parks=${r.parks} triples=${r.triples}`);
if (r.err) console.log(`  ERR ${r.err}`);
if (!r.ok && !r.err) console.log(`  leftover hand=${JSON.stringify(r.hand)} tray=${JSON.stringify(r.slots)}`);
if (process.env.SHOW_EVENTS === '1') for (const e of r.events) console.log('   ' + JSON.stringify(e));
process.exit(r.ok ? 0 : 1);
