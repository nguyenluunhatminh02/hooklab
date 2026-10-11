import { Prisma } from '../../generated/prisma/client';

/** Canonical "requests received" filter — the ONLY place this filter exists. */
export const RECEIVED_WHERE = {
  replayOfId: null,
} satisfies Prisma.WebhookRecordWhereInput;

export function receivedWhere(
  scope: Prisma.WebhookRecordWhereInput = {},
): Prisma.WebhookRecordWhereInput {
  return { ...scope, ...RECEIVED_WHERE };
}
