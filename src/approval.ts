import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type ApprovalVerifier = (approvalId: string) => boolean;

/**
 * Verifies an approval_id against a SQLite database (read-only).
 * Supports both:
 * - operational state DB (`pending_confirmations` where confirmation_id=? AND status='COMMITTED')
 * - recommendation DB (`recommendation` where id=? AND status='approved')
 */
export function createSqliteApprovalVerifier(dbPath: string): ApprovalVerifier {
  return (approvalId: string): boolean => {
    const clean = approvalId.trim();
    if (!clean || !existsSync(dbPath)) return false;

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      const tables = new Set(
        (
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );

      if (tables.has("pending_confirmations")) {
        const row = db
          .prepare(
            `SELECT 1 AS ok FROM pending_confirmations WHERE confirmation_id = ? AND status = 'COMMITTED' LIMIT 1`,
          )
          .get(clean);
        if (row) return true;
      }

      if (tables.has("recommendation")) {
        const numId = Number.parseInt(clean.replace(/^rec_/i, ""), 10);
        if (Number.isInteger(numId) && numId > 0) {
          const row = db
            .prepare(`SELECT 1 AS ok FROM recommendation WHERE id = ? AND status = 'approved' LIMIT 1`)
            .get(numId);
          if (row) return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  };
}
