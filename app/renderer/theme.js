// 在样式表之前定好深浅色和过渡动画开关，避免开窗时闪一下。
// 深浅色没选过就跟随系统；过渡动画默认开，设置里可改成「跟随系统」或「关」。
(function () {
  const root = document.documentElement;
  let motion = 'on';
  try {
    const t = localStorage.getItem('radar.theme');
    if (t === 'light' || t === 'dark') root.dataset.theme = t;
    const m = localStorage.getItem('radar.motion');
    if (m === 'on' || m === 'off' || m === 'system') motion = m;
  } catch {}
  const off = motion === 'off' || (motion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  root.dataset.motion = off ? 'off' : 'on';
})();

// 界面缩放：radar.zoom = auto（默认）| 1 | 1.15 | 1.3 | 1.5，只记在这台电脑上。
// auto 按窗口宽度放大：窗口在 100% 时宽 1900 以内不放大，再宽就按比例放大（最多 1.5 倍），
// 这样 2K、4K 全屏时字不会小得看不清，内容也不会只占屏幕左边一小块。
(function () {
  const api = window.radar;
  const pref = () => {
    try { return localStorage.getItem('radar.zoom') || 'auto'; } catch { return 'auto'; }
  };
  function target(p) {
    if (p !== 'auto') {
      const n = Number(p);
      return n >= 0.8 && n <= 2 ? n : 1;
    }
    const z = (api && api.getZoom && api.getZoom()) || 1;
    const w = window.innerWidth * z; // 换算回 100% 时的宽度，放大以后不会越放越大
    return Math.min(1.5, Math.max(1, Math.round((w / 1900) * 20) / 20));
  }
  function apply() {
    if (!api || !api.setZoom) return 1;
    const f = target(pref());
    if (Math.abs(f - (api.getZoom() || 1)) > 0.01) api.setZoom(f);
    return f;
  }
  function set(p) {
    try { localStorage.setItem('radar.zoom', String(p)); } catch {}
    return apply();
  }
  window.radarZoom = { apply, set, pref, current: () => (api && api.getZoom ? api.getZoom() : 1) };
  apply();
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
})();
