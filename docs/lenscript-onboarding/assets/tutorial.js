/* 镜语剧本编辑器 · 引导页交互 */
(function () {
  'use strict';

  /* ── 1. 目录滚动高亮 ───────────────────────────── */
  function initScrollSpy() {
    var links = Array.prototype.slice.call(document.querySelectorAll('aside.toc a'));
    var sections = links
      .map(function (a) {
        var id = a.getAttribute('href').slice(1);
        return { id: id, el: document.getElementById(id), link: a };
      })
      .filter(function (s) { return s.el; });

    if (!sections.length || !('IntersectionObserver' in window)) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        sections.forEach(function (s) {
          s.link.classList.toggle('active', s.id === entry.target.id);
        });
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });

    sections.forEach(function (s) { observer.observe(s.el); });
  }

  /* ── 2. 标签速查 ───────────────────────────────── */
  var TAGS = {
    script: [
      { key: 's', label: '场景', color: '#3A7D44' },
      { key: 'a', label: '动作', color: '#6B5B95' },
      { key: 'r', label: '角色', color: '#A05A2C' },
      { key: 'l', label: '对白', color: '#2F6FAF' },
      { key: 'p', label: '括注', color: '#7F7F7F' },
      { key: 'x', label: '转场', color: '#A33F62' }
    ],
    semantic: [
      { key: 'd', label: '描述', color: '#2F6FAF' },
      { key: 'e', label: '例子', color: '#C0504D' },
      { key: 'v', label: '验证', color: '#5572F1' },
      { key: 't', label: '迁移', color: '#9C7A00' },
      { key: 'c', label: '自定义说明', color: '#7F7F7F' }
    ]
  };

  function initTags() {
    var game = {
      active: null
    };

    function makeChip(tag) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip';
      chip.setAttribute('data-tag', tag.key);
      chip.setAttribute('aria-pressed', 'false');

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = tag.color;

      var code = document.createElement('span');
      code.textContent = '#' + tag.key;

      var label = document.createElement('span');
      label.className = 'lbl';
      label.textContent = tag.label;

      chip.appendChild(dot);
      chip.appendChild(code);
      chip.appendChild(label);
      chip.addEventListener('click', function () {
        select(game.active === tag.key ? null : tag.key);
      });
      return chip;
    }

    function select(key) {
      game.active = key;

      var chips = document.querySelectorAll('.tag-chip');
      Array.prototype.forEach.call(chips, function (chip) {
        var on = chip.getAttribute('data-tag') === key;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });

      var rows = document.querySelectorAll('#tag-sample .row');
      Array.prototype.forEach.call(rows, function (row) {
        var tag = row.getAttribute('data-tag');
        if (!key) {
          row.classList.remove('dim', 'hit');
        } else {
          var match = tag === key;
          row.classList.toggle('dim', !match);
          row.classList.toggle('hit', match);
        }
      });
    }

    var scriptHost = document.getElementById('chips-script');
    var semanticHost = document.getElementById('chips-semantic');
    if (scriptHost) TAGS.script.forEach(function (t) { scriptHost.appendChild(makeChip(t)); });
    if (semanticHost) TAGS.semantic.forEach(function (t) { semanticHost.appendChild(makeChip(t)); });
  }

  /* ── 3. 决策器 ─────────────────────────────────── */
  var RESULTS = {
    outline: {
      name: '① 剧本大纲（右侧栏）',
      why: '你只是想在看稿子时快速定位。右侧常驻、跟着光标走，是干扰最小的方案。',
      how: '命令「视图 · 大纲」；建议在设置里打开「打开剧本时自动展开大纲」。',
      tip: '它只改结构不改正文，拖完记得执行「大纲 · 把当前结构回写 Markdown」。'
    },
    map: {
      name: '② 导图 · 编辑模式',
      why: '改结构、写正文都在这一张图上完成，实时写回 Markdown。',
      how: '命令「视图 · 导图」；工具栏第一个按钮确认在编辑模式（铅笔图标的方向是「切到阅读」）。',
      tip: '双击标题改字，双击正文改整段；Tab 缩进、回车加兄弟；子节点拖到父节点身上可合并。右键节点能加「框 / 概要 / 标注」，方向菜单可切「向下组织图」，工具栏刷子是一键主题。'
    },
    mapread: {
      name: '② 导图 · 阅读模式',
      why: '正文全部自动展开、只读，最适合通读和检查场次。',
      how: '命令「视图 · 导图」，再点工具栏第一个按钮切到阅读模式（模式会被记住）。',
      tip: '阅读模式下正文可以选中复制；双击节点仍然会跳到笔记里对应的那一行。工具栏眼镜图标是「背诵模式」：遮住 ==高亮== 与标注，点一下揭开。'
    },
    board: {
      name: '③ 白板',
      why: '素材、分镜、角色关系这类需要空间感的整理，白板比层级结构更合适。',
      how: '命令「白板 · 新建白板」，或「白板 · 打开 Home 白板」。',
      tip: '要给别人过一遍结构时，用「白板 · 开始演示」。'
    },
    nestmind: {
      name: '④ 脑图文件（.nestmind）',
      why: '你要的是一张能单独命名、单独分享、不绑死某篇笔记的图。',
      how: '直接新建 .nestmind 文件；也可以在白板里把脑图卡片「导出为 .nestmind」。',
      tip: '它还能被插回白板，当素材卡片用。'
    }
  };

  function initWizard() {
    var box = document.getElementById('wizard-box');
    if (!box) return;

    var step0 = document.getElementById('wiz-step0');
    var step1 = document.getElementById('wiz-step1');
    var result = document.getElementById('wiz-result');
    var dots = box.querySelectorAll('.wiz-dot');

    /** 第二步按钮的取值就是结果键；保留一层映射，方便以后改名。 */
    var RESULT_KEY = { map: 'map', mapread: 'mapread' };

    function showDot(index) {
      Array.prototype.forEach.call(dots, function (d, i) {
        d.classList.toggle('on', i <= index);
      });
    }

    function toStep1() {
      step0.style.display = 'none';
      step1.style.display = 'block';
      result.classList.remove('show');
      showDot(1);
    }

    function showResult(key) {
      var data = RESULTS[RESULT_KEY[key] || key];
      if (!data) return;
      step0.style.display = 'none';
      step1.style.display = 'none';
      result.classList.add('show');
      showDot(2);
      document.getElementById('res-name').textContent = data.name;
      document.getElementById('res-why').textContent = data.why;
      document.getElementById('res-how').textContent = data.how;
      document.getElementById('res-tip').textContent = data.tip;
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('.wiz-opt');
      if (btn) {
        var go = btn.getAttribute('data-go');
        var res = btn.getAttribute('data-res');
        if (go === 'edit') { toStep1(); return; }
        if (go) { showResult(go); return; }
        if (res) { showResult(res); return; }
      }

      if (e.target.id === 'wiz-again' || e.target.closest('#wiz-again')) {
        step0.style.display = 'block';
        step1.style.display = 'none';
        result.classList.remove('show');
        showDot(0);
        box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }

  /* ── 4. 命令搜索 ───────────────────────────────── */
  function initCommandSearch() {
    var input = document.getElementById('cmd-search');
    var table = document.getElementById('cmd-table');
    var noResult = document.getElementById('no-result');
    if (!input || !table) return;

    var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));

    function filter() {
      var q = input.value.trim().toLowerCase();
      var visible = 0;

      rows.forEach(function (row) {
        var text = row.textContent.toLowerCase();
        var hit = !q || text.indexOf(q) !== -1;
        row.classList.toggle('hidden', !hit);
        if (hit) visible++;
      });

      if (noResult) noResult.style.display = visible === 0 ? 'block' : 'none';
    }

    input.addEventListener('input', filter);
    input.addEventListener('search', filter);
    filter();
  }

  /* ── 5. 上手清单 ───────────────────────────────── */
  function initChecklist() {
    var list = document.getElementById('check-list');
    if (!list) return;

    var KEY = 'lenscript-onboarding-steps';
    var items = Array.prototype.slice.call(list.querySelectorAll('.check-item'));
    var fill = document.getElementById('progress-fill');
    var text = document.getElementById('progress-text');

    var saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (err) {
      saved = [];
    }

    function persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch (err) {
        /* 隐私模式下写不进去，忽略即可 */
      }
    }

    function render() {
      var done = 0;
      items.forEach(function (item) {
        var step = item.getAttribute('data-step');
        var on = saved.indexOf(step) !== -1;
        item.classList.toggle('done', on);
        item.setAttribute('role', 'checkbox');
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        item.tabIndex = 0;
        if (on) done++;
      });

      if (fill) fill.style.width = (done / items.length * 100) + '%';
      if (text) text.textContent = done + ' / ' + items.length;
    }

    function toggle(item) {
      var step = item.getAttribute('data-step');
      var idx = saved.indexOf(step);
      if (idx === -1) saved.push(step);
      else saved.splice(idx, 1);
      persist();
      render();
    }

    items.forEach(function (item) {
      item.addEventListener('click', function () { toggle(item); });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle(item);
        }
      });
    });

    render();
  }

  /* ── 启动 ─────────────────────────────────────── */
  function boot() {
    initScrollSpy();
    initTags();
    initWizard();
    initCommandSearch();
    initChecklist();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
