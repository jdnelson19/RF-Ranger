/**
 * Every receiver family RF Ranger can monitor, across manufacturers, and
 * the one place that turns a family into a device object.
 */
import type { ReceiverDevice } from './device.js';
import { SennheiserReceiver } from './sennheiser/receiver.js';
import { SENNHEISER_FAMILIES, SENNHEISER_FAMILY_IDS, type SennheiserFamilyId } from './sennheiser/families.js';
import { SSC_PORT } from './sennheiser/ssc.js';
import { ShureReceiver } from './shure/receiver.js';
import { SHURE_FAMILIES, SHURE_FAMILY_IDS, type ShureFamilyId } from './shure/families.js';

export type DeviceFamilyId = ShureFamilyId | SennheiserFamilyId;
export const FAMILY_IDS: readonly DeviceFamilyId[] = [...SHURE_FAMILY_IDS, ...SENNHEISER_FAMILY_IDS];

export function isSennheiser(family: string): family is SennheiserFamilyId {
  return (SENNHEISER_FAMILY_IDS as string[]).includes(family);
}

export function familyLabel(family: DeviceFamilyId): string {
  return isSennheiser(family) ? SENNHEISER_FAMILIES[family].label : SHURE_FAMILIES[family].label;
}

export function defaultPort(family: DeviceFamilyId): number {
  return isSennheiser(family) ? SSC_PORT : SHURE_FAMILIES[family].defaultPort;
}

export interface ReceiverOptions {
  id: string;
  host: string;
  family: DeviceFamilyId;
  port?: number;
  channels?: number;
  meterRateMs?: number;
}

export function createReceiverDevice(o: ReceiverOptions): ReceiverDevice {
  return isSennheiser(o.family)
    ? new SennheiserReceiver({ ...o, family: o.family })
    : new ShureReceiver({ ...o, family: o.family });
}
