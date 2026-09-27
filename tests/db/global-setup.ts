import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { databaseUrl, dropDatabase, migrateDatabase, quoteIdentifier, withAdminClient } from './support/postgres';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

/**
 * Builds one migrated template database from empty. Each test file clones it so
 * files stay isolated without migrating again.
 */
export default async function setup(project: TestProject) {
  const template = `fern_test_template_${randomBytes(6).toString('hex')}`;
  await withAdminClient((client) => client.query(`create database ${quoteIdentifier(template)}`));

  const pool = new pg.Pool({ connectionString: databaseUrl(template), max: 1 });
  try {
    await migrateDatabase(pool);
  } catch (error) {
    await pool.end();
    await dropDatabase(template);
    throw error;
  }
  await pool.end();

  project.provide('templateDatabase', template);
  return () => dropDatabase(template);
}
