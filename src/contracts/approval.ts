import type { JsonValue } from "../domain.ts";
import { badRequest } from "../errors.ts";
import {
  contractRecord,
  contractString,
  optionalContractString,
  rejectContractFields,
} from "./shared.ts";

export const DOCUMENT_APPROVAL_CONTRACT = "dev.agentattention/document-approval/v1";

export interface DocumentApprovalPayload {
  format: "markdown" | "plain";
  document: string;
}

export interface DocumentApprovalResolution {
  decision: "approved" | "changes_requested";
  comment?: string;
}

export function parseDocumentApprovalPayload(value: unknown): DocumentApprovalPayload {
  const payload = contractRecord(value, DOCUMENT_APPROVAL_CONTRACT);
  rejectContractFields(payload, ["format", "document"], DOCUMENT_APPROVAL_CONTRACT);
  if (payload.format !== "markdown" && payload.format !== "plain") {
    throw badRequest(
      "invalid_contract_payload",
      `${DOCUMENT_APPROVAL_CONTRACT}.format must be markdown or plain`,
    );
  }
  return {
    format: payload.format,
    document: contractString(payload.document, `${DOCUMENT_APPROVAL_CONTRACT}.document`, 750_000),
  };
}

export function documentApprovalResolution(
  decision: "approved" | "changes_requested",
  comment?: string | null,
): DocumentApprovalResolution & JsonValue {
  const normalized = optionalContractString(comment, "comment", 20_000);
  if (decision === "changes_requested" && normalized === null) {
    throw badRequest("comment_required", "A comment is required when requesting document changes");
  }
  return {
    decision,
    ...(normalized === null ? {} : { comment: normalized }),
  } as DocumentApprovalResolution & JsonValue;
}
