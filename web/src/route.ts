import { useEffect, useState } from 'react';

/**
 * Hash routes, so any view (e.g. a backstage TV's pickup screen) can be
 * bookmarked and reopens straight into that view:
 *   #/                   launch screen
 *   #/pickup?group=Vocals
 *   #/engineer  #/engineer/attention  #/engineer/devices  #/engineer/inspector
 */
export type View = 'launch' | 'pickup' | 'engineer' | 'attention' | 'devices' | 'inspector';

export interface Route {
  view: View;
  group?: string;
}

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const group = new URLSearchParams(query).get('group') ?? undefined;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'pickup') return { view: 'pickup', group };
  if (parts[0] === 'engineer') {
    if (parts[1] === 'attention') return { view: 'attention', group };
    if (parts[1] === 'devices') return { view: 'devices', group };
    if (parts[1] === 'inspector') return { view: 'inspector' };
    return { view: 'engineer', group };
  }
  return { view: 'launch' };
}

export function href(route: Route): string {
  const path = {
    launch: '/',
    pickup: '/pickup',
    engineer: '/engineer',
    attention: '/engineer/attention',
    devices: '/engineer/devices',
    inspector: '/engineer/inspector',
  }[route.view];
  return `#${path}${route.group ? `?group=${encodeURIComponent(route.group)}` : ''}`;
}

export function navigate(route: Route): void {
  location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
