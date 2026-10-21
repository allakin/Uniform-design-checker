// Контент-скрипт: подсветка и выбор элемента, скриншот, форма варианта блока (группа + заметка).
// Внедряется по запросу из background.js (chrome.scripting.executeScript).
(() => {
  // После перезагрузки расширения старый скрипт на странице «осиротевает»: убираем его и ставим новый.
  const prev = globalThis.__udcInstance;
  if (prev?.alive()) return;
  prev?.destroy();
  // Интерфейс старых версий, которые не умеют убирать за собой (нет __udcInstance.destroy), тоже убираем.
  document.querySelectorAll('udc-review-root').forEach((n) => n.remove());
  const cleanups = [];
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  // Иконки Gravity UI из content/icons.js (внедряется перед этим файлом).
  const I = (name, size = 14) =>
    `<svg class="gi" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">${globalThis.__udcIcons?.[name] || ''}</svg>`;
  const MAX_SHOT_PX = 30000; // предел высоты canvas
  const MAX_SEGMENTS = 25;

  const STYLES = `
    :host { all: initial; }
    /* Тёмная тема — та же палитра, что в popup.css и pages/review.css */
    * { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "YS Text", Roboto, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
    .bar, .panel, .toast, .countdown, .busy {
      color-scheme: dark;
      --surface: rgba(255, 255, 255, .035); --surface-2: rgba(255, 255, 255, .06); --surface-hover: rgba(255, 255, 255, .09);
      --line: rgba(255, 255, 255, .08); --line-strong: rgba(255, 255, 255, .14);
      --text: #ededed; --text-2: #a3a3a3; --text-3: #737373;
      --accent: #8f7fd1; --accent-soft: #b9aee6; --ring: 0 0 0 3px rgba(143, 127, 209, .22);
      --danger: #fb8f84; --ok: #6ee7a6;
      --glass: radial-gradient(120% 80% at 50% -20%, rgba(143, 127, 209, .10), transparent 60%), rgba(28, 28, 28, .92);
      --glass-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(255, 255, 255, .09), 0 24px 60px rgba(0, 0, 0, .55);
    }
    [hidden] { display: none !important; }
    .gi { display: inline-block; flex: none; vertical-align: -2px; }
    .bar > span:first-child, .busy span, .countdown span, button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    ::placeholder { color: #737373; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .12); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }

    .hl { position: fixed; pointer-events: none; border: 2px solid #8f7fd1; background: rgba(143, 127, 209, .12);
          border-radius: 3px; transition: top .06s, left .06s, width .06s, height .06s; box-shadow: 0 0 0 1px rgba(255, 255, 255, .35), 0 0 24px rgba(143, 127, 209, .35); }
    .hl.selected { border: 1.5px solid #b9aee6; background: transparent; transition: none;
                   box-shadow: 0 0 0 100vmax rgba(0, 0, 0, .55), 0 0 0 4px rgba(143, 127, 209, .15), 0 0 30px rgba(143, 127, 209, .22); }
    /* Маркеры по углам выделения */
    .hl.selected::after { content: ''; position: absolute; inset: -5px; pointer-events: none;
      background: linear-gradient(#ededed, #ededed) left top / 6px 6px no-repeat, linear-gradient(#ededed, #ededed) right top / 6px 6px no-repeat,
                  linear-gradient(#ededed, #ededed) left bottom / 6px 6px no-repeat, linear-gradient(#ededed, #ededed) right bottom / 6px 6px no-repeat; }
    .hl-label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 6px; white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis;
                background: linear-gradient(180deg, #6a5aa8, #4e4185); color: #fff; font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 5px 8px; border-radius: 6px;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 6px 16px rgba(0, 0, 0, .4); }
    .hl-label.below { bottom: auto; top: 100%; margin: 6px 0 0; }
    .hl-label b { font-weight: 400; opacity: .8; margin-left: 6px; }

    .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 14px; align-items: center;
           background: var(--glass); backdrop-filter: blur(18px); color: var(--text); padding: 8px 8px 8px 16px; border-radius: 14px; font-size: 13px; line-height: 1.3;
           box-shadow: var(--glass-shadow); width: max-content; max-width: calc(100vw - 24px); }
    .bar > span:first-child { white-space: nowrap; font-weight: 500; }
    .bar > span:first-child .gi { color: var(--accent-soft); }
    .bar.bottom { top: auto; bottom: 12px; }
    .bar kbd { font: 11px ui-monospace, Menlo, monospace; color: var(--text); background: rgba(255, 255, 255, .08); box-shadow: inset 0 0 0 1px var(--line); border-radius: 5px; padding: 2px 6px; }
    .bar .muted { color: var(--text-3); }

    button { cursor: pointer; border: 0; border-radius: 10px; font-size: 13px; font-weight: 600; padding: 8px 12px; color: inherit; transition: background .15s, box-shadow .15s, color .15s; }
    .btn-primary { background: linear-gradient(180deg, #6a5aa8, #4e4185); color: #fff;
                   box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 0 0 1px rgba(143, 127, 209, .55), 0 8px 22px rgba(143, 127, 209, .19); }
    .btn-primary:hover { background: linear-gradient(180deg, #7666b6, #58498f); }
    .btn-primary:disabled { background: rgba(143, 127, 209, .18); box-shadow: none; cursor: progress; }
    .btn-ghost { background: transparent; color: var(--text-2); }
    .btn-ghost:hover { background: var(--surface-2); color: var(--text); }
    .btn-light { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }
    .btn-light:hover { background: var(--surface-hover); box-shadow: inset 0 0 0 1px var(--line-strong); }

    .panel { position: fixed; top: 16px; right: 16px; width: 400px; max-height: calc(100vh - 32px); pointer-events: auto;
             display: flex; flex-direction: column; background: var(--glass); backdrop-filter: blur(24px); color: var(--text); border-radius: 18px;
             box-shadow: var(--glass-shadow); font-size: 13px; }
    .panel.left { right: auto; left: 16px; }
    .panel-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .panel-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; flex: 1; }
    .panel-head .sub { font-size: 12px; color: var(--text-3); font-weight: 400; display: block; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .icon-btn { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; font-size: 15px; color: var(--text-3); background: transparent; }
    .icon-btn:hover { background: var(--surface-2); color: var(--text); }
    .panel-body { padding: 14px 18px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
    .panel-body > * { flex-shrink: 0; }
    .shot { border: 1px solid var(--line); border-radius: 12px; background: repeating-conic-gradient(rgba(255, 255, 255, .045) 0 25%, transparent 0 50%) 0 0 / 16px 16px, rgba(0, 0, 0, .25);
            display: grid; place-items: center; max-height: 220px; overflow: hidden; padding: 6px; }
    .shot canvas { max-width: 100%; max-height: 206px; display: block; object-fit: contain; border-radius: 3px; }
    .shot { position: relative; }
    .shot-retake { position: absolute; top: 8px; right: 8px; padding: 5px 9px; font-size: 12px; border-radius: 8px; color: var(--text);
                   background: rgba(20, 20, 20, .82); backdrop-filter: blur(8px); box-shadow: 0 0 0 1px var(--line-strong), 0 4px 12px rgba(0, 0, 0, .35); }
    .shot-retake:hover { background: rgba(40, 40, 40, .92); color: #fff; }
    .shot-retake:disabled { cursor: progress; color: var(--text-2); }
    .shot-meta { font: 11px ui-monospace, Menlo, monospace; color: var(--text-3); margin-top: -6px; word-break: break-all; }
    label { display: flex; flex-direction: column; gap: 6px; font-weight: 500; font-size: 12px; color: var(--text-2); }
    .req { color: var(--danger); }
    input[type=text], input[type=url], textarea { font: 400 13px/1.4 sans-serif; font-family: inherit; color: var(--text); background: rgba(255, 255, 255, .04); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; outline: none; width: 100%; transition: border-color .15s, box-shadow .15s; }
    input:hover, textarea:hover { border-color: var(--line-strong); }
    input:focus, textarea:focus { border-color: var(--accent); box-shadow: var(--ring); background: rgba(255, 255, 255, .06); }
    textarea { resize: vertical; min-height: 84px; }
    .invalid { border-color: #f04438 !important; box-shadow: 0 0 0 3px rgba(240, 68, 56, .18) !important; }
    .err { color: var(--danger); font-weight: 400; font-size: 11px; }
    /* Выбор группы: существующие группы ревью и «Новая группа» */
    .groups { display: flex; flex-wrap: wrap; gap: 6px; max-height: 148px; overflow-y: auto; overscroll-behavior: contain; padding: 1px; }
    .groups button { max-width: 100%; padding: 6px 10px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--text-2); border: 1px solid var(--line); }
    .groups button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .groups button:hover { background: var(--surface-hover); color: var(--text); }
    .groups button[aria-pressed=true] { background: rgba(143, 127, 209, .14); color: var(--accent-soft); border-color: rgba(143, 127, 209, .55); }
    .groups .cnt { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-3); }
    .groups button[aria-pressed=true] .cnt { color: inherit; opacity: .75; }
    .groups .new { border-style: dashed; }
    .panel-foot { display: flex; gap: 8px; padding: 12px 18px 16px; border-top: 1px solid var(--line); align-items: center; }
    .panel-foot .spacer { flex: 1; }
    .hint { font-size: 11px; color: var(--text-3); }

    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 10px; align-items: center;
             background: var(--glass); backdrop-filter: blur(18px); color: var(--text); padding: 8px 8px 8px 16px; border-radius: 14px; font-size: 13px; box-shadow: var(--glass-shadow); max-width: calc(100vw - 24px); }
    .toast.error { background: radial-gradient(120% 80% at 50% -20%, rgba(240, 68, 56, .25), transparent 60%), rgba(42, 18, 18, .92); color: #fecdca; }
    .hl.region { border-style: dashed; border-color: #8f7fd1; background: rgba(143, 127, 209, .1); transition: none; }
    .countdown { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: none; background: var(--glass); backdrop-filter: blur(18px); color: var(--text);
                 padding: 10px 16px; border-radius: 14px; font-size: 13px; box-shadow: var(--glass-shadow); display: flex; gap: 12px; align-items: center; }
    .countdown span .gi { color: var(--accent-soft); }
    .countdown b { font-size: 18px; min-width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; color: #fff;
                   background: linear-gradient(180deg, #6a5aa8, #4e4185); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 6px 16px rgba(143, 127, 209, .20); }
    .discard { position: absolute; left: 12px; right: 12px; bottom: 12px; border-radius: 14px;
               background: radial-gradient(120% 80% at 50% -20%, rgba(240, 68, 56, .16), transparent 60%), #241b1b; border: 1px solid rgba(240, 68, 56, .3);
               box-shadow: 0 16px 40px rgba(0, 0, 0, .6); padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 6px; }
    .discard-head { display: flex; align-items: center; gap: 6px; color: var(--danger); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .discard-q { font-size: 14px; font-weight: 600; }
    .discard-note { font-size: 12px; color: var(--text-2); }
    .discard-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
    .btn-danger { background: linear-gradient(180deg, #f04438, #d92d20); color: #fff; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .2), 0 6px 18px rgba(217, 45, 32, .35); }
    .btn-danger:hover { background: linear-gradient(180deg, #f6604f, #e0392b); }
    .busy { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: auto; cursor: progress; }
    .busy span { background: var(--glass); backdrop-filter: blur(18px); color: var(--text); padding: 11px 18px; border-radius: 12px; font-size: 13px; box-shadow: var(--glass-shadow); }

    /* Поле без <label>: клик по пустому месту иначе «нажимал» бы первую кнопку группы */
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field-label { font-weight: 500; font-size: 12px; color: var(--text-2); }
  `;

  const state = {
    mode: 'idle', // idle | picking | capturing | form
    review: null,
    hovered: null,
    selected: null,
    elementInfo: null,
    styles: null,
    region: null, // выделенная область в координатах документа
    drag: null,
    countdownTimer: 0,
    childStack: [],
    shot: null,
    groupId: '', // выбранная в форме группа; '' — новая группа
    formSeq: 0, // номер открытой формы: асинхронная работа от прошлой формы не трогает новую
    retaking: false, // идёт «Переснять»
    panelLeft: false,
    toastTimer: 0,
    rafId: 0,
  };

  let host = null;
  let ui = null;

  // ---------- UI root (Shadow DOM, чтобы стили страницы и наши не пересекались) ----------

  function ensureUi() {
    if (host && host.isConnected) return;
    host = document.createElement('udc-review-root');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="hl" hidden><div class="hl-label"></div></div>
      <div class="bar" hidden>
        <span>${I('target', 16)} Наведите на блок и кликните</span>
        <span class="muted">протяните мышью — область · <kbd>↑</kbd> родитель <kbd>↓</kbd> дочерний <kbd>Esc</kbd> отмена</span>
        <button class="btn-ghost" data-act="cancel-pick">Отмена</button>
      </div>
      <div class="busy" hidden><span>${I('camera', 16)} Делаю скриншот…</span></div>
      <div class="countdown" hidden><span>${I('stopwatch', 16)} Откройте нужное меню или состояние — выбор начнётся через</span><b></b></div>
      <div class="panel" hidden></div>
      <div class="toast" hidden></div>
    `;
    ui = {
      root,
      hl: root.querySelector('.hl'),
      label: root.querySelector('.hl-label'),
      bar: root.querySelector('.bar'),
      busy: root.querySelector('.busy'),
      panel: root.querySelector('.panel'),
      toast: root.querySelector('.toast'),
      countdown: root.querySelector('.countdown'),
    };
    ui.bar.querySelector('[data-act=cancel-pick]').addEventListener('click', () => cancel());

    // Клики и прочие события внутри нашего UI не должны доходить до обработчиков страницы.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'wheel', 'paste']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(host);
  }

  const isOurs = (e) => !!host && e.composedPath().includes(host);

  // ---------- Подсветка ----------

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += '.' + cls.slice(0, 2).join('.');
    return s;
  }

  function drawHighlight(el, selected = false) {
    if (!el || !el.isConnected) {
      ui.hl.hidden = true;
      return;
    }
    drawRect(el.getBoundingClientRect(), describe(el), { selected });
  }

  function drawRect(r, name, { selected = false, region = false } = {}) {
    ui.hl.hidden = false;
    ui.hl.classList.toggle('selected', selected);
    ui.hl.classList.toggle('region', region);
    Object.assign(ui.hl.style, {
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`,
    });
    ui.label.innerHTML = '';
    ui.label.append(name);
    const size = document.createElement('b');
    size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    ui.label.append(size);
    ui.label.classList.toggle('below', r.top < 30);
    // Плашку с подсказкой уводим вниз, если она закрывает подсвеченный блок.
    if (state.mode === 'picking') ui.bar.classList.toggle('bottom', r.top < 70 && r.bottom > 0);
  }

  function trackSelected() {
    cancelAnimationFrame(state.rafId);
    const loop = () => {
      if (state.mode !== 'form') return;
      if (state.region) {
        const g = state.region;
        drawRect({ left: g.left - window.scrollX, top: g.top - window.scrollY, width: g.width, height: g.height, bottom: g.top - window.scrollY + g.height },
          'Область', { selected: true, region: true });
      } else if (state.selected) drawHighlight(state.selected, true);
      else return;
      state.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- Режим выбора ----------

  function startPicking(review) {
    if (review) state.review = review;
    ensureUi();
    closePanel();
    hideToast();
    state.mode = 'picking';
    state.hovered = null;
    state.childStack = [];
    ui.bar.hidden = false;
    ui.hl.hidden = true;
    state.drag = null;
    state.region = null;
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClick, true);
    for (const t of BLOCKED) window.addEventListener(t, block, true);
  }

  // Нажатия не пропускаем к странице — иначе открытые меню и попапы закроются. Рамку области ведём
  // на pointer-событиях: после отменённого pointerdown браузер не присылает mousedown/mousemove/mouseup.
  const BLOCKED = ['mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend', 'submit'];

  function stopPicking() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('click', onClick, true);
    for (const t of BLOCKED) window.removeEventListener(t, block, true);
    if (ui) ui.bar.hidden = true;
  }

  // Клик, который браузер сгенерирует после mouseup, тоже не должен дойти до страницы.
  function swallowNextClick() {
    const fn = (e) => block(e);
    window.addEventListener('click', fn, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', fn, { capture: true }), 400);
  }

  function onDown(e) {
    if (isOurs(e)) return;
    block(e);
    if (e.button === 0) state.drag = { x: e.clientX, y: e.clientY, active: false };
  }

  function dragRect(e, d = state.drag) {
    const left = Math.min(d.x, e.clientX), top = Math.min(d.y, e.clientY);
    const width = Math.abs(e.clientX - d.x), height = Math.abs(e.clientY - d.y);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function onUp(e) {
    if (isOurs(e)) return;
    block(e);
    const d = state.drag;
    state.drag = null;
    if (!d?.active) return; // обычный клик — обработает onClick
    swallowNextClick();
    selectRegion(dragRect(e, d));
  }

  function block(e) {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onDragMove(e) {
    if (!state.drag || isOurs(e)) return;
    block(e);
    if (!state.drag.active && Math.hypot(e.clientX - state.drag.x, e.clientY - state.drag.y) > 6) state.drag.active = true;
    if (state.drag.active) drawRect(dragRect(e), 'Область', { region: true });
  }

  function onMove(e) {
    if (isOurs(e) || state.drag?.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el === state.hovered) return;
    if (state.childStack.length && state.hovered?.contains(el)) return; // пользователь поднялся к родителю — не сбрасываем
    state.hovered = el;
    state.childStack = [];
    drawHighlight(el);
  }

  function onClick(e) {
    if (isOurs(e)) return;
    block(e);
    const el = state.hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== host) select(el);
  }

  // Клавиатура: перехватываем на window в фазе захвата, раньше обработчиков страницы.
  listen(
    window,
    'keydown',
    (e) => {
      if (state.mode === 'picking') {
        if (e.key === 'Escape') cancel();
        else if (e.key === 'ArrowUp' && state.hovered?.parentElement && state.hovered !== document.body) {
          state.childStack.push(state.hovered);
          state.hovered = state.hovered.parentElement;
          drawHighlight(state.hovered);
        } else if (e.key === 'ArrowDown' && state.childStack.length) {
          state.hovered = state.childStack.pop();
          drawHighlight(state.hovered);
        } else if (e.key === 'Enter' && state.hovered) select(state.hovered);
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (state.mode === 'form' && isOurs(e)) {
        const inField = e.composedPath()[0]?.matches?.('input[type=text]');
        if (e.key === 'Escape') {
          e.preventDefault();
          if (ui.panel.querySelector('.discard')) hideDiscard();
          else requestClose();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || inField) && !ui.panel.querySelector('.discard')) {
          e.preventDefault();
          save();
        }
        // Горячие клавиши сайта не должны срабатывать, пока пользователь печатает в форме.
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  for (const type of ['keyup', 'keypress', 'focusin', 'focusout']) {
    listen(window, type, (e) => state.mode === 'form' && isOurs(e) && e.stopImmediatePropagation(), true);
  }

  async function select(el) {
    stopPicking();
    state.mode = 'capturing';
    state.selected = el;
    state.region = null;
    state.elementInfo = elementInfo(el);
    state.styles = collectStyles(el);
    ui.hl.hidden = true;
    ui.busy.hidden = false;
    try {
      state.shot = await shootElement(el);
      openForm(el);
    } catch (err) {
      reset();
      showToast(`Не удалось сделать скриншот: ${err.message}`, { error: true });
    } finally {
      ui.busy.hidden = true;
    }
  }

  async function shootElement(el) {
    if (!isDropdownSelect(el)) return captureElement(el);
    // Список нативного select рисует ОС — его нельзя снять. Показываем такой же список прямо на странице.
    const list = openSelectList(el);
    try {
      const union = () => unionRect(el.getBoundingClientRect(), list.getBoundingClientRect());
      const shot = await captureElement(el, { rectOf: union });
      shot.note = 'Список select раскрыт расширением: нативный выпадающий список рисует система, поэтому показана его копия';
      return shot;
    } finally {
      list.remove();
    }
  }

  async function selectRegion(r) {
    stopPicking();
    state.mode = 'capturing';
    const anchor = commonAncestor(r);
    state.selected = null;
    state.region = { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
    state.elementInfo = {
      ...(anchor ? elementInfo(anchor) : {}),
      name: `Область ${Math.round(r.width)}×${Math.round(r.height)}`,
      region: true,
      attributes: {}, // в области много элементов — атрибуты общего предка сбивали бы с толку
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    state.styles = null; // в области много элементов — стили одного были бы обманчивы
    ui.hl.hidden = true;
    ui.busy.hidden = false;
    try {
      state.shot = await captureRegion(r);
      state.shot.note = 'Снимок области экрана';
      openForm(null);
    } catch (err) {
      reset();
      showToast(`Не удалось сделать скриншот: ${err.message}`, { error: true });
    } finally {
      ui.busy.hidden = true;
    }
  }

  // Ближайший общий предок элементов по углам и центру области.
  function commonAncestor(r) {
    const pts = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]];
    const els = pts.map(([x, y]) => document.elementFromPoint(x, y)).filter((e) => e && e !== host);
    if (!els.length) return null;
    let anc = els[0];
    while (anc && !els.every((e) => anc.contains(e))) anc = anc.parentElement;
    return anc && anc !== document.documentElement ? anc : document.body;
  }

  function cancel() {
    reset();
  }

  function reset() {
    stopPicking();
    cancelAnimationFrame(state.rafId);
    state.mode = 'idle';
    state.hovered = null;
    state.selected = null;
    state.region = null;
    state.drag = null;
    state.shot = null;
    clearInterval(state.countdownTimer);
    if (ui) {
      ui.hl.hidden = true;
      ui.busy.hidden = true;
      ui.countdown.hidden = true;
      closePanel();
    }
  }

  // ---------- Скриншот элемента ----------

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function settle() {
    await nextFrame();
    await nextFrame();
    await sleep(120);
  }

  async function grab() {
    const res = await chrome.runtime.sendMessage({ type: 'udc:capture' });
    if (!res?.ok) throw new Error(res?.error || 'нет ответа от расширения');
    // createImageBitmap из Blob не зависит от CSP страницы (в отличие от <img src="data:...">).
    return createImageBitmap(dataUrlToBlob(res.dataUrl));
  }

  function dataUrlToBlob(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png' });
  }

  // Фиксированные/липкие элементы (шапки, чаты, баннеры) перекрывают блок при прокрутке — прячем на время съёмки.
  function hideOverlays(target) {
    const hidden = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node === host || node.contains(target) || target.contains(node)) continue;
      const pos = getComputedStyle(node).position;
      if (pos === 'fixed' || pos === 'sticky') {
        hidden.push([node, node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
        node.style.setProperty('visibility', 'hidden', 'important');
      }
    }
    return () => {
      for (const [node, value, prio] of hidden) {
        if (value) node.style.setProperty('visibility', value, prio);
        else node.style.removeProperty('visibility');
      }
    };
  }

  function unionRect(a, b) {
    const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right), bottom = Math.max(a.bottom, b.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // Снимок прямоугольника экрана как есть: без прокрутки и без скрытия оверлеев (меню, попапы остаются).
  async function captureRegion(r) {
    host.style.display = 'none';
    try {
      await settle();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const bmp = await grab();
      const scale = bmp.width / window.innerWidth;
      const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
      const y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
      if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('слишком маленькая область');
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((x1 - x0) * scale);
      canvas.height = Math.round((y1 - y0) * scale);
      canvas.getContext('2d').drawImage(bmp, x0 * scale, y0 * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      bmp.close();
      return finish(canvas, false);
    } finally {
      host.style.display = 'block';
    }
  }

  async function captureElement(el, { rectOf = () => el.getBoundingClientRect() } = {}) {
    const startX = window.scrollX;
    const startY = window.scrollY;
    const html = document.documentElement;
    const prevScrollBehavior = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    host.style.display = 'none';
    let restoreOverlays = () => {};

    try {
      const vw = html.clientWidth || window.innerWidth;
      const vh = html.clientHeight || window.innerHeight;
      let r = rectOf();
      if (r.width < 1 || r.height < 1) throw new Error('у элемента нулевой размер');

      restoreOverlays = hideOverlays(el);

      // Блок помещается в экран — один снимок.
      if (r.height <= vh) {
        if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          // Снимаемая область может быть больше самого элемента (раскрытый список) — докручиваем.
          const u = rectOf();
          if (u.bottom > vh) window.scrollBy({ top: u.bottom - vh + 4, behavior: 'instant' });
          else if (u.top < 0) window.scrollBy({ top: u.top - 4, behavior: 'instant' });
        }
        await settle();
        r = rectOf();
        const bmp = await grab();
        const scale = bmp.width / window.innerWidth;
        const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right);
        const y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
        if (x1 <= x0 || y1 <= y0) throw new Error('элемент вне видимой области');
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((x1 - x0) * scale);
        canvas.height = Math.round((y1 - y0) * scale);
        canvas.getContext('2d').drawImage(bmp, x0 * scale, y0 * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        bmp.close();
        return finish(canvas, false);
      }

      // Блок выше экрана — прокручиваем и склеиваем несколько снимков.
      const docTop = r.top + window.scrollY;
      let canvas = null;
      let ctx = null;
      let scale = 1;
      let x0 = 0, x1 = 0;
      let captured = 0; // сколько CSS-пикселей блока уже снято
      let truncated = false;
      let totalHeight = r.height;

      for (let i = 0; captured < totalHeight - 0.5; i++) {
        if (i >= MAX_SEGMENTS) {
          truncated = true;
          break;
        }
        if (i === 0) el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
        else window.scrollTo({ left: window.scrollX, top: docTop + captured, behavior: 'instant' });
        await settle();
        const cr = rectOf();
        const visBottomLocal = Math.min(cr.bottom, vh) - cr.top; // нижняя видимая граница в координатах блока
        if (visBottomLocal <= captured + 0.5) {
          truncated = true; // страница не прокручивается дальше (блок во внутреннем скролл-контейнере)
          break;
        }
        const bmp = await grab();
        if (!canvas) {
          scale = bmp.width / window.innerWidth;
          x0 = Math.max(0, cr.left);
          x1 = Math.min(vw, cr.right);
          totalHeight = Math.min(cr.height, MAX_SHOT_PX / scale);
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((x1 - x0) * scale));
          canvas.height = Math.max(1, Math.round(totalHeight * scale));
          ctx = canvas.getContext('2d');
        }
        const fromLocal = Math.max(captured, -cr.top); // верхняя видимая граница
        const toLocal = Math.min(visBottomLocal, totalHeight);
        const sy = (cr.top + fromLocal) * scale;
        const h = (toLocal - fromLocal) * scale;
        ctx.drawImage(bmp, x0 * scale, sy, canvas.width, h, 0, fromLocal * scale, canvas.width, h);
        bmp.close();
        captured = toLocal;
      }
      if (!canvas) throw new Error('не удалось снять элемент');
      if (captured < totalHeight - 0.5) {
        // обрезаем пустой хвост
        const cut = document.createElement('canvas');
        cut.width = canvas.width;
        cut.height = Math.max(1, Math.round(captured * scale));
        cut.getContext('2d').drawImage(canvas, 0, 0);
        canvas = cut;
      }
      return finish(canvas, truncated || totalHeight < r.height);
    } finally {
      restoreOverlays();
      window.scrollTo({ left: startX, top: startY, behavior: 'instant' });
      html.style.scrollBehavior = prevScrollBehavior;
      host.style.display = 'block';
    }
  }

  function finish(canvas, truncated) {
    let dataUrl = canvas.toDataURL('image/png');
    // Большие PNG раздувают хранилище и отчёт — для них используем JPEG.
    if (dataUrl.length > 2.5 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return { dataUrl, width: canvas.width, height: canvas.height, canvas, truncated };
  }

  // ---------- Форма варианта ----------

  // ---------- Стили и данные элемента ----------

  function parseColor(str) {
    const m = String(str).match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function hex({ r, g, b, a = 1 }) {
    const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ''}`.toUpperCase();
  }

  // rgb()/rgba() внутри любых значений (тени, градиенты, рамки) → HEX.
  const hexify = (v) =>
    String(v)
      .replace(/rgba?\([^)]+\)/g, (m) => (parseColor(m) ? hex(parseColor(m)) : m))
      // #abc → #AABBCC, регистр единый — чтобы у всех цветов был образец
      .replace(/#([0-9a-f]{3,8})\b/gi, (m, h) => (h.length === 3 || h.length === 4 ? `#${[...h].map((c) => c + c).join('')}` : m).toUpperCase());
  const clip = (v, n = 160) => (v.length > n ? v.slice(0, n) + '…' : v);

  function shorthand(values) {
    const [t, r, b, l] = values;
    if (r === l) return t === b ? (t === r ? t : `${t} ${r}`) : `${t} ${r} ${b}`;
    return values.join(' ');
  }

  const sides = (cs, fmt) => ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue(fmt(s)));

  function blend(top, bottom) {
    const a = top.a + bottom.a * (1 - top.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  }

  function luminance({ r, g, b }) {
    const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  // Фон, который реально виден под элементом: смешиваем полупрозрачные фоны предков до первого непрозрачного.
  function effectiveBackground(el) {
    const layers = [];
    let approx = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') approx = true;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let color = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) color = blend(layers[i], color);
    return { color, approx };
  }

  // Первый видимый текст внутри элемента — для него считаем контраст.
  function textHost(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent.trim() && n.parentElement?.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const t = walker.nextNode();
    return t ? { node: t.parentElement, sample: t.textContent.trim().replace(/\s+/g, ' ').slice(0, 40) } : null;
  }

  function contrastInfo(el) {
    const t = textHost(el);
    if (!t) return null;
    const cs = getComputedStyle(t.node);
    const fg0 = parseColor(cs.color);
    if (!fg0) return null;
    const { color: bg, approx } = effectiveBackground(t.node);
    const fg = blend(fg0, bg);
    const l1 = luminance(fg), l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return {
      ratio: Math.round(ratio * 100) / 100,
      aa: ratio >= (large ? 3 : 4.5),
      aaa: ratio >= (large ? 4.5 : 7),
      large,
      text: hex(fg),
      background: hex(bg),
      approx,
      sample: t.sample,
    };
  }

  function collectStyles(el) {
    const cs = getComputedStyle(el);
    const v = (p) => cs.getPropertyValue(p).trim();
    const groups = [];
    const add = (title, rows) => {
      rows = rows.filter(([, value]) => value);
      if (rows.length) groups.push({ title, rows: rows.map(([k, value]) => [k, clip(hexify(value))]) });
    };
    const rect = el.getBoundingClientRect();
    const not = (value, ...skip) => (skip.includes(value) ? '' : value);
    const hasText = !!textHost(el);
    const flex = /flex/.test(v('display'));
    const grid = /grid/.test(v('display'));

    add('Размер', [
      ['width', `${Math.round(rect.width * 100) / 100}px`],
      ['height', `${Math.round(rect.height * 100) / 100}px`],
      ['min-width', not(v('min-width'), 'auto', '0px')],
      ['max-width', not(v('max-width'), 'none')],
      ['min-height', not(v('min-height'), 'auto', '0px')],
      ['max-height', not(v('max-height'), 'none')],
    ]);
    add('Отступы', [
      ['padding', not(shorthand(sides(cs, (s) => `padding-${s}`)), '0px')],
      ['margin', not(shorthand(sides(cs, (s) => `margin-${s}`)), '0px')],
      ['gap', flex || grid ? not(v('gap'), 'normal', 'normal normal') : ''],
    ]);
    if (hasText) {
      add('Типографика', [
        ['font-family', v('font-family')],
        ['font-size', v('font-size')],
        ['font-weight', v('font-weight')],
        ['line-height', v('line-height')],
        ['letter-spacing', not(v('letter-spacing'), 'normal')],
        ['font-style', not(v('font-style'), 'normal')],
        ['text-align', not(v('text-align'), 'start')],
        ['text-transform', not(v('text-transform'), 'none')],
        ['text-decoration', not(v('text-decoration-line'), 'none')],
      ]);
    }
    const bgColor = parseColor(v('background-color'));
    add('Цвета', [
      ['color', hasText ? v('color') : ''],
      ['background-color', bgColor && bgColor.a > 0 ? v('background-color') : ''],
      ['background-image', not(v('background-image'), 'none').replace(/url\("?data:[^)]*\)/g, 'url(data:…)')],
      ['opacity', not(v('opacity'), '1')],
    ]);
    const widths = sides(cs, (s) => `border-${s}-width`);
    const styles = sides(cs, (s) => `border-${s}-style`);
    const colors = sides(cs, (s) => `border-${s}-color`);
    const hasBorder = widths.some((w, i) => parseFloat(w) > 0 && styles[i] !== 'none');
    const uniform = new Set(widths).size === 1 && new Set(styles).size === 1 && new Set(colors).size === 1;
    const radius = shorthand(['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => v(`border-${c}-radius`)));
    add('Рамка', [
      ['border', hasBorder && uniform ? `${widths[0]} ${styles[0]} ${colors[0]}` : ''],
      ['border-width', hasBorder && !uniform ? shorthand(widths) : ''],
      ['border-style', hasBorder && !uniform ? shorthand(styles) : ''],
      ['border-color', hasBorder && !uniform ? shorthand(colors) : ''],
      ['border-radius', not(radius, '0px')],
      ['outline', v('outline-style') !== 'none' && parseFloat(v('outline-width')) > 0 ? `${v('outline-width')} ${v('outline-style')} ${v('outline-color')}` : ''],
    ]);
    add('Эффекты', [
      ['box-shadow', not(v('box-shadow'), 'none')],
      ['filter', not(v('filter'), 'none')],
      ['backdrop-filter', not(v('backdrop-filter'), 'none')],
      ['transform', not(v('transform'), 'none')],
      ['cursor', not(v('cursor'), 'auto')],
    ]);
    add('Раскладка', [
      ['display', v('display')],
      ['position', not(v('position'), 'static')],
      ['flex-direction', flex ? v('flex-direction') : ''],
      ['flex-wrap', flex ? not(v('flex-wrap'), 'nowrap') : ''],
      ['justify-content', flex || grid ? not(v('justify-content'), 'normal') : ''],
      ['align-items', flex || grid ? not(v('align-items'), 'normal') : ''],
      ['grid-template-columns', grid ? not(v('grid-template-columns'), 'none') : ''],
      ['z-index', not(v('z-index'), 'auto')],
      ['overflow', not(v('overflow'), 'visible', 'visible visible')],
    ]);
    const variables = collectVariables(el);
    if (variables.used.length) groups.push({ title: 'Свойства через переменные', kind: 'vars', rows: variables.used.map(([k, a, r]) => [k, arrow(a, r)]) });
    if (variables.defined.length) groups.push({ title: 'Переменные элемента', kind: 'vars', rows: variables.defined.map(([k, a, r]) => [k, arrow(a, r)]) });
    if (variables.inherited.length) groups.push({ title: 'Переменные из родителей', kind: 'vars', rows: variables.inherited });
    const notes = [];
    if (variables.blocked) notes.push(`${variables.blocked} табл. стилей с другого домена недоступны браузеру — переменные из них не видны`);
    if (variables.truncated) notes.push('Показаны не все переменные — их слишком много');
    return { groups, contrast: contrastInfo(el), variables, notes };
  }

  const arrow = (authored, resolved) => (!resolved || authored === resolved ? authored : `${authored} → ${resolved}`);

  // ---------- CSS-переменные ----------
  // Значения var(...) видны только в исходных правилах — вычисленные стили их уже подставили.
  // Поэтому проходим по таблицам стилей, берём правила, подходящие элементу, и разворачиваем переменные через getComputedStyle.

  const VAR_RE = /var\(\s*(--[\w-]+)/g;
  const MAX_VARS = 60;

  // «a: b; c: var(--x, rgb(1, 2, 3))» → [{ prop, value, important }] с учётом скобок и кавычек.
  function parseDeclarations(cssText) {
    const out = [];
    let depth = 0, quote = '', start = 0;
    const push = (chunk) => {
      const i = chunk.indexOf(':');
      if (i < 1) return;
      let value = chunk.slice(i + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/!\s*important$/i, '').trim();
      out.push({ prop: chunk.slice(0, i).trim(), value, important });
    };
    for (let i = 0; i < cssText.length; i++) {
      const ch = cssText[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0) {
        push(cssText.slice(start, i));
        start = i + 1;
      }
    }
    push(cssText.slice(start));
    return out;
  }

  function matchedDeclarations(el) {
    const decls = [];
    let blocked = 0;
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          let ok = false;
          try {
            ok = el.matches(rule.selectorText);
          } catch {}
          if (ok) decls.push(...parseDeclarations(rule.style.cssText));
          if (rule.cssRules?.length) visit(rule.cssRules); // CSS nesting
        } else if (rule.cssRules) {
          if (rule instanceof CSSMediaRule && !matchMedia(rule.media.mediaText).matches) continue;
          if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
          visit(rule.cssRules); // @layer, @container, @scope и т.п.
        }
      }
    };
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) sheets.push(...root.styleSheets, ...(root.adoptedStyleSheets || []));
    for (const sheet of sheets) {
      if (sheet.disabled || (sheet.media?.mediaText && !matchMedia(sheet.media.mediaText).matches)) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        blocked++; // CSS с другого домена без CORS
        continue;
      }
      visit(rules);
    }
    decls.push(...parseDeclarations(el.getAttribute('style') || '')); // inline-стили — последними
    return { decls, blocked };
  }

  function collectVariables(el) {
    const { decls, blocked } = matchedDeclarations(el);
    const cs = getComputedStyle(el);
    // Каскад упрощённо: побеждает последнее объявление, !important — сильнее (специфичность не учитываем).
    const win = new Map();
    for (const d of decls) {
      const prev = win.get(d.prop);
      if (!prev || d.important || !prev.important) win.set(d.prop, d);
    }
    const used = [], defined = [], refs = new Set();
    for (const [prop, d] of win) {
      const resolved = hexify(cs.getPropertyValue(prop).trim());
      if (prop.startsWith('--')) defined.push([prop, clip(d.value), clip(resolved)]);
      else if (d.value.includes('var(')) used.push([prop, clip(d.value), clip(resolved)]);
      else continue;
      for (const m of d.value.matchAll(VAR_RE)) refs.add(m[1]);
    }
    const own = new Set(defined.map(([name]) => name));
    const inherited = [...refs].filter((name) => !own.has(name)).map((name) => [name, clip(hexify(cs.getPropertyValue(name).trim()) || '— не задана')]);
    const truncated = used.length > MAX_VARS || defined.length > MAX_VARS || inherited.length > MAX_VARS;
    return { used: used.slice(0, MAX_VARS), defined: defined.slice(0, MAX_VARS), inherited: inherited.slice(0, MAX_VARS), blocked, truncated };
  }

  const ATTR_KEEP = /^(id|class|role|title|alt|href|src|type|name|placeholder|for|target|disabled|tabindex|aria-.+|data-(testid|test-id|test|qa|cy|qa-id)[\w-]*)$/;
  function attributesOf(el) {
    const out = {};
    for (const a of el.attributes) if (ATTR_KEEP.test(a.name)) out[a.name] = clip(a.value, 200);
    return out;
  }

  // ---------- Нативный select: эмуляция раскрытого списка ----------

  const isDropdownSelect = (el) => el.tagName === 'SELECT' && !el.multiple && el.size <= 1 && el.options.length > 0;

  function openSelectList(sel) {
    const r = sel.getBoundingClientRect();
    const cs = getComputedStyle(sel);
    const list = document.createElement('div');
    list.setAttribute('data-udc-select-list', '');
    list.style.cssText = `position:absolute;z-index:2147483646;left:${r.left + window.scrollX}px;top:${r.bottom + window.scrollY + 2}px;
      min-width:${r.width}px;max-width:${Math.max(r.width, 480)}px;box-sizing:border-box;background:#fff;color:#111;
      border:1px solid rgba(0,0,0,.18);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px 0;
      font-family:${cs.fontFamily};font-size:${cs.fontSize};line-height:1.35;text-align:left;`;
    const MAX = 15;
    let shown = 0;
    for (const child of sel.children) {
      if (shown >= MAX) break;
      const items = child.tagName === 'OPTGROUP' ? [child, ...child.children] : [child];
      for (const item of items) {
        if (shown >= MAX) break;
        const row = document.createElement('div');
        row.textContent = item.tagName === 'OPTGROUP' ? item.label : item.text;
        let css = 'padding:4px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        if (item.tagName === 'OPTGROUP') css += 'font-weight:700;color:#555;';
        else {
          if (child.tagName === 'OPTGROUP') css += 'padding-left:24px;';
          if (item.selected) css += 'background:#0a64d8;color:#fff;';
          if (item.disabled) css += 'color:#999;';
          shown++;
        }
        row.style.cssText = css;
        list.append(row);
      }
    }
    if (sel.options.length > shown) {
      const more = document.createElement('div');
      more.textContent = `… ещё ${sel.options.length - shown}`;
      more.style.cssText = 'padding:4px 12px;color:#888;font-style:italic;';
      list.append(more);
    }
    document.body.append(list);
    return list;
  }

  function cssPath(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter((c) => c && !/\d{3,}|[:[\]]/.test(c)) : [];
      if (cls.length) part += '.' + cls.slice(0, 2).map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function elementInfo(el) {
    const rect = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      name: describe(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      attributes: attributesOf(el),
    };
  }

  function formHasInput() {
    return [...ui.panel.querySelectorAll('input')].some((f) => f.value.trim());
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function openForm(el) {
    state.mode = 'form';
    const formId = ++state.formSeq;
    const g = state.region;
    const r = el ? el.getBoundingClientRect() : { left: g.left - window.scrollX, width: g.width, height: g.height };
    state.panelLeft = r.left + r.width / 2 > window.innerWidth / 2 && r.left > 440;
    const groups = state.review?.groups || [];
    // По умолчанию — группа, в которую добавляли последний вариант: обычно снимают один блок на нескольких страницах подряд.
    state.groupId = groups.some((x) => x.id === state.groupId) ? state.groupId : groups.some((x) => x.id === state.review?.lastGroupId) ? state.review.lastGroupId : '';

    const p = ui.panel;
    p.classList.toggle('left', state.panelLeft);
    p.innerHTML = `
      <div class="panel-head">
        <h2>Новый вариант блока<span class="sub"></span></h2>
        <button class="icon-btn" data-act="side" title="Переместить панель">${I('swap', 16)}</button>
        <button class="icon-btn" data-act="cancel" title="Отмена (Esc)">${I('xmark', 16)}</button>
      </div>
      <div class="panel-body">
        <div class="shot">
          <button type="button" class="shot-retake" data-act="retake" title="Снять заново — если блок на странице изменился">${I('camera', 14)} Переснять</button>
        </div>
        <div class="shot-meta"></div>
        <div class="field"><span class="field-label">Группа <span class="req">*</span></span>
          ${groups.length ? `<div class="groups" data-groups>${groups.map((x) => `<button type="button" data-group="${esc(x.id)}"><span></span><b class="cnt">${x.count || 0}</b></button>`).join('')}<button type="button" class="new" data-group="">${I('plus', 12)} Новая группа</button></div>` : ''}
          <input type="text" name="newGroup" maxlength="200" placeholder="Например: Кнопка удаления, Модалка подтверждения">
          <span class="err" data-err="group" hidden>Назовите группу: какой это блок</span>
        </div>
        <label>Заметка
          <input type="text" name="note" maxlength="300" placeholder="Необязательно: чем отличается этот вариант">
        </label>
      </div>
      <div class="panel-foot">
        <button class="btn-light" data-act="repick">Другой элемент</button>
        <span class="spacer"></span>
        <span class="hint">Enter</span>
        <button class="btn-primary" data-act="save">Сохранить</button>
      </div>
    `;
    p.querySelector('.sub').textContent = `Ревью: ${state.review?.title || '—'}`;
    // Названия групп — пользовательский текст, только через textContent.
    p.querySelectorAll('[data-group]:not(.new) span').forEach((span, k) => {
      span.textContent = groups[k].title;
      span.parentElement.title = groups[k].title;
    });
    p.querySelectorAll('[data-group]').forEach((btn) => btn.addEventListener('click', () => pickGroup(btn.dataset.group, { focus: true })));
    pickGroup(state.groupId);
    renderShot();
    p.querySelector('[data-act=retake]').addEventListener('click', retake);

    p.querySelector('[data-act=cancel]').addEventListener('click', requestClose);
    p.querySelector('[data-act=side]').addEventListener('click', () => {
      state.panelLeft = !state.panelLeft;
      p.classList.toggle('left', state.panelLeft);
    });
    p.querySelector('[data-act=repick]').addEventListener('click', () => startPicking());
    p.querySelector('[data-act=save]').addEventListener('click', save);
    p.hidden = false;
    trackSelected();
    setTimeout(() => formIsOpen(formId) && focusFirst(), 0);
  }

  const formIsOpen = (formId) => state.mode === 'form' && state.formSeq === formId;

  // Группа выбрана — поле нового названия прячется; «Новая группа» — показывается.
  function pickGroup(id, { focus = false } = {}) {
    const p = ui.panel;
    state.groupId = id;
    p.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === id)));
    const input = p.querySelector('[name=newGroup]');
    input.hidden = !!id;
    input.classList.remove('invalid');
    p.querySelector('[data-err=group]').hidden = true;
    if (focus) (id ? p.querySelector('[name=note]') : input).focus();
  }

  function focusFirst() {
    const p = ui.panel;
    (state.groupId ? p.querySelector('[name=note]') : p.querySelector('[name=newGroup]'))?.focus();
  }

  // Превью и подпись — перерисовываются и после «Переснять».
  function renderShot() {
    const p = ui.panel;
    const el = state.selected;
    const shotBox = p.querySelector('.shot');
    shotBox.querySelector('canvas')?.remove();
    shotBox.prepend(state.shot.canvas);
    const info = state.elementInfo;
    p.querySelector('.shot-meta').textContent =
      (el ? `${describe(el)} · ${info.width}×${info.height}` : info.name) +
      (state.shot.truncated ? ' · снят не целиком' : '') +
      (state.shot.note && el ? ' · список раскрыт расширением' : '');
  }

  // «Переснять»: блок на странице изменился (раскрыли, дописали, поменялась высота) — снимаем тот же элемент
  // или ту же область заново. Выбранная группа и заметка остаются.
  async function retake() {
    if (state.mode !== 'form' || state.retaking) return;
    const el = state.selected;
    const g = state.region;
    if (el && !el.isConnected) {
      showToast('Элемента больше нет на странице — выберите его заново кнопкой «Другой элемент»', { error: true });
      return;
    }
    const formId = state.formSeq;
    const btn = ui.panel.querySelector('[data-act=retake]');
    state.retaking = true;
    btn.disabled = true;
    btn.innerHTML = `${I('camera', 14)} Снимаю…`;
    try {
      let shot;
      if (el) {
        shot = await shootElement(el);
      } else {
        // Область снимается как есть, без прокрутки: если её увели с экрана — возвращаем.
        const vh = document.documentElement.clientHeight || window.innerHeight;
        if (g.top < window.scrollY || g.top + g.height > window.scrollY + vh) window.scrollTo({ left: window.scrollX, top: Math.max(0, g.top - 20), behavior: 'instant' });
        const left = g.left - window.scrollX, top = g.top - window.scrollY;
        shot = await captureRegion({ left, top, width: g.width, height: g.height, right: left + g.width, bottom: top + g.height });
        shot.note = 'Снимок области экрана';
      }
      if (state.formSeq !== formId || state.mode !== 'form') return;
      state.shot = shot;
      if (el) {
        state.elementInfo = elementInfo(el);
        state.styles = collectStyles(el);
      }
      renderShot();
    } catch (err) {
      if (state.formSeq === formId) showToast(`Не удалось переснять: ${err.message}`, { error: true });
    } finally {
      state.retaking = false;
      if (btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = `${I('camera', 14)} Переснять`;
      }
    }
  }

  // Закрытие формы: если что-то введено — предупреждение прямо в панели (системный confirm показал бы «Confirm action on <id>»).
  function requestClose() {
    if (!formHasInput()) return cancel();
    if (ui.panel.querySelector('.discard')) return;
    const box = document.createElement('div');
    box.className = 'discard';
    box.innerHTML = `
      <div class="discard-head">${I('warning', 16)} Предупреждение</div>
      <div class="discard-q">Закрыть вариант без сохранения?</div>
      <div class="discard-note">Скриншот и введённые название группы и заметка не сохранятся.</div>
      <div class="discard-actions">
        <button type="button" class="btn-light" data-act="stay">Остаться</button>
        <button type="button" class="btn-danger" data-act="discard">Закрыть без сохранения</button>
      </div>`;
    box.querySelector('[data-act=stay]').addEventListener('click', hideDiscard);
    box.querySelector('[data-act=discard]').addEventListener('click', cancel);
    ui.panel.append(box);
    box.querySelector('[data-act=stay]').focus();
  }

  function hideDiscard() {
    ui.panel.querySelector('.discard')?.remove();
    focusFirst();
  }

  function closePanel() {
    if (!ui) return;
    ui.panel.hidden = true;
    ui.panel.innerHTML = '';
  }

  async function save() {
    if (state.mode !== 'form' || state.retaking) return;
    const p = ui.panel;
    const groupEl = p.querySelector('[name=newGroup]');
    const newGroupTitle = state.groupId ? '' : groupEl.value.trim();
    const ok = !!(state.groupId || newGroupTitle);
    groupEl.classList.toggle('invalid', !ok);
    p.querySelector('[data-err=group]').hidden = ok;
    if (!ok) return groupEl.focus();

    const issue = {
      ...(state.groupId ? { groupId: state.groupId } : { newGroupTitle }),
      note: p.querySelector('[name=note]').value.trim(),
      screenshot: state.shot.dataUrl,
      screenshotSize: { width: state.shot.width, height: state.shot.height },
      screenshotTruncated: state.shot.truncated,
      screenshotNote: state.shot.note || '',
      styles: state.styles,
      page: { url: location.href, title: document.title },
      element: state.elementInfo,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    };

    const btn = p.querySelector('[data-act=save]');
    btn.disabled = true;
    btn.textContent = 'Сохраняю…';
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'udc:saveIssue', reviewId: state.review.id, issue });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res?.ok) {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
      showToast(`Не сохранилось: ${res?.error || 'расширение недоступно — обновите страницу'}`, { error: true });
      return;
    }
    state.review = res.review;
    state.groupId = res.group.id; // следующий блок, скорее всего, — та же группа на другой странице
    reset();
    showToast(`Вариант ${res.number} добавлен в группу «${res.group.title}»`, {
      actions: [
        { label: 'Ещё блок', primary: true, run: () => startPicking() },
        { label: 'Открыть ревью', run: () => chrome.runtime.sendMessage({ type: 'udc:openReview', reviewId: state.review.id }) },
      ],
    });
  }

  // ---------- Уведомления ----------

  function showToast(text, { error = false, actions = [] } = {}) {
    ensureUi();
    clearTimeout(state.toastTimer);
    const t = ui.toast;
    t.className = `toast${error ? ' error' : ''}`;
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    t.append(span);
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = a.primary ? 'btn-primary' : 'btn-ghost';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        hideToast();
        a.run();
      });
      t.append(b);
    }
    const close = document.createElement('button');
    close.className = 'btn-ghost';
    close.innerHTML = I('xmark', 14);
    close.title = 'Закрыть';
    close.addEventListener('click', hideToast);
    t.append(close);
    t.hidden = false;
    state.toastTimer = setTimeout(hideToast, error ? 8000 : 7000);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    if (ui) ui.toast.hidden = true;
  }

  // ---------- Таймер перед выбором: успеть открыть меню, попап, hover-состояние ----------

  function startCountdown(seconds, review) {
    if (review) state.review = review;
    ensureUi();
    reset();
    hideToast();
    state.mode = 'countdown';
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(state.countdownTimer);
        ui.countdown.hidden = true;
        startPicking();
        return;
      }
      ui.countdown.querySelector('b').textContent = String(left);
      left--;
    };
    ui.countdown.hidden = false;
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  // ---------- Сообщения от расширения ----------

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === 'udc:ping') {
      sendResponse({ pong: true });
      return;
    }
    if (msg?.type === 'udc:start') {
      if (state.mode === 'form' || state.mode === 'capturing') {
        // Форма уже открыта — не теряем введённое.
        sendResponse({ ok: true, busy: true });
        return;
      }
      if (msg.delay > 0) startCountdown(msg.delay, msg.review);
      else startPicking(msg.review);
      sendResponse({ ok: true });
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  globalThis.__udcInstance = {
    alive() {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    destroy() {
      try {
        reset();
        hideToast();
      } catch {}
      cleanups.forEach((fn) => fn());
      host?.remove();
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {}
    },
  };
})();
