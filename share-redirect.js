/**
 * share-redirect.js — 社群分享靜態導頁自動跳轉至單篇閱讀視圖（符合嚴格 CSP 'self' 規範）
 */
(function () {
  "use strict";
  var target = document.documentElement.getAttribute("data-target-route");
  if (target) {
    window.location.replace(target);
  }
})();
