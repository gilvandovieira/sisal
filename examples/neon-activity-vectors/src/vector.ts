/**
 * The activity-vector model: a deterministic, ordered numeric projection of a
 * post's consolidated stats. Pure and database-free, so it is unit-testable.
 *
 * This is **SQL feature vectorization**, not an AI embedding and not pgvector:
 * every dimension is a known product statistic with an obvious meaning, the
 * order is fixed, and the array is just an export/scoring/debug projection of the
 * named columns in `post_activity_stats` (the canonical storage). The same
 * projection exists in SQL as `app.post_activity_vector` — keep the two in sync.
 *
 * The order is versioned by {@link VECTOR_VERSION}; bump it if the order ever
 * changes (cosine over mismatched dimensions is meaningless).
 *
 * @module
 */

/** The vector schema version; only ever compare vectors of the same version. */
export const VECTOR_VERSION = "activity-v1";

/**
 * The ordered dimension names of an `activity-v1` vector. Index i here is index
 * i in {@link buildActivityVector} and in the SQL `app.post_activity_vector`.
 */
export const VECTOR_DIMENSIONS = [
  "votes_1h",
  "comments_1h",
  "reports_1h",
  "unique_actors_1h",
  "vote_ma_6h",
  "comment_ma_6h",
  "hot_score",
  "rising_score",
  "age_minutes",
] as const;

/** Number of dimensions in an `activity-v1` vector. */
export const VECTOR_LENGTH = VECTOR_DIMENSIONS.length;

/** The consolidated features one vector is projected from (the stats columns). */
export interface ActivityStatsFeatures {
  readonly votes_1h: number;
  readonly comments_1h: number;
  readonly reports_1h: number;
  readonly unique_actors_1h: number;
  readonly vote_ma_6h: number;
  readonly comment_ma_6h: number;
  readonly hot_score: number;
  readonly rising_score: number;
  readonly age_minutes: number;
}

/**
 * Projects consolidated stats into the ordered `activity-v1` vector. Values are
 * RAW (deterministic feature projection) — the canonical analytics shape. THE
 * ORDER HERE IS THE CONTRACT; it must match {@link VECTOR_DIMENSIONS} and the
 * SQL `app.post_activity_vector`.
 *
 * (Raw, un-standardized dimensions can dominate cosine — `age_minutes` and the
 * scores have a much larger range than per-hour counts; the README discusses
 * this. A future `activity-v2` could standardize them — hence the version.)
 */
export function buildActivityVector(s: ActivityStatsFeatures): number[] {
  return [
    s.votes_1h,
    s.comments_1h,
    s.reports_1h,
    s.unique_actors_1h,
    s.vote_ma_6h,
    s.comment_ma_6h,
    s.hot_score,
    s.rising_score,
    s.age_minutes,
  ];
}

function assertSameLength(a: readonly number[], b: readonly number[]): void {
  if (a.length !== b.length) {
    throw new Error(
      `vector length mismatch: ${a.length} vs ${b.length} (compare only ` +
        `vectors of the same vector_version)`,
    );
  }
}

/**
 * Cosine similarity in [-1, 1] — the cosine of the angle between two vectors,
 * ignoring magnitude. Returns 0 when either vector is all zeros. Throws on a
 * length mismatch.
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  assertSameLength(a, b);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Euclidean (L2) distance — straight-line distance, magnitude included. 0 for
 * identical vectors. Throws on a length mismatch.
 */
export function l2Distance(a: readonly number[], b: readonly number[]): number {
  assertSameLength(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
