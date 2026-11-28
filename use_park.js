// use_park.js - 页面内执行「移出」道具
//
// 机制（见 bot.js 注释）：PropType.remove，把 crushArray 里的手牌前 3 张移到
// moveOutObj 的三格暂存区。**手牌为空时无法使用**，这是游戏机制而非脚本限制。
//
// 返回 JSON：
//   { ok, hand, trayBefore, trayAfter, ret, err }

(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;

  function findComps() {
    var cc = G.cc;
    if (!cc || !cc.director) return null;
    var scene = cc.director.getScene();
    if (!scene) return null;
    var out = { crush: null, moveOut: null };
    var stack = [scene];
    while (stack.length) {
      var n = stack.pop();
      var comps = n._components || [];
      for (var i = 0; i < comps.length; i++) {
        var c = comps[i];
        if (!c) continue;
        if (!out.crush && ('crushArray' in c) && typeof c.moveOutBlock === 'function') out.crush = c;
        else if (!out.moveOut && ('moveOutObj' in c)) out.moveOut = c;
      }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) stack.push(ch[k]);
    }
    return out;
  }

  function countTray(moveOut) {
    var n = 0;
    if (!moveOut || !moveOut.moveOutObj) return n;
    for (var k in moveOut.moveOutObj) {
      var arr = moveOut.moveOutObj[k];
      if (arr && arr.length) n += arr.length;
    }
    return n;
  }

  try {
    var c = findComps();
    if (!c || !c.crush) {
      return JSON.stringify({ ok: false, err: 'crush_component_not_found' });
    }

    var hand = c.crush.crushArray || [];
    var trayBefore = countTray(c.moveOut);

    if (!hand.length) {
      return JSON.stringify({
        ok: false, err: 'hand_empty', hand: 0, trayBefore: trayBefore,
        hint: 'move-out only works on hand cards; the hand is empty at solve time'
      });
    }

    var ret = null, err = null;
    try {
      ret = c.crush.moveOutBlock();
    } catch (e) {
      err = String((e && e.message) || e);
    }

    var trayAfter = countTray(c.moveOut);
    return JSON.stringify({
      ok: err === null,
      hand: hand.length,
      trayBefore: trayBefore,
      trayAfter: trayAfter,
      ret: ret === undefined ? null : String(ret),
      err: err
    });
  } catch (e) {
    return JSON.stringify({ ok: false, err: String((e && e.message) || e) });
  }
})()
