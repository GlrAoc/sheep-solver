// 实验：点方案前 3 张 -> 移出 -> 报告暂存区状态，验证移出语义
(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var cc = G.cc;
  var scene = cc.director.getScene();
  var out = { steps: [] };

  var board = null, crush = null, moveOut = null;
  var stack = [scene];
  while (stack.length) {
    var n = stack.pop(), cs = n._components || [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i]; if (!c) continue;
      try {
        if (!board && ("nowLevelBlockObj" in c) && typeof c.checkIsShow === 'function') board = c;
        else if (!crush && ("crushArray" in c) && typeof c.moveOutBlock === 'function') crush = c;
        else if (!moveOut && ("moveOutObj" in c)) moveOut = c;
      } catch (e) { }
    }
    var ch = n.children || [];
    for (var k = 0; k < ch.length; k++) stack.push(ch[k]);
  }
  if (!board || !crush) return JSON.stringify({ err: 'comp_missing' });

  var STUB = { stopPropagation: function () { }, preventDefault: function () { } };

  function allCards() {
    var res = [];
    var obj = board.nowLevelBlockObj || {};
    for (var L in obj) for (var R in obj[L]) for (var C2 in obj[L][R]) {
      var nd = obj[L][R][C2];
      var comps = (nd && nd._components) || [];
      for (var q = 0; q < comps.length; q++) {
        var cd = comps[q] && comps[q].cardDataObj;
        if (cd && typeof comps[q].touchEnd === 'function') { res.push(comps[q]); break; }
      }
    }
    return res;
  }

  function handTypes() {
    return (crush.crushArray || []).map(function (x) {
      return x && x.cardDataObj ? x.cardDataObj.type : null;
    });
  }

  function trayState() {
    var o = {};
    var mo = moveOut && moveOut.moveOutObj;
    if (mo) for (var kk in mo) {
      o[kk] = (mo[kk] || []).map(function (x) {
        return x && x.cardDataObj ? x.cardDataObj.type : null;
      });
    }
    return o;
  }

  out.handBefore = handTypes();
  out.trayBefore = trayState();

  // 点前 3 张"未被压住"的牌：直接找 cnt==0 的（用 checkIsShow 近似）
  var cards = allCards();
  var clicked = 0;
  for (var ci = 0; ci < cards.length && clicked < 3; ci++) {
    var comp = cards[ci];
    try {
      if (comp.isShowLight === false) continue;
      var cd = comp.cardDataObj;
      if (!cd) continue;
      // 只点没被压住的：用 checkIsShow 的兄弟逻辑不易拿，改用 removed 状态判断
      if (cd.moldType === 0) continue;
      comp.touchStart(STUB);
      comp.touchEnd(STUB);
      clicked++;
    } catch (e) { }
  }
  out.clicked = clicked;
  out.handAfterClick = handTypes();

  var moOk = false, moErr = null;
  try { moOk = crush.moveOutBlock(); } catch (e) { moErr = String((e && e.message) || e); }
  out.moveOutCalled = moOk;
  out.moveOutErr = moErr;
  out.handAfterMoveOut = handTypes();
  out.trayAfter = trayState();
  out.failNumber = crush.failNumber;

  return JSON.stringify(out);
})()
