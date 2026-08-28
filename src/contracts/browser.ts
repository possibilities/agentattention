import type { JsonValue } from "../domain.ts";
import { badRequest } from "../errors.ts";
import {
  contractRecord,
  contractString,
  optionalContractString,
  rejectContractFields,
} from "./shared.ts";

export const BROWSER_INTERACTION_CONTRACT = "dev.agentattention/browser-interaction/v1";

export interface BrowserInteractionPayload {
  targetName: string;
  requestedAction: string;
}

export interface BrowserInteractionResolution {
  outcome: "completed";
  note?: string;
}

export function parseBrowserInteractionPayload(value: unknown): BrowserInteractionPayload {
  const payload = contractRecord(value, BROWSER_INTERACTION_CONTRACT);
  rejectContractFields(payload, ["targetName", "requestedAction"], BROWSER_INTERACTION_CONTRACT);
  const targetName = contractString(
    payload.targetName,
    `${BROWSER_INTERACTION_CONTRACT}.targetName`,
    32,
  );
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(targetName)) {
    throw badRequest(
      "invalid_contract_payload",
      `${BROWSER_INTERACTION_CONTRACT}.targetName is not an Agentbrowse Browser target name`,
    );
  }
  return {
    targetName,
    requestedAction: contractString(
      payload.requestedAction,
      `${BROWSER_INTERACTION_CONTRACT}.requestedAction`,
      4_000,
    ),
  };
}

export function browserInteractionResolution(
  note?: string | null,
): BrowserInteractionResolution & JsonValue {
  const normalized = optionalContractString(note, "note", 20_000);
  return {
    outcome: "completed",
    ...(normalized === null ? {} : { note: normalized }),
  } as BrowserInteractionResolution & JsonValue;
}
