import {
  type DocumentApprovalPayload,
  documentApprovalResolution,
} from "../../contracts/approval.ts";
import type { AttentionItem } from "../../domain.ts";
import { createCommandPalette } from "../palette.ts";
import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "../theme.ts";
import type { ProcessorDecision } from "./types.ts";

export async function runApprovalProcessor(
  item: AttentionItem,
  payload: DocumentApprovalPayload,
): Promise<ProcessorDecision> {
  const core = await import("@opentui/core");
  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const root = new core.BoxRenderable(renderer, {
    id: "approval-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "approval-scroll",
    width: "100%",
    flexGrow: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
    viewportCulling: true,
  });
  const body = new core.BoxRenderable(renderer, {
    id: "approval-body",
    width: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  body.add(
    new core.TextRenderable(renderer, {
      content: `${SIGNAL_GLYPHS.rail} DOCUMENT REVIEW`,
      fg: SIGNAL_ROOM.accent,
      height: 1,
      wrapMode: "none",
    }),
  );
  body.add(
    new core.TextRenderable(renderer, {
      content: item.title,
      fg: SIGNAL_ROOM.text,
      attributes: core.TextAttributes.BOLD,
      marginTop: 1,
    }),
  );
  if (item.context) {
    body.add(
      new core.TextRenderable(renderer, {
        content: item.context,
        fg: SIGNAL_ROOM.muted,
        marginTop: 1,
        wrapMode: "word",
      }),
    );
  }
  body.add(
    new core.TextRenderable(renderer, {
      content: payload.document,
      fg: SIGNAL_ROOM.text,
      marginTop: 1,
      wrapMode: payload.format === "markdown" ? "word" : "none",
    }),
  );
  scroll.add(body);
  root.add(scroll);

  const commentRow = new core.BoxRenderable(renderer, {
    id: "approval-comment-row",
    width: "100%",
    minHeight: 1,
    flexDirection: "row",
    paddingLeft: 2,
    paddingRight: 2,
    paddingBottom: 1,
    backgroundColor: SIGNAL_ROOM.canvas,
    visible: false,
    onMouseUp: (event) => {
      event.stopPropagation();
      comment.focus();
    },
  });
  commentRow.add(
    new core.TextRenderable(renderer, {
      content: SIGNAL_GLYPHS.rail,
      fg: SIGNAL_ROOM.local,
      width: 2,
    }),
  );
  const comment = new core.TextareaRenderable(renderer, {
    id: "approval-comment",
    flexGrow: 1,
    minHeight: 1,
    height: 4,
    wrapMode: "word",
    backgroundColor: SIGNAL_ROOM.canvas,
    focusedBackgroundColor: SIGNAL_ROOM.canvas,
    textColor: SIGNAL_ROOM.text,
    focusedTextColor: SIGNAL_ROOM.text,
    cursorColor: SIGNAL_ROOM.accent,
    placeholder: "Describe the requested changes…",
    placeholderColor: SIGNAL_ROOM.muted,
  });
  commentRow.add(comment);
  root.add(commentRow);
  renderer.root.add(root);

  let commentMode = false;
  let closed = false;
  const palette = createCommandPalette(core, renderer, "approval-palette", {
    onOpenChange: (open) => {
      if (open) comment.blur();
      else if (commentMode) comment.focus();
    },
  });
  renderer.root.add(palette.root);
  try {
    scroll.verticalScrollBar.visible = false;
    scroll.horizontalScrollBar.visible = false;
  } catch {
    // Compatible older OpenTUI builds need no explicit scrollbar changes.
  }

  let done!: (decision: ProcessorDecision) => void;
  const finished = new Promise<ProcessorDecision>((resolveDecision) => {
    done = resolveDecision;
  });
  const finish = (decision: ProcessorDecision): void => {
    if (closed) return;
    closed = true;
    renderer.destroy();
    done(decision);
  };
  const approve = (): void =>
    finish({ kind: "resolve", resolution: documentApprovalResolution("approved") });
  const requestChanges = (): void => {
    commentMode = true;
    commentRow.visible = true;
    comment.focus();
    paint();
  };
  const submitChanges = (): void => {
    const value = comment.plainText.trim();
    if (!value) return;
    finish({
      kind: "resolve",
      resolution: documentApprovalResolution("changes_requested", value),
    });
  };
  const cancelComment = (): void => {
    commentMode = false;
    commentRow.visible = false;
    comment.blur();
    paint();
  };
  const scrollBy = (amount: number): void => {
    scroll.scrollBy({ x: 0, y: amount });
    renderer.requestRender();
  };
  const scrollTo = (amount: number): void => {
    scroll.scrollTop = amount;
    renderer.requestRender();
  };

  const commands = () =>
    commentMode
      ? [
          { id: "send-changes", key: "ENTER", label: "send change request", onRun: submitChanges },
          {
            id: "cancel-comment",
            key: "ESC",
            label: "cancel change request",
            onRun: cancelComment,
          },
        ]
      : [
          { id: "approve", key: "A", label: "approve document", onRun: approve },
          { id: "changes", key: "C", label: "request changes", onRun: requestChanges },
          {
            id: "stale",
            key: "R",
            label: "return stale",
            onRun: () => finish({ kind: "return", reason: "stale", comment: null }),
          },
          { id: "up", key: "K", label: "scroll up", onRun: () => scrollBy(-2) },
          { id: "down", key: "J", label: "scroll down", onRun: () => scrollBy(2) },
          { id: "top", key: "G", label: "jump to top", onRun: () => scrollTo(0) },
          {
            id: "bottom",
            key: "⇧G",
            label: "jump to bottom",
            onRun: () => scrollTo(Number.MAX_SAFE_INTEGER),
          },
          {
            id: "back",
            key: "Q",
            label: "back without resolving",
            onRun: () => finish({ kind: "back" }),
          },
        ];

  const paint = (): void => {
    palette.update({
      width: renderer.width || process.stdout.columns || 80,
      height: renderer.height || process.stdout.rows || 24,
      commands: commands(),
    });
    renderer.requestRender();
  };

  comment.onSubmit = submitChanges;
  const back = () => finish({ kind: "back" });
  process.once("SIGTERM", back);
  process.once("SIGHUP", back);
  renderer.keyInput.on("keypress", (key) => {
    if (palette.handleKey(key)) {
      ownKey(key);
      return;
    }
    if (key.ctrl && key.name === "c") {
      ownKey(key);
      back();
      return;
    }
    if (commentMode) {
      if (key.name === "escape") {
        ownKey(key);
        cancelComment();
      }
      return;
    }
    if (key.name === "a") {
      ownKey(key);
      approve();
    } else if (key.name === "c") {
      ownKey(key);
      requestChanges();
    } else if (key.name === "j" || key.name === "down") scrollBy(2);
    else if (key.name === "k" || key.name === "up") scrollBy(-2);
    else if (key.name === "g") scrollTo(0);
    else if (key.name === "G" || key.name === "end") scrollTo(Number.MAX_SAFE_INTEGER);
    else if (key.name === "q") {
      ownKey(key);
      back();
    }
  });

  paint();
  return await finished;
}

function ownKey(key: { preventDefault(): void; stopPropagation(): void }): void {
  key.preventDefault();
  key.stopPropagation();
}
