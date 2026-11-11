(function () {
  var root = document.documentElement;
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) {
      return null;
    }
  }
  function setLang(l) {
    root.setAttribute('data-lang', l);
    root.lang = l === 'zh' ? 'zh-Hant' : l === 'hans' ? 'zh-Hans' : 'en';
    document.querySelectorAll('button[data-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === l)); });
    store('lang', l);
  }
  function setTheme(t) {
    if (t === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    document.querySelectorAll('button[data-th]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.th === t)); });
    store('theme', t);
  }
  setLang(root.getAttribute('data-lang') || 'en');
  setTheme(store('theme') || 'auto');
  document.querySelectorAll('button[data-lang]').forEach(function (b) { b.onclick = function () { setLang(b.dataset.lang); }; });
  document.querySelectorAll('button[data-th]').forEach(function (b) { b.onclick = function () { setTheme(b.dataset.th); }; });

  // The docs sidebar is a collapsed list on phones and always open on wider screens.
  var nav = document.querySelector('details.doc-nav');
  if (nav) {
    var wide = matchMedia('(min-width: 861px)');
    var sync = function () { nav.open = wide.matches; };
    sync();
    wide.addEventListener('change', sync);
  }

  // Scroll tour: the step crossing the middle of the viewport picks the animation scene.
  var stage = document.querySelector('[data-demo="tour"]');
  var steps = document.querySelectorAll('.tour-step');
  if (stage && steps.length && 'IntersectionObserver' in window) {
    var activate = function (step) {
      steps.forEach(function (s) { s.classList.toggle('is-active', s === step); });
      if (stage.dataset.scene !== step.dataset.step) stage.dataset.scene = step.dataset.step;
    };
    activate(steps[0]);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) activate(e.target); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(function (s) { io.observe(s); });
  }

  var cmd = document.getElementById('cmd');
  if (cmd) {
    document.querySelectorAll('.install [role=tab]').forEach(function (t) {
      t.onclick = function () {
        document.querySelectorAll('.install [role=tab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
        cmd.textContent = t.dataset.cmd;
      };
    });
    var copy = document.getElementById('copy');
    copy.onclick = function () {
      var select = function () {
        var r = document.createRange();
        r.selectNodeContents(cmd);
        var s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      };
      if (!navigator.clipboard) return select();
      navigator.clipboard.writeText(cmd.textContent).then(function () {
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
      }, select);
    };
  }
})();
