/**
 * Sheep auto-player bot (injected, v4)
 *
 * Model is an exact match of the client behaviour:
 *   - clickable(i) <=> no remaining j: layer[j] > layer[i] && |dRow| < 8 && |dRol| < 8
 *   - click -> hand.push(type); three of a kind auto-eliminate
 *   - removeCardNode refuses the click when the hand already holds 7 -> hand must stay <= 6
 *   - prop "moveOut" (once): moves hand[0..min(3,len)] to a 3-slot tray; tray cards can be
 *     clicked back into the hand at any time
 *   - win: board empty && hand empty && tray empty
 *
 * Execution:
 *   - full DFS plan when the board is solvable within the budget
 *   - otherwise one greedy legal step per tick
 *   - every step carries the expected post-state signature; any mismatch (animation,
 *     rejected click, manual interference) drops the plan and replans
 *
 * Control handle: <G>.__sheepBot   (G = document.gameContext || globalThis)
 *
 * ASCII only on purpose: this file is injected as a single expression through
 * Debugger.evaluateOnCallFrame and encoding round-trips corrupt non-ASCII text.
 */
(function () {
  'use strict';
  var G = (typeof document !== 'undefined' && document.gameContext) ? document.gameContext
    : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!G) return 'no global';
  var cc = G.cc || (typeof cc !== 'undefined' ? cc : null);
  if (!cc || !cc.director) return 'no cc';

  if (G.__sheepBot && G.__sheepBot.stop) { try { G.__sheepBot.stop(); } catch (e) { } }

  var SUB = 8;
  var LOGS = [];
  function log() {
    var p = [];
    for (var i = 0; i < arguments.length; i++) p.push(String(arguments[i]));
    var s = p.join(' ');
    LOGS.push(new Date().toISOString().slice(11, 19) + ' ' + s);
    if (LOGS.length > 600) LOGS.shift();
    try { console.log('[sheep-bot] ' + s); } catch (e) { }
  }

  var CFG = {
    tickMs: 300,
    planBudgetMs: 2500,   // first deep attempt per level
    retryBudgetMs: 700,   // later attempts
    maxHand: 6,           // hand length must stay below 7
    maxClicks: 5000,      // a full 246-block level plus move-outs runs ~900 steps
    internalFallback: false,  // the in-page solver still models the tray as one free pool
    dryRun: false
  };

  // ---------------- component lookup ----------------
  function findComps() {
    var scene = cc.director.getScene();
    var out = { scene: scene, cb: null, crush: null, moveOut: null, ui: null };
    if (!scene) return out;
    var stack = [scene];
    while (stack.length) {
      var n = stack.pop();
      var comps = n._components || [];
      for (var i = 0; i < comps.length; i++) {
        var c = comps[i];
        if (!c) continue;
        if (!out.cb && ('nowLevelBlockObj' in c) && typeof c.checkIsShow === 'function') out.cb = c;
        else if (!out.crush && ('crushArray' in c) && typeof c.moveOutBlock === 'function') out.crush = c;
        else if (!out.moveOut && ('moveOutObj' in c)) out.moveOut = c;
        else if (!out.ui && typeof c.removeEndFunc === 'function') out.ui = c;
      }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) stack.push(ch[k]);
    }
    return out;
  }

  // ---------------- state reading ----------------
  function blockCompOf(node) {
    var cs = (node && node._components) || [];
    for (var i = 0; i < cs.length; i++) {
      if (cs[i] && cs[i].cardDataObj && typeof cs[i].touchEnd === 'function') return cs[i];
    }
    return null;
  }

  function readBoard(cb) {
    var obj = cb.nowLevelBlockObj || {};
    var list = [];
    for (var L in obj) for (var R in obj[L]) for (var C2 in obj[L][R]) {
      var comp = blockCompOf(obj[L][R][C2]);
      if (!comp) continue;
      list.push({
        key: L + '-' + C2 + '-' + R,
        layer: +L, row: +R, rol: +C2,
        type: comp.cardDataObj.type, comp: comp
      });
    }
    return list;
  }

  function readHand(crush) {
    var a = (crush && crush.crushArray) || [], out = [];
    for (var i = 0; i < a.length; i++) if (a[i] && a[i].cardDataObj) out.push(a[i].cardDataObj.type);
    return out;
  }

  // moveOutObj is {1:[...],2:[...],3:[...]} and each array is a visual stack: updateBlockPosStatus
  // calls setStatus(false) for every element except the last, so only the top card is interactive.
  function readTraySlots(moveOut) {
    var slots = [[], [], []];
    if (!moveOut || !moveOut.moveOutObj) return slots;
    for (var k in moveOut.moveOutObj) {
      var idx = (+k) - 1;
      if (idx < 0 || idx > 2) continue;
      var arr = moveOut.moveOutObj[k] || [];
      for (var i = 0; i < arr.length; i++) {
        var comp = arr[i];
        if (!comp || !comp.cardDataObj) continue;
        slots[idx].push({ type: comp.cardDataObj.type, comp: comp, pos: i, slot: idx });
      }
    }
    return slots;
  }

  function readTray(moveOut) {
    var slots = readTraySlots(moveOut), out = [];
    for (var k = 0; k < 3; k++) for (var i = 0; i < slots[k].length; i++) out.push(slots[k][i]);
    return out;
  }

  var parksUsed = 0;
  function parkLeft(ui) {
    // moveOutBlock() has no prop-count check in this build (the check lives in the share/ad
    // callback), so the only real limit is "the hand is not empty". Report a large number.
    return 999;
  }

  function sigSlots(hand, slots) {
    var parts = [];
    for (var k = 0; k < 3; k++) {
      var t = [], s = slots[k] || [];
      for (var i = 0; i < s.length; i++) t.push(s[i] !== undefined && s[i].type !== undefined ? s[i].type : s[i]);
      parts.push(t.join(','));
    }
    return hand.join(',') + '|' + parts.join('/');
  }

  // flat signature kept for the in-page DFS model (1 free tray pool)
  function sig(hand, tray) {
    return sigSlots(hand, [tray, [], []]);
  }

  // ---------------- exact solver ----------------
  // returns {moves:[{k:'b',i}|{k:'t',t}|{k:'p'}], cleared:int} or null
  function solveModel(blocks, hand0, tray0, parkTotal, maxHand, budgetMs, variant) {
    var n = blocks.length;
    if (!n && !hand0.length && !tray0.length) return { moves: [], cleared: 0 };

    var perm = new Array(n), i0;
    for (i0 = 0; i0 < n; i0++) perm[i0] = i0;
    if (variant > 0) {
      var ps = ((variant * 2654435761) + 0x9e3779b9) >>> 0;
      for (i0 = n - 1; i0 > 0; i0--) {
        ps ^= ps << 13; ps >>>= 0; ps ^= ps >>> 17; ps ^= ps << 5; ps >>>= 0;
        var jj = ps % (i0 + 1), tmp = perm[i0];
        perm[i0] = perm[jj]; perm[jj] = tmp;
      }
    }

    var layer = new Int16Array(n), row = new Int16Array(n), rol = new Int16Array(n), type = new Int8Array(n);
    for (var i = 0; i < n; i++) {
      var b = blocks[perm[i]];
      layer[i] = b.layer; row[i] = b.row; rol[i] = b.rol; type[i] = b.type;
    }

    var inv = new Array(n), j, k;
    for (j = 0; j < n; j++) inv[j] = [];
    for (j = 0; j < n; j++) {
      var lj = layer[j], rj = row[j], cj = rol[j];
      for (k = 0; k < n; k++) {
        if (k === j) continue;
        if (lj > layer[k] && (rj - row[k] < SUB) && (row[k] - rj < SUB) &&
          (cj - rol[k] < SUB) && (rol[k] - cj < SUB)) inv[j].push(k);
      }
    }
    var cnt0 = new Int16Array(n);
    for (j = 0; j < n; j++) for (k = 0; k < inv[j].length; k++) cnt0[inv[j][k]]++;

    var cnt, remFlag, inAvail, remain, byType;
    var hand, hsize, tray, tsize, parks;
    var plan, nodes, budget, maxHandLocal = maxHand;
    var t0 = Date.now(), seed = 13;
    function rnd() {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    }

    function reset() {
      cnt = new Int16Array(cnt0);
      remFlag = new Uint8Array(n);
      for (var q = 0; q < n; q++) remFlag[q] = 1;
      inAvail = new Uint8Array(n);
      byType = [];
      for (var t = 0; t < 32; t++) byType.push([]);
      remain = n; hsize = 0; tsize = 0; parks = 0;
      hand = new Int8Array(8);
      tray = new Int8Array(8);
      for (var a = 0; a < hand0.length; a++) hand[hsize++] = hand0[a];
      for (var c = 0; c < tray0.length; c++) tray[tsize++] = tray0[c];
      plan = [];
      for (var q2 = 0; q2 < n; q2++) if (cnt[q2] === 0) { inAvail[q2] = 1; byType[type[q2]].push(q2); }
    }

    function addAvail(x) { inAvail[x] = 1; byType[type[x]].push(x); }
    function delAvail(x) {
      inAvail[x] = 0;
      var a = byType[type[x]], idx = a.indexOf(x);
      if (idx >= 0) { a[idx] = a[a.length - 1]; a.pop(); }
    }
    function handPush(t) {
      hand[hsize++] = t;
      var c = 0, i;
      for (i = 0; i < hsize; i++) if (hand[i] === t) c++;
      if (c === 3) {
        var w = 0;
        for (i = 0; i < hsize; i++) if (hand[i] !== t) hand[w++] = hand[i];
        hsize = w;
        return 3;
      }
      return 0;
    }
    function handPop(t, cleared) {
      if (cleared) { hand[hsize++] = t; hand[hsize++] = t; hand[hsize++] = t; }
      for (var i = hsize - 1; i >= 0; i--) {
        if (hand[i] === t) {
          for (var q = i; q < hsize - 1; q++) hand[q] = hand[q + 1];
          hsize--;
          return;
        }
      }
    }
    function boardMove(x) {
      var t = type[x];
      delAvail(x); remFlag[x] = 0; remain--;
      var vs = inv[x], unlocked = [];
      for (var m = 0; m < vs.length; m++) {
        var v = vs[m]; cnt[v]--;
        if (cnt[v] === 0) { addAvail(v); unlocked.push(v); }
      }
      var cleared = handPush(t);
      var mv = { k: 'b', i: x, t: t, cleared: cleared, unlocked: unlocked };
      plan.push(mv);
      return mv;
    }
    function boardUndo(mv) {
      handPop(mv.t, mv.cleared);
      remain++; remFlag[mv.i] = 1;
      var vs = inv[mv.i];
      for (var q = 0; q < vs.length; q++) {
        var v = vs[q];
        if (cnt[v] === 0) delAvail(v);
        cnt[v]++;
      }
      addAvail(mv.i);
    }
    function trayMoveAt(slot) {
      var t = tray[slot];
      for (var q = slot; q < tsize - 1; q++) tray[q] = tray[q + 1];
      tsize--;
      var cleared = handPush(t);
      var mv = { k: 't', t: t, cleared: cleared };
      plan.push(mv);
      return mv;
    }
    function trayUndo(mv) { handPop(mv.t, mv.cleared); tray[tsize++] = mv.t; }
    function parkDo() {
      var take = Math.min(3, hsize), moved = [], q;
      for (q = 0; q < take; q++) moved.push(hand[q]);
      for (q = take; q < hsize; q++) hand[q - take] = hand[q];
      hsize -= take;
      for (q = 0; q < take; q++) tray[tsize++] = moved[q];
      parks++;
      var mv = { k: 'p', moved: moved };
      plan.push(mv);
      return mv;
    }
    function parkUndo(mv) {
      tsize -= mv.moved.length;
      for (var q = hsize - 1; q >= 0; q--) hand[q + mv.moved.length] = hand[q];
      for (var r = 0; r < mv.moved.length; r++) hand[r] = mv.moved[r];
      hsize += mv.moved.length;
      parks--;
    }
    function trayCountOf(t) { var c = 0; for (var q = 0; q < tsize; q++) if (tray[q] === t) c++; return c; }
    function traySlotOf(t) { for (var q = 0; q < tsize; q++) if (tray[q] === t) return q; return -1; }
    function handCounts() {
      var c = new Int8Array(32);
      for (var q = 0; q < hsize; q++) c[hand[q]]++;
      return c;
    }

    function tryPark() {
      if (parks >= parkTotal || tsize !== 0 || hsize === 0) return false;
      var mv = parkDo();
      if (dfs()) return true;
      plan.pop(); parkUndo(mv);
      return false;
    }

    function dfs() {
      if (remain === 0 && hsize === 0 && tsize === 0) return true;
      if (++nodes > budget) return false;
      if (hsize > maxHandLocal) return false;

      var hc = handCounts();
      var forced = -1, t;
      for (t = 0; t < 32; t++) if (hc[t] === 2 && (byType[t].length || trayCountOf(t) > 0)) { forced = t; break; }

      var cands = [];
      if (forced >= 0) {
        for (var f = 0; f < byType[forced].length; f++) cands.push({ k: 'b', i: byType[forced][f], s: 1e9 });
        if (trayCountOf(forced) > 0) cands.push({ k: 't', t: forced, s: 1e9 });
      } else {
        if (hsize >= maxHandLocal) {
          for (t = 0; t < 32; t++) if (hc[t] === 2 && trayCountOf(t) > 0) cands.push({ k: 't', t: t, s: 1e9 });
          if (!cands.length) return tryPark();
        } else {
          for (t = 0; t < 32; t++) {
            var a = byType[t], tr = trayCountOf(t);
            if (!a.length && !tr) continue;
            var sc;
            if (hc[t] === 1) sc = 3000 + (a.length + tr) * 60;
            else if (a.length >= 3) sc = 900 + a.length * 40 - hsize * 40;
            else if (a.length === 2) sc = 200 - hsize * 60;
            else sc = 50 - hsize * 100;
            var jit = rnd() * 400;
            for (var m = 0; m < a.length; m++) cands.push({ k: 'b', i: a[m], s: sc + jit + rnd() * 20 });
            if (tr > 0) cands.push({ k: 't', t: t, s: sc * 0.6 + 400 + rnd() * 30 });
          }
          cands.sort(function (x, y) { return y.s - x.s; });
        }
      }

      for (var q = 0; q < cands.length; q++) {
        var c = cands[q], mv;
        if (c.k === 'b') {
          if (!remFlag[c.i] || !inAvail[c.i]) continue;
          mv = boardMove(c.i);
          if (dfs()) return true;
          plan.pop(); boardUndo(mv);
        } else {
          var slot = traySlotOf(c.t);
          if (slot < 0) continue;
          mv = trayMoveAt(slot);
          if (dfs()) return true;
          plan.pop(); trayUndo(mv);
        }
        if (nodes > budget) return false;
      }
      return tryPark();
    }

    var solution = null;
    var variantBudget = Math.min(budgetMs, 4000);
    var best = 0;
    while (Date.now() - t0 < variantBudget && !solution) {
      reset();
      nodes = 0; budget = 400000;
      for (var q8 = 0; q8 < 8; q8++) rnd();
      var ok = false;
      try { ok = dfs(); } catch (e) { ok = false; }
      if (ok) {
        solution = plan.map(function (mv) {
          return mv.k === 'b' ? { k: 'b', i: perm[mv.i] } : { k: mv.k, t: mv.t, moved: mv.moved };
        });
      }
    }
    return solution;
  }

  function applyType(hand, t) {
    // client getNewPosit(): a new card is inserted right after the last card of the same type
    var pos = hand.length, i;
    for (i = hand.length - 1; i >= 0; i--) if (hand[i] === t) { pos = i + 1; break; }
    hand.splice(pos, 0, t);
    var c = 0;
    for (i = 0; i < hand.length; i++) if (hand[i] === t) c++;
    if (c === 3) {
      var w = 0, dropped = 0;
      for (i = 0; i < hand.length; i++) {
        if (hand[i] === t && dropped < 3) { dropped++; continue; }
        hand[w++] = hand[i];
      }
      hand.length = w;
    }
  }

  // replay the move list on the faithful model to attach the expected post-state signature to each step
  function annotate(blocks, hand0, slots0, moves) {
    var hand = hand0.slice();
    var slots = [[], [], []];
    for (var k = 0; k < 3; k++) {
      var src = slots0[k] || [];
      for (var q = 0; q < src.length; q++) slots[k].push(src[q] !== undefined && src[q].type !== undefined ? src[q].type : src[q]);
    }
    var out = [];
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i];
      if (mv.k === 'b') {
        var b = blocks[mv.i];
        applyType(hand, b.type);
        out.push({ k: 'b', key: b.key, type: b.type, sig: sigSlots(hand, slots) });
      } else if (mv.k === 't') {
        var slot = mv.slot;
        if (slot === undefined) {
          for (var r0 = 0; r0 < 3; r0++) {
            if (slots[r0].length && slots[r0][slots[r0].length - 1] === mv.t) { slot = r0; break; }
          }
        }
        if (slot === undefined || !slots[slot] || !slots[slot].length) return null;
        var top = slots[slot].pop();
        applyType(hand, top);
        out.push({ k: 't', slot: slot, type: top, sig: sigSlots(hand, slots) });
      } else {
        if (!hand.length) return null;
        var take = Math.min(3, hand.length);
        var moved = hand.splice(0, take);
        for (var r = 0; r < take; r++) slots[r].push(moved[r]);
        out.push({ k: 'p', moved: moved, sig: sigSlots(hand, slots) });
      }
    }
    return out;
  }

  function greedyStep(blocks, handArr, trayArr, parkTotal) {
    // one legal move, scored the same way as the DFS, no search
    var hc = {}, hsize = handArr.length, i;
    for (i = 0; i < handArr.length; i++) hc[handArr[i]] = (hc[handArr[i]] || 0) + 1;
    var trayCount = {};
    for (i = 0; i < trayArr.length; i++) trayCount[trayArr[i]] = (trayCount[trayArr[i]] || 0) + 1;

    var avail = [], byType = {};
    for (i = 0; i < blocks.length; i++) {
      var b = blocks[i], ok = true;
      for (var j = 0; j < blocks.length; j++) {
        if (i === j) continue;
        var o = blocks[j];
        if (o.layer > b.layer && Math.abs(o.row - b.row) < SUB && Math.abs(o.rol - b.rol) < SUB) { ok = false; break; }
      }
      if (!ok) continue;
      avail.push(i);
      (byType[b.type] = byType[b.type] || []).push(i);
    }

    // forced completion
    for (var t in byType) if (hc[t] === 2) return { k: 'b', key: blocks[byType[t][0]].key, type: blocks[byType[t][0]].type };
    for (var tt in trayCount) if (hc[tt] === 2) return { k: 't', type: +tt };

    if (hsize < CFG.maxHand) {
      var best = null, bestScore = -1e9;
      for (var t2 in byType) {
        var a = byType[t2], tr = trayCount[t2] || 0;
        var sc;
        if ((hc[t2] || 0) === 1) sc = 3000 + (a.length + tr) * 60;
        else if (a.length >= 3) sc = 900 + a.length * 40 - hsize * 40;
        else if (a.length === 2) sc = 200 - hsize * 60;
        else sc = 50 - hsize * 100;
        if (sc > bestScore) {
          bestScore = sc;
          best = { k: 'b', key: blocks[a[0]].key, type: blocks[a[0]].type };
        }
      }
      if (best) return best;
    }
    // hand full: park if allowed
    if (parkTotal > 0 && trayArr.length === 0 && hsize > 0) return { k: 'p' };
    return null;
  }

  // ---------------- execution ----------------
  var STUB = { stopPropagation: function () { }, preventDefault: function () { } };
  function clickComp(comp) {
    try {
      // a card that is still running its position tween keeps isChoosed = true and touchStart()
      // bails out immediately; the tween callback would clear it, so clear it here and click now.
      if (comp.isChoosed === true) comp.isChoosed = false;
      // isShowLight === false means a buried tray card (setStatus(false)): not interactive
      if (comp.isShowLight === false) return false;
    } catch (e) { }
    try { comp.touchStart(STUB); } catch (e) { }
    try { comp.touchEnd(STUB); } catch (e) { }
    return true;
  }

  var state = {
    running: false, phase: 'init', clicks: 0, wins: 0,
    plan: 0, mode: '', hand: 0, tray: 0, left: 0, lastError: null, lastPlanMs: 0, levelKey: null
  };
  var plan = [], planSig = '', deepTried = false, levelTag = null, lastDeepAt = 0, pending = null;

  function currentSig(handArr, slotsArr) { return sigSlots(handArr, slotsArr); }

  function tick() {
    var c = findComps();
    if (!c.cb) { state.phase = 'idle(no board)'; return; }
    if (!c.cb._boardInit) { state.phase = 'idle(wait level)'; return; }

    var lk = c.cb.nowLevelData && c.cb.nowLevelData.levelKey;
    if (lk !== levelTag) {
      // the level can switch between two ticks, so credit the win from the last observed state
      if (levelTag !== null && state.clicks > 0 && state.left === 0 && state.hand === 0 && state.tray === 0) {
        state.wins++; log('WIN (level cleared) clicks=' + state.clicks);
      }
      levelTag = lk; deepTried = false; lastDeepAt = 0; parksUsed = 0; plan = []; planSig = ''; state.levelKey = lk;
      log('level ' + lk + ' (prev left=' + state.left + ' hand=' + state.hand + ' tray=' + state.tray + ' clicks=' + state.clicks + ')');
    }

    var board = readBoard(c.cb);
    var hand = readHand(c.crush);
    var slotsList = readTraySlots(c.moveOut);
    var slots = [
      slotsList[0].map(function (x) { return x.type; }),
      slotsList[1].map(function (x) { return x.type; }),
      slotsList[2].map(function (x) { return x.type; })
    ];
    var trayList = readTray(c.moveOut);
    var tray = trayList.map(function (x) { return x.type; });

    state.hand = hand.length; state.tray = tray.length; state.left = board.length;

    // settle the previous step: the client removes/eliminates inside a tween, so the state is
    // only final one frame later. Verify here instead of right after the click.
    var curSig = currentSig(hand, slots);
    if (pending) {
      var pd = pending;
      if (pd.sig && curSig === pd.sig) {
        // expected state reached
        pending = null;
        if (plan.length) plan.shift();
        planSig = pd.sig;
      } else {
        // the client removes a card first and collapses the triple a frame (or two) later,
        // so wait for the expected signature; only give up once the state is really frozen.
        if (pd.lastSig === curSig) pd.same = (pd.same || 0) + 1;
        else { pd.lastSig = curSig; pd.same = 0; }
        if (pd.same < 8 && (Date.now() - pd.ts) < 4000) return;
        pending = null;
        log('settle timeout after ' + pd.k + ' got=' + curSig + ' want=' + pd.sig + ' -> replan');
        plan = []; planSig = '';
      }
    }

    if (!board.length && !hand.length && !tray.length) {
      if (state.clicks > 0 && state.phase !== 'win') { state.phase = 'win'; state.wins++; log('WIN clicks=' + state.clicks); }
      return;
    }
    state.phase = 'playing';

    var pk = parkLeft(c.ui);

    if (!plan.length || planSig !== currentSig(hand, slots)) {
      if (!CFG.internalFallback) {
        state.phase = 'drift';
        log('no valid plan (mode=' + state.mode + ') -> stop; re-dump and re-solve');
        stop();
        return;
      }
      var tryDeep = !deepTried || (state.clicks - lastDeepAt >= 40);
      var moves = null;
      if (hand.length < 7 && tryDeep) {
        lastDeepAt = state.clicks;
        var budget = deepTried ? CFG.retryBudgetMs : CFG.planBudgetMs;
        var t0 = Date.now();
        var v = deepTried ? 3 : 0;
        moves = solveModel(board, hand, tray, pk, CFG.maxHand, budget, v);
        state.lastPlanMs = Date.now() - t0;
      }
      var steps = moves ? annotate(board, hand, slots, moves) : null;
      if (steps && steps.length) {
        plan = steps; planSig = currentSig(hand, slots);
        state.mode = 'dfs';
        log('plan dfs steps=' + steps.length + ' left=' + board.length + ' hand=' + hand.length +
          ' tray=' + tray.length + ' parks=' + pk + ' ' + state.lastPlanMs + 'ms');
      } else {
        deepTried = true;
        var g = greedyStep(board, hand, tray, pk);
        if (!g) { state.phase = 'stuck'; log('no legal step left=' + board.length + ' hand=' + hand.length + ' -> stop'); stop(); return; }
        var gi = -1;
        if (g.key) { for (var q2 = 0; q2 < board.length; q2++) if (board[q2].key === g.key) { gi = q2; break; } }
        var gsteps = annotate(board, hand, slots, [{ k: g.k, i: gi, t: g.type, slot: g.slot }]);
        if (!gsteps || !gsteps.length) { state.phase = 'stuck'; log('greedy step does not annotate -> stop'); stop(); return; }
        plan = [gsteps[0]];
        planSig = currentSig(hand, slots);
        state.mode = 'greedy';
      }
    }

    var step = plan[0];
    if (!step) { plan = []; return; }
    state.lastStep = step.k + ':' + (step.key || step.type || '') + ' want=' + step.sig + ' planLen=' + plan.length;

    if (step.k === 'b') {
      var target = null;
      for (var i2 = 0; i2 < board.length; i2++) if (board[i2].key === step.key) { target = board[i2]; break; }
      if (!target) { plan = []; planSig = ''; return; }
      if (!c.cb.checkIsShow(target.layer, target.rol, target.row)) {
        log('step ' + step.key + ' no longer clickable -> replan');
        plan = []; planSig = '';
        return;
      }
      if (CFG.dryRun) { log('[dry] ' + step.key + ' type=' + target.type); if (step.sig) plan.shift(); else plan = []; return; }
      clickComp(target.comp);
      state.clicks++;
    } else if (step.k === 't') {
      // only the top card of a slot is interactive, so pick the last element of that slot
      var slotIdx = step.slot, tc = null;
      if (slotIdx !== undefined && slotsList[slotIdx] && slotsList[slotIdx].length) {
        tc = slotsList[slotIdx][slotsList[slotIdx].length - 1];
      } else {
        for (var i3 = 0; i3 < trayList.length; i3++) if (trayList[i3].type === step.type) { tc = trayList[i3]; slotIdx = trayList[i3].slot; break; }
      }
      if (!tc) { log('tray slot ' + slotIdx + ' empty -> replan'); plan = []; planSig = ''; return; }
      if (CFG.dryRun) { log('[dry] tray slot=' + slotIdx + ' type=' + tc.type); if (step.sig) plan.shift(); else plan = []; return; }
      if (clickComp(tc.comp) === false) { log('tray slot ' + slotIdx + ' not interactive -> replan'); plan = []; planSig = ''; return; }
      state.clicks++;
    } else {
      // real move-out action: crushArea.moveOutBlock() (removeEndFunc is an empty stub in this build)
      if (!c.crush || typeof c.crush.moveOutBlock !== 'function') { plan = []; state.phase = 'no-park'; return; }
      if (CFG.dryRun) { log('[dry] park hand=' + hand.length); if (step.sig) plan.shift(); else plan = []; return; }
      var trayBefore = tray.length;
      var okPark = false;
      try { okPark = c.crush.moveOutBlock(); } catch (e) { log('park err ' + e); }
      var trayAfter = readTray(findComps().moveOut).length;
      if (!okPark || trayAfter <= trayBefore) {
        state.phase = 'stuck';
        log('park failed (tray ' + trayBefore + '->' + trayAfter + ') -> stop');
        stop();
        return;
      }
      parksUsed++;
      parkAt = Date.now();
      state.clicks++;
      log('park ok #' + parksUsed + ', hand ' + hand.length + ' -> ' + Math.max(0, hand.length - Math.min(3, hand.length)) + ', tray=' + trayAfter);
    }

    pending = { sig: step.sig || '', ts: Date.now(), k: step.k, lastSig: curSig };
    if (state.clicks > CFG.maxClicks) { state.phase = 'maxClicks'; stop(); }
  }

  function safeTick() {
    try { tick(); } catch (e) { state.lastError = String(e) + ' | ' + (e && e.stack); log('tick err ' + e); }
  }

  var timer = null, parkAt = 0;
  // Every park re-tweens all tray nodes. A deep tray plus a 150ms click cadence saturates the
  // render loop (observed: 48s freeze with 33 tray cards), so pace the bot by tray depth.
  function pace() {
    var d = CFG.tickMs;
    if (state.tray >= 20) d = Math.max(d, 700);
    else if (state.tray >= 12) d = Math.max(d, 450);
    else if (state.tray >= 6) d = Math.max(d, 300);
    var sincePark = Date.now() - parkAt;
    if (sincePark < 700) d = Math.max(d, 700 - sincePark);
    return d;
  }
  function loop() {
    if (!state.running) return;
    safeTick();
    if (!state.running) return;
    var setT = G.setTimeout || setTimeout;
    timer = setT(loop, pace());
  }
  function start() {
    if (timer) return;
    var setT = G.setTimeout || setTimeout;
    timer = setT(loop, CFG.tickMs);
    state.running = true;
    log('bot started tick=' + CFG.tickMs + 'ms');
  }
  function stop() {
    if (timer) { var clr = G.clearTimeout || clearTimeout; try { clr(timer); } catch (e) { } timer = null; }
    state.running = false;
    log('bot stopped');
  }

  G.__sheepBot = {
    cfg: CFG, state: state, logs: LOGS, start: start, stop: stop,
    stepOnce: safeTick,
    status: function () { return JSON.parse(JSON.stringify(state)); },
    snapshot: function () {
      var c = findComps();
      if (!c.cb) return 'no board';
      var b = readBoard(c.cb);
      return {
        levelKey: c.cb.nowLevelData && c.cb.nowLevelData.levelKey,
        boardInit: c.cb._boardInit,
        blocks: b.length,
        hand: readHand(c.crush),
        tray: readTray(c.moveOut).map(function (x) { return x.type; }),
        parks: parkLeft(c.ui),
        clickable: b.filter(function (x) { return c.cb.checkIsShow(x.layer, x.rol, x.row); }).map(function (x) { return x.key; })
      };
    },
    planNow: function (budget) {
      var c = findComps();
      if (!c.cb || !c.cb._boardInit) return 'no board';
      var b = readBoard(c.cb), h = readHand(c.crush), tr = readTray(c.moveOut).map(function (x) { return x.type; });
      var t0 = Date.now();
      var mv = solveModel(b, h, tr, parkLeft(c.ui), CFG.maxHand, budget || 3000, 0);
      return mv ? { steps: mv.length, left: b.length, ms: Date.now() - t0, parks: mv.filter(function (m) { return m.k === 'p'; }).length }
        : { solved: false, left: b.length, hand: h.length, ms: Date.now() - t0 };
    },
    // load an externally computed plan (e.g. from beam3.js) and execute it.
    // list items: {kind:'board', id:'<layer>-<rol>-<row>'} | {kind:'tray', type:n, slot:0..2} | {kind:'park', moved:[..]}
    setPlan: function (list) {
      var c = findComps();
      if (!c.cb || !c.cb._boardInit) return 'no board';
      var board = readBoard(c.cb);
      var hand = readHand(c.crush);
      var slotsList = readTraySlots(c.moveOut);
      var slots = [
        slotsList[0].map(function (x) { return x.type; }),
        slotsList[1].map(function (x) { return x.type; }),
        slotsList[2].map(function (x) { return x.type; })
      ];
      var moves = [], miss = 0;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.kind === 'park') { moves.push({ k: 'p', moved: s.moved || [] }); continue; }
        if (s.kind === 'tray') { moves.push({ k: 't', t: s.type, slot: s.slot }); continue; }
        var idx = -1;
        for (var q = 0; q < board.length; q++) if (board[q].key === s.id) { idx = q; break; }
        if (idx < 0) { miss++; continue; }
        moves.push({ k: 'b', i: idx });
      }
      var steps = annotate(board, hand, slots, moves);
      if (!steps) return 'annotate failed (plan does not match the live state)';
      plan = steps;
      planSig = currentSig(hand, slots);
      deepTried = true;
      levelTag = c.cb.nowLevelData && c.cb.nowLevelData.levelKey;
      state.mode = 'external';
      state.plan = steps.length;
      log('external plan loaded steps=' + steps.length + ' missing=' + miss);
      return 'ok steps=' + steps.length + ' missing=' + miss;
    },
    dumpBoard: function () {
      var c = findComps();
      if (!c.cb || !c.cb._boardInit) return 'no board';
      var b = readBoard(c.cb);
      var out = { levelKey: c.cb.nowLevelData && c.cb.nowLevelData.levelKey, blocks: [] };
      for (var i = 0; i < b.length; i++) {
        out.blocks.push({
          id: b[i].key, layerNum: b[i].layer, rowNum: b[i].row, rolNum: b[i].rol, type: b[i].type,
          covered: !c.cb.checkIsShow(b[i].layer, b[i].rol, b[i].row)
        });
      }
      out.hand = readHand(c.crush);
      var sl = readTraySlots(c.moveOut);
      out.tray = readTray(c.moveOut).map(function (x) { return x.type; });
      out.traySlots = [
        sl[0].map(function (x) { return x.type; }),
        sl[1].map(function (x) { return x.type; }),
        sl[2].map(function (x) { return x.type; })
      ];
      out.parks = parksUsed;
      return JSON.stringify(out);
    }
  };

  if (G.__sheepHold) {
    state.phase = 'held';
    log('installed but held (G.__sheepHold); call __sheepBot.start() to run');
  } else {
    start();
  }
  return 'bot v4 installed; board=' + (findComps().cb ? 'found' : 'none') + (G.__sheepHold ? '; HELD' : '');
})();
