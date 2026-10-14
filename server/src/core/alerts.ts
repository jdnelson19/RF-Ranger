import type { ChannelTelemetry, ConnectionStatus } from './model.js';
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
    add('rx-offline', 'critical', connection.lastError ? `Receiver offline: ${connection.lastError}` : 'Receiver offline');
    return out; // nothing else about this channel can be trusted
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
