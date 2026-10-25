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
