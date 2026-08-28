import { isFirstPartyContract } from "../contracts/index.ts";
import type { AttentionItem } from "../domain.ts";

export interface QueueItemView {
  id: string;
  title: string;
  detail: string;
  supported: boolean;
}

export function queueItemView(item: AttentionItem, width: number): QueueItemView {
  const supported = isFirstPartyContract(item.contract);
  const facts = [
    shortContract(item.contract),
    `priority ${item.priority}`,
    item.claim ? `claimed by ${item.claim.holder}` : "unclaimed",
    ...(item.useBefore ? [`use before ${item.useBefore}`] : []),
    ...(supported ? [] : ["unsupported"]),
  ];
  return {
    id: item.id,
    title: truncate(item.title, Math.max(1, width - 4)),
    detail: truncate(facts.join(" · "), Math.max(1, width - 4)),
    supported,
  };
}

export function shortContract(contract: string): string {
  const slash = contract.lastIndexOf("/");
  const version = slash >= 0 ? contract.slice(slash + 1) : "";
  const base = slash >= 0 ? contract.slice(0, slash) : contract;
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf(".")) + 1);
  return version ? `${name}/${version}` : name;
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}
