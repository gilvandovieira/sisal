/**
 * The hot-score model, in TypeScript.
 *
 * This mirrors the PostgreSQL `app.calculate_hot_score` function
 * (migrations/0002_hot_score_function.sql) exactly, against the same constants.
 * The database is the source of truth at runtime (the value is stored and
 * indexed); this copy exists so the model is unit-testable without a database
 * and so application code can preview a score.
 *
 * @module
 */

/** Epoch the age component is measured from: 2024-01-01T00:00:00Z. */
export const HOT_EPOCH_SECONDS = 1704067200;

/** Decay window in seconds (~12.5h); one window ~= one order of magnitude. */
export const HOT_DECAY_SECONDS = 45000;

/**
 * Computes a stable, Reddit-inspired hot score.
 *
 * `sign * log10(max(|score|, 1)) + (epochSeconds(createdAt) - EPOCH) / DECAY`.
 * It depends only on its inputs — never on the current time — so the result is
 * stable for a given post and only changes when the vote totals change.
 */
export function calculateHotScore(score: number, createdAt: Date): number {
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = Math.sign(score);
  const ageComponent = (createdAt.getTime() / 1000 - HOT_EPOCH_SECONDS) /
    HOT_DECAY_SECONDS;
  return sign * order + ageComponent;
}
