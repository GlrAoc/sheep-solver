#!/usr/bin/env node
/**
 * 离线模拟：按给定方案点击，在手牌达到上限时插入一次「移出」。
 * 目的：验证 11 格方案（peak=10）能否靠"7 手牌 + 3 移出"跑完。
 *
 *   node .sim_moveout.js <plan.json> <board.json> [handMax] [parkAt]
 *
 * 移出语义（来自 moveOutBlock / addThreeOutBlock 源码）：
 *   crushArray.splice(0, 3) -> moveOutObj[1..3].push(...)
 *   即取"最早点击且仍未消除的 3 张"，放进 3 个可堆叠的槽。
 *   本模拟按两种假设各跑一遍：
 *     A) 暂存区的牌不参与三消（最坏情况）
 *     B) 暂存区的牌参与三消（当手牌凑齐同色第 3 张时一起消）
 */
const fs = require('fs');

const planPath = process.argv[2];
const boardPath = process.argv[3];
const HMAX = +(process.argv[4] || 7);
const PARK_AT = process.argv[5] === undefined ? HMAX : +(process.argv[5]);

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));

const typeOf = {};
board.blocks.forEach((b) => { typeOf[String(b.id)] = b.type; });

function simulate(parkParticipates) {
  const hand = [];              // FIFO: { id, type }
  let parked = [[], [], []];    // 3 slots, each stackable
  let parkedUsed = false;
  let peak = 0;
  let triples = 0;
  const events = [];

  function tryCrush() {
    // 手牌内三消：只看手牌末尾（新加入的牌触发）
    const counts = {};
    for (const c of hand) counts[c.type] = (counts[c.type] || 0) + 1;
    for (const tStr of Object.keys(counts)) {
      if (counts[tStr] >= 3) {
        const t = Number(tStr);
        let need = 3;
        for (let i = hand.length - 1; i >= 0 && need > 0; i--) {
          if (hand[i].type === t) { hand.splice(i, 1); need--; }
        }
        triples++;
        // 假设 B：暂存区里同色的牌也能跟着消
        if (parkParticipates) {
          for (let s = 0; s < 3; s++) {
            for (let j = parked[s].length - 1; j >= 0; j--) {
              if (parked[s][j] === t) { parked[s].splice(j, 1); break; }
            }
          }
        }
        return true;
      }
    }
    return false;
  }

  for (let s = 0; s < plan.length; s++) {
    const step = plan[s];
    const id = String(step.id);
    const t = typeOf[id];
    if (t === undefined) return { ok: false, err: 'unknown id at step ' + s, peak, triples, events };

    // 手牌满且还有移出可用 -> 先移出
    if (hand.length >= PARK_AT && !parkedUsed) {
      const take = Math.min(hand.length, 3);
      const moved = hand.splice(0, take);
      moved.forEach((c, i) => parked[i % 3].push(c.type));
      parkedUsed = true;
      events.push({ at: s, act: 'park', cards: moved.map((c) => c.type), handLeft: hand.length });
      tryCrush();
    }

    if (hand.length >= HMAX) {
      return { ok: false, err: `hand overflow at step ${s} (${hand.length})`, peak, triples, events, parked };
    }

    hand.push({ id, type: t });
    if (hand.length > peak) peak = hand.length;
    tryCrush();
  }

  const parkedLeft = parked.reduce((a, b) => a + b.length, 0);
  return {
    ok: hand.length === 0 && parkedLeft === 0,
    handLeft: hand.length,
    parkedLeft,
    parked: parked.map((s) => s.slice()),
    peak,
    triples,
    events
  };
}

console.log('plan=' + planPath.split(/[\\/]/).pop() + ' steps=' + plan.length + ' HMAX=' + HMAX + ' parkAt=' + PARK_AT);

const A = simulate(false);
console.log('\n[A] 暂存区不参与三消（最坏情况）');
console.log('  ok=' + A.ok + '  handLeft=' + A.handLeft + '  parkedLeft=' + A.parkedLeft
  + '  peak=' + A.peak + '  triples=' + A.triples);
if (A.err) console.log('  err=' + A.err);
if (A.events) console.log('  park: ' + JSON.stringify(A.events));

const B = simulate(true);
console.log('\n[B] 暂存区参与三消（乐观）');
console.log('  ok=' + B.ok + '  handLeft=' + B.handLeft + '  parkedLeft=' + B.parkedLeft
  + '  peak=' + B.peak + '  triples=' + B.triples);
if (B.err) console.log('  err=' + B.err);
if (B.events) console.log('  park: ' + JSON.stringify(B.events));
if (B.parked) console.log('  剩余暂存区: ' + JSON.stringify(B.parked));
