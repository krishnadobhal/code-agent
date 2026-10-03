import { Box, Text } from "ink";

/** The y/N question shown while a tool call waits for approval. */
export function ApprovalBox({ request }: { request: string }) {
  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text>{`Allow ${request}?`}</Text>
      <Text dimColor>y = yes, n or Enter = no</Text>
    </Box>
  );
}
