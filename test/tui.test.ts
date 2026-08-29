import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { AttentionItem } from "../src/domain.ts";
import { createCommandPalette, type PaletteCommand, paletteMatches } from "../src/tui/palette.ts";
import { createQueueEmptyState } from "../src/tui/queue.ts";
import { queueItemView } from "../src/tui/queue-model.ts";

const commands: PaletteCommand[] = [
  { id: "process", key: "ENTER", label: "process selected item", onRun: () => {} },
  { id: "refresh", key: "R", label: "refresh queue", onRun: () => {} },
  { id: "up", key: "K", label: "select previous item", onRun: () => {} },
  { id: "down", key: "J", label: "select next item", onRun: () => {} },
  { id: "quit", key: "Q", label: "quit", onRun: () => {} },
];

describe("queue presentation", () => {
  test("labels supported contracts and truncates every row at narrow widths", () => {
    const view = queueItemView(item(), 36);
    expect(view.supported).toBe(true);
    expect(view.title.length).toBeLessThanOrEqual(32);
    expect(view.detail.length).toBeLessThanOrEqual(32);
    expect(view.detail).toContain("question/v1");
  });

  test("keeps the command palette inside 40, 80, and 120-column frames", async () => {
    for (const frame of [
      { width: 40, height: 7 },
      { width: 80, height: 24 },
      { width: 120, height: 30 },
    ]) {
      const setup = await createTestRenderer(frame);
      const id = `attention-palette-${frame.width}`;
      const palette = createCommandPalette(core, setup.renderer, id);
      setup.renderer.root.add(palette.root);
      palette.update({ ...frame, commands });
      expect(palette.handleKey({ name: "k", ctrl: true, sequence: "k" })).toBe(true);
      await setup.flush();
      const panel = setup.renderer.root.findDescendantById(`${id}-panel`);
      expect(panel).toBeInstanceOf(core.BoxRenderable);
      expect(panel?.x).toBeGreaterThanOrEqual(0);
      expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(frame.width);
      expect(panel?.y).toBeGreaterThanOrEqual(0);
      expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual(frame.height);
      expect(setup.captureCharFrame()).toContain("COMMANDS");
      setup.renderer.destroy();
    }
  });

  test("filters commands by either human label or displayed key", () => {
    expect(paletteMatches(commands, "select").map((command) => command.id)).toEqual([
      "process",
      "up",
      "down",
    ]);
    expect(paletteMatches(commands, "enter").map((command) => command.id)).toEqual(["process"]);
  });

  test("centers a stable no-items state without refresh narration", async () => {
    for (const frame of [
      { width: 40, height: 7 },
      { width: 80, height: 24 },
      { width: 120, height: 30 },
    ]) {
      const setup = await createTestRenderer(frame);
      setup.renderer.root.add(createQueueEmptyState(core, setup.renderer));
      const emptyState = setup.renderer.root.findDescendantById("attention-queue-empty");
      expect(emptyState).toBeInstanceOf(core.BoxRenderable);
      if (emptyState) emptyState.visible = true;
      await setup.flush();

      const rendered = setup.captureCharFrame();
      const lines = rendered.split("\n");
      const row = lines.findIndex((line) => line.includes("NO ITEMS"));
      const column = row >= 0 ? (lines[row]?.indexOf("NO ITEMS") ?? -1) : -1;
      expect(row).toBeGreaterThanOrEqual(Math.floor(frame.height / 2) - 1);
      expect(row).toBeLessThanOrEqual(Math.ceil(frame.height / 2));
      expect(column).toBeGreaterThanOrEqual(Math.floor((frame.width - 8) / 2) - 1);
      expect(column).toBeLessThanOrEqual(Math.ceil((frame.width - 8) / 2));
      expect(rendered).not.toContain("REFRESHING");
      setup.renderer.destroy();
    }
  });
});

function item(): AttentionItem {
  return {
    id: "attn_queue",
    contract: "dev.agentattention/question/v1",
    title: "A deliberately long question title that must fit narrow terminals",
    context: "Context",
    payload: { questions: [{ id: "one", prompt: "Continue?" }] },
    priority: 10,
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
    useBefore: "2026-08-28T13:00:00.000Z",
    revision: 1,
  };
}
