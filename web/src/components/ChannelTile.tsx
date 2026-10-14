import { READINESS_TONE, SEVERITY_TONE, mhz, runtime, show, slotTone, value } from '../format';
import type { SlotView } from '../types';
import { Battery, Meter, StatusPill, ToneIcon } from './ui';

const RF_MIN = -100;
const RF_MAX = -30;
const RF_WEAK = -85;
const AUDIO_MIN = -60;

/** Dense per-channel tile for the engineer grid. */
export function ChannelTile({ s, frozen, onOpen }: { s: SlotView; frozen: boolean; onOpen: () => void }) {
  const t = s.telemetry;
  const tone = frozen ? 'idle' : slotTone(s);
  const rf = value(t.rfDbm);
  const antennas = ['A', 'B', 'C', 'D'];
  const pct = value(t.batteryPercent);
  const bars = value(t.batteryBars);
  const top = s.alerts[0];
  const offline = s.alerts.some((a) => a.code === 'rx-offline');
  const txOn = s.txOn;
  const name = s.assignment?.artist ?? (t.name.state === 'ok' ? t.name.value : 'Unassigned');
  const iem = s.role === 'iem';
  const rfMuted = value(t.rfMuted);
  const mw = value(t.rfOutputMw);

  return (
    <button type="button" className={`tile tile--${tone}${offline ? ' tile--offline' : ''}`} onClick={onOpen}>
      <div className="tile__head">
        <span className="tile__label">{s.label}</span>
        <span className="tile__where">{s.receiverId} · ch{s.channel}</span>
        <StatusPill label={s.readiness.label} />
      </div>

      <div className="tile__name" title={name}>{name}</div>
      <div className="tile__sub">
        {iem
          ? [s.assignment?.role, 'In-ear', value(t.audioMode)].filter(Boolean).join(' · ')
          : [s.assignment?.role, txOn ? show(t.txModel) : 'TX off', value(t.txDeviceId)].filter(Boolean).join(' · ')}
      </div>

      {iem ? (
        <div className="tile__battery">
          {rfMuted
            ? <span className="tag tag--bad">RF MUTED</span>
            : <span className="tile__num">RF {mw === 0 ? 'off' : show(t.rfOutputMw, (v) => `${v} mW`)}</span>}
          {s.bay ? (
            <span className="tile__charger">⚡ pack bay {s.assignment?.charger?.bay}</span>
          ) : (
            <span className="tile__num tile__num--dim">pack not monitored</span>
          )}
        </div>
      ) : (
        <>
          <div className="tile__battery">
            <Battery bars={bars} percent={pct} tone={batteryTone(s)} />
            <span className="tile__num">{pct !== undefined ? `${pct}%` : bars !== undefined ? `${bars}/5` : show(t.batteryBars)}</span>
            <span className="tile__num tile__num--dim">
              {t.batteryRuntimeMin.state === 'ok' ? runtime(t.batteryRuntimeMin.value) : t.batteryRuntimeMin.state === 'absent' && t.batteryRuntimeMin.reason === 'calculating' ? 'calc…' : ''}
            </span>
            {s.bay && !txOn && <span className="tile__charger">⚡ bay {s.assignment?.charger?.bay}</span>}
          </div>

          <div className="tile__meters">
            {(rf ?? [undefined]).map((v, i) => (
              <Meter key={i} label={rf && rf.length > 1 ? `RF ${antennas[i]}` : 'RF'} value={txOn ? v : undefined} min={RF_MIN} max={RF_MAX} warnBelow={RF_WEAK}
                readout={txOn && v !== undefined ? `${v}` : '—'} />
            ))}
            <Meter label="AUD" value={txOn ? value(t.audioRmsDbfs) : undefined} min={AUDIO_MIN} max={0}
              readout={txOn && t.audioRmsDbfs.state === 'ok' ? `${t.audioRmsDbfs.value}` : '—'} />
          </div>
        </>
      )}

      <div className="tile__foot">
        <span className="tile__num">{t.frequencyKhz.state === 'ok' ? `${mhz(t.frequencyKhz.value)} MHz` : '— MHz'}</span>
        {t.linkQuality.state !== 'unsupported' && <span className="tile__num tile__num--dim">Q {show(t.linkQuality)}/5</span>}
        {value(t.rxMuted) && <span className="tag tag--warn">MUTED</span>}
      </div>

      <div className={`tile__alert tile__alert--${top ? SEVERITY_TONE[top.severity] : 'none'}`}>
        {top ? (
          <>
            <ToneIcon tone={SEVERITY_TONE[top.severity]} />
            <span>{top.message}</span>
            {s.alerts.length > 1 && <span className="tile__more">+{s.alerts.length - 1}</span>}
          </>
        ) : (
          <span className="tile__ok">No issues</span>
        )}
      </div>
    </button>
  );
}

function batteryTone(s: SlotView) {
  if (s.alerts.some((a) => a.code === 'battery-critical')) return 'bad' as const;
  if (s.alerts.some((a) => a.code === 'battery-low')) return 'warn' as const;
  return READINESS_TONE.READY;
}
