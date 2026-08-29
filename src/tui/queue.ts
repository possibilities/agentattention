import { resolve } from "node:path";
import type { TerminalCapabilities } from "@opentui/core";
import { AttentionClient } from "../client.ts";
import type { ClientConfig } from "../config.ts";
import { isFirstPartyContract } from "../contracts/index.ts";
import type { AttentionItem } from "../domain.ts";
import { createCommandPalette } from "./palette.ts";
import { queueItemView } from "./queue-model.ts";
import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "./theme.ts";

export interface QueueTuiOptions {
  clientConfigPath: string;
  serverConfigPath: string;
}

type ProcessorImageCapabilities = Pick<
  TerminalCapabilities,
  "image_protocol" | "kitty_graphics" | "multiplexer" | "sixel"
>;

export function resolveProcessorImageProtocol(
  explicitProtocol: string | undefined,
  capabilities: ProcessorImageCapabilities | null,
): string {
  if (explicitProtocol !== undefined) return explicitProtocol;

  const negotiatedProtocol = capabilities?.image_protocol ?? "auto";
  if (negotiatedProtocol !== "auto") return negotiatedProtocol;
  if (!capabilities || capabilities.multiplexer === "tmux") return "blocks";
  if (capabilities.kitty_graphics) return "kitty";
  if (capabilities.sixel) return "sixel";
  return "blocks";
}

export async function runQueueTui(
  clientConfig: ClientConfig,
  options: QueueTuiOptions,
): Promise<void> {
  const core = await import("@opentui/core");
  const client = new AttentionClient(clientConfig);
  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const root = new core.BoxRenderable(renderer, {
    id: "attention-queue-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "attention-queue-scroll",
    width: "100%",
    flexGrow: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
    viewportCulling: true,
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction === "up") move(-1);
      else if (direction === "down") move(1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    },
  });
  const body = new core.BoxRenderable(renderer, {
    id: "attention-queue-body",
    width: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  scroll.add(body);
  root.add(scroll);
  renderer.root.add(root);

  const palette = createCommandPalette(core, renderer, "attention-queue-palette");
  renderer.root.add(palette.root);
  try {
    scroll.verticalScrollBar.visible = false;
    scroll.horizontalScrollBar.visible = false;
  } catch {
    // Older compatible OpenTUI builds render correctly without scrollbar setters.
  }

  let items: AttentionItem[] = [];
  let selected = 0;
  let loading = true;
  let processing = false;
  let error: string | null = null;
  let closed = false;
  let refreshGeneration = 0;

  const selectedItem = (): AttentionItem | null => items[selected] ?? null;

  const move = (delta: number): void => {
    if (items.length === 0 || processing) return;
    selected = Math.max(0, Math.min(items.length - 1, selected + delta));
    paint();
  };

  const jump = (index: number): void => {
    if (items.length === 0 || processing) return;
    selected = Math.max(0, Math.min(items.length - 1, index));
    paint();
  };

  const processSelected = async (): Promise<void> => {
    const item = selectedItem();
    if (!item || processing || !isFirstPartyContract(item.contract)) return;
    const imageProtocol = resolveProcessorImageProtocol(
      process.env.OPENTUI_IMAGE_PROTOCOL,
      renderer.capabilities,
    );
    processing = true;
    paint();
    renderer.suspend();
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../cli.ts"),
          "--config",
          options.serverConfigPath,
          "--client-config",
          options.clientConfigPath,
          "process",
          item.id,
        ],
        {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: { ...process.env, OPENTUI_IMAGE_PROTOCOL: imageProtocol },
        },
      );
      await child.exited;
    } finally {
      renderer.resume();
      processing = false;
      await refresh();
    }
  };

  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration;
    loading = true;
    paint();
    try {
      const next: AttentionItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listItems({
          status: "open",
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        next.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (generation !== refreshGeneration || closed) return;
      const selectedId = selectedItem()?.id;
      items = next;
      selected = Math.max(
        0,
        selectedId
          ? items.findIndex((item) => item.id === selectedId)
          : Math.min(selected, items.length - 1),
      );
      error = null;
    } catch (caught) {
      if (generation !== refreshGeneration || closed) return;
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (generation === refreshGeneration && !closed) {
        loading = false;
        paint();
      }
    }
  };

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    renderer.destroy();
    done();
  };

  const commands = () => [
    {
      id: "process",
      key: "ENTER",
      label: "process selected item",
      onRun: () => void processSelected(),
    },
    { id: "refresh", key: "R", label: "refresh queue", onRun: () => void refresh() },
    { id: "up", key: "K", label: "select previous item", onRun: () => move(-1) },
    { id: "down", key: "J", label: "select next item", onRun: () => move(1) },
    { id: "top", key: "G", label: "select first item", onRun: () => jump(0) },
    {
      id: "bottom",
      key: "⇧G",
      label: "select last item",
      onRun: () => jump(items.length - 1),
    },
    { id: "quit", key: "Q", label: "quit", onRun: shutdown },
  ];

  const paint = (): void => {
    if (closed) return;
    const columns = renderer.width || process.stdout.columns || 80;
    const rows = renderer.height || process.stdout.rows || 24;
    palette.update({ width: columns, height: rows, commands: commands() });
    for (const child of body.getChildren()) {
      body.remove(child);
      child.destroyRecursively();
    }
    if (error) {
      body.add(
        new core.TextRenderable(renderer, {
          content: `${SIGNAL_GLYPHS.idle} FAILED · R REFRESH\n\n${error}`,
          fg: SIGNAL_ROOM.danger,
          wrapMode: "word",
        }),
      );
      renderer.requestRender();
      return;
    }
    if (items.length === 0) {
      body.add(
        new core.TextRenderable(renderer, {
          content: loading
            ? `${SIGNAL_GLYPHS.idle} REFRESHING`
            : `${SIGNAL_GLYPHS.idle} EMPTY\n\nwaiting for attention items`,
          fg: loading ? SIGNAL_ROOM.accent : SIGNAL_ROOM.muted,
        }),
      );
      renderer.requestRender();
      return;
    }
    body.add(
      new core.TextRenderable(renderer, {
        id: "attention-queue-signal",
        content: `${SIGNAL_GLYPHS.rail} OPEN · ${items.length}${processing ? " · PROCESSOR ACTIVE" : ""}`,
        fg: processing ? SIGNAL_ROOM.local : SIGNAL_ROOM.accent,
        height: 1,
        wrapMode: "none",
      }),
    );
    body.add(new core.TextRenderable(renderer, { content: "", height: 1 }));
    items.forEach((item, index) => {
      const view = queueItemView(item, Math.max(20, columns - 4));
      const active = index === selected;
      const row = new core.BoxRenderable(renderer, {
        id: `attention-queue-item-${item.id}`,
        width: "100%",
        flexDirection: "column",
        marginBottom: 1,
        backgroundColor: SIGNAL_ROOM.canvas,
        onMouseUp: (event) => {
          event.stopPropagation();
          selected = index;
          paint();
          void processSelected();
        },
      });
      row.add(
        new core.TextRenderable(renderer, {
          content: new core.StyledText([
            active
              ? core.bold(core.fg(SIGNAL_ROOM.accent)(`${SIGNAL_GLYPHS.rail} `))
              : core.fg(SIGNAL_ROOM.canvas)("  "),
            active
              ? core.bold(core.fg(SIGNAL_ROOM.text)(view.title))
              : core.fg(view.supported ? SIGNAL_ROOM.text : SIGNAL_ROOM.muted)(view.title),
          ]),
          height: 1,
          wrapMode: "none",
        }),
      );
      row.add(
        new core.TextRenderable(renderer, {
          content: `  ${view.detail}`,
          fg: view.supported ? SIGNAL_ROOM.muted : SIGNAL_ROOM.danger,
          height: 1,
          wrapMode: "none",
        }),
      );
      body.add(row);
    });
    renderer.requestRender();
  };

  let done!: () => void;
  const finished = new Promise<void>((resolveDone) => {
    done = resolveDone;
  });
  const interval = setInterval(() => {
    if (!processing) void refresh();
  }, 1_000);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);
  renderer.keyInput.on("keypress", (key) => {
    if (palette.handleKey(key)) {
      ownKey(key);
      return;
    }
    if (key.ctrl && key.name === "c") {
      ownKey(key);
      shutdown();
      return;
    }
    if (processing) return;
    if (key.name === "q") {
      ownKey(key);
      shutdown();
    } else if (key.name === "r") {
      ownKey(key);
      void refresh();
    } else if (key.name === "j" || key.name === "down") {
      ownKey(key);
      move(1);
    } else if (key.name === "k" || key.name === "up") {
      ownKey(key);
      move(-1);
    } else if (key.name === "g") {
      ownKey(key);
      jump(0);
    } else if (key.name === "G" || key.name === "end") {
      ownKey(key);
      jump(items.length - 1);
    } else if (key.name === "enter" || key.name === "return") {
      ownKey(key);
      void processSelected();
    }
  });

  paint();
  await refresh();
  await finished;
}

function ownKey(key: { preventDefault(): void; stopPropagation(): void }): void {
  key.preventDefault();
  key.stopPropagation();
}
