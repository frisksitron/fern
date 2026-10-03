import { asc, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { profiles } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import type { ProfileId } from '$lib/shared/contracts/ids';
import type { Profile } from '$lib/zero/schema';

/** Whether the profile still exists; a deleted profile's cookie must not open library pages. */
export const profileExists = Effect.fn('profileExists')((id: ProfileId) =>
  query((db) => db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).limit(1)).pipe(
    Effect.map((rows) => rows.length > 0),
  ),
);

/** Every profile as Zero synchronizes it, in the profile picker's order (oldest first). */
export const loadProfiles = Effect.fn('loadProfiles')(() =>
  query((db) => db.select().from(profiles).orderBy(asc(profiles.createdAt))).pipe(
    Effect.map((rows): Profile[] =>
      rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() })),
    ),
  ),
);

/** Every profile, by name. */
export const listProfiles = Effect.fn('listProfiles')(() =>
  query((db) => db.select({ id: profiles.id, name: profiles.name }).from(profiles).orderBy(asc(profiles.name))),
);
