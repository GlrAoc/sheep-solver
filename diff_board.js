#!/usr/bin/env node
/**
 * diff_board.js - prove the offline generator reproduces the live board.
 *
 *   node diff_board.js <generated.board.json> <live_dump.json>
 *
 * Both sides are reduced to the same identity: "<layer>-<rol>-<row>:<type>".
 * Exit 0 = identical, 2 = mismatch (prints up to 20 differences).
 */
const fs = require('fs');

const aPath = process.argv[2], bPath = process.argv[3];
if (!aPath || !bPath) { console.error('usage: node diff_board.js <gen.json> <live.json>'); process.exit(1); }

function load(p) {
  const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  const d = o.dump || o;
  const blocks = d.blocks || [];
  const key = (b) => b.id || (b.layerNum + '-' + b.rolNum + '-' + b.rowNum);
  return { blocks, levelKey: d.levelKey, key };
}

const A = load(aPath), B = load(bPath);
const mapA = new Map(), mapB = new Map();
for (const b of A.blocks) mapA.set(A.key(b), b.type);
for (const b of B.blocks) mapB.set(B.key(b), b.type);

let same = 0;
const onlyA = [], onlyB = [], diffType = [];
for (const [k, t] of mapA) {
  if (!mapB.has(k)) onlyA.push(k);
  else if (mapB.get(k) !== t) diffType.push(k + ' gen=' + t + ' live=' + mapB.get(k));
  else same++;
}
for (const k of mapB.keys()) if (!mapA.has(k)) onlyB.push(k);

console.log('generated blocks : ' + A.blocks.length + (A.levelKey ? ' levelKey=' + A.levelKey : ''));
console.log('live      blocks : ' + B.blocks.length + (B.levelKey ? ' levelKey=' + B.levelKey : ''));
console.log('identical        : ' + same);
console.log('only generated   : ' + onlyA.length + (onlyA.length ? ' e.g. ' + onlyA.slice(0, 10).join(' ') : ''));
console.log('only live        : ' + onlyB.length + (onlyB.length ? ' e.g. ' + onlyB.slice(0, 10).join(' ') : ''));
console.log('type mismatch    : ' + diffType.length + (diffType.length ? ' e.g. ' + diffType.slice(0, 10).join(' | ') : ''));

const ok = onlyA.length === 0 && onlyB.length === 0 && diffType.length === 0 && A.blocks.length > 0;
console.log(ok ? 'RESULT: MATCH - the seed reproduces the live board exactly'
  : 'RESULT: MISMATCH - the generator does not match this client build');
process.exit(ok ? 0 : 2);
