/** Signal Room tokens are a fleet design contract, not a shared runtime package. */
export const SIGNAL_ROOM = {
  canvas: "#090c0e",
  field: "#0d1215",
  panel: "#131a1e",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  local: "#e2b56f",
  remote: "#7fb9e8",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const;

export const SIGNAL_GLYPHS = {
  rail: "▎",
  live: "●",
  idle: "○",
  rule: "─",
  ellipsis: "…",
} as const;
