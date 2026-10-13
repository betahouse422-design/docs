// Tema claro / oscuro: sigue al sistema hasta que se elige uno a mano.
const root = document.documentElement;
const mq = window.matchMedia('(prefers-color-scheme: dark)');

export const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches);
export const themeVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();

function announce() {
  const m = document.querySelector('meta[name="theme-color"]:not([media])') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  m.content = themeVar('--bg') || (isDark() ? '#121316' : '#f2f1ee');
  window.dispatchEvent(new Event('themechange'));
}

export function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('tema', next); } catch { /* sin almacenamiento */ }
  announce();
}

export function initTheme(button) {
  button?.addEventListener('click', toggleTheme);
  mq.addEventListener?.('change', () => { if (!root.dataset.theme) announce(); });
  announce();
}
