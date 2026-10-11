import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from './membership.service';

const WORKSPACE_ID = 7;
const USER_ID = 1;

/**
 * 02 §3 permission matrix — every workspace-scoped action the design defines,
 * mapped to the one of the two enforcement methods that owns it. The routes
 * for subscriber actions land in P2/P5, but they call these same methods,
 * so this table is the single test site for the whole matrix (02 §3).
 */
const MATRIX = [
  { action: 'view workspace/subscribers/records/stats', check: 'assertMember' },
  { action: 'create subscriber', check: 'assertMember' },
  { action: 'update subscriber', check: 'assertMember' },
  { action: 'replay record', check: 'assertMember' },
  { action: 'rotate subscriber secret', check: 'assertOwner' },
  { action: 'revoke subscriber', check: 'assertOwner' },
  { action: 'delete subscriber', check: 'assertOwner' },
  { action: 'delete workspace', check: 'assertOwner' },
] as const;

type Check = (typeof MATRIX)[number]['check'];

describe('MembershipService — 02 §3 matrix', () => {
  let service: MembershipService;
  const membershipFindUnique = jest.fn();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembershipService,
        { provide: PrismaService, useValue: { membership: { findUnique: membershipFindUnique } } },
      ],
    }).compile();

    service = module.get(MembershipService);
  });

  beforeEach(() => {
    membershipFindUnique.mockReset();
  });

  /** Contract status: 200 (allowed) or the exact refusal status. */
  async function statusOf(check: Check): Promise<HttpStatus> {
    try {
      if (check === 'assertMember') {
        await service.assertMember(WORKSPACE_ID, USER_ID);
      } else {
        await service.assertOwner(WORKSPACE_ID, USER_ID);
      }
      return HttpStatus.OK;
    } catch (error) {
      if (error instanceof HttpException) {
        return error.getStatus();
      }
      throw error;
    }
  }

  describe.each(MATRIX)('$action → $check', ({ check }) => {
    it('owner → 200', async () => {
      membershipFindUnique.mockResolvedValue({ role: Role.OWNER });

      expect(await statusOf(check)).toBe(HttpStatus.OK);
    });

    it(check === 'assertOwner' ? 'member → 403' : 'member → 200', async () => {
      membershipFindUnique.mockResolvedValue({ role: Role.MEMBER });

      const expected = check === 'assertOwner' ? HttpStatus.FORBIDDEN : HttpStatus.OK;
      expect(await statusOf(check)).toBe(expected);
    });

    it('non-member → 404 (existence never leaks)', async () => {
      membershipFindUnique.mockResolvedValue(null);

      expect(await statusOf(check)).toBe(HttpStatus.NOT_FOUND);
    });
  });

  it('assertMember looks up the workspace+user composite key and returns the role', async () => {
    membershipFindUnique.mockResolvedValue({ role: Role.OWNER });

    await expect(service.assertMember(WORKSPACE_ID, USER_ID)).resolves.toBe(Role.OWNER);
    expect(membershipFindUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: WORKSPACE_ID, userId: USER_ID } },
      select: { role: true },
    });
  });
});
