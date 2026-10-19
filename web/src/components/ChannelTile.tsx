import { SEVERITY_TONE, mhz, runtime, show, shownReadiness, slotTone, value } from '../format';
import type { DisplayOptions } from '../display';
import type { PresetChannel, SlotView } from '../types';
import { Battery, Meter, StatusPill, ToneIcon, Waveform } from './ui';

const RF_MIN = -100;
const RF_MAX = -30;
const RF_WEAK = -85;
const AUDIO_MIN = -60;

/**
 * Dense per-channel tile for the engineer grid. `fields` hides details per
 * the screen's display options; status (the readiness pill, the tile's colour,
 * TALK and MUTED tags) always shows. `preset` carries the active show preset's
 * nickname and waveform switch for this channel.
 */
export function ChannelTile({ s, frozen, onOpen, fields, preset }: {
  s: SlotView;
  frozen: boolean;
  onOpen: () => void;
  fields?: DisplayOptions;
  preset?: PresetChannel;
}) {
  const show_ = (f: keyof DisplayOptions) => fields?.[f] ?? true;
  const t = s.telemetry;
  const readiness = shownReadiness(s, preset?.nickname);
  const tone = frozen ? 'idle' : slotTone(s, readiness);
  const rf = value(t.rfDbm);
  const antennas = ['A', 'B', 'C', 'D'];
  const pct = value(t.batteryPercent);
  const bars = value(t.batteryBars);
  const top = s.alerts[0];
  const offline = s.alerts.some((a) => a.code === 'rx-offline');
  // Servers before 0.1.1 don't send txOn; fall back to the older rule rather than blanking the meters.
  const txOn = s.txOn ?? (t.batteryBars.state === 'ok' || t.txModel.state === 'ok' || t.linkQuality.state === 'ok');
  const channelName = s.assignment?.artist ?? (t.name.state === 'ok' ? t.name.value : 'Unassigned');
  const name = preset?.nickname ?? channelName;
  const iem = s.role === 'iem';
  const rfMuted = value(t.rfMuted);
  const mw = value(t.rfOutputMw);

  return (
    <button type="button" className={`tile tile--${tone}${offline ? ' tile--offline' : ''}`} onClick={onOpen}>
      <div className="tile__head">
        <span className="tile__label">{s.label}</span>
        <span className="tile__where">{s.receiverId} · ch{s.channel}</span>
        <StatusPill readiness={readiness} />
      </div>

      <div className="tile__name" title={preset?.nickname ? `${name} (channel name: ${channelName})` : name}>{name}</div>
      {show_('transmitter') && <div className="tile__sub">
        {iem
          ? [s.assignment?.role, 'In-ear', value(t.audioMode)].filter(Boolean).join(' · ')
          : [s.assignment?.role, txOn ? show(t.txModel) : 'TX off', value(t.txDeviceId)].filter(Boolean).join(' · ')}
      </div>}

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
          {(show_('battery') || show_('runtime') || (s.bay && !txOn)) && <div className="tile__battery">
            {show_('battery') && <Battery bars={bars} percent={pct} tone={batteryTone(s)} />}
            {show_('battery') && <span className="tile__num">{pct !== undefined ? `${pct}%` : bars !== undefined ? `${bars}/5` : show(t.batteryBars)}</span>}
            {show_('runtime') && <span className="tile__num tile__num--dim">
              {t.batteryRuntimeMin.state === 'ok' ? runtime(t.batteryRuntimeMin.value) : t.batteryRuntimeMin.state === 'absent' && t.batteryRuntimeMin.reason === 'calculating' ? 'calc…' : ''}
            </span>}
            {s.bay && !txOn && <span className="tile__charger">⚡ bay {s.assignment?.charger?.bay}</span>}
          </div>}

          {(show_('rf') || show_('audio')) && <div className="tile__meters">
            {show_('rf') && (rf ?? [undefined]).map((v, i) => (
              <Meter key={i} label={rf && rf.length > 1 ? `RF ${antennas[i]}` : 'RF'} value={txOn ? v : undefined} min={RF_MIN} max={RF_MAX} warnBelow={RF_WEAK}
                readout={txOn && v !== undefined ? `${v}` : '—'} />
            ))}
            {show_('audio') && <Meter label="AUD" value={txOn ? value(t.audioRmsDbfs) : undefined} min={AUDIO_MIN} max={0}
              readout={txOn && t.audioRmsDbfs.state === 'ok' ? `${t.audioRmsDbfs.value}` : '—'} />}
          </div>}

          {preset?.waveform && <Waveform levels={s.levels} live={!frozen} />}
        </>
      )}

      <div className="tile__foot">
        {show_('frequency') && <span className="tile__num">{t.frequencyKhz.state === 'ok' ? `${mhz(t.frequencyKhz.value)} MHz` : '— MHz'}</span>}
        {show_('quality') && t.linkQuality.state !== 'unsupported' && <span className="tile__num tile__num--dim">Q {show(t.linkQuality)}/5</span>}
        {txOn && value(t.txTalkSwitch) && <span className="tag tag--talk" title="Talk switch held: audio is going to talkback">TALK</span>}
        {value(t.rxMuted) && <span className="tag tag--warn">MUTED</span>}
      </div>

      {show_('alerts') && <div className={`tile__alert tile__alert--${top ? SEVERITY_TONE[top.severity] : 'none'}`}>
        {top ? (
          <>
            <ToneIcon tone={SEVERITY_TONE[top.severity]} />
            <span>{top.message}</span>
            {s.alerts.length > 1 && <span className="tile__more">+{s.alerts.length - 1}</span>}
          </>
        ) : (
          <span className="tile__ok">No issues</span>
        )}
      </div>}
    </button>
  );
}

function batteryTone(s: SlotView) {
  if (s.alerts.some((a) => a.code === 'battery-critical' || a.code === 'battery-low')) return 'bad' as const;
  return 'ok' as const;
}
