'use strict';
/* 任务进度面板：右下角一张卡片，告诉用户「还在动」还是「可能卡住了」。
 *
 *   jobStart(id, title, { en, total, expect, stallAfter, live, step })
 *     total       有总步数就显示真实进度（例如采集 12 步），没有就显示来回走的进度条
 *     expect      一般要多少秒；超过两倍就提示「比平时慢」
 *     live        任务会不断报告进展（采集日志、流式回答）；stallAfter 秒没新动静就提示「可能卡住了」
 *   jobBeat(id, stepText, done)   报一次进展；done 是已完成步数（可省）
 *   jobEnd(id, ok, message)       结束：成功的 2.5 秒后自己收起，出错的留着等用户关
 *   withJob(id, title, opts, fn)  包住一个 Promise 任务，开始、结束都替你调
 *
 * 加载动画是一张去了底的动态 WebP（assets/loading/mascot.webp），外圈一行 LOADING 绕着它转。
 * 卡片只建一次，之后每秒只改文字和数字：重建元素会让转圈和人物动画从头开始。
 */
(function () {
  const JOBS = new Map();
  let timer = null;
  let collapsed = false;
  let mini = null;

  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const SVGNS = 'http://www.w3.org/2000/svg';

  function host() {
    let el = document.getElementById('jobs');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'jobs';
    el.className = 'jobs';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const x = e.target.closest('[data-job-x]');
      if (x) {
        const j = JOBS.get(x.dataset.jobX);
        if (j && j.state !== 'run') remove(j);
        else collapsed = true;
        paint();
        return;
      }
      if (e.target.closest('[data-job-open]')) { collapsed = false; paint(); }
    });
    return el;
  }

  /* 加载动画：人物 + 外圈一行字（SVG 沿圆排，整个圈转） */
  let ringSeq = 0;
  function art(size) {
    const box = document.createElement('span');
    box.className = 'job-art';
    const img = document.createElement('img');
    img.src = 'assets/loading/mascot.webp';
    img.alt = '';
    img.width = img.height = size;
    img.draggable = false;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'job-ring');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('aria-hidden', 'true');
    const pid = `jobRing${++ringSeq}`;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('id', pid);
    path.setAttribute('d', 'M60,60 m-50,0 a50,50 0 1,1 100,0 a50,50 0 1,1 -100,0');
    path.setAttribute('fill', 'none');
    const text = document.createElementNS(SVGNS, 'text');
    const tp = document.createElementNS(SVGNS, 'textPath');
    tp.setAttribute('href', `#${pid}`);
    tp.setAttribute('textLength', '312');
    tp.setAttribute('lengthAdjust', 'spacing');
    text.appendChild(tp);
    svg.append(path, text);
    box.append(img, svg);
    box.setWord = (w) => {
      const s = `${w} · ${w} · ${w} · `;
      if (tp.textContent !== s) tp.textContent = s;
    };
    box.setWord('LOADING');
    return box;
  }

  function status(j, now) {
    const sec = (now - j.start) / 1000;
    const quiet = (now - j.beat) / 1000;
    if (j.state === 'ok') return { cls: 'is-ok', word: 'COMPLETE', beat: '完成' };
    if (j.state === 'err') return { cls: 'is-err', word: 'ERROR', beat: '没完成' };
    if (j.live && quiet > j.stallAfter) return { cls: 'is-stall', word: 'LOADING', beat: `已经 ${Math.floor(quiet)} 秒没有新动静，可能卡住了` };
    if (!j.live && j.expect && sec > j.expect * 2) return { cls: 'is-slow', word: 'LOADING', beat: `比平时慢（一般 ${j.expect} 秒左右），还在等返回` };
    if (j.live) return { cls: '', word: 'LOADING', beat: quiet < 2 ? '刚刚有动静' : `${Math.floor(quiet)} 秒前有动静` };
    return { cls: '', word: 'LOADING', beat: j.expect ? `在等返回，一般 ${j.expect} 秒左右` : '在等返回' };
  }

  function build(j) {
    const sec = document.createElement('section');
    sec.className = 'job';
    sec.dataset.job = j.id;
    const a = art(84);
    const main = document.createElement('div');
    main.className = 'job-main';
    main.innerHTML = `<p class="job-eb"></p><h3 class="job-title"></h3>
      <div class="job-bar">${Array.from({ length: 24 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <p class="job-step"></p><ul class="job-facts"></ul>`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'job-x';
    x.dataset.jobX = j.id;
    sec.append(a, main, x);
    j.el = { sec, art: a, eb: main.querySelector('.job-eb'), title: main.querySelector('.job-title'),
      bar: main.querySelector('.job-bar'), step: main.querySelector('.job-step'), facts: main.querySelector('.job-facts'), x };
    return sec;
  }

  function update(j, now) {
    const st = status(j, now);
    const e = j.el;
    e.sec.className = `job ${st.cls}`.trim();
    e.art.setWord(st.word);
    e.eb.textContent = j.en || 'Task';
    e.title.textContent = j.title;
    const known = j.state === 'ok' || j.total > 0;
    e.bar.classList.toggle('is-unknown', !known);
    const lit = j.state === 'ok' ? 24 : known ? Math.round(Math.min(1, (j.done || 0) / j.total) * 24) : 0;
    [...e.bar.children].forEach((c, i) => c.classList.toggle('on', i < lit));
    if (known) {
      e.bar.setAttribute('role', 'progressbar');
      e.bar.setAttribute('aria-valuemin', '0');
      e.bar.setAttribute('aria-valuemax', String(j.total || 1));
      e.bar.setAttribute('aria-valuenow', String(j.state === 'ok' ? (j.total || 1) : (j.done || 0)));
    }
    e.step.textContent = j.step || '准备中…';
    const secs = ((j.endAt || now) - j.start) / 1000;
    const facts = [`已用 ${clock(secs)}`];
    if (j.total) facts.push(`${j.state === 'ok' ? j.total : (j.done || 0)} / ${j.total} 步`);
    facts.push(st.beat);
    const html = facts.map((f, i) => `<li${i === facts.length - 1 ? ' class="job-beat"' : ''}></li>`).join('');
    if (e.facts.children.length !== facts.length) e.facts.innerHTML = html;
    facts.forEach((f, i) => { if (e.facts.children[i].textContent !== f) e.facts.children[i].textContent = f; });
    const label = j.state === 'run' ? '收起' : '关掉';
    if (e.x.textContent !== label) e.x.textContent = label;
    e.x.title = j.state === 'run' ? '收起，任务继续在后台跑' : '关掉这张卡片';
  }

  function remove(j) {
    if (j.el) j.el.sec.remove();
    JOBS.delete(j.id);
  }

  function paint() {
    const el = host();
    const now = Date.now();
    const list = [...JOBS.values()];
    if (!list.length) { el.hidden = true; if (mini) { mini.remove(); mini = null; } stopTimer(); return; }
    el.hidden = false;
    const running = list.filter((j) => j.state === 'run');
    if (!running.length) collapsed = false;

    if (collapsed) {
      for (const j of list) if (j.el) j.el.sec.hidden = true;
      if (!mini) {
        mini = document.createElement('button');
        mini.type = 'button';
        mini.className = 'job-mini';
        mini.dataset.jobOpen = '1';
        mini.title = '展开任务进度';
        mini.art = art(40);
        const t = document.createElement('span');
        t.className = 'job-mini-t';
        mini.append(mini.art, t);
        el.appendChild(mini);
      }
      const j = running[0];
      const st = status(j, now);
      mini.className = `job-mini ${st.cls}`.trim();
      const pct = j.total ? ` ${Math.round(((j.done || 0) / j.total) * 100)}%` : '';
      const more = running.length > 1 ? ` / 共 ${running.length} 个任务` : '';
      mini.lastChild.innerHTML = '';
      mini.lastChild.append(`${j.title}${pct}`, Object.assign(document.createElement('small'), { textContent: `${clock((now - j.start) / 1000)}${more}` }));
    } else {
      if (mini) { mini.remove(); mini = null; }
      for (const j of list) {
        if (!j.el) el.appendChild(build(j));
        j.el.sec.hidden = false;
        update(j, now);
      }
    }
    startTimer();
  }

  // 每秒刷新一次已用时间和「多久没动静」，没有任务时停掉
  function startTimer() { if (!timer) timer = setInterval(paint, 1000); }
  function stopTimer() { clearInterval(timer); timer = null; }

  window.jobStart = function (id, title, opts = {}) {
    const now = Date.now();
    const old = JOBS.get(id);
    if (old && old.state === 'run') { old.title = title; paint(); return old; }
    if (old) remove(old);
    const j = {
      id, title, en: opts.en || 'Task', total: opts.total || 0, done: 0, step: opts.step || '',
      expect: opts.expect || 0, stallAfter: opts.stallAfter || 30, live: !!opts.live,
      start: now, beat: now, state: 'run', endAt: 0, el: null,
    };
    JOBS.set(id, j);
    paint();
    return j;
  };

  window.jobBeat = function (id, step, done) {
    const j = JOBS.get(id);
    if (!j || j.state !== 'run') return;
    j.beat = Date.now();
    if (step) j.step = step;
    if (typeof done === 'number') j.done = Math.max(j.done || 0, done);
    paint();
  };

  window.jobEnd = function (id, ok, message) {
    const j = JOBS.get(id);
    if (!j || j.state !== 'run') return;
    j.state = ok ? 'ok' : 'err';
    j.endAt = Date.now();
    if (ok && j.total) j.done = j.total;
    j.step = message || (ok ? '完成' : '出错了');
    if (ok) setTimeout(() => { if (JOBS.get(id) === j) { remove(j); paint(); } }, 2500);
    paint();
  };

  window.withJob = async function (id, title, opts, fn) {
    window.jobStart(id, title, opts);
    try {
      const r = await fn();
      const bad = r && r.ok === false;
      window.jobEnd(id, !bad, bad ? (r.error || (r.needKey ? '还没填 API key' : '没成功')) : (opts.doneText || '完成'));
      return r;
    } catch (e) {
      window.jobEnd(id, false, String((e && e.message) || e));
      throw e;
    }
  };

  window.jobRunning = (id) => { const j = JOBS.get(id); return !!(j && j.state === 'run'); };
})();
