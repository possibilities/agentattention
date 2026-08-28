import { type QuestionPayload, questionResolution } from "../../contracts/question.ts";
import type { AttentionItem } from "../../domain.ts";
import { createCommandPalette } from "../palette.ts";
import { SIGNAL_GLYPHS, SIGNAL_ROOM } from "../theme.ts";
import type { ProcessorDecision } from "./types.ts";

export async function runQuestionProcessor(
  item: AttentionItem,
  payload: QuestionPayload,
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
    id: "question-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "question-scroll",
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
    id: "question-body",
    width: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  scroll.add(body);
  root.add(scroll);

  const inputRow = new core.BoxRenderable(renderer, {
    id: "question-answer-row",
    width: "100%",
    minHeight: 1,
    flexDirection: "row",
    paddingLeft: 2,
    paddingRight: 2,
    paddingBottom: 1,
    backgroundColor: SIGNAL_ROOM.canvas,
    onMouseUp: (event) => {
      event.stopPropagation();
      answer.focus();
    },
  });
  inputRow.add(
    new core.TextRenderable(renderer, {
      content: SIGNAL_GLYPHS.rail,
      fg: SIGNAL_ROOM.local,
      width: 2,
    }),
  );
  const answer = new core.TextareaRenderable(renderer, {
    id: "question-answer",
    flexGrow: 1,
    minHeight: 1,
    height: 3,
    wrapMode: "word",
    backgroundColor: SIGNAL_ROOM.canvas,
    focusedBackgroundColor: SIGNAL_ROOM.canvas,
    textColor: SIGNAL_ROOM.text,
    focusedTextColor: SIGNAL_ROOM.text,
    cursorColor: SIGNAL_ROOM.accent,
    placeholder: "Enter answer…",
    placeholderColor: SIGNAL_ROOM.muted,
  });
  inputRow.add(answer);
  root.add(inputRow);
  renderer.root.add(root);

  const palette = createCommandPalette(core, renderer, "question-palette", {
    onOpenChange: (open) => {
      if (open) answer.blur();
      else if (!currentQuestion()?.choices) answer.focus();
    },
  });
  renderer.root.add(palette.root);
  try {
    scroll.verticalScrollBar.visible = false;
    scroll.horizontalScrollBar.visible = false;
  } catch {
    // Compatible older OpenTUI builds need no explicit scrollbar changes.
  }

  const answers = new Map<string, string>();
  let index = 0;
  let choiceIndex = 0;
  let notice: string | null = null;
  let closed = false;

  const currentQuestion = () => payload.questions[index];
  const syncTextAnswer = (): void => {
    const question = currentQuestion();
    if (!question || question.choices) return;
    const value = answer.plainText.trim();
    if (value.length === 0) answers.delete(question.id);
    else answers.set(question.id, value);
  };

  const moveQuestion = (delta: number): void => {
    syncTextAnswer();
    index = Math.max(0, Math.min(payload.questions.length - 1, index + delta));
    notice = null;
    showQuestion();
  };

  const choose = (selected: number): void => {
    const question = currentQuestion();
    const choice = question?.choices?.[selected];
    if (!question || !choice) return;
    choiceIndex = selected;
    answers.set(question.id, choice.value);
    if (index < payload.questions.length - 1) moveQuestion(1);
    else finishAnswers();
  };

  const finishAnswers = (): void => {
    syncTextAnswer();
    const missing = payload.questions.findIndex((question) => !answers.get(question.id)?.trim());
    if (missing >= 0) {
      index = missing;
      notice = "answer required before submission";
      showQuestion();
      return;
    }
    finish({ kind: "resolve", resolution: questionResolution(payload, answers) });
  };

  const commands = () => [
    { id: "previous", key: "K", label: "previous question", onRun: () => moveQuestion(-1) },
    { id: "next", key: "J", label: "next question", onRun: () => moveQuestion(1) },
    { id: "submit", key: "S", label: "submit all answers", onRun: finishAnswers },
    {
      id: "stale",
      key: "R",
      label: "return stale",
      onRun: () => finish({ kind: "return", reason: "stale", comment: null }),
    },
    {
      id: "back",
      key: "Q",
      label: "back without resolving",
      onRun: () => finish({ kind: "back" }),
    },
  ];

  const showQuestion = (): void => {
    const question = currentQuestion();
    if (!question) return;
    for (const child of body.getChildren()) {
      body.remove(child);
      child.destroyRecursively();
    }
    body.add(
      new core.TextRenderable(renderer, {
        content: `${SIGNAL_GLYPHS.rail} QUESTION ${index + 1} OF ${payload.questions.length}`,
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
        content: question.prompt,
        fg: SIGNAL_ROOM.text,
        marginTop: 1,
        wrapMode: "word",
      }),
    );
    if (notice) {
      body.add(
        new core.TextRenderable(renderer, {
          content: `${SIGNAL_GLYPHS.idle} ${notice.toUpperCase()}`,
          fg: SIGNAL_ROOM.danger,
          marginTop: 1,
        }),
      );
    }
    const choices = question.choices;
    inputRow.visible = choices === null;
    if (choices) {
      const existing = answers.get(question.id);
      choiceIndex = Math.max(
        0,
        choices.findIndex((choice) => choice.value === existing),
      );
      choices.forEach((choice, choicePosition) => {
        const selected = choicePosition === choiceIndex;
        const row = new core.BoxRenderable(renderer, {
          id: `question-choice-${choicePosition}`,
          width: "100%",
          height: 1,
          marginTop: choicePosition === 0 ? 1 : 0,
          backgroundColor: SIGNAL_ROOM.canvas,
          onMouseUp: (event) => {
            event.stopPropagation();
            choose(choicePosition);
          },
        });
        row.add(
          new core.TextRenderable(renderer, {
            content: `${selected ? `${SIGNAL_GLYPHS.rail} ` : "  "}${choice.label}`,
            fg: selected ? SIGNAL_ROOM.text : SIGNAL_ROOM.muted,
            attributes: selected ? core.TextAttributes.BOLD : core.TextAttributes.NONE,
            height: 1,
          }),
        );
        body.add(row);
      });
      answer.blur();
    } else {
      answer.setText(answers.get(question.id) ?? "");
      answer.cursorOffset = answer.plainText.length;
      answer.focus();
    }
    palette.update({
      width: renderer.width || process.stdout.columns || 80,
      height: renderer.height || process.stdout.rows || 24,
      commands: commands(),
    });
    scroll.scrollTop = Number.MAX_SAFE_INTEGER;
    renderer.requestRender();
  };

  answer.onSubmit = () => {
    syncTextAnswer();
    if (index < payload.questions.length - 1) moveQuestion(1);
    else finishAnswers();
  };

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
    const question = currentQuestion();
    if (!question?.choices) return;
    if (key.name === "j" || key.name === "down") {
      choiceIndex = Math.min(question.choices.length - 1, choiceIndex + 1);
      ownKey(key);
      showQuestion();
    } else if (key.name === "k" || key.name === "up") {
      choiceIndex = Math.max(0, choiceIndex - 1);
      ownKey(key);
      showQuestion();
    } else if (key.name === "enter" || key.name === "return") {
      ownKey(key);
      choose(choiceIndex);
    } else if (key.name === "q") {
      ownKey(key);
      back();
    }
  });

  showQuestion();
  return await finished;
}

function ownKey(key: { preventDefault(): void; stopPropagation(): void }): void {
  key.preventDefault();
  key.stopPropagation();
}
