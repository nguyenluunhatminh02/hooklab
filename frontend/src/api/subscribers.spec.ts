import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './httpClient';
import {
  createSubscriber,
  deleteSubscriber,
  fetchSubscriber,
  listSubscribers,
  revokeSubscriber,
  rotateSubscriber,
  updateSubscriber,
} from './subscribers';
import type { CreateSubscriberInput, SubscriberDetail } from './types';

/**
 * Subscriber wrappers (02 §4) — asserted at the apiRequest boundary so the
 * exact method/path/body of each call is pinned without a network stub.
 */

vi.mock('./httpClient', () => ({ apiRequest: vi.fn() }));

const apiRequestMock = vi.mocked(apiRequest);

const subscriberDetail: SubscriberDetail = {
  id: 3,
  workspaceId: 1,
  name: 'payments',
  status: 'active',
  endpointUrl: 'https://example.com/webhook/abc',
  ingestToken: 'pay_7d3d8128d6a8',
  destination: { method: 'POST', url: 'https://example.com/webhook/abc', headers: {}, auth: { type: 'none' } },
  signatureHeader: 'x-hooklab-signature',
  receivedCount: 2,
  verifiedCount: 1,
  rejectedCount: 1,
  createdAt: '2026-10-08T00:00:00.000Z',
  revokedAt: null,
  secretHint: '...abc',
};

const createInput: CreateSubscriberInput = {
  name: 'payments',
  destinationUrl: 'https://example.com/webhook/abc',
};

describe('subscribers api', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it('listSubscribers GETs the workspace-scoped collection', async () => {
    apiRequestMock.mockResolvedValue([]);

    await expect(listSubscribers(7)).resolves.toEqual([]);

    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/workspaces/7/subscribers');
  });

  it('createSubscriber POSTs the input to the collection route', async () => {
    apiRequestMock.mockResolvedValue({ ...subscriberDetail, secret: 'raw-secret' });

    await createSubscriber(7, createInput);

    expect(apiRequestMock).toHaveBeenCalledWith('/workspaces/7/subscribers', {
      method: 'POST',
      body: createInput,
    });
  });

  it('fetchSubscriber GETs the subscriber by id', async () => {
    apiRequestMock.mockResolvedValue(subscriberDetail);

    await expect(fetchSubscriber(3)).resolves.toEqual(subscriberDetail);

    expect(apiRequestMock).toHaveBeenCalledWith('/subscribers/3');
  });

  it('updateSubscriber PATCHes the partial input', async () => {
    const patch = { destinationMethod: 'PUT' as const };
    apiRequestMock.mockResolvedValue(subscriberDetail);

    await updateSubscriber(3, patch);

    expect(apiRequestMock).toHaveBeenCalledWith('/subscribers/3', {
      method: 'PATCH',
      body: patch,
    });
  });

  it('rotateSubscriber POSTs a body-less rotate call', async () => {
    apiRequestMock.mockResolvedValue({
      secret: 'raw-secret',
      secretHint: '...abc',
      rotatedAt: '2026-10-08T00:00:00.000Z',
      note: 'store the secret now',
    });

    await rotateSubscriber(3);

    expect(apiRequestMock).toHaveBeenCalledWith('/subscribers/3/rotate', { method: 'POST' });
  });

  it('revokeSubscriber POSTs a body-less revoke call', async () => {
    apiRequestMock.mockResolvedValue({
      revokedAt: '2026-10-08T00:00:00.000Z',
      note: 'revoked',
    });

    await revokeSubscriber(3);

    expect(apiRequestMock).toHaveBeenCalledWith('/subscribers/3/revoke', { method: 'POST' });
  });

  it('deleteSubscriber DELETEs the subscriber and resolves void', async () => {
    apiRequestMock.mockResolvedValue(undefined);

    await expect(deleteSubscriber(3)).resolves.toBeUndefined();

    expect(apiRequestMock).toHaveBeenCalledWith('/subscribers/3', { method: 'DELETE' });
  });
});
