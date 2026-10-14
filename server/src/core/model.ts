import { UNKNOWN, type Reading } from './reading.js';

export type Manufacturer = 'shure' | 'sennheiser';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface ConnectionStatus {
  state: ConnectionState;
  /** When `state` last changed (epoch ms). */
  since: number;
  /** Last time any message arrived from the device (epoch ms). */
  lastMessageAt?: number;
  lastError?: string;
}

/** Normalised live data for one receiver channel. Units are in the field names. */
export interface ChannelTelemetry {
  name: Reading<string>;
  frequencyKhz: Reading<number>;
  groupChannel: Reading<string>;

  txModel: Reading<string>;
  /** Hardware identity of the transmitter on air, where the family reports one. */
  txDeviceId: Reading<string>;
  txOffsetDb: Reading<number>;
  txMuted: Reading<boolean>;

  batteryBars: Reading<number>;
  batteryPercent: Reading<number>;
  batteryRuntimeMin: Reading<number>;
  batteryType: Reading<string>;

  /** RSSI per diversity antenna, A first. */
  rfDbm: Reading<number[]>;
  /** Front-panel antenna/squelch status as reported, e.g. "AX", "BB". */
  antennas: Reading<string>;
  audioRmsDbfs: Reading<number>;
  audioPeakDbfs: Reading<number>;
  /** Axient link quality, 0-5. */
  linkQuality: Reading<number>;

  rxMuted: Reading<boolean>;
  interference: Reading<boolean>;
  encryptionFault: Reading<boolean>;
  unregisteredTx: Reading<boolean>;
}

export type Metric = keyof ChannelTelemetry;

export function emptyTelemetry(): ChannelTelemetry {
  return {
    name: UNKNOWN,
    frequencyKhz: UNKNOWN,
    groupChannel: UNKNOWN,
    txModel: UNKNOWN,
    txDeviceId: UNKNOWN,
    txOffsetDb: UNKNOWN,
    txMuted: UNKNOWN,
    batteryBars: UNKNOWN,
    batteryPercent: UNKNOWN,
    batteryRuntimeMin: UNKNOWN,
    batteryType: UNKNOWN,
    rfDbm: UNKNOWN,
    antennas: UNKNOWN,
    audioRmsDbfs: UNKNOWN,
    audioPeakDbfs: UNKNOWN,
    linkQuality: UNKNOWN,
    rxMuted: UNKNOWN,
    interference: UNKNOWN,
    encryptionFault: UNKNOWN,
    unregisteredTx: UNKNOWN,
  };
}

/**
 * One charger bay. Networked docking chargers report the battery in a bay but
 * not which transmitter it belongs to; that link comes from the assignment.
 */
export interface BayTelemetry {
  batteryPresent: Reading<boolean>;
  chargePercent: Reading<number>;
  batteryBars: Reading<number>;
  healthPercent: Reading<number>;
  /** Minutes to the charge target; 0 once full. */
  minutesToFull: Reading<number>;
  full: Reading<boolean>;
  /** Charger-reported fault for this bay; `null` means no fault. */
  error: Reading<string | null>;
}

export function emptyBay(): BayTelemetry {
  return {
    batteryPresent: UNKNOWN,
    chargePercent: UNKNOWN,
    batteryBars: UNKNOWN,
    healthPercent: UNKNOWN,
    minutesToFull: UNKNOWN,
    full: UNKNOWN,
    error: UNKNOWN,
  };
}

export interface ChargerInfo {
  id: string;
  manufacturer: Manufacturer;
  host: string;
  model?: string;
  deviceId?: string;
  firmware?: string;
  /** Storage mode charges to a storage level, not full. */
  storageMode?: boolean;
}

export interface ReceiverInfo {
  id: string;
  manufacturer: Manufacturer;
  family: string;
  host: string;
  model?: string;
  deviceId?: string;
  firmware?: string;
  rfBand?: string;
  channelCount: number;
}
