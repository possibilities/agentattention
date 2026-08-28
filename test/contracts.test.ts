import { describe, expect, test } from "bun:test";
import {
  browserInteractionResolution,
  documentApprovalResolution,
  parseBrowserInteractionPayload,
  parseDocumentApprovalPayload,
  parseQuestionPayload,
  questionResolution,
} from "../src/contracts/index.ts";
import { ServiceError } from "../src/errors.ts";

describe("first-party contracts", () => {
  test("supports several free-text and single-choice questions", () => {
    const payload = parseQuestionPayload({
      questions: [
        { id: "name", prompt: "What name should be used?" },
        {
          id: "lane",
          prompt: "Which lane?",
          choices: [
            { value: "fast", label: "Fast" },
            { value: "careful", label: "Careful" },
          ],
        },
      ],
    });
    expect(payload.questions[0]?.choices).toBeNull();
    expect(
      questionResolution(
        payload,
        new Map([
          ["name", "Orbiter"],
          ["lane", "careful"],
        ]),
      ),
    ).toEqual({
      answers: [
        { questionId: "name", answer: "Orbiter" },
        { questionId: "lane", answer: "careful" },
      ],
    });
  });

  test("requires comments for requested document changes", () => {
    expect(
      parseDocumentApprovalPayload({ format: "markdown", document: "# Plan\n\nShip it." }),
    ).toEqual({ format: "markdown", document: "# Plan\n\nShip it." });
    expect(documentApprovalResolution("approved")).toEqual({ decision: "approved" });
    expectServiceError(() => documentApprovalResolution("changes_requested"), "comment_required");
  });

  test("uses an opaque Agentbrowse target name without browser secrets", () => {
    expect(
      parseBrowserInteractionPayload({
        targetName: "jobsearch",
        requestedAction: "Sign in to the employment site.",
      }),
    ).toEqual({
      targetName: "jobsearch",
      requestedAction: "Sign in to the employment site.",
    });
    expect(browserInteractionResolution("Signed in.")).toEqual({
      outcome: "completed",
      note: "Signed in.",
    });
  });

  test("rejects unknown first-party payload fields", () => {
    expectServiceError(
      () =>
        parseQuestionPayload({
          questions: [{ id: "one", prompt: "One?", surprise: true }],
        }),
      "invalid_contract_payload",
    );
  });
});

function expectServiceError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe(code);
  }
}
