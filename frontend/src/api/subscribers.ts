import { apiRequest } from './httpClient';
import type {
  CreateSubscriberInput,
  CreatedSubscriber,
  RevokeResult,
  RotateResult,
  SubscriberDetail,
  SubscriberSummary,
  UpdateSubscriberInput,
} from './types';

export function listSubscribers(workspaceId: number): Promise<SubscriberSummary[]> {
  return apiRequest<SubscriberSummary[]>(`/workspaces/${workspaceId}/subscribers`);
}

export function createSubscriber(
  workspaceId: number,
  input: CreateSubscriberInput,
): Promise<CreatedSubscriber> {
  return apiRequest<CreatedSubscriber>(`/workspaces/${workspaceId}/subscribers`, {
    method: 'POST',
    body: input,
  });
}

export function fetchSubscriber(subscriberId: number): Promise<SubscriberDetail> {
  return apiRequest<SubscriberDetail>(`/subscribers/${subscriberId}`);
}

export function updateSubscriber(
  subscriberId: number,
  input: UpdateSubscriberInput,
): Promise<SubscriberDetail> {
  return apiRequest<SubscriberDetail>(`/subscribers/${subscriberId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function rotateSubscriber(subscriberId: number): Promise<RotateResult> {
  return apiRequest<RotateResult>(`/subscribers/${subscriberId}/rotate`, { method: 'POST' });
}

export function revokeSubscriber(subscriberId: number): Promise<RevokeResult> {
  return apiRequest<RevokeResult>(`/subscribers/${subscriberId}/revoke`, { method: 'POST' });
}

export function deleteSubscriber(subscriberId: number): Promise<void> {
  return apiRequest<void>(`/subscribers/${subscriberId}`, { method: 'DELETE' });
}
