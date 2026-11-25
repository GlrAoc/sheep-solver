#!/usr/bin/env node
/**
 * Push an externally solved plan into the running bot.
 *
 *   node apply_plan.js <plan3.json>
 *
 * solve3.js writes steps as {kind:'board', id, ...} | {kind:'tray', type} | {kind:'park'}.
 * The bot re-derives per-step state signatures from the live board (setPlan), so any
 * drift (rejected click, manual input, animation) aborts the plan instead of misclicking.
 *
 * The resulting expression is written to .plan_expr.js and executed through eval_cdp.js.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const planFile = process.argv[2];
if (!planFile || !fs.existsSync(planFile)) {
  console.error('usage: node apply_plan.js <plan3.json>');
  process.exit(1);
}
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
if (!Array.isArray(plan) || !plan.length) {
  console.error('plan is empty');
  process.exit(1);
}

const expr = '(function(){try{'
  + 'var G=(typeof document!=="undefined"&&document.gameContext)?document.gameContext:(typeof globalThis!=="undefined"?globalThis:this);'
  + 'if(!G) return "no global";'
  + 'var b=G.__sheepBot; if(!b) return "no bot";'
  + 'return b.setPlan(' + JSON.stringify(plan) + ');'
  + '}catch(e){return "ERR:"+e;}})()';

const tmp = path.join(__dirname, '.plan_expr.js');
fs.writeFileSync(tmp, expr, 'utf8');
console.log('plan steps:', plan.length, '->', path.basename(tmp));

const r = spawnSync(process.execPath, [path.join(__dirname, 'eval_cdp.js'), '--file', tmp], {
  encoding: 'utf8'
});
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
