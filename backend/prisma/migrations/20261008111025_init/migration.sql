-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "DestinationMethod" AS ENUM ('POST', 'PUT', 'PATCH');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RejectReason" AS ENUM ('MISSING_SIGNATURE', 'INVALID_SIGNATURE', 'RATE_LIMITED', 'BODY_TOO_LARGE');

-- CreateEnum
CREATE TYPE "ReplayError" AS ENUM ('REPLAY_TARGET_BLOCKED', 'REPLAY_TIMEOUT', 'REPLAY_UPSTREAM_ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ingestToken" TEXT NOT NULL,
    "hmacSecret" TEXT NOT NULL,
    "destinationMethod" "DestinationMethod" NOT NULL DEFAULT 'POST',
    "destinationUrl" TEXT NOT NULL,
    "destinationHeaders" JSONB,
    "signatureHeaderName" TEXT NOT NULL DEFAULT 'X-Hub-Signature-256',
    "revokedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookRecord" (
    "id" SERIAL NOT NULL,
    "subscriberId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "rawBody" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL,
    "rejectReason" "RejectReason",
    "eventType" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bodyBytes" INTEGER NOT NULL,
    "replayOfId" INTEGER,
    "replayTargetUrl" TEXT,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "replayError" "ReplayError",
    "replayedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "WebhookRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "id" SERIAL NOT NULL,
    "subscriberId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_ingestToken_key" ON "Subscriber"("ingestToken");

-- CreateIndex
CREATE INDEX "Subscriber_workspaceId_idx" ON "Subscriber"("workspaceId");

-- CreateIndex
CREATE INDEX "WebhookRecord_subscriberId_receivedAt_idx" ON "WebhookRecord"("subscriberId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookRecord_receivedAt_idx" ON "WebhookRecord"("receivedAt");

-- CreateIndex
CREATE INDEX "WebhookRecord_replayOfId_idx" ON "WebhookRecord"("replayOfId");

-- CreateIndex
CREATE INDEX "RateLimitWindow_subscriberId_occurredAt_idx" ON "RateLimitWindow"("subscriberId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRecord" ADD CONSTRAINT "WebhookRecord_replayOfId_fkey" FOREIGN KEY ("replayOfId") REFERENCES "WebhookRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRecord" ADD CONSTRAINT "WebhookRecord_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateLimitWindow" ADD CONSTRAINT "RateLimitWindow_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
