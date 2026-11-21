import { createDb, createPool, migrateDatabase } from '@iv2/db';
import { eq } from 'drizzle-orm';
import { iamUsers } from '../modules/iam/db/index.js';
import { createAuth } from '../modules/iam/public/index.js';

const email = process.env.SEED_USER_EMAIL ?? 'admin@inventory.local';
const password = process.env.SEED_USER_PASSWORD ?? 'password1234';
const name = process.env.SEED_USER_NAME ?? 'Local Admin';

const pool = createPool();

try {
  await migrateDatabase(pool);
  const db = createDb(pool);
  const [existing] = await db
    .select({ id: iamUsers.id })
    .from(iamUsers)
    .where(eq(iamUsers.email, email))
    .limit(1);

  if (existing) {
    console.log(`Dev user already exists: ${email}`);
  } else {
    const auth = createAuth(db);
    await auth.api.signUpEmail({
      body: { email, password, name },
    });
    console.log(`Created dev user: ${email}`);
  }
} finally {
  await pool.end();
}
