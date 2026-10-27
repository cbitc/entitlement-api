/**
 * Bootstraps (or revokes) administrator access for an existing account.
 *
 * There is no admin API that can create the first administrator, so this is
 * the only way in. It only flips `role`; the account itself must already exist
 * (sign in once with the email verification code).
 *
 *   node scripts/grant-admin.mjs someone@example.com
 *   node scripts/grant-admin.mjs someone@example.com --revoke
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const main = async () => {
  const [rawEmail, ...flags] = process.argv.slice(2);
  const email = rawEmail?.trim().toLowerCase();
  if (!email) {
    throw new Error('Usage: node scripts/grant-admin.mjs <email> [--revoke]');
  }

  const revoke = flags.includes('--revoke');
  const role = revoke ? 'CUSTOMER' : 'ADMIN';

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(
      `No account for ${email}. Sign in once (verification code) before promoting it.`,
    );
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role },
    select: { email: true, role: true, status: true },
  });

  console.log(`${updated.email} is now ${updated.role} (${updated.status})`);
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
