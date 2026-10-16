import { PromotionErrorCode, PromotionView } from "@copilot-agent/contracts";

/** The promotion columns a view needs, as stored or as `to_jsonb` returns them. */
export interface PromotionViewRow {
  id: string; source: string; reason: string; state: string; size: string;
  error_code: string | null; error_message: string | null;
  created_at: Date | string; committed_at: Date | string | null; failed_at: Date | string | null;
}

/**
 * View columns for a session row aliased `s`: its latest promotion (`promotion`, a JSON row) and when its current
 * segment started (`segment_started_at`, absent for the implicit first segment).
 */
export const PROMOTION_VIEW_COLUMNS = `(SELECT to_jsonb(p) FROM session_promotions p WHERE p.session_id=s.id ORDER BY p.created_at DESC LIMIT 1) AS promotion,
  (SELECT g.started_at FROM session_segments g WHERE g.session_id=s.id AND g.generation=s.placement_generation) AS segment_started_at`;

const iso = (value: Date | string | null): string | undefined => (value === null ? undefined : new Date(value).toISOString());

/** A promotion as callers see it. */
export function promotionView(row: PromotionViewRow): PromotionView {
  return PromotionView.parse({
    id: row.id, state: row.state, source: row.source, reason: row.reason, size: row.size, requestedAt: iso(row.created_at),
    ...(row.committed_at ? { committedAt: iso(row.committed_at) } : {}),
    ...(row.failed_at ? { failedAt: iso(row.failed_at) } : {}),
    ...(row.error_code ? { error: { code: PromotionErrorCode.parse(row.error_code), message: row.error_message ?? "" } } : {}),
  });
}

/** The promotion view of a `promotion` column selected with {@link PROMOTION_VIEW_COLUMNS}, if the session has one. */
export function promotionViewOf(value: unknown): PromotionView | undefined {
  return value && typeof value === "object" ? promotionView(value as PromotionViewRow) : undefined;
}
