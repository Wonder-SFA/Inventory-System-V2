import type { Database } from '@iv2/db';
import { eq } from 'drizzle-orm';
import { type AccessSwitchState, iamSystemSettings } from '../db/index.js';

const SETTINGS_SINGLETON_ID = 1;

export async function getAccessSwitch(db: Database): Promise<AccessSwitchState> {
  const [row] = await db
    .select({ accessSwitch: iamSystemSettings.accessSwitch })
    .from(iamSystemSettings)
    .where(eq(iamSystemSettings.id, SETTINGS_SINGLETON_ID))
    .limit(1);

  return row?.accessSwitch ?? 'ACTIVE';
}

export async function setAccessSwitch(
  db: Database,
  mode: AccessSwitchState,
): Promise<AccessSwitchState> {
  const now = new Date();
  await db
    .insert(iamSystemSettings)
    .values({
      id: SETTINGS_SINGLETON_ID,
      accessSwitch: mode,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: iamSystemSettings.id,
      set: {
        accessSwitch: mode,
        updatedAt: now,
      },
    });

  return mode;
}
