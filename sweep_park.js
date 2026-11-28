#!/usr/bin/env node
/**
 * sweep_park.js - find a real board where one "move out" turns NO WIN into WIN.
 *
 * For each board: prove the 7-slot pure run fails, then let dfs_park use one park,
 * then validate the resulting plan with verify_plan3 (an independent implementation).
 *   node sweep_park.js <board...>
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const NODE = process.execPath;
const boards = process.argv.slice(2);

function run(args, env, timeout) {
  const r = spawnSync(NODE, args, {
    cwd: DIR, encoding: 'utf8', timeout,
    env: Object.assign({}, process.env, env), maxBuffer: 32 * 1024 * 1024
  });
  return (r.stdout || '') + (r.stderr || '');
}

for (const b of boards) {
  const name = path.basename(b);
  const n = JSON.parse(fs.readFileSync(path.join(DIR, b), 'utf8')).blocks.length;
  const pureOut = path.join(DIR, '.sw_pure.plan.json');
  try { fs.unlinkSync(pureOut); } catch (e) { }

  const pure = run(['dfs_nopark.js', b, '10', '3000000000', '12345'], { PLAN_OUT: pureOut }, 40000);
  if (/SOLVED/.test(pure)) { console.log(`${name} (${n}): pure 7-slot SOLVED -> not a park case`); continue; }
  const bl = (/bestLeft=(\d+)/.exec(pure) || [])[1];

  const parkOut = path.join(DIR, '.sw_park.plan.json');
  try { fs.unlinkSync(parkOut); } catch (e) { }
  const park = run(['dfs_park.js', b, '25', '4000000000', '12345'], {
    PARK_MAX: '1', MEMO_BITS: '25', PLAN_OUT: parkOut
  }, 60000);
  if (!/SOLVED/.test(park) || !fs.existsSync(parkOut)) {
    console.log(`${name} (${n}): pure bestLeft=${bl} | park1 NO WIN -> ${(/bestLeft=(\d+)/.exec(park) || [])[1]}`);
    continue;
  }
  const v = run(['verify_plan3.js', b, parkOut], {}, 120000);
  const win = /RESULT\s*:\s*WIN/.test(v);
  console.log(`${name} (${n}): pure bestLeft=${bl} | park1 ${park.match(/SOLVED[^\n]*/)[0]} | verify=${win ? 'WIN' : 'FAIL'}`);
  if (!win) console.log(v.slice(-500));
}
