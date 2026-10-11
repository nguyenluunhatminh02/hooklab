// Minimal P0 seed: `prisma db seed` must be runnable. P1 adds real
// demo data (users/workspaces) once auth lands — keep this idempotent.
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 requires a driver adapter (BUILD_PLAN §2.2 / C11) — same wiring
// as PrismaService so the seed talks to the database instead of throwing.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main(): Promise<void> {
  const userCount = await prisma.user.count();
  console.log(`[seed] users already present: ${userCount} (nothing to seed at P0)`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
