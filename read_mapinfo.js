(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  return JSON.stringify({ mapInfo: G.__mapInfo || null });
})()
