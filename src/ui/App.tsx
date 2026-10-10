import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useEffect, useReducer, useState } from "react";
import type { Controller, LineKind, LogLine } from "./controller.js";

const COLOR: Record<LineKind, string | undefined> = {
  user: "cyan",
  assistant: "white",
  tool: "gray",
  info: "yellow",
  error: "red",
};

const PREFIX: Record<LineKind, string> = {
  user: "› ",
  assistant: "",
  tool: "",
  info: "• ",
  error: "✗ ",
};

function Line({ line }: { line: LogLine }): React.ReactElement {
  return (
    <Text color={COLOR[line.kind]}>
      {PREFIX[line.kind]}
      {line.text}
    </Text>
  );
}

export function App({ controller }: { controller: Controller }): React.ReactElement {
  const { exit } = useApp();
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [input, setInput] = useState("");

  useEffect(() => controller.subscribe(force), [controller]);

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      exit();
      return;
    }
    const pending = controller.pending;
    if (pending?.kind === "approval") {
      if (char.toLowerCase() === "y") controller.answer(true);
      else if (char.toLowerCase() === "n") controller.answer(false);
      return;
    }
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (pending?.kind === "ask") {
        controller.answer(text);
      } else if (text.length > 0 && !controller.busy) {
        void controller.send(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const pending = controller.pending;
  return (
    <Box flexDirection="column">
      <Static items={controller.lines}>{(line) => <Line key={line.id} line={line} />}</Static>
      {controller.live.length > 0 && <Text>{controller.live}</Text>}
      <Box marginTop={1}>
        {pending?.kind === "approval" ? (
          <Text color="yellow">{pending.prompt} </Text>
        ) : pending?.kind === "ask" ? (
          <Text color="yellow">
            {pending.prompt} {input}
          </Text>
        ) : controller.busy ? (
          <Text color="gray">…working</Text>
        ) : (
          <Text>
            <Text color="green">› </Text>
            {input}
          </Text>
        )}
      </Box>
    </Box>
  );
}
