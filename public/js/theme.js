// Loaded in <head> so the right theme is applied before the page paints.
(function () {
  const root = document.documentElement;
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch {}
  const prefersLight = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = saved || (prefersLight ? 'light' : 'dark');

  function label(btn) {
    const dark = root.dataset.theme === 'dark';
    // "Lumos" lights things up, "Nox" puts the lights out.
    btn.innerHTML = dark ? '<span aria-hidden="true">☀</span> Lumos' : '<span aria-hidden="true">☾</span> Nox';
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      label(btn);
      btn.addEventListener('click', () => {
        root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem('theme', root.dataset.theme);
        } catch {}
        document.querySelectorAll('[data-theme-toggle]').forEach(label);
      });
    });
  });
})();
