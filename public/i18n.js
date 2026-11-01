/* TV Hub dashboard i18n — Persian (default) and English.
 * fa: nothing happens (the page is written in Persian).
 * en: every Persian text (static or created later by the app) is translated with the dictionary in i18n-en.js.
 * Switch language with the button in the header; the choice is remembered in this browser.
 */
(function () {
  var KEY = 'tvhub-lang';
  var lang = 'fa';
  try { lang = localStorage.getItem(KEY) || window.TVHUB_DEFAULT_LANG || 'fa'; } catch (e) { lang = window.TVHUB_DEFAULT_LANG || 'fa'; }
  if (lang !== 'en' && lang !== 'fa') lang = 'fa';
  window.TVLANG = lang;
  var de = document.documentElement;
  de.lang = lang;
  de.dir = lang === 'en' ? 'ltr' : 'rtl';
  window.setLang = function (l) {
    try { localStorage.setItem(KEY, l); } catch (e) {}
    location.reload();
  };
  window.t = function (s) { return s; };
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('langBtn'); if (b) b.textContent = lang === 'en' ? 'فارسی' : 'EN';
  });
  if (lang !== 'en') return;

  var T = window.TVI18N.create(window.I18N_EN);
  var tr = T.tr, FA = T.FA;
  window.t = tr;
  window.I18N_MISSING = T.missing;   // run in the browser console to list texts that still lack a translation

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function doNode(n) {
    if (n.nodeType === 3) {
      var p = n.parentNode;
      if (p && /^(SCRIPT|STYLE)$/.test(p.nodeName)) return;
      var v = n.nodeValue;
      if (v && (FA.test(v) || /[۰-۹٪٫٬،؟؛]/.test(v))) { var nv = tr(v); if (nv !== v) n.nodeValue = nv; }
    } else if (n.nodeType === 1) {
      if (/^(SCRIPT|STYLE)$/.test(n.tagName)) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var a = n.getAttribute(ATTRS[i]);
        if (a && FA.test(a)) { var na = tr(a); if (na !== a) n.setAttribute(ATTRS[i], na); }
      }
      for (var c = n.firstChild; c; c = c.nextSibling) doNode(c);
    }
  }

  var obs = new MutationObserver(function (list) {
    obs.disconnect();
    try {
      list.forEach(function (m) {
        if (m.type === 'childList') m.addedNodes.forEach(doNode);
        else doNode(m.target);
      });
    } finally { start(); }
  });
  function start() {
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS });
  }
  start();
  document.addEventListener('DOMContentLoaded', function () {
    obs.disconnect(); doNode(document.body); doNode(document.head); start();
    var tt = document.querySelector('title'); if (tt) tt.textContent = tr(tt.textContent);
  });

  // native dialogs created by the app's code
  ['alert', 'confirm', 'prompt'].forEach(function (f) {
    var orig = window[f];
    window[f] = function (msg, def) { return orig.call(window, tr(String(msg)), def); };
  });
})();
