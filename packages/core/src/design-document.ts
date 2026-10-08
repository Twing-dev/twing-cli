/** One human-readable document per group. Markdown sections are optional. */
export const DESIGN_DOCUMENT_SECTIONS = [
  "problemStatement", "solutionAbstract", "fullSolution",
  "implementationDetails", "risksAndLimitations", "validation",
] as const;

export type DesignDocumentSection = typeof DESIGN_DOCUMENT_SECTIONS[number];

export interface DesignDocumentContent {
  schemaVersion: 1;
  title: string;
  sections: Partial<Record<DesignDocumentSection, string>>;
}

export type DesignDocumentStatus = "missing" | "pending" | "running" | "ready" | "failed" | "unavailable";

export interface DesignDocumentResponse {
  groupId: string;
  revision: number;
  status: DesignDocumentStatus;
  stale: boolean;
  content?: DesignDocumentContent;
}
