import type { BayTelemetry, ChannelRole, ChannelTelemetry, ConnectionStatus } from './model.js';
import { freshValue } from './reading.js';

/**
 * READY (green), STANDBY (orange: switched off, on its charger, or not yet
 * known to be fine), NOT_READY (red: low battery or a fault), UNASSIGNED (a
 * spare that is switched off).
 */
export type ReadinessLabel = 'READY' | 'STANDBY' | 'NOT_READY' | 'UNASSIGNED';

export interface Readiness {
  label: ReadinessLabel;
  /** A word or two for the status pill: "Ready", "Off", "On charger", "Battery low". */
  status: string;
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
  /** Bar thresholds apply only to transmitters that report no percentage. */
  criticalBars: number;
  warningBars: number;
  criticalPercent: number;
  warningPercent: number;
  /** A docked transmitter counts as charged at or above this charge. */
  chargerReadyPercent: number;
  /**
   * IEM bodypacks report nothing, so without a charger bay only the rack
   * transmitter can be checked. When false (the default) such a slot stops at
   * STANDBY; when true, a healthy transmitter alone is READY.
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
  const present = input.role !== 'iem' && txPresent(t);

  // A spare that someone has switched on is judged like any other mic, so a
  // channel named only "RF-4" still shows its battery and faults.
  if (!input.assigned && !present) return { label: 'UNASSIGNED', status: 'Spare' };

  if (!online(connection, now, th)) {
    return { label: 'NOT_READY', status: 'Offline', reason: input.role === 'iem' ? 'IEM transmitter offline' : 'Receiver offline' };
  }

  if (input.role === 'iem') return iemReadiness(input, th);

  if (present && input.expectedTxDeviceId && t.txDeviceId.state === 'ok') {
    const seen = t.txDeviceId.value;
    if (seen !== input.expectedTxDeviceId) {
      return { label: 'NOT_READY', status: 'Wrong transmitter', reason: `Wrong transmitter: expected ${input.expectedTxDeviceId}, seeing ${seen}` };
    }
  }

  const fault = (r: ChannelTelemetry['interference']) => freshValue(r, now, th.faultMaxAgeMs) === true;
  if (fault(t.encryptionFault)) return { label: 'NOT_READY', status: 'Encryption', reason: 'Encryption mismatch' };
  if (fault(t.unregisteredTx)) return { label: 'NOT_READY', status: 'Unregistered', reason: 'Unregistered transmitter' };
  if (fault(t.interference)) return { label: 'NOT_READY', status: 'Interference', reason: 'RF interference' };

  const battery = batteryLevel(t, now, th);
  if (battery === 'critical') return { label: 'NOT_READY', status: 'Battery critical', reason: 'Battery critical' };

  if (!present) {
    if (input.storage) return fromCharger(input.storage, now, th, MIC_CHARGER_TEXT);
    return { label: 'STANDBY', status: 'Off', reason: 'Transmitter off or out of range', source: 'receiver' };
  }

  if (battery === undefined) return { label: 'STANDBY', status: 'Battery unknown', reason: 'Battery level unknown', source: 'receiver' };
  if (battery === 'low') return { label: 'NOT_READY', status: 'Battery low', reason: 'Battery low', source: 'receiver' };

  return { label: 'READY', status: 'Ready', source: 'receiver' };
}

/**
 * How worried to be about a transmitter's battery. The percentage decides
 * when the transmitter reports one: Shure's bars don't line up with it. Bars
 * are the fallback for transmitters without a percentage (e.g. AA cells).
 */
export function batteryLevel(t: ChannelTelemetry, now: number, th: ReadinessThresholds): 'critical' | 'low' | 'ok' | undefined {
  const pct = freshValue(t.batteryPercent, now, th.batteryMaxAgeMs);
  if (pct !== undefined) return pct <= th.criticalPercent ? 'critical' : pct <= th.warningPercent ? 'low' : 'ok';
  const bars = freshValue(t.batteryBars, now, th.batteryMaxAgeMs);
  if (bars !== undefined) return bars <= th.criticalBars ? 'critical' : bars <= th.warningBars ? 'low' : 'ok';
  return undefined;
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
  if (muted === true) return { label: 'NOT_READY', status: 'RF muted', reason: 'IEM RF muted', source: 'receiver' };
  if (mw === 0) return { label: 'NOT_READY', status: 'RF off', reason: 'IEM RF off', source: 'receiver' };
  if (muted === undefined || mw === undefined) {
    return { label: 'STANDBY', status: 'State unknown', reason: 'IEM transmitter state unknown', source: 'receiver' };
  }

  if (input.storage) return fromCharger(input.storage, now, th, IEM_CHARGER_TEXT);
  return th.iemReadyWithoutCharger
    ? { label: 'READY', status: 'On air', reason: 'IEM on air; pack not monitored', source: 'receiver' }
    : { label: 'STANDBY', status: 'On air', reason: 'IEM on air; pack battery not monitored', source: 'receiver' };
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
 * Docked is STANDBY however full: the transmitter isn't on yet.
 */
function fromCharger(s: StorageInput, now: number, th: ReadinessThresholds, text: ChargerText): Readiness {
  if (!online(s.connection, now, th)) {
    return { label: 'STANDBY', status: 'Off', reason: text.offline, source: 'charger' };
  }
  // Charger values are reported on change only, so a live connection keeps them current.
  const bay = s.bay;
  if (!bay || bay.batteryPresent.state !== 'ok') {
    return { label: 'STANDBY', status: 'Off', reason: text.silent, source: 'charger' };
  }
  if (bay.error.state === 'ok' && bay.error.value !== null) {
    return { label: 'NOT_READY', status: 'Charger fault', reason: `Charger: ${bay.error.value}`, source: 'charger' };
  }
  if (!bay.batteryPresent.value) {
    return { label: 'STANDBY', status: 'Off', reason: text.empty, source: 'charger' };
  }
  const pct = bay.chargePercent.state === 'ok' ? bay.chargePercent.value : undefined;
  if (pct === undefined) {
    return { label: 'STANDBY', status: 'On charger', reason: 'On charger; charge level unknown', source: 'charger' };
  }
  if (s.storageMode) {
    return { label: 'STANDBY', status: 'Storage mode', reason: 'Charger is in storage mode', source: 'charger', chargePercent: pct };
  }
  if (pct >= th.chargerReadyPercent) {
    return { label: 'STANDBY', status: 'On charger', reason: `On charger, ${pct}%`, source: 'charger', chargePercent: pct };
  }
  const mins = bay.minutesToFull.state === 'ok' ? `, full in ${bay.minutesToFull.value} min` : '';
  return { label: 'STANDBY', status: 'Charging', reason: `Charging, ${pct}%${mins}`, source: 'charger', chargePercent: pct };
}

/**
 * Whether a transmitter is on air. Shure has no single flag for this; the
 * transmitter-sourced fields flip between values and sentinels as it comes
 * and goes. Must be validated per family against hardware.
 *
 * Axient link quality is metered, so it shows a transmitter switching on
 * within one sample (an AD2 read 000 right away, 255 while off), about 1.5 s
 * before the model and battery reports arrive.
 */
export function txPresent(t: ChannelTelemetry): boolean {
  return t.batteryBars.state === 'ok' || t.txOffsetDb.state === 'ok' || t.txModel.state === 'ok' || t.linkQuality.state === 'ok';
}
