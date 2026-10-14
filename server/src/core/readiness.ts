import type { BayTelemetry, ChannelTelemetry, ConnectionStatus } from './model.js';
import { freshValue } from './reading.js';

export type ReadinessLabel = 'READY' | 'CHECK_WITH_AUDIO' | 'NOT_READY' | 'UNASSIGNED';

export interface Readiness {
  label: ReadinessLabel;
  /** Engineer-facing explanation; never shown on the pickup display. */
  reason?: string;
  /** Which evidence decided the label: the live receiver channel or the charger bay. */
  source?: 'receiver' | 'charger';
  /** Charge level to show on the pickup card while the transmitter sits on its charger. */
  chargePercent?: number;
}

/** The charger bay an assignment's transmitter is stored in. */
export interface StorageInput {
  connection: ConnectionStatus;
  bay: BayTelemetry | undefined;
  storageMode?: boolean;
}

export interface ReadinessThresholds {
  /** No message from the receiver for longer than this means it is offline. */
  receiverSilenceMs: number;
  /** Battery readings older than this are treated as unknown. */
  batteryMaxAgeMs: number;
  /** Fault flags (interference, encryption, ...) older than this are ignored. */
  faultMaxAgeMs: number;
  criticalBars: number;
  warningBars: number;
  criticalPercent: number;
  warningPercent: number;
  /** A docked transmitter counts as ready for pickup at or above this charge. */
  chargerReadyPercent: number;
}

export const DEFAULT_THRESHOLDS: ReadinessThresholds = {
  receiverSilenceMs: 5_000,
  batteryMaxAgeMs: 120_000,
  faultMaxAgeMs: 120_000,
  criticalBars: 1,
  warningBars: 3,
  criticalPercent: 20,
  warningPercent: 50,
  chargerReadyPercent: 90,
};

export interface ReadinessInput {
  assigned: boolean;
  connection: ConnectionStatus;
  telemetry: ChannelTelemetry;
  /** Transmitter identity the assignment expects, if any. */
  expectedTxDeviceId?: string;
  /** Present when the assignment names a charger bay for this transmitter. */
  storage?: StorageInput;
  now: number;
}

/**
 * Pickup-display readiness. Rules are evaluated in order and the first match
 * wins; see docs/architecture.md. Anything not positively known to be fine
 * stops short of READY.
 */
export function readiness(input: ReadinessInput, th: ReadinessThresholds = DEFAULT_THRESHOLDS): Readiness {
  const { connection, telemetry: t, now } = input;

  if (!input.assigned) return { label: 'UNASSIGNED' };

  const lastHeard = connection.lastMessageAt;
  if (connection.state !== 'connected' || lastHeard === undefined || now - lastHeard > th.receiverSilenceMs) {
    return { label: 'NOT_READY', reason: 'Receiver offline' };
  }

  const present = txPresent(t);

  if (present && input.expectedTxDeviceId && t.txDeviceId.state === 'ok') {
    const seen = t.txDeviceId.value;
    if (seen !== input.expectedTxDeviceId) {
      return { label: 'NOT_READY', reason: `Wrong transmitter: expected ${input.expectedTxDeviceId}, seeing ${seen}` };
    }
  }

  const fault = (r: ChannelTelemetry['interference']) => freshValue(r, now, th.faultMaxAgeMs) === true;
  if (fault(t.encryptionFault)) return { label: 'NOT_READY', reason: 'Encryption mismatch' };
  if (fault(t.unregisteredTx)) return { label: 'NOT_READY', reason: 'Unregistered transmitter' };
  if (fault(t.interference)) return { label: 'NOT_READY', reason: 'RF interference' };

  const bars = freshValue(t.batteryBars, now, th.batteryMaxAgeMs);
  const pct = freshValue(t.batteryPercent, now, th.batteryMaxAgeMs);
  if ((pct !== undefined && pct <= th.criticalPercent) || (bars !== undefined && bars <= th.criticalBars)) {
    return { label: 'NOT_READY', reason: 'Battery critical' };
  }

  if (!present) {
    if (input.storage) return fromCharger(input.storage, now, th);
    return { label: 'CHECK_WITH_AUDIO', reason: 'Transmitter off or out of range', source: 'receiver' };
  }

  if (pct === undefined && bars === undefined) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'Battery level unknown', source: 'receiver' };
  }
  if ((pct !== undefined && pct <= th.warningPercent) || (bars !== undefined && bars <= th.warningBars)) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'Battery low', source: 'receiver' };
  }

  return { label: 'READY', source: 'receiver' };
}

/**
 * Readiness of a switched-off transmitter from its assigned charger bay. The
 * charger can't identify what is docked, so this proves "a battery is in the
 * expected bay at this charge", not which transmitter it is.
 */
function fromCharger(s: StorageInput, now: number, th: ReadinessThresholds): Readiness {
  const lastHeard = s.connection.lastMessageAt;
  if (s.connection.state !== 'connected' || lastHeard === undefined || now - lastHeard > th.receiverSilenceMs) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'Transmitter off; charger offline', source: 'charger' };
  }
  // Charger values are reported on change only, so a live connection keeps them current.
  const bay = s.bay;
  if (!bay || bay.batteryPresent.state !== 'ok') {
    return { label: 'CHECK_WITH_AUDIO', reason: 'Transmitter off; charger bay not reporting', source: 'charger' };
  }
  if (bay.error.state === 'ok' && bay.error.value !== null) {
    return { label: 'NOT_READY', reason: `Charger: ${bay.error.value}`, source: 'charger' };
  }
  if (!bay.batteryPresent.value) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'Transmitter off and not on its charger', source: 'charger' };
  }
  const pct = bay.chargePercent.state === 'ok' ? bay.chargePercent.value : undefined;
  if (pct === undefined) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'On charger; charge level unknown', source: 'charger' };
  }
  if (s.storageMode) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'Charger is in storage mode', source: 'charger', chargePercent: pct };
  }
  if (pct >= th.chargerReadyPercent) {
    return { label: 'READY', reason: `On charger, ${pct}%`, source: 'charger', chargePercent: pct };
  }
  const mins = bay.minutesToFull.state === 'ok' ? `, full in ${bay.minutesToFull.value} min` : '';
  return { label: 'CHECK_WITH_AUDIO', reason: `Charging, ${pct}%${mins}`, source: 'charger', chargePercent: pct };
}

/**
 * Whether a transmitter is on air. Shure has no single flag for this; the
 * transmitter-sourced fields flip between values and sentinels as it comes
 * and goes. Must be validated per family against hardware.
 */
export function txPresent(t: ChannelTelemetry): boolean {
  return t.batteryBars.state === 'ok' || t.txOffsetDb.state === 'ok' || t.txModel.state === 'ok';
}
