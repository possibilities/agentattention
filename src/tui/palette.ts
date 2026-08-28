import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "./theme.ts";

type OpenTui = typeof import("@opentui/core");

export interface PaletteCommand {
  id: string;
  key: string;
  label: string;
  onRun(): void;
}

export interface PaletteState {
  commands: readonly PaletteCommand[];
  width: number;
  height: number;
}

export interface CommandPalette {
  root: InstanceType<OpenTui["BoxRenderable"]>;
  isOpen(): boolean;
  handleKey(key: {
    name: string;
    ctrl: boolean;
    meta?: boolean;
    sequence?: string;
    eventType?: string;
  }): boolean;
  update(state: PaletteState): void;
  close(): void;
}

export function paletteMatches(
  commands: readonly PaletteCommand[],
  filter: string,
): PaletteCommand[] {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return [...commands];
  return commands.filter((command) =>
    `${command.label} ${command.key}`.toLowerCase().includes(needle),
  );
}

const MAX_VISIBLE_ROWS = 10;

export function createCommandPalette(
  core: OpenTui,
  renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>,
  id: string,
  options: { onOpenChange?: (open: boolean) => void } = {},
): CommandPalette {
  let open = false;
  let filter = "";
  let selected = 0;
  let start = 0;
  let state: PaletteState = { commands: [], width: 80, height: 24 };
  let signature = "";

  const root = new core.BoxRenderable(renderer, {
    id,
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    visible: false,
    onMouseUp: (event) => {
      event.stopPropagation();
      close();
    },
  });
  const panel = new core.BoxRenderable(renderer, {
    id: `${id}-panel`,
    position: "absolute",
    flexDirection: "column",
    border: true,
    borderStyle: "single",
    borderColor: SIGNAL_ROOM.line,
    backgroundColor: SIGNAL_ROOM.panel,
    title: " COMMANDS ",
    titleColor: SIGNAL_ROOM.muted,
    titleAlignment: "left",
    paddingLeft: 2,
    paddingRight: 2,
    onMouseUp: (event) => event.stopPropagation(),
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      moveSelection(direction === "down" ? 1 : -1);
      event.preventDefault();
      event.stopPropagation();
    },
  });
  const filterText = new core.TextRenderable(renderer, {
    id: `${id}-filter`,
    content: "",
    height: 1,
    wrapMode: "none",
  });
  const rowsBox = new core.BoxRenderable(renderer, {
    id: `${id}-rows`,
    flexDirection: "column",
    marginTop: 1,
    backgroundColor: SIGNAL_ROOM.panel,
  });
  panel.add(filterText);
  panel.add(rowsBox);
  root.add(panel);

  const matches = (): PaletteCommand[] => paletteMatches(state.commands, filter);

  const moveSelection = (delta: number, wrap = false): void => {
    const count = matches().length;
    if (count === 0) return;
    const next = selected + delta;
    if (wrap && next < 0 && selected === 0) selected = count - 1;
    else if (wrap && next >= count && selected === count - 1) selected = 0;
    else selected = Math.min(count - 1, Math.max(0, next));
    layout();
    renderer.requestRender();
  };

  const run = (command: PaletteCommand): void => {
    close();
    command.onRun();
  };

  const openPalette = (): void => {
    open = true;
    filter = "";
    selected = 0;
    start = 0;
    root.visible = true;
    options.onOpenChange?.(true);
    layout();
    renderer.requestRender();
  };

  function close(): void {
    if (!open) return;
    open = false;
    root.visible = false;
    options.onOpenChange?.(false);
    renderer.requestRender();
  }

  function layout(): void {
    const visible = matches();
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    const width = Math.max(24, Math.min(48, state.width - 4));
    const rowCount = Math.min(
      Math.max(1, visible.length),
      Math.max(3, state.height - 8),
      MAX_VISIBLE_ROWS,
    );
    if (selected < start) start = selected;
    if (selected >= start + rowCount) start = selected - rowCount + 1;
    start = Math.max(0, Math.min(start, Math.max(0, visible.length - rowCount)));
    const height = rowCount + 4;
    panel.width = width;
    panel.height = height;
    panel.left = Math.max(0, Math.floor((state.width - width) / 2));
    panel.top = Math.max(0, Math.floor((state.height - height) / 3));

    const window = visible.slice(start, start + rowCount);
    const keyWidth = state.commands.reduce((max, command) => Math.max(max, command.key.length), 1);
    const nextSignature = JSON.stringify({
      filter,
      selected,
      start,
      width,
      window: window.map((command) => [command.id, command.key, command.label]),
    });
    if (signature === nextSignature) return;
    signature = nextSignature;

    filterText.content = new core.StyledText([
      core.bold(core.fg(SIGNAL_ROOM.accent)("> ")),
      filter.length > 0
        ? core.fg(SIGNAL_ROOM.text)(filter)
        : core.fg(SIGNAL_ROOM.muted)("type to filter"),
    ]);
    for (const child of rowsBox.getChildren()) {
      rowsBox.remove(child);
      child.destroyRecursively();
    }
    if (visible.length === 0) {
      rowsBox.add(
        new core.TextRenderable(renderer, {
          content: "no matching command",
          fg: SIGNAL_ROOM.muted,
          height: 1,
        }),
      );
      return;
    }
    window.forEach((command, index) => {
      const isSelected = start + index === selected;
      const row = new core.BoxRenderable(renderer, {
        id: `${id}-command-${command.id}`,
        height: 1,
        flexDirection: "row",
        backgroundColor: SIGNAL_ROOM.panel,
        onMouseUp: (event) => {
          event.stopPropagation();
          run(command);
        },
      });
      const key = `[${command.key}]`.padEnd(keyWidth + 2);
      row.add(
        new core.TextRenderable(renderer, {
          content: new core.StyledText([
            isSelected
              ? core.bold(core.fg(SIGNAL_ROOM.accent)(`${SIGNAL_GLYPHS.rail} `))
              : core.fg(SIGNAL_ROOM.panel)("  "),
            core.bold(core.fg(SIGNAL_ROOM.accent)(key)),
            core.fg(isSelected ? SIGNAL_ROOM.text : SIGNAL_ROOM.muted)(` ${command.label}`),
          ]),
        }),
      );
      rowsBox.add(row);
    });
  }

  return {
    root,
    isOpen: () => open,
    close,
    handleKey(key) {
      if (key.ctrl && key.name === "c") return false;
      if (key.eventType === "release") return open;
      if (!open) {
        if (key.ctrl && key.name === "k") {
          openPalette();
          return true;
        }
        return false;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "k")) {
        close();
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        const command = matches()[selected];
        if (command) run(command);
        return true;
      }
      if (key.name === "up") {
        moveSelection(-1, true);
        return true;
      }
      if (key.name === "down") {
        moveSelection(1, true);
        return true;
      }
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
        return true;
      }
      const sequence = key.sequence ?? "";
      if (!key.ctrl && key.meta !== true && sequence.length === 1 && sequence >= " ") {
        filter += sequence;
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
      }
      return true;
    },
    update(next) {
      state = next;
      if (open) layout();
    },
  };
}
