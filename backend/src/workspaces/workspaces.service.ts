import { Injectable } from '@nestjs/common';
import { Role } from '../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import { receivedWhere } from '../common/prisma/record-count';
import { MembershipService } from '../common/membership/membership.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';

/** 02 §3 wire shape — what the badges need without a round trip. */
export interface WorkspaceSummary {
  id: number;
  name: string;
  role: 'owner' | 'member';
  subscriberCount: number;
  receivedCount: number;
  createdAt: string;
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  /**
   * Two queries for any number of workspaces: memberships, then one subscriber
   * fetch whose filtered `_count` runs the canonical receivedWhere filter —
   * no per-workspace loop (anti N+1, conventions §3).
   */
  async list(userId: number): Promise<WorkspaceSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: {
        workspace: { select: { id: true, name: true, createdAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (memberships.length === 0) {
      return [];
    }

    const workspaceIds = memberships.map((entry) => entry.workspaceId);
    const subscribers = await this.prisma.subscriber.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: {
        workspaceId: true,
        _count: { select: { records: { where: receivedWhere() } } },
      },
    });

    const countsByWorkspace = new Map<number, { subscriberCount: number; receivedCount: number }>();
    for (const subscriber of subscribers) {
      const current = countsByWorkspace.get(subscriber.workspaceId) ?? {
        subscriberCount: 0,
        receivedCount: 0,
      };
      current.subscriberCount += 1;
      current.receivedCount += subscriber._count.records;
      countsByWorkspace.set(subscriber.workspaceId, current);
    }

    return memberships.map((entry) => {
      const counts = countsByWorkspace.get(entry.workspaceId) ?? {
        subscriberCount: 0,
        receivedCount: 0,
      };
      return {
        id: entry.workspace.id,
        name: entry.workspace.name,
        role: toWireRole(entry.role),
        subscriberCount: counts.subscriberCount,
        receivedCount: counts.receivedCount,
        createdAt: entry.workspace.createdAt.toISOString(),
      };
    });
  }

  /**
   * Workspace row and the creator's owner membership land in one callback
   * transaction — a crash between the two must not leave an orphan workspace
   * nobody can delete (conventions §3).
   */
  async create(userId: number, dto: CreateWorkspaceDto): Promise<WorkspaceSummary> {
    const workspace = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: dto.name } });
      await tx.membership.create({
        data: { workspaceId: created.id, userId, role: Role.OWNER },
      });
      return created;
    });

    return {
      id: workspace.id,
      name: workspace.name,
      role: toWireRole(Role.OWNER),
      subscriberCount: 0,
      receivedCount: 0,
      createdAt: workspace.createdAt.toISOString(),
    };
  }

  /** 204 / 403 (member) / 404 (non-member or gone) — matrix via MembershipService. */
  async remove(workspaceId: number, userId: number): Promise<void> {
    await this.membership.assertOwner(workspaceId, userId);
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
  }
}

function toWireRole(role: Role): 'owner' | 'member' {
  return role === Role.OWNER ? 'owner' : 'member';
}
