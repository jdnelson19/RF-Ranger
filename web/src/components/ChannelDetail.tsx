import { useEffect } from 'react';
import { SEVERITY_TONE, antennasText, mhz, runtime, show, shownReadiness } from '../format';
import type { ChannelTelemetry, Reading, SlotView } from '../types';
import { StatusPill, ToneIcon, Waveform } from './ui';

type Row = [label: string, key: keyof ChannelTelemetry, fmt?: (v: any) => string];

const ROWS: Array<[section: string, rows: Row[]]> = [
  ['Transmitter', [
    ['Model', 'txModel'],
    ['Device ID', 'txDeviceId'],
    ['Mute switch', 'txMuted', (v: boolean) => (v ? 'Muted' : 'Open')],
    ['Talk switch', 'txTalkSwitch', (v: boolean) => (v ? 'Held: audio to talkback' : 'Released')],
    ['Offset', 'txOffsetDb', (v: number) => `${v > 0 ? '+' : ''}${v} dB`],
  ]],
  ['Battery', [
    ['Bars', 'batteryBars', (v: number) => `${v} / 5`],
    ['Charge', 'batteryPercent', (v: number) => `${v}%`],
    ['Runtime', 'batteryRuntimeMin', (v: number) => `${runtime(v)} h`],
    ['Type', 'batteryType'],
    ['Health', 'batteryHealthPercent', (v: number) => `${v}%`],
    ['Charge cycles', 'batteryCycles'],
    ['Temperature', 'batteryTempC', (v: number) => `${v} °C`],
  ]],
  ['RF', [
    ['Frequency', 'frequencyKhz', (v: number) => `${mhz(v)} MHz`],
    ['Group / channel', 'groupChannel'],
    ['RSSI', 'rfDbm', (v: number[]) => v.map((x) => `${x} dBm`).join('  ·  ')],
    ['Antennas', 'antennas', (v: string) => antennasText(v)],
    ['Link quality', 'linkQuality', (v: number) => `${v} / 5`],
    ['Interference', 'interference', (v: boolean) => (v ? 'Detected' : 'None')],
    ['Encryption', 'encryptionFault', (v: boolean) => (v ? 'Mismatch' : 'OK')],
    ['Registration', 'unregisteredTx', (v: boolean) => (v ? 'Unregistered TX' : 'OK')],
  ]],
  ['Audio', [
    ['RMS', 'audioRmsDbfs', (v: number) => `${v} dBFS`],
    ['Peak', 'audioPeakDbfs', (v: number) => `${v} dBFS`],
    ['Receiver output', 'rxMuted', (v: boolean) => (v ? 'Muted' : 'On')],
  ]],
];

/** In-ear monitor transmitter channel; the receive-only pack reports nothing. */
const IEM_ROWS: Array<[section: string, rows: Row[]]> = [
  ['IEM transmitter', [
    ['RF output', 'rfOutputMw', (v: number) => (v === 0 ? 'Off' : `${v} mW`)],
    ['RF mute', 'rfMuted', (v: boolean) => (v ? 'Muted' : 'On air')],
    ['Audio mode', 'audioMode'],
  ]],
  ['RF', [
    ['Frequency', 'frequencyKhz', (v: number) => `${mhz(v)} MHz`],
    ['Group / channel', 'groupChannel'],
  ]],
];

const STATE_NOTE: Record<Reading<unknown>['state'], string> = {
  ok: '',
  absent: 'device reports unavailable',
  unsupported: 'not supported by this hardware',
  unknown: 'not received yet',
};

export function ChannelDetail({ s, now, live, nickname, onClose }: { s: SlotView; now: number; live: boolean; nickname?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const a = s.assignment;
  const readiness = shownReadiness(s, nickname);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={`Channel ${s.label} details`}>
        <header className="drawer__head">
          <div>
            <div className="drawer__label">{s.label}</div>
            <div className="drawer__title">{nickname ?? a?.artist ?? 'Unassigned'}</div>
            <div className="drawer__sub">
              {[nickname && `nickname in this preset${a?.artist ? `; channel name ${a.artist}` : ''}`, a?.role, s.group, `${s.receiverId} ch${s.channel}`, s.family.toUpperCase()]
                .filter(Boolean).join(' · ')}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <section className="drawer__section">
          <div className="drawer__readiness">
            <StatusPill readiness={readiness} size="lg" />
            <span className="drawer__reason">{readiness.reason ?? (readiness.label === 'READY' ? 'All checks passed' : '')}</span>
          </div>
          {a && <p className="drawer__note">Pickup display shows: <b>{s.readiness.status}</b>{s.readiness.source === 'charger' ? ' (from charger bay)' : ''}</p>}
          {s.alerts.length > 0 && (
            <ul className="alert-list">
              {s.alerts.map((al) => (
                <li key={al.code} className={`alert-list__item alert-list__item--${SEVERITY_TONE[al.severity]}`}>
                  <ToneIcon tone={SEVERITY_TONE[al.severity]} /> {al.message}
                </li>
              ))}
            </ul>
          )}
        </section>

        {s.role === 'mic' && (
          <section className="drawer__section">
            <h3>Last 5 seconds</h3>
            <Waveform levels={s.levels} live={live} tall />
            <p className="drawer__note">Audio and RF dropping out together points to RF. An audio spike with steady RF is the mic being bumped or handled.</p>
          </section>
        )}

        {a && (
          <section className="drawer__section">
            <h3>Assignment</h3>
            <dl className="kv">
              <dt>Expected TX ID</dt><dd>{a.expectedTxId ?? <span className="dim">not set</span>}</dd>
              <dt>Charger bay</dt><dd>{a.charger ? `${a.charger.id} · bay ${a.charger.bay}` : <span className="dim">none</span>}</dd>
              {a.notes && (<><dt>Notes</dt><dd>{a.notes}</dd></>)}
            </dl>
          </section>
        )}

        {s.bay && (
          <section className="drawer__section">
            <h3>Charger bay</h3>
            <dl className="kv">
              <dt>Battery</dt><dd>{show(s.bay.batteryPresent, (v) => (v ? 'Docked' : 'Empty'))}</dd>
              <dt>Charge</dt><dd>{show(s.bay.chargePercent, (v) => `${v}%`)}</dd>
              <dt>Time to full</dt><dd>{show(s.bay.minutesToFull, (v) => (v === 0 ? 'Full' : `${v} min`))}</dd>
              <dt>Health</dt><dd>{show(s.bay.healthPercent, (v) => `${v}%`)}</dd>
              <dt>Fault</dt><dd>{show(s.bay.error, (v) => v ?? 'None')}</dd>
            </dl>
          </section>
        )}

        {s.role === 'iem' && (
          <section className="drawer__section">
            <p className="drawer__note">
              The bodypack only receives, so its battery and signal aren't visible on the network.
              {a?.charger ? ' Its readiness comes from the charger bay.' : ' Assign a charger bay to track it.'}
            </p>
          </section>
        )}

        {(s.role === 'iem' ? IEM_ROWS : ROWS).map(([section, rows]) => (
          <section key={section} className="drawer__section">
            <h3>{section}</h3>
            <dl className="kv">
              {rows.map(([label, key, fmt]) => {
                const reading = s.telemetry[key] as Reading<unknown>;
                const age = reading.state === 'ok' ? Math.max(0, Math.round((now - reading.at) / 1000)) : undefined;
                return (
                  <div key={label} className="kv__row">
                    <dt>{label}</dt>
                    <dd className={reading.state === 'ok' ? '' : 'dim'}>
                      {show(reading, fmt ?? String)}
                      {reading.state !== 'ok' && !(reading.state === 'absent' && reading.reason) && <span className="kv__why">{STATE_NOTE[reading.state]}</span>}
                      {age !== undefined && age > 10 && <span className="kv__why">{age}s ago</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </aside>
    </div>
  );
}
