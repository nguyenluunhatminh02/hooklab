import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const NOT_A_MEMBER_MESSAGE = 'workspace not found';
const OWNER_ONLY_MESSAGE = 'owner role required';

/**
 * Single enforcement site for the 02 §3 membership matrix: every route that
 * scopes by workspace goes through assertMember/assertOwner, so owner/member/
 * non-member behaviour is decided (and tested) in exactly one place.
 */
@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read paths (view, create subscriber, update, replay).
   * Non-members get 404 — a 403 would confirm the workspace exists.
   */
  async assertMember(workspaceId: number, userId: number): Promise<Role> {
    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) {
      throw new NotFoundException({ message: NOT_A_MEMBER_MESSAGE });
    }
    return membership.role;
  }

  /**
   * Owner-only paths (rotate, revoke, delete subscriber, delete workspace).
   * Members are already known to the workspace, so they get 403, not 404.
   */
  async assertOwner(workspaceId: number, userId: number): Promise<void> {
    const role = await this.assertMember(workspaceId, userId);
    if (role !== Role.OWNER) {
      throw new ForbiddenException({ message: OWNER_ONLY_MESSAGE });
    }
  }
}
