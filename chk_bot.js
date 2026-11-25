(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var b = G.__sheepBot;
  if (!b) return JSON.stringify({ bot: false });
  var st = b.state || {};
  return JSON.stringify({
    bot: true,
    phase: st.phase, mode: st.mode, clicks: st.clicks, wins: st.wins,
    planLen: st.plan ? st.plan.length : null,
    lastError: st.lastError || null,
    logs: (b.logs || []).slice(-8)
  });
})()
