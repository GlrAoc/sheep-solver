/**
 * mod_infinite_props.js - unlimited "move out" / "undo" / "shuffle" props.
 *
 * Injected as a single expression through eval_cdp.js / inject.js:
 *     node eval_cdp.js --file mod_infinite_props.js
 *     node eval_cdp.js --file mod_infinite_props.js --off
 *
 * How the game gates a prop (read from the live client, class gameUiLayer):
 *
 *   removeEndFunc() {
 *     if (this.isMoving || this.checkPropUseLimit(PropType.remove)) return;
 *     if (this.userData.prop_remove >= 1) { crush.moveOutBlock(); ...; this.userData.prop_remove--; }
 *     else this.showPropPop(1);                 // "watch an ad / share" popup
 *   }
 *
 *   checkPropUseLimit(t) {                      // true == blocked
 *     const m = <module>.default.getInstance().sheepMark;
 *     const used = {remove:m.propRemoveCount, cancel:m.propCancelCount, random:m.propRandomCount}[t];
 *     return used === undefined || isGamePropUseLimitReached(used, getGamePropUseLimit(t));
 *   }
 *
 * and game-ui-item-btn.setData(owned, used, limit) decides the look:
 *   used >= limit -> mask + video icon; owned >= 1 -> the number; else -> video icon.
 *
 * So there are exactly three things to neutralise:
 *   1. the free-quota gate      -> checkPropUseLimit always returns false
 *   2. the owned count          -> userData.prop_remove/prop_cancel/prop_random pinned to 9999
 *   3. the button look/state    -> re-issued through setGameLayerUiData() so the number shows
 * plus a 1s watchdog, because setGameLayerUiData()/server sync rewrites both from storage.
 *
 * No server round-trip is involved in this UI layer: moveOutBlock(), cancelOneStep() and
 * chessboard.updateBlockArea() all run locally, which is why the inventory bump is enough.
 *
 * Control handle: <G>.__sheepInf  (G = document.gameContext)
 *   .status()        snapshot
 *   .remove() .cancel() .shuffle()   call the local primitive directly
 *   .off()           restore everything (original props, handlers, counts)
 *
 * ASCII only on purpose: this file is injected as one expression and non-ASCII text is
 * re-encoded on the way through the debugger bridge.
 */
(function () {
  var G = (typeof document !== 'undefined' && document && document.gameContext) ? document.gameContext : null;
  if (!G) return JSON.stringify({ ok: false, err: 'no_game_context' });
  var cc = G.cc;
  if (!cc || !cc.director) return JSON.stringify({ ok: false, err: 'no_cc' });

  var NUM = 9999;
  var P = { remove: 1, cancel: 2, random: 3 };   // PropType values seen in showTipPop

  function clsOf(o) { try { return cc.js.getClassName(o); } catch (e) { return ''; } }

  // ---------- discovery ----------
  function walkScene(fn) {
    var scene = cc.director.getScene();
    if (!scene) return null;
    var stack = [scene], got = null;
    while (stack.length) {
      var n = stack.pop();
      var cs = n._components || [];
      for (var i = 0; i < cs.length; i++) {
        var r = fn(cs[i], n);
        if (r !== undefined && r !== null && r !== false) { got = r; break; }
      }
      if (got) break;
      var ch = n.children || [];
      for (var j = 0; j < ch.length; j++) stack.push(ch[j]);
    }
    return got;
  }

  // the live prop layer: active node, has userData, has the three buttons
  function findUi() {
    return walkScene(function (c, n) {
      if (!c) return null;
      var cn = clsOf(c);
      if (cn !== 'gameUiLayer' && cn !== 'new-game-ui') return null;
      if (typeof c.removeEndFunc !== 'function' || !c.removeBtn) return null;
      if (!n.activeInHierarchy) return null;
      return c;
    });
  }

  function findCrush() {
    return walkScene(function (c) {
      if (c && ('crushArray' in c) && typeof c.moveOutBlock === 'function') return c;
      return null;
    });
  }

  function findChessboard() {
    return walkScene(function (c) {
      if (c && ('nowLevelBlockObj' in c) && typeof c.updateBlockArea === 'function') return c;
      return null;
    });
  }

  // ---------- state ----------
  var st = {
    installedAt: Date.now(), ok: false, uiClass: null, uiNode: null,
    inv: null, gatePatched: 0, ticks: 0, arms: 0, errs: [], restored: false
  };
  var protos = [];   // patched prototypes, so restore() can put the original gate back

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

  function savedUserData(ui) {
    if (!ui || !ui.userData) return null;
    var u = ui.userData;
    return { remove: num(u.prop_remove), cancel: num(u.prop_cancel), random: num(u.prop_random) };
  }

  function armUserData(ui) {
    if (!ui || !ui.userData) return false;
    var u = ui.userData, changed = false;
    if (u.prop_remove !== NUM) { u.prop_remove = NUM; changed = true; }
    if (u.prop_cancel !== NUM) { u.prop_cancel = NUM; changed = true; }
    if (u.prop_random !== NUM) { u.prop_random = NUM; changed = true; }
    return changed;
  }

  function armBtn(b) {
    if (!b) return;
    try {
      if (typeof b.setData === 'function') b.setData(NUM, 0, NUM);
      else { b.currentCount = NUM; b.usedCount = 0; b.useLimit = NUM; }
    } catch (e) {
      b.currentCount = NUM; b.usedCount = 0; b.useLimit = NUM;
    }
    // belt and braces: the ad state is what makes the tile look "empty"
    try { if (b.mask) b.mask.active = false; } catch (e) { }
    try { if (b.video) b.video.active = false; } catch (e) { }
    try { if (b.numLabel && b.numLabel.node) b.numLabel.node.active = true; } catch (e) { }
  }

  // the free-quota gate: returns true when the prop should be blocked. Patch the prototype
  // once per class - every current and future instance inherits it.
  function patchGate(c) {
    var proto = Object.getPrototypeOf(c);
    if (!proto || typeof proto.checkPropUseLimit !== 'function') return false;
    if (proto.__infGate) return false;
    proto.__infGateOrig = proto.checkPropUseLimit;
    proto.checkPropUseLimit = function () { return false; };
    proto.__infGate = 1;
    protos.push(proto);
    st.gatePatched++;
    return true;
  }

  // Every instance of the two prop layers gets the gate patch, active or not: the level can
  // switch between matchRootNode/new-game-ui and gameLayer/gameUiLayer without a reload.
  function patchAllProtos() {
    var hit = 0;
    walkScene(function (c) {
      if (!c) return null;
      var cn = clsOf(c);
      if (cn !== 'gameUiLayer' && cn !== 'new-game-ui') return null;
      if (typeof c.checkPropUseLimit === 'function') { patchGate(c); hit++; }
      return null;   // keep walking: both layers must be covered
    });
    return hit;
  }

  // wrap the click handler so the inventory is topped up right before every use,
  // and again right after (the handler decrements it on success)
  function wrapBtn(b, tag) {
    if (!b || !b.callBack || b.__infWrapped) return false;
    var orig = b.callBack;
    b.__infOrig = orig;
    b.callBack = function () {
      try { arm(true); } catch (e) { st.errs.push('arm:' + e); }
      var r;
      try { r = orig.apply(this, arguments); } catch (e) { st.errs.push(tag + ':' + e); }
      try { arm(true); } catch (e) { }
      return r;
    };
    b.__infWrapped = 1;
    return true;
  }

  function arm(refresh) {
    patchAllProtos();          // both prop layers, active or not
    var ui = findUi();
    if (!ui) return false;
    if (!st.uiClass) {
      st.uiClass = clsOf(ui);
      st.uiNode = ui.node ? ui.node.name : '?';
      st.saved = savedUserData(ui);
    }
    armUserData(ui);
    armBtn(ui.removeBtn); armBtn(ui.cancelBtn); armBtn(ui.randomBtn);
    wrapBtn(ui.removeBtn, 'remove');
    wrapBtn(ui.cancelBtn, 'cancel');
    wrapBtn(ui.randomBtn, 'random');
    if (refresh) {
      try { ui.setGameLayerUiData(); } catch (e) { st.errs.push('refresh:' + e); }
      try {
        var u = ui.userData || {};
        st.inv = { remove: u.prop_remove, cancel: u.prop_cancel, random: u.prop_random };
      } catch (e) { }
    }
    st.arms++;
    st.ok = true;
    return true;
  }

  // ---------- restore ----------
  function restore() {
    if (st.restored) return 'already';
    st.restored = true;
    try { if (st.timer) (G.clearInterval || clearInterval)(st.timer); } catch (e) { }
    var ui = null;
    try { ui = findUi(); } catch (e) { }
    if (ui) {
      if (st.saved && ui.userData) {
        if (st.saved.remove !== null) ui.userData.prop_remove = st.saved.remove;
        if (st.saved.cancel !== null) ui.userData.prop_cancel = st.saved.cancel;
        if (st.saved.random !== null) ui.userData.prop_random = st.saved.random;
      }
    }
    for (var i = 0; i < protos.length; i++) {
      var p = protos[i];
      if (p && p.__infGate && p.__infGateOrig) {
        p.checkPropUseLimit = p.__infGateOrig;
        p.__infGate = 0;
      }
    }
    if (ui) {
      [ui.removeBtn, ui.cancelBtn, ui.randomBtn].forEach(function (b) {
        if (b && b.__infWrapped && b.__infOrig) { b.callBack = b.__infOrig; b.__infWrapped = 0; }
      });
      try { ui.setGameLayerUiData(); } catch (e) { }
    }
    st.ok = false;
    return 'restored';
  }

  // ---------- direct actions (scriptable, do not touch the inventory at all) ----------
  var direct = {
    remove: function () {
      var c = findCrush();
      if (!c) return 'no_crush';
      if (!c.crushArray || !c.crushArray.length) return 'hand_empty';
      try { return String(c.moveOutBlock()); } catch (e) { return 'err:' + e; }
    },
    cancel: function () {
      var c = findCrush();
      if (!c) return 'no_crush';
      if (typeof c.cancelOneStep !== 'function') return 'no_cancelOneStep';
      try { return String(c.cancelOneStep()); } catch (e) { return 'err:' + e; }
    },
    shuffle: function () {
      var cb = findChessboard();
      if (!cb) return 'no_chessboard';
      try {
        var r = cb.updateBlockArea();
        if (r && typeof r.then === 'function') r.then(function () { arm(true); }, function () { });
        return 'called';
      } catch (e) { return 'err:' + e; }
    }
  };

  var prev = G.__sheepInf;
  if (prev && typeof prev.off === 'function') { try { prev.off(); } catch (e) { } }

  G.__sheepInf = {
    num: NUM,
    status: function () { return JSON.stringify(st); },
    arm: function () { var r = arm(true); st.ok = r; return r; },
    remove: direct.remove,
    cancel: direct.cancel,
    shuffle: direct.shuffle,
    off: restore
  };

  var installed = arm(true);
  var setT = G.setInterval || setInterval;
  st.timer = setT(function () {
    st.ticks++;
    try {
      var ui = findUi();
      if (!ui) return;
      var u = ui.userData || {};
      var low = num(u.prop_remove) === null || u.prop_remove < NUM ||
        num(u.prop_cancel) === null || u.prop_cancel < NUM ||
        num(u.prop_random) === null || u.prop_random < NUM;
      // re-arm quietly unless something actually drifted (then redraw the labels too)
      arm(low && (st.ticks % 2 === 0));
    } catch (e) { st.errs.push('tick:' + e); }
  }, 1000);

  return JSON.stringify({
    ok: !!installed, ui: st.uiClass, node: st.uiNode, inv: st.inv,
    gatePatched: st.gatePatched, saved: st.saved, status: st.ok
  });
})()
