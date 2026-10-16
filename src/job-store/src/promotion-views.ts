import { PromotionErrorCode, PromotionView, SharedHarnessRef } from "@copilot-agent/contracts";

/** The promotion columns a view needs, as stored or as `to_jsonb` returns them. */
export interface PromotionViewRow {
  id: string; source: string; reason: string; state: string; size: string;
  error_code: string | null; error_message: string | null;
  created_at: Date | string; committed_at: Date | string | null; failed_at: Date | string | null;
}

/**
 * View columns for a session row aliased `s`: its latest promotion (`promotion`, a JSON row; handoffs are reported by
 * their own ledger) and its current segment as recorded (`segment`, absent for the implicit first segment).
 */
export const PROMOTION_VIEW_COLUMNS = `(SELECT to_jsonb(p) FROM session_promotions p WHERE p.session_id=s.id AND p.kind='promotion' ORDER BY p.created_at DESC LIMIT 1) AS promotion,
  (SELECT jsonb_build_object('started_at',g.started_at,'ahp_session_id',g.ahp_session_id,'harness',g.harness) FROM session_segments g
     WHERE g.session_id=s.id AND g.generation<=s.placement_generation ORDER BY g.generation DESC LIMIT 1) AS segment`;

/** The current segment selected with {@link PROMOTION_VIEW_COLUMNS}: its start, runtime session, and harness reference. */
export function segmentOf(value: unknown): { startedAt: string; ahpSessionId: string; harness?: SharedHarnessRef } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { started_at: string; ahp_session_id: string; harness: unknown };
  return {
    startedAt: new Date(row.started_at).toISOString(), ahpSessionId: row.ahp_session_id,
    ...(row.harness ? { harness: SharedHarnessRef.parse(row.harness) } : {}),
  };
}

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
