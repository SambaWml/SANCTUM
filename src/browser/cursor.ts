/**
 * Cursor visível no vídeo: o Playwright move o mouse por código e a gravação não mostra ponteiro,
 * então quem assiste não sabe onde o teste clicou. Uma camada injetada em cada página desenha:
 * bolinha que segue o mouse, pulso a cada clique e contorno no campo em foco (onde se digita).
 * A camada não recebe eventos (pointer-events: none), fica fora da acessibilidade (aria-hidden,
 * shadow DOM fechado) e não aparece em snapshots — não muda o que o teste vê nem onde ele clica.
 */
export const CURSOR_SCRIPT = `(() => {
  if (window.__sanctumCursor || window.top !== window) return;
  window.__sanctumCursor = true;
  const init = () => {
    const host = document.createElement('div');
    host.setAttribute('data-sanctum-cursor', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(255,59,48,.6);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.6);transition:transform .08s';
    const focus = document.createElement('div');
    focus.style.cssText = 'position:fixed;display:none;border:3px solid rgba(255,59,48,.9);border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.7)';
    root.append(focus, dot);
    document.documentElement.appendChild(host);
    addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      dot.style.transform = 'scale(1.6)';
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:44px;height:44px;margin:-22px 0 0 -22px;' +
        'border-radius:50%;border:3px solid rgba(255,59,48,.95)';
      root.appendChild(ring);
      ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 650 }).onfinish = () => ring.remove();
    }, true);
    addEventListener('mouseup', () => { dot.style.transform = 'scale(1)'; }, true);
    let hide;
    addEventListener('focusin', (e) => {
      const el = e.target;
      if (!(el instanceof Element) || !el.matches('input, textarea, select, [contenteditable]')) return;
      const r = el.getBoundingClientRect();
      Object.assign(focus.style, { display: 'block', left: (r.left - 4) + 'px', top: (r.top - 4) + 'px', width: (r.width + 2) + 'px', height: (r.height + 2) + 'px' });
      clearTimeout(hide);
      hide = setTimeout(() => { focus.style.display = 'none'; }, 1500);
    }, true);
  };
  if (document.documentElement) init(); else addEventListener('DOMContentLoaded', init);
})();`;
