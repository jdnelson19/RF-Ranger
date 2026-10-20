import { useEffect, useState } from 'react';

/**
 * Hash routes, so any view (e.g. a backstage TV's pickup screen) can be
 * bookmarked and reopens straight into that view:
 *   #/                   launch screen
 *   #/pickup?group=Vocals  #/pickup?show=<preset id>   pickup for one group or one show preset
 *   #/engineer  #/engineer/attention  #/engineer/devices  #/engineer/inspector  #/engineer/planning-center
 *   #/engineer?show=<preset id>   the engineer grid limited to a show preset
 */
export type View = 'launch' | 'pickup' | 'engineer' | 'attention' | 'devices' | 'inspector' | 'planning-center';

export interface Route {
  view: View;
  group?: string;
  /** Show preset id (engineer grid and pickup display). */
  show?: string;
}

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const group = params.get('group') ?? undefined;
  const show = params.get('show') ?? undefined;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'pickup') return { view: 'pickup', group, show };
  if (parts[0] === 'engineer') {
    if (parts[1] === 'attention') return { view: 'attention', group };
    if (parts[1] === 'devices') return { view: 'devices', group };
    if (parts[1] === 'inspector') return { view: 'inspector' };
    if (parts[1] === 'planning-center') return { view: 'planning-center' };
    return { view: 'engineer', group, show };
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
    'planning-center': '/engineer/planning-center',
  }[route.view];
  const params = new URLSearchParams();
  if (route.group) params.set('group', route.group);
  if (route.show && (route.view === 'engineer' || route.view === 'pickup')) params.set('show', route.show);
  const query = params.toString();
  return `#${path}${query ? `?${query}` : ''}`;
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
