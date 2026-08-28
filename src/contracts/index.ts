import type { JsonValue } from "../domain.ts";
import {
  DOCUMENT_APPROVAL_CONTRACT,
  type DocumentApprovalPayload,
  parseDocumentApprovalPayload,
} from "./approval.ts";
import {
  BROWSER_INTERACTION_CONTRACT,
  type BrowserInteractionPayload,
  parseBrowserInteractionPayload,
} from "./browser.ts";
import { parseQuestionPayload, QUESTION_CONTRACT, type QuestionPayload } from "./question.ts";

export * from "./approval.ts";
export * from "./browser.ts";
export * from "./question.ts";

export type FirstPartyContract =
  | typeof QUESTION_CONTRACT
  | typeof DOCUMENT_APPROVAL_CONTRACT
  | typeof BROWSER_INTERACTION_CONTRACT;

export type FirstPartyPayload =
  | QuestionPayload
  | DocumentApprovalPayload
  | BrowserInteractionPayload;

export function isFirstPartyContract(contract: string): contract is FirstPartyContract {
  return (
    contract === QUESTION_CONTRACT ||
    contract === DOCUMENT_APPROVAL_CONTRACT ||
    contract === BROWSER_INTERACTION_CONTRACT
  );
}

export function parseFirstPartyPayload(
  contract: FirstPartyContract,
  payload: JsonValue,
): FirstPartyPayload {
  if (contract === QUESTION_CONTRACT) return parseQuestionPayload(payload);
  if (contract === DOCUMENT_APPROVAL_CONTRACT) return parseDocumentApprovalPayload(payload);
  return parseBrowserInteractionPayload(payload);
}
