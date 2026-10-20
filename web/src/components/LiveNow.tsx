import { useEffect, useState } from 'react';
import type { Live } from '../useSnapshot';

/**
 * Planning Center Services Live, as the snapshot carries it: the current
 * item with a countdown to its planned end (computed on the server's clock,
 * so a screen with a wrong clock still counts right), and what's next.
 */
function useCountdown(live: Live): number | undefined {
  const now = live.snapshot?.live;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!now) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [!!now]);
  if (!now || !live.snapshot || live.receivedAt === undefined) return undefined;
  void tick;
  const serverNow = live.snapshot.serverTime + (Date.now() - live.receivedAt);
  return Math.round((Date.parse(now.item.endsAt) - serverNow) / 1000);
}

function clock(sec: number): string {
  const s = Math.abs(sec);
  const text = s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return sec < 0 ? `+${text}` : text;
}

const tone = (sec: number) => (sec < 0 ? 'over' : sec <= 30 ? 'soon' : 'ok');

/**
 * The live segment's countdown for the top center of a screen, with the
 * segment's name under it. Nothing when nothing is live.
 */
export function LiveClock({ live, className = '' }: { live: Live; className?: string }) {
  const left = useCountdown(live);
  const now = live.snapshot?.live;
  if (!now || left === undefined || !live.online) return null;
  return (
    <div className={`live-clock live-clock--${tone(left)} ${className}`} role="timer" aria-live="off" title={left < 0 ? 'Over time' : 'Time left in this segment'}>
      <span className="live-clock__time">{clock(left)}</span>
      <span className="live-clock__title">{left < 0 ? `${now.item.title} · over` : now.item.title}</span>
    </div>
  );
}

/** Pickup display: the segment on now, its clock, and what's next. Nothing when nothing is live. */
export function LiveStrip({ live, showClock = true }: { live: Live; showClock?: boolean }) {
  const left = useCountdown(live);
  const now = live.snapshot?.live;
  if (!now || left === undefined || !live.online) return null;
  return (
    <div className={`live-strip live-strip--${tone(left)}`} role="status" aria-live="off">
      <span className="live-strip__now">Now</span>
      <span className="live-strip__title">{now.item.title}</span>
      {showClock && <span className="live-strip__clock" title={left < 0 ? 'Over time' : 'Time left in this segment'}>{clock(left)}</span>}
      {now.next && <span className="live-strip__next">Next: {now.next.title}</span>}
    </div>
  );
}

/** Engineer view: a banner with the live segment, its clock, the next item and the leader. */
export function LiveBanner({ live }: { live: Live }) {
  const left = useCountdown(live);
  const now = live.snapshot?.live;
  if (!now || left === undefined || !live.online) return null;
  return (
    <div className={`live-banner live-banner--${tone(left)}`} role="status" aria-live="off">
      <span className="live-banner__dot" aria-hidden="true" />
      <b>LIVE</b>
      <span className="dim">{now.serviceName}</span>
      <span className="live-banner__title">{now.item.title}</span>
      <span className="live-banner__clock">{left < 0 ? `${clock(left)} over` : `${clock(left)} left`}</span>
      {now.leader && <span>Leader: <b>{now.leader}</b></span>}
      {now.next && <span className="dim">Next: {now.next.title}</span>}
    </div>
  );
}
