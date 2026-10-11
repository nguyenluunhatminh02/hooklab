/** Wire shapes — design 02 §2–§4. The server envelope is unwrapped in httpClient. */

export interface User {
  id: number;
  email: string;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: User;
}

export interface WorkspaceSummary {
  id: number;
  name: string;
  role: 'owner' | 'member';
  subscriberCount: number;
  receivedCount: number;
  createdAt: string;
}

export type DestinationMethod = 'POST' | 'PUT' | 'PATCH';

/**
 * Outbound credential as the API reads it back (02 §4): secrets are reduced to
 * a `…last4` hint and never serialize — `{ type: 'none' }` means no credential
 * (also what an absent column serializes to).
 */
export type DestinationAuthMasked =
  | { type: 'none' }
  | { type: 'bearer'; tokenHint: string }
  | { type: 'basic'; usernameHint: string }
  | { type: 'apiKey'; headerName: string; valueHint: string };

/** The credential shape the API accepts on create/update (never on read-back). */
export type DestinationAuthInput =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; headerName: string; value: string };

export interface Destination {
  method: DestinationMethod;
  url: string;
  headers: Record<string, string>;
  auth: DestinationAuthMasked;
}

/**
 * The destination block as it appears on record detail (02 §6): the wire shows
 * method/url/headers only — the outbound credential belongs to the subscriber
 * row, not to a captured record, so it must not be typed here.
 */
export type RecordDestination = Omit<Destination, 'auth'>;

export interface SubscriberSummary {
  id: number;
  workspaceId: number;
  name: string;
  status: 'active' | 'revoked';
  endpointUrl: string;
  ingestToken: string;
  destination: Destination;
  signatureHeader: string;
  receivedCount: number;
  verifiedCount: number;
  rejectedCount: number;
  createdAt: string;
  revokedAt: string | null;
}

export interface SubscriberDetail extends SubscriberSummary {
  /** Last 4 chars — the full secret is only ever returned by create/rotate. */
  secretHint: string;
}

/** Create response carries the full secret exactly once (02 §4). */
export interface CreatedSubscriber extends SubscriberDetail {
  secret: string;
}

export interface RotateResult {
  secret: string;
  secretHint: string;
  rotatedAt: string;
  note: string;
}

export interface RevokeResult {
  revokedAt: string;
  note: string;
}

export interface CreateSubscriberInput {
  name: string;
  destinationUrl: string;
  destinationMethod?: DestinationMethod;
  destinationHeaders?: Record<string, string>;
  destinationAuth?: DestinationAuthInput;
  signatureHeader?: string;
}

export type UpdateSubscriberInput = Partial<CreateSubscriberInput>;
