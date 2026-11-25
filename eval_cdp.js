#!/usr/bin/env node
/**
 * Evaluate an expression inside the WeChat mini-program appservice (via a paused frame).
 *
 *   node eval_cdp.js "<expr>"
 *   node eval_cdp.js --file expr.js
 *   node eval_cdp.js --file expr.js --out result.json
 *   node eval_cdp.js --file expr.js --no-resume
 *
 * Env: CDP_WS (default ws://127.0.0.1:62000)
 *
 * The WMPF service layer has no Runtime.evaluate; the only way in is
 * Debugger.pause -> Debugger.evaluateOnCallFrame -> Debugger.resume.
 * Debugger.pause does not always land on the first try, so it is retried.
 */
const fs = require('fs');

const args = process.argv.slice(2);
let expr = null;
let noResume = false;
let outFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') expr = fs.readFileSync(args[++i], 'utf8');
  else if (args[i] === '--no-resume') noResume = true;
  else if (args[i] === '--out') outFile = args[++i];
  else if (!expr) expr = args[i];
}
if (!expr) { console.error('usage: node eval_cdp.js "<expr>" | --file f.js [--out r.json]'); process.exit(1); }

const WS = process.env.CDP_WS || 'ws://127.0.0.1:62000';
const ws = new WebSocket(WS);
let seq = 0;
const pending = new Map();
let done = false;
let pausedSeen = false;
let busy = false;
let ctxTries = 0;

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

function finish(msg, ok) {
  if (done) return;
  done = true;
  if (msg !== undefined) console.log(msg);
  try { ws.close(); } catch (e) { }
  setTimeout(() => process.exit(ok ? 0 : 1), 120);
}

// The proxy pauses whichever JS context happens to be current. Only the game VM exposes
// document.gameContext, so a payload sent to the wrong context sees undefined globals
// (symptom: "no bot" while the bot is installed). Probe, and re-pause until we land right.
async function handlePaused(m) {
  const frames = (m.params && m.params.callFrames) || [];
  if (!frames.length) return finish('[eval] no frames', false);
  const fid = frames[0].callFrameId;
  try {
    const probe = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: fid,
      expression: "!!(typeof document!=='undefined'&&document&&document.gameContext)",
      returnByValue: true, silent: true
    });
    const ok = probe && probe.result && probe.result.value === true;
    if (!ok && ctxTries < 8) {
      ctxTries++;
      await send('Debugger.resume').catch(() => { });
      setTimeout(() => { send('Debugger.pause').catch(() => { }); }, 300);
      return;
    }
  } catch (e) { }
  try {
    const r = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: fid, expression: expr, returnByValue: true, silent: false, timeout: 15000
    });
    if (r.exceptionDetails) {
      console.log('[eval] EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 1000));
    } else {
      const v = r.result.value;
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      if (outFile) {
        fs.writeFileSync(outFile, typeof v === 'string' ? v : JSON.stringify(v, null, 1), 'utf8');
        console.log('[eval] -> ' + outFile + ' (' + (text ? text.length : 0) + ' chars)');
      } else {
        console.log(text);
      }
    }
    if (!noResume) await send('Debugger.resume').catch(() => { });
    finish(undefined, true);
  } catch (e) {
    console.log('[eval] error ' + e.message);
    await send('Debugger.resume').catch(() => { });
    finish(undefined, false);
  }
}

ws.onopen = async () => {
  try {
    await send('Debugger.enable');
    let tries = 0;
    const kick = setInterval(() => {
      if (pausedSeen || done) { clearInterval(kick); return; }
      if (++tries > 10) { clearInterval(kick); finish('[eval] pause never hit', false); return; }
      send('Debugger.pause').catch(() => { });
    }, 1200);
    send('Debugger.pause').catch(() => { });
  } catch (e) { finish('[eval] enable failed: ' + e.message, false); }
};

ws.onmessage = async (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error))); else p.resolve(m.result);
    return;
  }
  if (m.method === 'Debugger.paused') {
    if (busy || done) return;
    busy = true;
    pausedSeen = true;
    try { await handlePaused(m); } finally { busy = false; }
    return;
  }
};
ws.onerror = (e) => { console.log('[eval] ws error ' + (e && (e.message || e.type))); };
ws.onclose = () => { if (!done) finish('[eval] closed', false); };
// The pause trick only works while the client is running JS. A win/lose screen, a paused
// level or a stopped render loop leaves nothing to pause, so cap the wait and say why.
const WAIT_MS = parseInt(process.env.EVAL_WAIT_MS || '45000', 10);
setTimeout(() => {
  finish('[eval] timeout after ' + Math.round(WAIT_MS / 1000) + 's - the client is not executing JS right now ' +
    '(win/lose screen or paused level). Wake it (tap 下一关/继续) and rerun.', false);
}, WAIT_MS);
