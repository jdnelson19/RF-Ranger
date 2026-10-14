import type { BayTelemetry, ChannelRole, ChannelTelemetry, ConnectionStatus } from './model.js';
import { freshValue } from './reading.js';

export type ReadinessLabel = 'READY' | 'CHECK_WITH_AUDIO' | 'NOT_READY' | 'UNASSIGNED';

export interface Readiness {
  label: ReadinessLabel;
  /** Engineer-facing explanation; never shown on the pickup display. */
  reason?: string;
  /**
   * Which evidence decided the label: the live rack unit's channel (a mic
   * receiver or an IEM transmitter) or the charger bay.
   */
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
  /**
   * IEM bodypacks report nothing, so without a charger bay only the rack
   * transmitter can be checked. When false (the default) such a slot stops at
   * CHECK WITH AUDIO; when true, a healthy transmitter alone is READY.
   */
  iemReadyWithoutCharger: boolean;
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
  iemReadyWithoutCharger: false,
};

export interface ReadinessInput {
  assigned: boolean;
  /** Defaults to `mic`. */
  role?: ChannelRole;
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

  if (!online(connection, now, th)) {
    return { label: 'NOT_READY', reason: input.role === 'iem' ? 'IEM transmitter offline' : 'Receiver offline' };
  }

  if (input.role === 'iem') return iemReadiness(input, th);

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
    if (input.storage) return fromCharger(input.storage, now, th, MIC_CHARGER_TEXT);
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

function online(c: ConnectionStatus, now: number, th: ReadinessThresholds): boolean {
  return c.state === 'connected' && c.lastMessageAt !== undefined && now - c.lastMessageAt <= th.receiverSilenceMs;
}

/**
 * In-ear monitor channel. The rack transmitter must be positively sending
 * (RF on, not muted). The bodypack is receive-only and invisible on the
 * network, so it can only be vouched for by its charger bay.
 */
function iemReadiness(input: ReadinessInput, th: ReadinessThresholds): Readiness {
  const { telemetry: t, now } = input;
  const muted = freshValue(t.rfMuted, now, th.faultMaxAgeMs);
  const mw = freshValue(t.rfOutputMw, now, th.faultMaxAgeMs);
  if (muted === true) return { label: 'NOT_READY', reason: 'IEM RF muted', source: 'receiver' };
  if (mw === 0) return { label: 'NOT_READY', reason: 'IEM RF off', source: 'receiver' };
  if (muted === undefined || mw === undefined) {
    return { label: 'CHECK_WITH_AUDIO', reason: 'IEM transmitter state unknown', source: 'receiver' };
  }

  if (input.storage) return fromCharger(input.storage, now, th, IEM_CHARGER_TEXT);
  return th.iemReadyWithoutCharger
    ? { label: 'READY', reason: 'IEM on air; pack not monitored', source: 'receiver' }
    : { label: 'CHECK_WITH_AUDIO', reason: 'IEM on air; pack battery not monitored', source: 'receiver' };
}

interface ChargerText {
  offline: string;
  silent: string;
  empty: string;
}

const MIC_CHARGER_TEXT: ChargerText = {
  offline: 'Transmitter off; charger offline',
  silent: 'Transmitter off; charger bay not reporting',
  empty: 'Transmitter off and not on its charger',
};

const IEM_CHARGER_TEXT: ChargerText = {
  offline: 'IEM pack charger offline',
  silent: 'IEM pack charger bay not reporting',
  empty: 'IEM pack not on its charger',
};

/**
 * Readiness of a switched-off transmitter (or an IEM pack) from its assigned
 * charger bay. The charger can't identify what is docked, so this proves "a
 * battery is in the expected bay at this charge", not which device it is.
 */
function fromCharger(s: StorageInput, now: number, th: ReadinessThresholds, text: ChargerText): Readiness {
  if (!online(s.connection, now, th)) {
    return { label: 'CHECK_WITH_AUDIO', reason: text.offline, source: 'charger' };
  }
  // Charger values are reported on change only, so a live connection keeps them current.
  const bay = s.bay;
  if (!bay || bay.batteryPresent.state !== 'ok') {
    return { label: 'CHECK_WITH_AUDIO', reason: text.silent, source: 'charger' };
  }
  if (bay.error.state === 'ok' && bay.error.value !== null) {
    return { label: 'NOT_READY', reason: `Charger: ${bay.error.value}`, source: 'charger' };
  }
  if (!bay.batteryPresent.value) {
    return { label: 'CHECK_WITH_AUDIO', reason: text.empty, source: 'charger' };
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
