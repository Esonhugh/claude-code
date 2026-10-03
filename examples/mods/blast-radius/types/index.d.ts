export type BlastRiskKind = "remove" | "reset" | "clean" | "force-push" | "migrate";

export type BlastRisk = { kind: BlastRiskKind; label: string; targets: string[] };

export type BlastReport = { summary: string; lines: string[] };
