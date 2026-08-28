import { describe, expect, test } from "bun:test";
import {
  QUESTION_CONTRACT,
  type QuestionPayload,
  questionResolution,
} from "../src/contracts/question.ts";
import type { AttentionItem, JsonValue } from "../src/domain.ts";
import {
  type ProcessorClient,
  type ProcessorRunners,
  processAttentionItem,
} from "../src/tui/processor.ts";
import type { ProcessorDecision } from "../src/tui/processors/types.ts";

describe("attention processor orchestration", () => {
  test("dispatches a validated first-party payload and resolves under its claim", async () => {
    const calls: string[] = [];
    const initial = questionItem();
    const client = processorClient(initial, calls);
    const runners = processorRunners(async (_item, payload) => {
      calls.push(`question:${payload.questions[0]?.prompt}`);
      return {
        kind: "resolve",
        resolution: questionResolution(payload, new Map([["answer", "yes"]])),
      };
    });

    await processAttentionItem(client, initial.id, runners);

    expect(calls).toEqual([
      "get",
      "claim",
      "question:Continue?",
      'resolve:claim_test:{"answers":[{"questionId":"answer","answer":"yes"}]}',
    ]);
  });

  test("releases its claim when the user goes back", async () => {
    const calls: string[] = [];
    const initial = questionItem();
    await processAttentionItem(
      processorClient(initial, calls),
      initial.id,
      processorRunners(async () => ({ kind: "back" })),
    );
    expect(calls).toEqual(["get", "claim", "release:claim_test"]);
  });

  test("releases its claim when a processor fails", async () => {
    const calls: string[] = [];
    const initial = questionItem();
    await expect(
      processAttentionItem(
        processorClient(initial, calls),
        initial.id,
        processorRunners(async () => {
          throw new Error("processor failed");
        }),
      ),
    ).rejects.toThrow("processor failed");
    expect(calls).toEqual(["get", "claim", "release:claim_test"]);
  });
});

test("browser processor and Agentbrowse share one OpenTUI runtime", async () => {
  const { LiveViewRenderable, loadOpenTuiCore } = await import("agentbrowse/opentui");
  const core = await loadOpenTuiCore();
  expect(Object.getPrototypeOf(LiveViewRenderable.prototype).constructor).toBe(
    core.ImageRenderable,
  );
});

function processorRunners(
  question: (item: AttentionItem, payload: QuestionPayload) => Promise<ProcessorDecision>,
): ProcessorRunners {
  return {
    question,
    approval: async () => ({ kind: "back" }),
    browser: async () => ({ kind: "back" }),
  };
}

function processorClient(initial: AttentionItem, calls: string[]): ProcessorClient {
  const claimed: AttentionItem = {
    ...initial,
    claim: {
      id: "claim_test",
      holder: "handler",
      claimedAt: "2026-08-28T12:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  return {
    getItem: async () => {
      calls.push("get");
      return initial;
    },
    claimItem: async () => {
      calls.push("claim");
      return claimed;
    },
    renewClaim: async () => claimed,
    releaseClaim: async (_id, claimId) => {
      calls.push(`release:${claimId}`);
      return { ...claimed, claim: null };
    },
    resolveItem: async (_id, resolution, options) => {
      calls.push(`resolve:${options?.claimId}:${JSON.stringify(resolution)}`);
      return terminalItem(claimed, "resolved", resolution);
    },
    returnItem: async (_id, reason, options) => {
      calls.push(`return:${options?.claimId}:${reason}`);
      return terminalItem(claimed, "returned", null);
    },
  };
}

function questionItem(): AttentionItem {
  return {
    id: "attn_question",
    contract: QUESTION_CONTRACT,
    title: "One question",
    context: "Choose whether the agent should continue.",
    payload: { questions: [{ id: "answer", prompt: "Continue?" }] },
    priority: 0,
    labels: {},
    correlationId: null,
    parentId: null,
    status: "open",
    claim: null,
    resolution: null,
    returnOutcome: null,
    cancellation: null,
    createdBy: "producer",
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    useBefore: null,
    revision: 1,
  };
}

function terminalItem(
  item: AttentionItem,
  status: "resolved" | "returned",
  resolution: JsonValue,
): AttentionItem {
  return {
    ...item,
    status,
    claim: null,
    resolution:
      status === "resolved"
        ? {
            payload: resolution,
            resolvedBy: "handler",
            resolvedAt: "2026-08-28T12:00:01.000Z",
          }
        : null,
    returnOutcome:
      status === "returned"
        ? {
            reason: "stale",
            comment: null,
            returnedBy: "handler",
            returnedAt: "2026-08-28T12:00:01.000Z",
          }
        : null,
  };
}
