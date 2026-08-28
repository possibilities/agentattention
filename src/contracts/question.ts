import type { JsonValue } from "../domain.ts";
import { badRequest } from "../errors.ts";
import {
  contractIdentifier,
  contractRecord,
  contractString,
  rejectContractFields,
} from "./shared.ts";

export const QUESTION_CONTRACT = "dev.agentattention/question/v1";

export interface QuestionChoice {
  value: string;
  label: string;
}

export interface QuestionField {
  id: string;
  prompt: string;
  choices: QuestionChoice[] | null;
}

export interface QuestionPayload {
  questions: QuestionField[];
}

export interface QuestionAnswer {
  questionId: string;
  answer: string;
}

export interface QuestionResolution {
  answers: QuestionAnswer[];
}

export function parseQuestionPayload(value: unknown): QuestionPayload {
  const payload = contractRecord(value, QUESTION_CONTRACT);
  rejectContractFields(payload, ["questions"], QUESTION_CONTRACT);
  if (
    !Array.isArray(payload.questions) ||
    payload.questions.length < 1 ||
    payload.questions.length > 20
  ) {
    throw badRequest(
      "invalid_contract_payload",
      `${QUESTION_CONTRACT}.questions must contain 1 to 20 questions`,
    );
  }
  const seen = new Set<string>();
  const questions = payload.questions.map((raw, index) => {
    const path = `${QUESTION_CONTRACT}.questions[${index}]`;
    const question = contractRecord(raw, path);
    rejectContractFields(question, ["id", "prompt", "choices"], path);
    const id = contractIdentifier(question.id, `${path}.id`);
    if (seen.has(id)) {
      throw badRequest("invalid_contract_payload", `${path}.id must be unique`);
    }
    seen.add(id);
    const prompt = contractString(question.prompt, `${path}.prompt`, 4_000);
    let choices: QuestionChoice[] | null = null;
    if (question.choices !== undefined && question.choices !== null) {
      if (
        !Array.isArray(question.choices) ||
        question.choices.length < 2 ||
        question.choices.length > 20
      ) {
        throw badRequest(
          "invalid_contract_payload",
          `${path}.choices must contain 2 to 20 choices`,
        );
      }
      const choiceValues = new Set<string>();
      choices = question.choices.map((rawChoice, choiceIndex) => {
        const choicePath = `${path}.choices[${choiceIndex}]`;
        const choice = contractRecord(rawChoice, choicePath);
        rejectContractFields(choice, ["value", "label"], choicePath);
        const value = contractString(choice.value, `${choicePath}.value`, 256);
        if (choiceValues.has(value)) {
          throw badRequest("invalid_contract_payload", `${choicePath}.value must be unique`);
        }
        choiceValues.add(value);
        return {
          value,
          label: contractString(choice.label, `${choicePath}.label`, 500),
        };
      });
    }
    return { id, prompt, choices };
  });
  return { questions };
}

export function questionResolution(
  payload: QuestionPayload,
  answers: ReadonlyMap<string, string>,
): QuestionResolution & JsonValue {
  const result = payload.questions.map((question) => {
    const answer = answers.get(question.id)?.trim() ?? "";
    if (answer.length === 0 || answer.length > 20_000) {
      throw badRequest(
        "invalid_question_answer",
        `Answer for ${question.id} must be 1 to 20000 characters`,
      );
    }
    if (question.choices && !question.choices.some((choice) => choice.value === answer)) {
      throw badRequest(
        "invalid_question_answer",
        `Answer for ${question.id} must name one of its choices`,
      );
    }
    return { questionId: question.id, answer };
  });
  return { answers: result } as QuestionResolution & JsonValue;
}
