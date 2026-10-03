import { Box, Text } from "ink";

/** One finished line of the transcript. */
export type Item = { id: number; kind: "user" | "assistant" | "tool" | "info" | "error"; text: string };

/** Renders an item in its role's style. */
export function TranscriptLine({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <Text color="cyan">{`> ${item.text}`}</Text>;
    case "tool":
      return <Text dimColor>{`  ${item.text}`}</Text>;
    case "info":
      return <Text dimColor>{item.text}</Text>;
    case "error":
      return <Text color="red">{item.text}</Text>;
    case "assistant":
      return (
        <Box marginBottom={1}>
          <Text>{item.text}</Text>
        </Box>
      );
  }
}
