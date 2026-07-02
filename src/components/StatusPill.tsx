import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "bad" | "neutral" | "info";

export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}
