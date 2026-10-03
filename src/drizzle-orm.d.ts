// drizzle-orm 1.0.0-rc.5's Effect types still import SqlError from its pre-4.0 path. Remove when Drizzle ships fixed types.
declare module 'effect/unstable/sql/SqlError' {
  export * from 'effect/sql/SqlError';
}
