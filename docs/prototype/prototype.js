/* Vgent 低保真原型交互。vanilla JS，无依赖，全事件委托。
 * 目的只有一个：证明布局和 token 在真实交互下站得住，不是产品代码。 */
(() => {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $('#app');
  const root = document.documentElement;
  const log = $('#log');
  const logInner = $('#log-inner');
  const input = $('#input');

  const save = (k, v) => { try { localStorage.setItem('vgent.' + k, v); } catch (e) {} };

  /* ── 主题 / 密度 ───────────────────────────────────────────────────── */

  function syncChrome() {
    // 深色优先：没有显式 data-theme="light" 时永远是深色，不跟随系统。
    const light = root.dataset.theme === 'light';
    $('#theme-label').textContent = light ? '浅色' : '深色';
    $('#theme-icon').firstElementChild.setAttribute('href', light ? '#i-sun' : '#i-moon');
    $('#density-label').textContent = root.dataset.density === 'compact' ? '紧凑' : '舒适';
  }

  const acts = {
    theme() {
      const light = root.dataset.theme === 'light';
      root.dataset.theme = light ? 'dark' : 'light';
      save('theme', root.dataset.theme);
      syncChrome();
    },

    density() {
      root.dataset.density = root.dataset.density === 'compact' ? 'comfortable' : 'compact';
      save('density', root.dataset.density);
      syncChrome();
    },

    /* ── 面板 ── */
    // ⌘B 在「240px 完整」和「48px 图标条」之间切，不再收到 0。
    'toggle-left'() { app.dataset.left = app.dataset.left === 'rail' ? 'on' : 'rail'; },

    'toggle-right'() {
      const on = app.dataset.right !== 'on';
      app.dataset.right = on ? 'on' : 'off';
      $('[data-act="toggle-right"]', $('#task-head')).setAttribute('aria-pressed', String(on));
    },

    'open-right'() { openPane('changes'); },

    tab(e, el) {
      const name = el.dataset.tab;
      $$('.tab[data-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
      $$('.pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
    },

    /* ── 视图切换 ── */
    'new-task'() { setView('empty'); },
    'select-task'(e, el) {
      $$('.task').forEach(t => t.setAttribute('aria-current', String(t === el)));
      setView('task');
    },
    'use-sug'(e, el) {
      setView('task');
      input.value = el.firstChild.textContent.trim();
      input.focus();
    },
    'open-editor'() { toast('原型里没有编辑器，这里只占个位。'); },
    'build-plan'() { toast('「构建」是占位，原型不执行计划。'); },
    noop() {},

    /* ── 分组方式 ── */
    groupby(e, el) { regroup(el.dataset.v); },

    /* ── 折叠 / 展开 ── */
    tool(e, el) {
      const card = el.closest('.tool');
      card.dataset.open = card.dataset.open === 'true' ? 'false' : 'true';
    },
    trow(e, el) {
      const row = el.closest('.trow');
      row.dataset.open = row.dataset.open === 'true' ? 'false' : 'true';
    },
    fold(e, el) {
      const box = el.closest('.fold');
      box.dataset.open = box.dataset.open === 'true' ? 'false' : 'true';
    },

    /* ── checkpoint：回退到某条用户消息 ── */
    checkpoint() { toast('已回退 3 个文件'); },

    /* ── 从对话流跳到右栏 ── */
    'open-diff'(e, el) {
      openPane('changes');
      const row = $(`.file-row[data-file="${el.dataset.file}"]`);
      if (!row) return;
      const box = row.closest('.pane-file');
      box.setAttribute('aria-expanded', 'true');
      $('.diff-wrap', box).hidden = false;
      flash(box);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    'open-term'() { openPane('term'); },

    'pane-file'(e, el) {
      const box = el.closest('.pane-file');
      const open = box.getAttribute('aria-expanded') !== 'true';
      box.setAttribute('aria-expanded', String(open));
      $('.diff-wrap', box).hidden = !open;
    },

    /* ── 审批 ── */
    approve(e, el) { resolveApproval(el, '已执行'); },
    'approve-always'(e, el) { resolveApproval(el, '已执行 · 本任务内一直允许'); },
    deny(e, el) {
      const card = el.closest('.tool');
      card.removeAttribute('data-status');
      $('[data-slot="status"]', card).innerHTML = '<span class="del">已拒绝</span>';
      $('[data-role="await"]', card).hidden = true;
    },

    /* ── 提问：两个问题，‹ › 翻页 ── */
    'ask-prev'(e, el) { askPage(el.closest('.ask'), -1); },
    'ask-next'(e, el) { askPage(el.closest('.ask'), +1); },
    'ask-submit'(e, el) { closeAsk(el.closest('.ask'), askAnswers(el.closest('.ask'))); },
    'ask-skip'(e, el) { closeAsk(el.closest('.ask'), '（已跳过）'); },
    'ask-reopen'(e, el) {
      const card = el.closest('.ask');
      $('[data-role="form"]', card).hidden = false;
      $('[data-role="answered"]', card).hidden = true;
    },

    /* ── 变更还原：引擎直接写盘，只有还原，没有「接受」 ── */
    'revert-file'(e, el) {
      const box = el.closest('.pane-file');
      markFile($('.file-row', box).dataset.file, '已还原');
    },

    /* ── 队列跳转 ── */
    jump(e, el) {
      const target = document.getElementById(el.dataset.target);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(target);
    },

    /* ── Composer ── */
    send() { if ($('#btn-send').dataset.running === 'true') acts.stop(); else doSend(); },
    mic() { toast('语音输入是占位，原型不实现。'); },
    stop() {
      $('#btn-stop').hidden = true;
      $('#btn-send').dataset.running = 'false';
      toast('已停止');
    },
    'to-bottom'() { log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }); },

    settings() { toast('设置是独立页面，这里只是入口。原型不实现。'); },

    /* ── 浮层 ── */
    cmdk() { openCmdk(); },
    pop(e, el) { openPop(el); },
  };

  function setView(view) {
    const task = view === 'task';
    $('#task-head').hidden = !task;
    $('#log').hidden = !task;
    $('#empty').hidden = task;
    $('#empty-sug').hidden = task;
    $('.review-bar').hidden = !task;
    $('#main').dataset.view = view;
    // 新任务还没跑，发送键回到箭头态
    if (!task) $('#btn-send').dataset.running = 'false';
    if (task) log.scrollTop = log.scrollHeight;
    else input.focus();
  }

  function openPane(name) {
    if (app.dataset.right !== 'on') acts['toggle-right']();
    acts.tab(null, { dataset: { tab: name } });
  }

  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  let toastTimer = 0;
  function toast(msg) {
    const box = $('#toast');
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2200);
  }

  function resolveApproval(el, label) {
    const card = el.closest('.tool');
    card.removeAttribute('data-status');
    card.dataset.open = 'true';
    $('[data-slot="status"]', card).innerHTML = '<span class="ok">exit 0</span>';
    $('.right', card).insertAdjacentHTML('beforeend', '<span>4.1s</span>');
    $('[data-role="await"]', card).hidden = true;
    $('[data-role="done"]', card).hidden = false;
    const q = $('.queue-item[data-target="tool-approval"]');
    if (q) q.remove();
    bumpCount('.tab[data-tab="queue"] .cnt', -1);
    void label;
  }

  function markFile(name, label) {
    $$(`.file-row[data-file="${name}"]`).forEach(row => {
      if (row.dataset.resolved === 'true') return;
      row.dataset.resolved = 'true';
      $('.stat', row).innerHTML = `<span class="faint">${label}</span>`;
    });
    toast(`${label}：${name}`);
  }

  /* ── 提问卡片：翻页 / 收口 ───────────────────────────────────────────── */

  function askPage(card, delta) {
    const pages = $$('.ask-page', card);
    const i = Math.min(pages.length, Math.max(1, (+card.dataset.i || 1) + delta));
    card.dataset.i = String(i);
    pages.forEach(p => { p.hidden = +p.dataset.page !== i; });
    $('[data-slot="i"]', card).textContent = String(i);
  }

  function askAnswers(card) {
    return $$('.ask-page', card).map(page => {
      const free = $('.ask-free', page).value.trim();
      const picked = $('input:checked', page);
      return free || (picked ? picked.value : '（未选）');
    }).join(' · ');
  }

  function closeAsk(card, answer) {
    $('[data-slot="answer"]', card).textContent = answer;
    $('[data-role="form"]', card).hidden = true;
    $('[data-role="answered"]', card).hidden = false;
    const q = $('.queue-item[data-target="ask-card"]');
    if (q) q.remove();
    bumpCount('.tab[data-tab="queue"] .cnt', -1);
  }

  /* ── 左栏分组：只重排现有节点，不重渲染 ─────────────────────────────── */

  const taskList = $('#task-list');
  const TASKS = $$('.task', taskList);

  const GROUPERS = {
    '按项目': t => t.dataset.repo,
    '按状态': t => ({ running: '进行中', approval: '待处理', question: '待处理' }[t.dataset.state] || '已完成'),
    '按更新时间': t => {
      const m = +t.dataset.ts;
      return m < 60 ? '一小时内' : m < 1080 ? '今天' : m < 2880 ? '昨天' : '更早';
    },
  };
  const ORDER = { '进行中': 0, '待处理': 1, '已完成': 2, '一小时内': 0, '今天': 1, '昨天': 2, '更早': 3 };

  function regroup(mode) {
    const key = GROUPERS[mode] ? mode : '按项目';
    $$('.group-title', taskList).forEach(g => g.remove());

    const buckets = new Map();
    TASKS.forEach(t => {
      const k = GROUPERS[key](t);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    });

    const names = [...buckets.keys()].sort((a, b) =>
      (ORDER[a] ?? 9) - (ORDER[b] ?? 9) || a.localeCompare(b));

    names.forEach(name => {
      const items = buckets.get(name).sort((a, b) => a.dataset.ts - b.dataset.ts);
      const head = document.createElement('div');
      head.className = 'group-title';
      // 按状态分组时组名带数量
      head.innerHTML = key === '按状态'
        ? `<span>${name}</span><span class="n">${items.length}</span>`
        : `<span>${name}</span>`;
      taskList.appendChild(head);
      items.forEach(t => taskList.appendChild(t));
    });
  }

  function bumpCount(sel, delta) {
    const el = $(sel);
    if (!el) return;
    const n = Math.max(0, (parseInt(el.textContent, 10) || 0) + delta);
    if (n === 0) el.remove(); else el.textContent = String(n);
  }

  /* ── 通用 popover ─────────────────────────────────────────────────── */

  const POPS = {
    repo:     { title: '项目', items: ['vgent  ·  feat/web-proto', 'freecode  ·  main', 'ai-sdk  ·  main'] },
    branch:   { title: '分支', items: ['main', 'feat/web-proto', 'fix/resume-stream'] },
    engine:   { title: '引擎', items: ['Claude Code', 'Codex', 'Vgent (自研)'] },
    model:    { title: '模型', items: ['claude-sonnet-4.5', 'claude-opus-4.1', 'gpt-5-codex', 'gemini-3-pro'] },
    model2:   { title: '模型', items: ['sonnet-4.5', 'opus-4.1', 'gpt-5-codex'] },
    // 权限只在任务头的胶囊上，不进 composer
    perm:     { title: '权限模式', items: ['plan', 'allow-reads', 'allow-edits', 'yolo'] },
    worktree: { title: 'worktree', items: ['feat/web-proto', 'main', '＋ 新建 worktree…'] },
    mode:     { title: '模式', items: ['Agent', 'Plan', 'Ask'] },
    groupby:  { title: '分组方式', items: ['按项目', '按状态', '按更新时间'], act: 'groupby' },
    runloc:   { title: '运行位置', items: ['本机', '新 worktree'] },
    runloc2:  { title: '运行位置', items: ['本机', '新 worktree'] },
    attach:   { title: '添加上下文', items: ['文件', '文件夹', '图片', '终端输出', '分支 diff'] },
    commit:   { title: '提交', items: ['提交', '提交并开 PR'] },
    sidechat: { title: '侧聊', note: '侧聊：不打断主线程问个问题（对应 /side）。原型里只占位。' },
  };

  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }

  function openPop(trigger) {
    const spec = POPS[trigger.dataset.pop];
    if (!spec) return;
    const wasFor = pop && pop.dataset.for === trigger.dataset.pop;
    closePop();
    if (wasFor) return;

    const slot = $('[data-slot]', trigger);
    const current = slot ? slot.textContent.trim() : '';
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.dataset.for = trigger.dataset.pop;
    pop.innerHTML =
      `<div class="pop-title">${spec.title}</div>` +
      (spec.note
        ? `<div class="pop-note">${spec.note}</div>`
        : spec.items.map(v =>
            `<button class="opt" data-v="${v}"><span class="lbl">${v}</span>` +
            `<span class="check">${v.startsWith(current) && current ? '✓' : ''}</span></button>`).join(''));

    pop.addEventListener('click', ev => {
      const opt = ev.target.closest('.opt');
      if (!opt) return;
      const v = opt.dataset.v;
      if (slot) slot.textContent = v.split('  ·  ')[0];
      if (spec.act && acts[spec.act]) acts[spec.act](ev, { dataset: { v } });
      closePop();
    });

    document.body.appendChild(pop);
    const r = trigger.getBoundingClientRect();
    const h = pop.offsetHeight;
    const below = r.bottom + 4 + h < innerHeight;
    pop.style.top = (below ? r.bottom + 4 : r.top - h - 4) + 'px';
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + 'px';
  }

  /* ── ⌘K 命令面板 ──────────────────────────────────────────────────── */

  const CMDS = [
    { l: '新任务', h: '⌘N', run: acts['new-task'] },
    { l: '切换任务：给 Web 端定三栏布局和 design token', h: '任务' },
    { l: '切换任务：清掉 dist 重新全量构建', h: '任务' },
    { l: '切换任务：续流断点存储方案调研', h: '任务' },
    { l: '切引擎：Claude Code', h: '引擎' },
    { l: '切引擎：Codex', h: '引擎' },
    { l: '切引擎：Vgent (自研)', h: '引擎' },
    { l: '切模型：claude-sonnet-4.5', h: '模型' },
    { l: '切模型：gpt-5-codex', h: '模型' },
    { l: '/compact  压缩当前上下文', h: '命令' },
    { l: '切换右栏（变更 / 文件 / 终端 / 计划 / 队列）', h: '⌘J', run: acts['toggle-right'] },
    { l: '切换左栏（完整 / 图标条）', h: '⌘B', run: acts['toggle-left'] },
    { l: '切换任务分组方式', h: '左栏', run: () => openPop($('.groupby')) },
    { l: '打开侧聊', h: '/side', run: () => openPop($('[data-pop="sidechat"]')) },
    { l: '切换主题', h: '', run: acts.theme },
    { l: '切换密度', h: '', run: acts.density },
  ];

  let cmdk = null, cursor = 0, shown = [];

  function openCmdk() {
    if (cmdk) return;
    cmdk = document.createElement('div');
    cmdk.className = 'scrim';
    cmdk.innerHTML =
      '<div class="cmdk" role="dialog" aria-label="命令面板">' +
      '<input class="cmdk-input" placeholder="搜索任务、引擎、模型、命令…" spellcheck="false">' +
      '<div class="cmdk-list"></div></div>';
    document.body.appendChild(cmdk);

    const box = $('.cmdk-input', cmdk);
    const list = $('.cmdk-list', cmdk);

    const render = () => {
      const q = box.value.trim().toLowerCase();
      shown = CMDS.filter(c => !q || c.l.toLowerCase().includes(q));
      cursor = Math.min(cursor, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length
        ? shown.map((c, i) =>
            `<button class="opt" data-i="${i}" data-cursor="${i === cursor}">` +
            `<span class="lbl trunc">${c.l}</span><span class="hint">${c.h}</span></button>`).join('')
        : '<div class="cmdk-empty">没有匹配项</div>';
    };

    const pick = i => {
      const c = shown[i];
      closeCmdk();
      if (c && c.run) c.run();
    };

    box.addEventListener('input', () => { cursor = 0; render(); });
    box.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        cursor = (cursor + (ev.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(1, shown.length);
        render();
        const cur = $('[data-cursor="true"]', list);
        if (cur) cur.scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter') { ev.preventDefault(); pick(cursor); }
    });
    list.addEventListener('click', ev => {
      const opt = ev.target.closest('.opt');
      if (opt) pick(+opt.dataset.i);
    });
    cmdk.addEventListener('mousedown', ev => { if (ev.target === cmdk) closeCmdk(); });

    render();
    box.focus();
  }

  function closeCmdk() { if (cmdk) { cmdk.remove(); cmdk = null; cursor = 0; } }

  /* ── @ 文件补全 ───────────────────────────────────────────────────── */

  const FILES = [
    'packages/engine/src/index.ts',
    'packages/engine/src/tools.ts',
    'packages/server/src/chat.ts',
    'packages/server/src/chat-stream.ts',
    'packages/sandbox-local/src/index.ts',
    'apps/web/src/App.tsx',
    'apps/web/src/tokens.css',
    'docs/architecture.md',
    'docs/prototype/tokens.css',
  ];

  const atMenu = $('#at-menu');

  function openAt(all) {
    const q = all ? '' : (input.value.slice(0, input.selectionStart).match(/@([\w./-]*)$/) || [, ''])[1];
    const hits = FILES.filter(f => f.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
    if (!hits.length) return closeAt();
    atMenu.innerHTML = hits.map(f =>
      `<button class="opt" data-f="${f}"><span class="lbl mono trunc">${f}</span></button>`).join('');
    atMenu.hidden = false;
  }
  function closeAt() { atMenu.hidden = true; }

  // 选中后往 textarea 里插纯文本 @path。产品最终形态应该是 contenteditable
  // 里的内联 pill，原型简化成纯文本（见 README）。
  atMenu.addEventListener('click', ev => {
    const opt = ev.target.closest('.opt');
    if (!opt) return;
    const at = input.value.slice(0, input.selectionStart).match(/@([\w./-]*)$/);
    const start = at ? input.selectionStart - at[0].length : input.selectionStart;
    input.setRangeText('@' + opt.dataset.f + ' ', start, input.selectionStart, 'end');
    closeAt();
    input.focus();
  });

  input.addEventListener('input', () => {
    if (/@[\w./-]*$/.test(input.value.slice(0, input.selectionStart))) openAt(false); else closeAt();
  });

  input.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') return closeAt();
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
  });

  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    setView('task');
    logInner.insertAdjacentHTML('beforeend',
      '<section class="turn"><div class="usermsg" data-role="usermsg"><p></p>' +
      '<button class="ckpt" data-act="checkpoint">回退到此处</button></div></section>');
    // 用 textContent 落文本，再把 @引用 换成内联 pill（不走 innerHTML，避免注入）
    const p = logInner.lastElementChild.querySelector('p');
    p.textContent = text;
    p.innerHTML = p.innerHTML.replace(/@[\w./-]+/g, m => `<span class="ref-chip">${m}</span>`);
    input.value = '';
    closeAt();
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }

  /* ── 全局委托 + 快捷键 ───────────────────────────────────────────── */

  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) { closePop(); return; }
    if (el.dataset.act !== 'pop') closePop();
    const fn = acts[el.dataset.act];
    if (fn) { ev.preventDefault(); fn(ev, el); }
  });

  document.addEventListener('keydown', ev => {
    const meta = ev.metaKey || ev.ctrlKey;
    if (ev.key === 'Escape') { closeCmdk(); closePop(); closeAt(); return; }
    if (!meta) return;
    const k = ev.key.toLowerCase();
    if (k === 'k') { ev.preventDefault(); cmdk ? closeCmdk() : openCmdk(); }
    else if (k === 'n') { ev.preventDefault(); acts['new-task'](); }
    else if (k === 'j') { ev.preventDefault(); acts['toggle-right'](); }
    else if (k === 'b') { ev.preventDefault(); acts['toggle-left'](); }
  });

  addEventListener('resize', closePop);

  /* ── 滚动跟随 + 新内容浮标 ───────────────────────────────────────── */

  const fab = $('#fab');
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

  // 最近一条用户消息 position:sticky 粘在滚动容器顶部；粘住时加 .is-pinned
  // （下边框 + 轻阴影），靠比较它和滚动口顶边的距离判断。
  function syncPinned() {
    const top = log.getBoundingClientRect().top;
    $$('.usermsg', logInner).forEach(el => {
      const r = el.getBoundingClientRect();
      // 顶边已经顶到滚动口上沿，且自己还没被本轮的末尾推出去
      el.classList.toggle('is-pinned', r.top - top < 1 && r.bottom - top > 1);
    });
  }

  log.addEventListener('scroll', () => {
    if (nearBottom()) fab.hidden = true;
    syncPinned();
  });

  // 假流：每 8 秒往运行中那一轮追加一条工具行（去卡片化的 .trow），
  // 演示"在底部就跟随，不在底部就出浮标"。
  const FAKE = [
    ['读取', 'packages/server/src/chat-stream.ts', '0.3s'],
    ['搜索', '"resumeStream"', '5 个结果 · 0.2s'],
    ['$', 'pnpm --filter @vgent/server test', 'exit 0 · 2.1s'],
    ['编辑', 'packages/server/src/chat-stream.ts', '0.7s'],
  ];
  let n = 0;
  setInterval(() => {
    const [verb, target, right] = FAKE[n++ % FAKE.length];
    const follow = nearBottom();
    const running = $('#trow-running');
    const html =
      '<div class="trow" data-open="false"><button class="trow-sum" data-act="trow">' +
      '<span class="tri">▸</span>' +
      `<span class="verb${verb === '$' ? ' mono' : ''}">${verb}</span>` +
      `<span class="target trunc">${target}</span>` +
      `<span class="right">${right}</span></button>` +
      '<div class="trow-body">原型里的假数据，用来演示流式追加。</div></div>';
    // 插在"运行中"那一行之前，spinner 行永远在最后
    if (running) running.insertAdjacentHTML('beforebegin', html);
    else logInner.lastElementChild.insertAdjacentHTML('beforeend', html);
    if (follow) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    else fab.hidden = false;
  }, 8000);

  /* ── 启动 ─────────────────────────────────────────────────────────── */

  // 图标条模式下只剩状态点，用原生 title 兜住完整标题
  $$('[data-title]').forEach(el => { el.title = el.dataset.title; });

  syncChrome();
  regroup('按项目');
  setView('task');
  // 进入任务直接定位末尾。等一帧，让字体和 grid 落定后 scrollHeight 才是最终值。
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; syncPinned(); });
})();
