import type { RequestHandler, Response } from 'express';

const injectionMarker = 'data-bull-board-extension-menu-icon';

const extensionMenuIconScript = `<script ${injectionMarker}>
(() => {
  const icon = '<svg data-bull-board-extension-icon aria-hidden="true" focusable="false" viewBox="2 2 20 20" fill="currentColor"><path d="M8.5 3H5a2 2 0 0 0-2 2v3.5h1.5a2.5 2.5 0 0 1 0 5H3V19a2 2 0 0 0 2 2h3.5v-1.5a2.5 2.5 0 0 1 5 0V21H19a2 2 0 0 0 2-2v-5.5h-1.5a2.5 2.5 0 0 1 0-5H21V5a2 2 0 0 0-2-2h-5.5v1.5a2.5 2.5 0 0 1-5 0V3Z"/></svg>';
  const install = () => {
    const avatar = document.querySelector('header button svg[viewBox="0 0 48 48"]');
    const trigger = avatar?.closest('button');
    if (!(avatar instanceof SVGElement) || !(trigger instanceof HTMLButtonElement)) return false;
    avatar.outerHTML = icon;
    trigger.setAttribute('aria-label', 'Extensions');
    trigger.setAttribute('title', 'Extensions');
    return true;
  };
  if (install()) return;
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect();
  });
  observer.observe(document.getElementById('root') ?? document.documentElement, { childList: true, subtree: true });
})();
</script>`;

export function injectExtensionMenuIcon(): RequestHandler {
  return (_req, res, next) => {
    const send = res.send.bind(res) as (body?: unknown) => Response;
    res.send = ((body?: unknown) => {
      if (typeof body !== 'string' || body.includes(injectionMarker) || !body.includes('</body>')) return send(body);
      return send(body.replace('</body>', `${extensionMenuIconScript}</body>`));
    }) as typeof res.send;
    next();
  };
}
