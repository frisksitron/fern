import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Maintenance connection used only to create and drop disposable test databases. */
export const adminDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://fern:fern@127.0.0.1:5432/fern';

export function databaseUrl(name: string, base = adminDatabaseUrl) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export function quoteIdentifier(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

export async function withAdminClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminDatabaseUrl });
  try {
    await client.connect();
  } catch (cause) {
    const target = new URL(adminDatabaseUrl);
    throw new Error(
      `PostgreSQL is not reachable at ${target.host}. Start it with ` +
        '`docker compose -f docker-compose.dev.yml up -d postgres --wait` or set TEST_DATABASE_URL.',
      { cause },
    );
  }
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(name: string) {
  await withAdminClient((client) => client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`));
}

/** Applies `migrations/` with Drizzle's migrator, failing on any migrator error. */
export async function migrateDatabase(pool: pg.Pool) {
  const result = await migrate(drizzle({ client: pool }), { migrationsFolder: 'migrations' });
  if (result) throw new Error(`Migrations could not start: ${JSON.stringify(result)}`);
}
