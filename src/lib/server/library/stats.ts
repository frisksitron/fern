import { Effect } from 'effect';

/** Statements run and rows read by a loader, for measuring how much of the library it touches. */
export type QueryStats = { queries: number; rows: number };

/** Runs a query and adds its rows to `stats`. */
export function countRows<Row, E, R>(stats: QueryStats, query: Effect.Effect<Row[], E, R>): Effect.Effect<Row[], E, R> {
  return Effect.tap(query, (rows) =>
    Effect.sync(() => {
      stats.queries++;
      stats.rows += rows.length;
    }),
  );
}
