/* TV Hub i18n core — shared by the dashboard (browser) and the server (Node).
 * create(dictionary) returns { tr(text), missing() }: tr() turns Persian text into English using the dictionary
 * ({exact, patterns}) and leaves anything it does not know untouched. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TVI18N = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Persian/Arabic letters only (digits and punctuation are not "text to translate")
  var FA = /[\u0620-\u063F\u0641-\u064A\u0671-\u06D3\u06D5\u06FA-\u06FF]/;
  var FADIG = '۰۱۲۳۴۵۶۷۸۹';
  function digits(s) {
    return s.replace(/[۰-۹]/g, function (c) { return FADIG.indexOf(c); })
            .replace(/٬|،/g, ',').replace(/٫/g, '.').replace(/٪/g, '%').replace(/؟/g, '?').replace(/؛/g, ';');
  }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
  function keepSpace(orig, out) { return /^\s*/.exec(orig)[0] + out + /\s*$/.exec(orig)[0]; }

  function create(D) {
    D = D || { exact: {}, patterns: {} };
    var exact = D.exact || {};
    var exactKeys = Object.keys(exact).filter(function (k) { return k.length >= 3; })
      .sort(function (a, b) { return b.length - a.length; });
    var WB = '\\u0600-\\u06FF\\u200c';
    var subRe = exactKeys.length
      ? new RegExp('(?<![' + WB + '])(?:' + exactKeys.map(esc).join('|') + ')(?![' + WB + '])', 'g') : null;
    // patterns: {} = any text, {#} = a number/word without spaces; ^ and $ anchor explicitly
    var pats = Object.keys(D.patterns || {}).map(function (k0) {
      var k = k0, pre = '', post = '';
      if (k.charAt(0) === '^') { pre = '^'; k = k.slice(1); }
      if (k.slice(-1) === '$') { post = '$'; k = k.slice(0, -1); }
      if (!pre && k.indexOf('{}') === 0) pre = '^';
      if (!post && k.slice(-2) === '{}') { post = '$'; pre = '^'; }   // "text{}" means: the whole line is "text" + a value
      var lit = k.split(/\{#?\}/), tok = k.match(/\{#?\}/g) || [], src = '';
      for (var i = 0; i < lit.length; i++) {
        src += esc(lit[i]);
        if (i < tok.length) src += tok[i] === '{#}' ? '(\\S+?)' : '([\\s\\S]*?)';
      }
      return { re: new RegExp(pre + src + post, 'g'), out: D.patterns[k0], lit: lit.join('').length };
    }).sort(function (a, b) { return (b.lit - a.lit) || (b.re.source.length - a.re.source.length); });   // most specific (most fixed text) first

    var cache = Object.create(null), MISS = Object.create(null);

    function tr1(s, quiet) {
      if (!FA.test(s)) return digits(s);
      var n = norm(s);
      if (cache[n] !== undefined) return cache[n] === null ? s : keepSpace(s, cache[n]);
      var out = null, partial = false;
      if (exact[n] !== undefined) out = exact[n];
      else {
        var w = n, changed = false, viaSub = false;
        for (var i = 0; i < pats.length; i++) {
          w = w.replace(pats[i].re, function () {
            var m = arguments; changed = true;
            return pats[i].out.replace(/\{(\d+)\}/g, function (_, k) { return tr(m[+k] || '', true); });
          });
        }
        if (subRe) w = w.replace(subRe, function (k) { changed = viaSub = true; return exact[k]; });
        if (changed) out = w;
        partial = viaSub;
      }
      if (out === null) { if (!quiet) MISS[n] = 1; cache[n] = null; return s; }
      out = digits(out);
      if (partial && FA.test(out) && !quiet) MISS[n] = 1;   // only partly translated
      cache[n] = out;
      return keepSpace(s, out);
    }
    // multi-line texts (dialogs, Telegram messages) are translated line by line
    function tr(s, quiet) {
      if (typeof s !== 'string') return s;
      if (!FA.test(s)) return digits(s);
      if (/\n/.test(s.trim())) return s.split(/(\n+)/).map(function (p, i) { return i % 2 ? p : tr1(p, quiet); }).join('');
      return tr1(s, quiet);
    }
    return { tr: tr, missing: function () { return Object.keys(MISS); }, FA: FA };
  }
  return { create: create, FA: FA };
});
