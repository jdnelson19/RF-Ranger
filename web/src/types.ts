// Wire types are defined once, on the server.
export type { Snapshot, SlotView, DeviceView } from '../../server/src/server/snapshot.js';
export type { Alert, Severity } from '../../server/src/core/alerts.js';
export type { Readiness, ReadinessLabel } from '../../server/src/core/readiness.js';
export type { BayTelemetry, ChannelTelemetry, ChargerInfo, ConnectionStatus, ReceiverInfo } from '../../server/src/core/model.js';
export type { Reading } from '../../server/src/core/reading.js';
export type { PcoStatus, ServiceType, UpcomingSummary } from '../../server/src/integrations/planning-center/types.js';
