import { AttentionClient } from "../client.ts";
import type { ClientConfig } from "../config.ts";
import {
  BROWSER_INTERACTION_CONTRACT,
  type BrowserInteractionPayload,
  DOCUMENT_APPROVAL_CONTRACT,
  type DocumentApprovalPayload,
  parseBrowserInteractionPayload,
  parseDocumentApprovalPayload,
  parseQuestionPayload,
  QUESTION_CONTRACT,
  type QuestionPayload,
} from "../contracts/index.ts";
import type { AttentionItem } from "../domain.ts";
import { conflict } from "../errors.ts";
import { runApprovalProcessor } from "./processors/approval.ts";
import { runQuestionProcessor } from "./processors/question.ts";
import type { ProcessorDecision } from "./processors/types.ts";

const CLAIM_SECONDS = 300;
const RENEW_EVERY_MS = 120_000;

export type ProcessorClient = Pick<
  AttentionClient,
  "getItem" | "claimItem" | "renewClaim" | "releaseClaim" | "resolveItem" | "returnItem"
>;

export interface ProcessorRunners {
  question(item: AttentionItem, payload: QuestionPayload): Promise<ProcessorDecision>;
  approval(item: AttentionItem, payload: DocumentApprovalPayload): Promise<ProcessorDecision>;
  browser(item: AttentionItem, payload: BrowserInteractionPayload): Promise<ProcessorDecision>;
}

const DEFAULT_PROCESSORS: ProcessorRunners = {
  question: runQuestionProcessor,
  approval: runApprovalProcessor,
  browser: async (item, payload) => {
    const { runBrowserProcessor } = await import("./processors/browser.ts");
    return await runBrowserProcessor(item, payload);
  },
};

export async function runAttentionProcessor(
  clientConfig: ClientConfig,
  itemId: string,
): Promise<void> {
  const client = new AttentionClient(clientConfig);
  await processAttentionItem(client, itemId);
}

export async function processAttentionItem(
  client: ProcessorClient,
  itemId: string,
  processors: ProcessorRunners = DEFAULT_PROCESSORS,
): Promise<void> {
  const initial = await client.getItem(itemId);
  if (initial.status !== "open") {
    throw conflict("item_not_open", `Cannot process an item in ${initial.status} state`);
  }

  let run: () => Promise<ProcessorDecision>;
  if (initial.contract === QUESTION_CONTRACT) {
    const payload = parseQuestionPayload(initial.payload);
    run = () => processors.question(initial, payload);
  } else if (initial.contract === DOCUMENT_APPROVAL_CONTRACT) {
    const payload = parseDocumentApprovalPayload(initial.payload);
    run = () => processors.approval(initial, payload);
  } else if (initial.contract === BROWSER_INTERACTION_CONTRACT) {
    const payload = parseBrowserInteractionPayload(initial.payload);
    run = () => processors.browser(initial, payload);
  } else {
    throw conflict(
      "unsupported_contract",
      `The first-party TUI does not process contract ${initial.contract}`,
    );
  }

  const claimed = await client.claimItem(itemId, CLAIM_SECONDS);
  const claimId = claimed.claim?.id;
  if (!claimId) throw conflict("claim_missing", "Claim response did not contain a claim");
  let terminal = false;
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing || terminal) return;
    renewing = true;
    void client
      .renewClaim(itemId, claimId, CLAIM_SECONDS)
      .catch(() => undefined)
      .finally(() => {
        renewing = false;
      });
  }, RENEW_EVERY_MS);
  renewal.unref();

  try {
    const decision = await run();
    await applyDecision(client, itemId, claimId, decision);
    terminal = decision.kind !== "back";
  } finally {
    clearInterval(renewal);
    if (!terminal) {
      await client.releaseClaim(itemId, claimId).catch(() => undefined);
    }
  }
}

async function applyDecision(
  client: ProcessorClient,
  itemId: string,
  claimId: string,
  decision: ProcessorDecision,
): Promise<void> {
  if (decision.kind === "resolve") {
    await client.resolveItem(itemId, decision.resolution, { claimId });
    return;
  }
  if (decision.kind === "return") {
    await client.returnItem(itemId, decision.reason, {
      claimId,
      comment: decision.comment,
    });
  }
}
