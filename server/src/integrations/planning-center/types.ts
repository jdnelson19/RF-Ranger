/**
 * Planning Center shapes shared with the web UI. No Node imports here: the
 * browser build type-checks this file.
 */

export interface ServiceType {
  id: string;
  name: string;
}

export interface Organization {
  id: string;
  name: string;
  /** IANA zone, e.g. "America/Chicago": plan times display in the church's zone. */
  timeZone?: string;
}

export interface PcoStatus {
  /** Credentials exist (saved on this computer, or from the environment). */
  configured: boolean;
  /** Where they came from; environment credentials can't be changed from the app. */
  source?: 'saved' | 'environment';
  /** Last 4 characters of the Application ID, to tell tokens apart. */
  tokenHint?: string;
  /** Planning Center accepted the credentials at the last check. */
  connected: boolean;
  organization?: Organization;
  serviceType?: { id: string; name?: string };
  /** Why the last check failed, in words for the person at the screen. */
  error?: string;
  checkedAt?: number;
}

export interface UpcomingSummary {
  serviceType: ServiceType;
  plan?: {
    id: string;
    title?: string;
    seriesTitle?: string;
    dates: string;
    serviceTimes: string[];
    /** After this, RF Ranger moves on to the following plan. */
    endsAt?: string;
  };
  scheduled: number;
  declined: number;
  unconfirmed: number;
}
