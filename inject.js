#!/usr/bin/env node
/**
 * 通过 CDP 代理注入 JS 到微信小程序 (WMPF) 的 appservice 上下文
 *
 *   node inject.js <script.js> [ws://127.0.0.1:62000] [timeoutMs]
 *
 * 流程: Debugger.enable -> Debugger.pause -> 等 paused
 *       -> Debugger.evaluateOnCallFrame(脚本内容) -> Debugger.resume
 *
 * 注: 该层不支持 Runtime.evaluate, 必须走暂停帧求值。
 */
const fs = require('fs');

const file = process.argv[2];
const WS = process.argv[3] || 'ws://127.0.0.1:62000';
const TIMEOUT = parseInt(process.argv[4] || '25000', 10);
if (!file) { console.error('usage: node inject.js <script.js> [ws] [timeoutMs]'); process.exit(1); }

const code = fs.readFileSync(file, 'utf8');
const ws = new WebSocket(WS);

let seq = 0;
const pending = new Map();
let pausedFrame = null;
let done = false;
let busy = false;
let pausedSeen = false;
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
  console.log(msg);
  try { ws.close(); } catch (e) { }
  setTimeout(() => process.exit(ok ? 0 : 1), 150);
}

ws.onopen = async () => {
  console.log('[inject] connected', WS);
  try {
    await send('Debugger.enable');
    console.log('[inject] debugger enabled');
    // 反复请求暂停, 直到真的 paused (某些帧不可暂停)
    let tries = 0;
    const kick = setInterval(() => {
      if (pausedSeen || done) { clearInterval(kick); return; }
      if (++tries > 12) { clearInterval(kick); finish('[inject] pause never hit', false); return; }
      send('Debugger.pause').catch(() => { });
    }, 1200);
    send('Debugger.pause').catch(() => { });
  } catch (e) {
    finish('[inject] enable failed: ' + e.message, false);
  }
};

ws.onmessage = async (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
    else p.resolve(m.result);
    return;
  }
  if (m.method === 'Debugger.paused') {
    if (busy || done) return;
    busy = true;
    pausedSeen = true;
    const frames = (m.params && m.params.callFrames) || [];
    if (!frames.length) { busy = false; return finish('[inject] no call frames', false); }
    const fid = frames[0].callFrameId;
    try {
      // only the game VM exposes document.gameContext; otherwise the payload lands on the
      // wrong global and later scripts see "no bot" while the bot is actually installed
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
        busy = false;
        return;
      }
      pausedFrame = fid;
      console.log('[inject] paused at', frames[0].url, 'line', frames[0].location && frames[0].location.line, 'col', frames[0].location && frames[0].location.column);
      try {
        const r = await send('Debugger.evaluateOnCallFrame', {
          callFrameId: pausedFrame,
          expression: code,
          returnByValue: true,
          silent: false,
          timeout: 10000
        });
        if (r.exceptionDetails) {
          console.log('[inject] EXCEPTION:', JSON.stringify(r.exceptionDetails).slice(0, 800));
        } else {
          console.log('[inject] result:', JSON.stringify(r.result && r.result.value));
        }
        await send('Debugger.resume').catch(() => { });
        finish('[inject] done', !r.exceptionDetails);
      } catch (e) {
        console.log('[inject] evaluate failed: ' + e.message);
        await send('Debugger.resume').catch(() => { });
        finish('[inject] failed', false);
      }
    } finally {
      busy = false;
    }
  }
};

ws.onerror = (e) => { console.log('[inject] ws error', e && (e.message || e.type)); };
ws.onclose = () => { if (!done) finish('[inject] closed unexpectedly', false); };

setTimeout(() => finish('[inject] timeout - 小程序是否已打开/已启用调试?', false), TIMEOUT);
