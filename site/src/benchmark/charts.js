// Interactive benchmark charts. Data: window.BENCH (charts-data.json, inlined by build.ts).
// Colors come from CSS tokens (--viz-*) so light/dark and the theme toggle apply.
(function () {
  var D = window.BENCH;
  if (!D) return;
  var NS = 'http://www.w3.org/2000/svg';
  var root = document.documentElement;
  var lang = function () { return root.getAttribute('data-lang') === 'zh' ? 'zh' : 'en'; };
  var T = {
    en: { claude: 'Claude model (claude-sonnet-5-5)', chatgpt: 'ChatGPT model (gpt-6.1-sol)', hit: 'cache hit', range: 'single-run range', tokens: 'tokens / task', cost: '$ / task', runs: 'runs', time: 'time', single: 'Single agent', sub: '3 subagents', teams: 'Agent Teams, 3 members', vsSingle: 'vs single agent', notTeam: 'official did not actually form a team in -p; reference only', round: 'Turn', idle: 'idle before', min: 'min', total: 'total over 2.7 h', first: 'first request hit', tui: 'total tokens, 6 turns' },
    zh: { claude: 'Claude 模型（claude-sonnet-5-5）', chatgpt: 'ChatGPT 模型（gpt-6.1-sol）', hit: '命中率', range: '單次範圍', tokens: 'token / 任務', cost: '$ / 任務', runs: '次', time: '用時', single: '單代理', sub: '3 個 subagent', teams: 'Agent Teams 3 人', vsSingle: '相對單代理', notTeam: '官方在 -p 下沒有真正組隊，僅供參考', round: '第', idle: '之前閒置', min: '分鐘', total: '2.7 小時總量', first: '第一個請求命中率', tui: '6 輪總 token' },
  };
  var t = function (k) { return T[lang()][k]; };
  var name = function (cli) { return D.clis[cli][lang()]; };
  var ours = function (cli) { return !!D.clis[cli].ours; };
  var css = function (v) { return getComputedStyle(root).getPropertyValue(v).trim(); };

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function label(parent, x, y, text, opts) {
    opts = opts || {};
    var n = el('text', { x: x, y: y, fill: opts.fill || 'var(--viz-ink2)', 'font-size': opts.size || 12, 'text-anchor': opts.anchor || 'start', 'font-weight': opts.weight || 400, 'dominant-baseline': 'middle' }, parent);
    n.textContent = text;
    return n;
  }

  // One tooltip per card; rows are [value, label] pairs, value first.
  function tooltip(card) {
    var tip = card.querySelector('.viz-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tip'; tip.hidden = true; card.appendChild(tip); }
    return {
      show: function (evt, title, rows) {
        tip.textContent = '';
        var h = document.createElement('div'); h.className = 'viz-tip-title'; h.textContent = title; tip.appendChild(h);
        rows.forEach(function (r) {
          var row = document.createElement('div');
          var b = document.createElement('b'); b.textContent = r[0];
          var s = document.createElement('span'); s.textContent = ' ' + r[1];
          row.appendChild(b); row.appendChild(s); tip.appendChild(row);
        });
        tip.hidden = false;
        var box = card.getBoundingClientRect();
        var x = (evt.clientX || box.left + box.width / 2) - box.left + 14;
        var y = (evt.clientY || box.top + 40) - box.top + 14;
        if (x + tip.offsetWidth > box.width - 8) x = Math.max(8, x - tip.offsetWidth - 28);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
      },
      hide: function () { tip.hidden = true; },
    };
  }
  function hover(node, card, title, rows) {
    var tip = tooltip(card);
    node.setAttribute('tabindex', '0');
    node.setAttribute('class', (node.getAttribute('class') || '') + ' viz-hit');
    var show = function (e) { tip.show(e, typeof title === 'function' ? title() : title, rows()); };
    node.addEventListener('pointermove', show);
    node.addEventListener('focus', show);
    node.addEventListener('pointerleave', tip.hide);
    node.addEventListener('blur', tip.hide);
  }
  function svgFor(id, height) {
    var card = document.getElementById(id);
    var box = card.querySelector('.viz-plot');
    box.textContent = '';
    var w = Math.max(box.clientWidth, 320);
    var svg = el('svg', { width: w, height: height, viewBox: '0 0 ' + w + ' ' + height, role: 'img' }, box);
    return { card: card, svg: svg, w: w };
  }
  var narrow = function (w) { return w < 560; };

  // A. Overall hit rate: mean dot + single-run range, grouped by model side.
  function overall() {
    var groups = ['claude', 'chatgpt'].map(function (side) {
      return { side: side, rows: D.overall.filter(function (r) { return D.clis[r.cli].side === side; }).sort(function (a, b) { return b.hit - a.hit; }) };
    });
    var stack = narrow(document.getElementById('viz-overall').querySelector('.viz-plot').clientWidth);
    var rowH = stack ? 40 : 30, head = 26, gap = 14;
    var h = 30 + groups.reduce(function (s, g) { return s + head + g.rows.length * rowH + gap; }, 0);
    var c = svgFor('viz-overall', h);
    var x0 = stack ? 16 : 210, x1 = c.w - 16, lo = 30, hi = 100;
    var sx = function (v) { return x0 + (v - lo) / (hi - lo) * (x1 - x0); };
    var y = 8;
    for (var v = lo; v <= hi; v += 10) {
      el('line', { x1: sx(v), x2: sx(v), y1: 4, y2: h - 22, stroke: 'var(--viz-grid)' }, c.svg);
      label(c.svg, sx(v), h - 10, v + '%', { anchor: 'middle', size: 11, fill: 'var(--viz-muted)' });
    }
    groups.forEach(function (g) {
      label(c.svg, 0, y + 12, t(g.side), { weight: 600, size: 12, fill: 'var(--viz-ink2)' });
      y += head;
      g.rows.forEach(function (r) {
        var cy = stack ? y + 28 : y + rowH / 2, col = ours(r.cli) ? 'var(--viz-1)' : 'var(--viz-other)';
        label(c.svg, 2, stack ? y + 10 : cy, name(r.cli), { fill: ours(r.cli) ? 'var(--viz-ink)' : 'var(--viz-ink2)', weight: ours(r.cli) ? 600 : 400, size: narrow(c.w) ? 11 : 12.5 });
        el('line', { x1: sx(r.min), x2: sx(r.max), y1: cy, y2: cy, stroke: col, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.6 }, c.svg);
        el('circle', { cx: sx(r.hit), cy: cy, r: 6, fill: col, stroke: 'var(--viz-surface)', 'stroke-width': 2 }, c.svg);
        var hit = el('rect', { x: 0, y: y, width: c.w, height: rowH, fill: 'transparent' }, c.svg);
        hover(hit, c.card, function () { return name(r.cli); }, function () {
          return [[r.hit + '%', t('hit')], [r.min + '–' + r.max + '%', t('range')], [r.tokens + 'k', t('tokens')], ['$' + r.cost.toFixed(3), t('cost')], [String(r.n), t('runs')]];
        });
        y += rowH;
      });
      y += gap;
    });
  }

  // Sequential blue ramp (steps 100–700), value 0..1 -> step.
  var RAMP = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700'];
  function ramp(v) { return 'var(' + RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor(v * RAMP.length)))] + ')'; }
  function inkOn(v) { return v >= 3 / 7 ? '#ffffff' : '#0b0b0b'; }

  function heatmap(id, cols, rows, opts) {
    var cellH = 30, top = 44, lw = opts.labelW;
    var cw = Math.max(62, Math.floor(((document.getElementById(id).querySelector('.viz-plot').clientWidth || 600) - lw) / cols.length));
    var w = lw + cw * cols.length;
    var h = top + rows.length * cellH + 8;
    var card = document.getElementById(id);
    var box = card.querySelector('.viz-plot');
    box.textContent = '';
    var svg = el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img' }, box);
    cols.forEach(function (cname, j) {
      var lines = String(cname).split('\n');
      lines.forEach(function (ln, k) { label(svg, lw + j * cw + cw / 2, 14 + k * 14, ln, { anchor: 'middle', size: 11, fill: 'var(--viz-ink2)' }); });
    });
    rows.forEach(function (r, i) {
      var y = top + i * cellH;
      label(svg, 0, y + cellH / 2, r.label, { size: 12, fill: r.strong ? 'var(--viz-ink)' : 'var(--viz-ink2)', weight: r.strong ? 600 : 400 });
      r.values.forEach(function (v, j) {
        var norm = opts.norm(v);
        var rect = el('rect', { x: lw + j * cw + 1, y: y + 1, width: cw - 2, height: cellH - 2, rx: 4, fill: ramp(norm) }, svg);
        label(svg, lw + j * cw + cw / 2, y + cellH / 2, v + '%', { anchor: 'middle', size: 11.5, fill: inkOn(norm), weight: 500 });
        hover(rect, card, function () { return r.label + ' · ' + opts.colTitle(j); }, function () { return opts.tip(r, j); });
      });
    });
  }

  function tasks() {
    var cols = D.tasks.clis;
    var colNames = cols.map(function (c) { return D.clis[c][lang() === 'zh' ? 'shortZh' : 'shortEn']; });
    heatmap('viz-tasks', colNames, D.tasks.rows.map(function (r) {
      return { label: r[lang()], values: r.cells.map(function (c) { return c[0]; }), raw: r };
    }), {
      labelW: 128,
      norm: function (v) { return (v - 50) / 46; },
      colTitle: function (j) { return name(cols[j]); },
      tip: function (r, j) { var c = r.raw.cells[j]; return [[c[0] + '%', t('hit')], [c[1] + 'k', t('tokens')], [c[2] + 's', t('time')]]; },
    });
  }

  function idle() {
    var g = D.idle.gaps;
    var cols = g.map(function (m, i) { return (lang() === 'zh' ? t('round') + (i + 1) + ' 輪' : t('round') + ' ' + (i + 1)) + '\n+' + m + ' ' + (lang() === 'zh' ? '分' : 'min'); });
    heatmap('viz-idle', cols, D.idle.rows.map(function (r) {
      return { label: name(r.cli), values: r.first, strong: ours(r.cli), raw: r };
    }), {
      labelW: 190,
      norm: function (v) { return v / 100; },
      colTitle: function (j) { return (lang() === 'zh' ? '第 ' + (j + 1) + ' 輪' : 'Turn ' + (j + 1)); },
      tip: function (r, j) { return [[r.raw.first[j] + '%', t('first')], [g[j] + ' ' + t('min'), t('idle')], [r.raw.tokens + 'k', t('total')], ['$' + r.raw.cost.toFixed(3), t('total')]]; },
    });
  }

  // D. Multi-agent: grouped horizontal bars, 3 modes in categorical slots 1–3.
  function multi() {
    var modes = ['single', 'sub', 'teams'];
    var barH = 12, rowGap = 18;
    var rows = D.multi;
    var lift = narrow(document.getElementById('viz-multi').querySelector('.viz-plot').clientWidth) ? 18 : 0;
    var h = 12 + rows.length * (modes.length * (barH + 2) + rowGap + lift) + 24;
    var c = svgFor('viz-multi', h);
    var stack = narrow(c.w), x0 = stack ? 16 : 210, x1 = c.w - 44, max = 500;
    var sx = function (v) { return x0 + v / max * (x1 - x0); };
    for (var v = 0; v <= max; v += stack ? 250 : 100) {
      el('line', { x1: sx(v), x2: sx(v), y1: 4, y2: h - 22, stroke: 'var(--viz-grid)' }, c.svg);
      label(c.svg, sx(v), h - 10, v + 'k', { anchor: 'middle', size: 11, fill: 'var(--viz-muted)' });
    }
    var y = 8;
    rows.forEach(function (r) {
      var blockH = modes.length * (barH + 2);
      if (stack) { label(c.svg, 2, y + 6, name(r.cli), { fill: ours(r.cli) ? 'var(--viz-ink)' : 'var(--viz-ink2)', weight: ours(r.cli) ? 600 : 400, size: 11.5 }); y += lift; }
      else label(c.svg, 0, y + blockH / 2, name(r.cli), { fill: ours(r.cli) ? 'var(--viz-ink)' : 'var(--viz-ink2)', weight: ours(r.cli) ? 600 : 400, size: narrow(c.w) ? 11 : 12.5 });
      modes.forEach(function (m, k) {
        var by = y + k * (barH + 2);
        if (r[m] == null) return;
        var bar = el('rect', { x: x0, y: by, width: Math.max(2, sx(r[m]) - x0), height: barH, rx: 3, fill: 'var(--viz-' + (k + 1) + ')', opacity: m === 'teams' && r.teamsNote ? 0.45 : 1 }, c.svg);
        label(c.svg, sx(r[m]) + 6, by + barH / 2, (r[m] / r.single).toFixed(1) + '×', { size: 11, fill: 'var(--viz-ink2)' });
        hover(bar, c.card, function () { return name(r.cli) + ' · ' + t(m); }, function () {
          var out = [[r[m] + 'k', t('tokens')], [(r[m] / r.single).toFixed(1) + '×', t('vsSingle')]];
          if (m === 'teams' && r.teamsNote) out.push(['*', t('notTeam')]);
          return out;
        });
      });
      y += blockH + rowGap;
    });
    var legend = c.card.querySelector('.viz-legend');
    legend.textContent = '';
    modes.forEach(function (m, k) {
      var item = document.createElement('span');
      var sw = document.createElement('i'); sw.style.background = 'var(--viz-' + (k + 1) + ')';
      item.appendChild(sw); item.appendChild(document.createTextNode(t(m)));
      legend.appendChild(item);
    });
  }

  // E. TUI 6 turns: total tokens, one bar per CLI.
  function tui() {
    var rows = D.tui.slice().sort(function (a, b) { return a.tokens - b.tokens; });
    var stack = narrow(document.getElementById('viz-tui').querySelector('.viz-plot').clientWidth);
    var rowH = stack ? 40 : 26;
    var h = rows.length * rowH + 34;
    var c = svgFor('viz-tui', h);
    var x0 = stack ? 16 : 210, x1 = c.w - 56, max = 700;
    var sx = function (v) { return x0 + v / max * (x1 - x0); };
    for (var v = 0; v <= max; v += stack ? 350 : 100) {
      el('line', { x1: sx(v), x2: sx(v), y1: 4, y2: h - 22, stroke: 'var(--viz-grid)' }, c.svg);
      label(c.svg, sx(v), h - 10, v + 'k', { anchor: 'middle', size: 11, fill: 'var(--viz-muted)' });
    }
    rows.forEach(function (r, i) {
      var y = 6 + i * rowH + (stack ? 14 : 0);
      label(c.svg, 2, stack ? y - 4 : y + rowH / 2 - 2, name(r.cli), { fill: ours(r.cli) ? 'var(--viz-ink)' : 'var(--viz-ink2)', weight: ours(r.cli) ? 600 : 400, size: narrow(c.w) ? 11 : 12.5 });
      var bar = el('rect', { x: x0, y: y + 4, width: sx(r.tokens) - x0, height: 14, rx: 3, fill: ours(r.cli) ? 'var(--viz-1)' : 'var(--viz-other)' }, c.svg);
      label(c.svg, sx(r.tokens) + 6, y + 11, r.tokens + 'k', { size: 11, fill: 'var(--viz-ink2)' });
      hover(bar, c.card, function () { return name(r.cli); }, function () { return [[r.tokens + 'k', t('tui')], [r.hit + '%', t('hit')]]; });
    });
  }

  function renderAll() { overall(); tasks(); idle(); multi(); tui(); }
  renderAll();
  new MutationObserver(renderAll).observe(root, { attributes: true, attributeFilter: ['data-lang', 'data-theme'] });
  var timer;
  window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(renderAll, 120); });

  // Same-origin iframe: grow it to the scatter page's height.
  var frame = document.getElementById('scatter-frame');
  if (frame) {
    var fit = function () { try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch (e) {} };
    frame.addEventListener('load', function () { fit(); new ResizeObserver(fit).observe(frame.contentDocument.body); });
  }
})();
