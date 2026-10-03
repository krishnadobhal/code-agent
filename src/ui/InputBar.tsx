import { Box, Text } from "ink";
import TextInput from "ink-text-input";

type Props = { busy: boolean; value: string; onChange: (value: string) => void; onSubmit: (value: string) => void };

/** The `> ` input line, or a status line while a turn runs (unmounted input can't take keys). */
export function InputBar({ busy, value, onChange, onSubmit }: Props) {
  if (busy) return <Text dimColor>working... (Ctrl+C to cancel)</Text>;
  return (
    <Box>
      <Text color="cyan">{"> "}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
