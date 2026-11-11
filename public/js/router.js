/** Minimal hash router with route guards. */

const routes = [];
let onNavigate = () => {};

export function defineRoute(pattern, handler, options = {}) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern
      .replace(/\/$/, '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })
      .replace(/\*/g, '(.*)')}/?$`,
  );
  routes.push({ regex, keys, handler, ...options });
}

export function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

export function parseQuery(path) {
  const [, search] = path.split('?');
  return new URLSearchParams(search || '');
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (replace) {
    window.history.replaceState(null, '', target);
    return resolve();
  }
  if (window.location.hash === target) return resolve();
  window.location.hash = target;
  return undefined;
}

export function onRouteChange(handler) {
  onNavigate = handler;
}

export async function resolve(context) {
  const full = currentPath();
  const [pathname, search] = full.split('?');
  for (const route of routes) {
    const match = route.regex.exec(pathname);
    if (match) {
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] || '');
      });
      await route.handler({ params, query: new URLSearchParams(search || ''), context, path: pathname });
      onNavigate(pathname);
      return true;
    }
  }
  return false;
}

export function startRouter(context) {
  window.addEventListener('hashchange', () => resolve(context));
  return resolve(context);
}
