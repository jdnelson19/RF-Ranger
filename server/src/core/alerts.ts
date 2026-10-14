import type { ChannelRole, ChannelTelemetry, ConnectionStatus } from './model.js';
import { freshValue } from './reading.js';
import { txPresent, type Readiness, type ReadinessThresholds } from './readiness.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  code: string;
  severity: Severity;
  message: string;
}

export interface AlertThresholds extends ReadinessThresholds {
  /** Strongest antenna below this, with a transmitter on air, is weak RF. */
  rfWeakDbm: number;
  runtimeWarnMin: number;
}

export interface AlertInput {
  assigned: boolean;
  /** Defaults to `mic`. */
  role?: ChannelRole;
  connection: ConnectionStatus;
  telemetry: ChannelTelemetry;
  readiness: Readiness;
  expectedTxDeviceId?: string;
  now: number;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Engineer-facing problems for one channel, most severe first. */
export function channelAlerts(input: AlertInput, th: AlertThresholds): Alert[] {
  const { connection, telemetry: t, now } = input;
  const out: Alert[] = [];
  const add = (code: string, severity: Severity, message: string) => out.push({ code, severity, message });

  const lastHeard = connection.lastMessageAt;
  if (connection.state !== 'connected' || lastHeard === undefined || now - lastHeard > th.receiverSilenceMs) {
    const what = input.role === 'iem' ? 'IEM transmitter offline' : 'Receiver offline';
    add('rx-offline', 'critical', connection.lastError ? `${what}: ${connection.lastError}` : what);
    return out; // nothing else about this channel can be trusted
  }

  if (input.role === 'iem') {
    iemAlerts(input, th, add);
    return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  }

  const fault = (r: ChannelTelemetry['interference']) => freshValue(r, now, th.faultMaxAgeMs) === true;
  if (fault(t.encryptionFault)) add('encryption', 'critical', 'Encryption mismatch');
  if (fault(t.unregisteredTx)) add('unregistered-tx', 'critical', 'Unregistered transmitter');
  if (fault(t.interference)) add('interference', 'critical', 'RF interference detected');

  const present = txPresent(t);
  if (present && input.expectedTxDeviceId && t.txDeviceId.state === 'ok' && t.txDeviceId.value !== input.expectedTxDeviceId) {
    add('tx-mismatch', 'critical', `Wrong transmitter: ${t.txDeviceId.value} (expected ${input.expectedTxDeviceId})`);
  }

  if (present) {
    const pct = freshValue(t.batteryPercent, now, th.batteryMaxAgeMs);
    const bars = freshValue(t.batteryBars, now, th.batteryMaxAgeMs);
    if ((pct !== undefined && pct <= th.criticalPercent) || (bars !== undefined && bars <= th.criticalBars)) {
      add('battery-critical', 'critical', 'Battery critical');
    } else if ((pct !== undefined && pct <= th.warningPercent) || (bars !== undefined && bars <= th.warningBars)) {
      add('battery-low', 'warning', 'Battery low');
    } else if (pct === undefined && bars === undefined) {
      add('battery-unknown', 'warning', 'Battery level unknown');
    }

    const runtime = freshValue(t.batteryRuntimeMin, now, th.batteryMaxAgeMs);
    if (runtime !== undefined && runtime < th.runtimeWarnMin) add('runtime-low', 'warning', `${runtime} min runtime left`);

    const rf = freshValue(t.rfDbm, now, 5_000);
    if (rf && rf.length > 0 && Math.max(...rf) < th.rfWeakDbm) add('rf-weak', 'warning', `Weak RF (${Math.max(...rf)} dBm)`);

    if (freshValue(t.txMuted, now, th.faultMaxAgeMs) === true) add('tx-muted', 'info', 'Transmitter mute switch on');
  } else if (input.assigned) {
    if (input.readiness.source === 'charger' && input.readiness.label === 'READY') {
      add('on-charger', 'info', input.readiness.reason ?? 'On charger');
    } else if (input.readiness.source === 'charger') {
      add('charger', input.readiness.label === 'NOT_READY' ? 'critical' : 'warning', input.readiness.reason ?? 'Check charger');
    } else {
      add('tx-off', 'warning', 'Transmitter off or out of range');
    }
  }

  if (freshValue(t.rxMuted, now, th.faultMaxAgeMs) === true) add('rx-muted', 'warning', 'Receiver output muted');

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** In-ear monitor transmitter channel. The pack is receive-only and reports nothing. */
function iemAlerts(input: AlertInput, th: AlertThresholds, add: (code: string, severity: Severity, message: string) => void): void {
  const { telemetry: t, now } = input;
  // An unassigned IEM channel going quiet is normal; an assigned one is an outage for that artist.
  const severity: Severity = input.assigned ? 'critical' : 'info';
  const muted = freshValue(t.rfMuted, now, th.faultMaxAgeMs);
  const mw = freshValue(t.rfOutputMw, now, th.faultMaxAgeMs);
  if (muted === true) add('iem-rf-muted', severity, 'IEM RF muted');
  if (mw === 0) add('iem-rf-off', severity, 'IEM RF off');
  if (!input.assigned) return;
  if (muted === undefined || mw === undefined) {
    add('iem-state-unknown', 'warning', 'IEM transmitter state unknown');
    return;
  }

  const r = input.readiness;
  if (r.source === 'charger') {
    if (r.label === 'READY') add('on-charger', 'info', r.reason ?? 'Pack on charger');
    else add('charger', r.label === 'NOT_READY' ? 'critical' : 'warning', r.reason ?? 'Check charger');
  } else if (r.label !== 'NOT_READY') {
    add('iem-pack-unmonitored', 'info', 'IEM pack battery not monitored');
  }
}
