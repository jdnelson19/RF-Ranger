import { useEffect } from 'react';
import { DemoBanner } from './components/ui';
import { navigate, useRoute } from './route';
import { useSnapshot } from './useSnapshot';
import { Engineer } from './views/Engineer';
import { Launch } from './views/Launch';
import { Pickup } from './views/Pickup';

export function App() {
  const route = useRoute();
  const live = useSnapshot();

  // Micboard-style shortcuts: 0-9 pick a group, f fullscreen, Esc back to start.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.drawer') || route.view === 'inspector') return;
      const groups = live.snapshot?.groups ?? [];
      if (e.key === 'f') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
      } else if (e.key === 'Escape' && route.view !== 'launch') {
        navigate({ view: 'launch' });
      } else if (/^[0-9]$/.test(e.key) && route.view !== 'launch') {
        const n = Number(e.key);
        navigate({ view: route.view, group: n === 0 ? undefined : groups[n - 1] ?? route.group });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, live.snapshot?.groups]);

  return (
    <>
      {live.snapshot?.demo && route.view !== 'pickup' && <DemoBanner />}
      {route.view === 'launch' && <Launch live={live} />}
      {route.view === 'pickup' && <Pickup live={live} route={route} />}
      {(route.view === 'engineer' || route.view === 'attention' || route.view === 'devices' || route.view === 'inspector' || route.view === 'planning-center') && (
        <Engineer live={live} route={route} />
      )}
    </>
  );
}
