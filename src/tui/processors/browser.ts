import {
  type BrowserTargetChoice,
  DEFAULT_BROWSER_DISCOVERY_TIMEOUT_MS,
  LiveViewRenderable,
  type LiveViewSurfaceState,
  listBrowserTargets,
  loadOpenTuiCore,
} from "agentbrowse/opentui";
import {
  type BrowserInteractionPayload,
  browserInteractionResolution,
} from "../../contracts/browser.ts";
import type { AttentionItem } from "../../domain.ts";
import { createCommandPalette } from "../palette.ts";
import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "../theme.ts";
import type { ProcessorDecision } from "./types.ts";

type BrowserProcessorMode = "context" | "browser";

const BROWSER_TEARDOWN_TIMEOUT_MS = 2_000;

/** Process one exact Browser target; attention items never open a target picker. */
export async function runBrowserProcessor(
  item: AttentionItem,
  payload: BrowserInteractionPayload,
): Promise<ProcessorDecision> {
  const core = await loadOpenTuiCore();
  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const root = new core.BoxRenderable(renderer, {
    id: "browser-processor-root",
    width: "100%",
    height: "100%",
    backgroundColor: SIGNAL_ROOM.canvas,
  });

  const contextScroll = new core.ScrollBoxRenderable(renderer, {
    id: "browser-processor-context-scroll",
    width: "100%",
    height: "100%",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
    viewportCulling: true,
  });
  const contextBody = new core.BoxRenderable(renderer, {
    id: "browser-processor-context",
    width: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  contextScroll.add(contextBody);
  root.add(contextScroll);

  const browserStage = new core.BoxRenderable(renderer, {
    id: "browser-processor-stage",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: SIGNAL_ROOM.canvas,
    visible: false,
  });
  let surfaceState: LiveViewSurfaceState = {
    phase: "empty",
    target: null,
    status: "No browser",
    error: null,
  };
  const liveView = new LiveViewRenderable(renderer, {
    id: "browser-processor-live-view",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    visible: false,
    pollFps: 15,
    onStateChange: (state) => {
      surfaceState = state;
      status.content = state.status;
      status.fg = state.error ? SIGNAL_ROOM.danger : SIGNAL_ROOM.muted;
      status.visible = liveView.submissionMetrics().submittedFrames === 0n || state.error !== null;
      if (state.phase === "connected" && mode === "browser") {
        liveView.requestControl();
        liveView.focus();
      }
      if (state.phase === "failed") {
        error = state.error ?? state.status;
      }
      paint();
    },
    onSubmission: () => {
      if (surfaceState.error === null) status.visible = false;
    },
  });
  const status = new core.TextRenderable(renderer, {
    id: "browser-processor-status",
    content: "Opening browser…",
    fg: SIGNAL_ROOM.muted,
    wrapMode: "word",
  });
  browserStage.add(liveView);
  browserStage.add(status);
  root.add(browserStage);
  renderer.root.add(root);

  let mode: BrowserProcessorMode = "context";
  let opening = false;
  let error: string | null = null;
  let closed = false;
  let discoveryController: AbortController | null = null;

  const palette = createCommandPalette(core, renderer, "browser-processor-palette", {
    onOpenChange: (open) => {
      if (mode !== "browser") return;
      if (open) {
        liveView.releaseHeldInput();
        liveView.blur();
      } else if (surfaceState.phase === "connected") {
        liveView.requestControl();
        liveView.focus();
      }
    },
  });
  renderer.root.add(palette.root);
  try {
    contextScroll.verticalScrollBar.visible = false;
    contextScroll.horizontalScrollBar.visible = false;
  } catch {
    // Compatible older OpenTUI builds need no explicit scrollbar changes.
  }

  let done!: (decision: ProcessorDecision) => void;
  const finished = new Promise<ProcessorDecision>((resolveDecision) => {
    done = resolveDecision;
  });

  const showContext = (): void => {
    if (closed) return;
    mode = "context";
    liveView.releaseHeldInput();
    liveView.blur();
    liveView.releaseControl();
    browserStage.visible = false;
    contextScroll.visible = true;
    paint();
  };

  const showBrowser = (): void => {
    if (closed) return;
    mode = "browser";
    contextScroll.visible = false;
    browserStage.visible = true;
    liveView.visible = true;
    status.visible =
      liveView.submissionMetrics().submittedFrames === 0n || surfaceState.error !== null;
    if (surfaceState.phase === "connected") {
      liveView.requestControl();
      liveView.focus();
    }
    paint();
  };

  const discoverExactTarget = async (): Promise<BrowserTargetChoice> => {
    discoveryController?.abort(new Error("Browser target discovery superseded"));
    const controller = new AbortController();
    discoveryController = controller;
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(
          `Browser target discovery timed out after ${DEFAULT_BROWSER_DISCOVERY_TIMEOUT_MS / 1_000} seconds`,
        ),
      );
    }, DEFAULT_BROWSER_DISCOVERY_TIMEOUT_MS);
    try {
      const targets = await abortable(
        listBrowserTargets(undefined, controller.signal),
        controller.signal,
      );
      const target = targets.find((candidate) => candidate.name === payload.targetName);
      if (!target) {
        throw new Error(`Browser target ${payload.targetName} is not running`);
      }
      if (!target.selectable) {
        throw new Error(
          `Browser target ${payload.targetName} is unavailable${target.disabledReason ? `: ${target.disabledReason}` : ""}`,
        );
      }
      return target;
    } finally {
      clearTimeout(timeout);
      if (discoveryController === controller) discoveryController = null;
    }
  };

  const openBrowser = async (): Promise<void> => {
    if (closed || opening) return;
    if (
      surfaceState.target?.name === payload.targetName &&
      surfaceState.phase !== "failed" &&
      surfaceState.phase !== "closed" &&
      surfaceState.phase !== "empty"
    ) {
      showBrowser();
      return;
    }
    opening = true;
    error = null;
    paint();
    try {
      const target = await discoverExactTarget();
      if (closed) return;
      showBrowser();
      status.content = `Connecting to ${target.name}`;
      status.fg = SIGNAL_ROOM.muted;
      status.visible = true;
      await liveView.connect(target);
    } catch (caught) {
      if (closed) return;
      error = caught instanceof Error ? caught.message : String(caught);
      showContext();
    } finally {
      opening = false;
      paint();
    }
  };

  const reconnect = async (): Promise<void> => {
    if (opening || closed) return;
    liveView.releaseHeldInput();
    liveView.releaseControl();
    await liveView.disconnect();
    await openBrowser();
  };

  const finish = async (decision: ProcessorDecision): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      process.off("SIGTERM", back);
      process.off("SIGHUP", back);
      renderer.keyInput.off("keypress", keypress);
      discoveryController?.abort(new Error("Browser processor closed"));
      discoveryController = null;
      try {
        liveView.releaseHeldInput();
        liveView.releaseControl();
      } catch {
        // Continue into bounded disposal even if native input release faults.
      }
      await settleWithin(
        Promise.resolve().then(() => liveView.dispose()),
        BROWSER_TEARDOWN_TIMEOUT_MS,
      );
    } finally {
      try {
        renderer.destroy();
      } catch {
        // The decision must still reach the processor orchestrator after teardown faults.
      }
      done(decision);
    }
  };

  const back = (): void => {
    void finish({ kind: "back" });
  };

  const scrollContext = (amount: number): void => {
    contextScroll.scrollBy({ x: 0, y: amount });
    renderer.requestRender();
  };

  const commands = () =>
    mode === "browser"
      ? [
          {
            id: "complete",
            key: "ENTER",
            label: "interaction complete",
            onRun: () =>
              void finish({ kind: "resolve", resolution: browserInteractionResolution() }),
          },
          { id: "context", key: "I", label: "show request context", onRun: showContext },
          { id: "reconnect", key: "R", label: "reconnect browser", onRun: () => void reconnect() },
          {
            id: "stale",
            key: "S",
            label: "return stale",
            onRun: () => void finish({ kind: "return", reason: "stale", comment: null }),
          },
          { id: "back", key: "Q", label: "back without resolving", onRun: back },
        ]
      : [
          {
            id: "open",
            key: "ENTER",
            label: opening ? "opening browser" : "open browser",
            onRun: () => void openBrowser(),
          },
          { id: "up", key: "K", label: "scroll context up", onRun: () => scrollContext(-2) },
          { id: "down", key: "J", label: "scroll context down", onRun: () => scrollContext(2) },
          {
            id: "stale",
            key: "S",
            label: "return stale",
            onRun: () => void finish({ kind: "return", reason: "stale", comment: null }),
          },
          { id: "back", key: "Q", label: "back without resolving", onRun: back },
        ];

  const paintContext = (): void => {
    for (const child of contextBody.getChildren()) {
      contextBody.remove(child);
      child.destroyRecursively();
    }
    contextBody.add(
      new core.TextRenderable(renderer, {
        content: `${SIGNAL_GLYPHS.rail} BROWSER INTERACTION`,
        fg: SIGNAL_ROOM.accent,
        height: 1,
        wrapMode: "none",
      }),
    );
    contextBody.add(
      new core.TextRenderable(renderer, {
        content: item.title,
        fg: SIGNAL_ROOM.text,
        attributes: core.TextAttributes.BOLD,
        marginTop: 1,
        wrapMode: "word",
      }),
    );
    if (item.context) {
      contextBody.add(
        new core.TextRenderable(renderer, {
          content: item.context,
          fg: SIGNAL_ROOM.muted,
          marginTop: 1,
          wrapMode: "word",
        }),
      );
    }
    contextBody.add(
      new core.TextRenderable(renderer, {
        content: payload.requestedAction,
        fg: SIGNAL_ROOM.text,
        marginTop: 1,
        wrapMode: "word",
      }),
    );
    contextBody.add(
      new core.TextRenderable(renderer, {
        content: `TARGET · ${payload.targetName}`,
        fg: SIGNAL_ROOM.remote,
        marginTop: 1,
        height: 1,
        wrapMode: "none",
      }),
    );
    if (error) {
      contextBody.add(
        new core.TextRenderable(renderer, {
          content: `${SIGNAL_GLYPHS.idle} ${error}`,
          fg: SIGNAL_ROOM.danger,
          marginTop: 1,
          wrapMode: "word",
        }),
      );
    }
    const openRow = new core.BoxRenderable(renderer, {
      id: "browser-processor-open",
      width: "100%",
      height: 1,
      marginTop: 2,
      backgroundColor: SIGNAL_ROOM.canvas,
      onMouseUp: (event) => {
        event.stopPropagation();
        void openBrowser();
      },
    });
    openRow.add(
      new core.TextRenderable(renderer, {
        content: `${SIGNAL_GLYPHS.rail} ${opening ? "OPENING TARGET…" : "OPEN TARGET"}`,
        fg: opening ? SIGNAL_ROOM.muted : SIGNAL_ROOM.local,
        attributes: core.TextAttributes.BOLD,
        height: 1,
      }),
    );
    contextBody.add(openRow);
  };

  function paint(): void {
    if (closed) return;
    palette.update({
      width: renderer.width || process.stdout.columns || 80,
      height: renderer.height || process.stdout.rows || 24,
      commands: commands(),
    });
    if (mode === "context") paintContext();
    renderer.requestRender();
  }

  const keypress = (key: import("@opentui/core").KeyEvent): void => {
    if (palette.handleKey(key)) {
      ownKey(key);
      return;
    }
    if (key.ctrl && key.name === "c") {
      ownKey(key);
      back();
      return;
    }
    if (mode !== "context") return;
    if (key.name === "enter" || key.name === "return") {
      ownKey(key);
      void openBrowser();
    } else if (key.name === "j" || key.name === "down") {
      ownKey(key);
      scrollContext(2);
    } else if (key.name === "k" || key.name === "up") {
      ownKey(key);
      scrollContext(-2);
    } else if (key.name === "q") {
      ownKey(key);
      back();
    }
  };

  process.once("SIGTERM", back);
  process.once("SIGHUP", back);
  renderer.keyInput.on("keypress", keypress);
  paint();
  return await finished;
}

function ownKey(key: { preventDefault(): void; stopPropagation(): void }): void {
  key.preventDefault();
  key.stopPropagation();
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (caught) => {
        cleanup();
        reject(caught);
      },
    );
  });
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      operation.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
