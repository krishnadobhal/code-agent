/** Terminal front ends: the Ink app for a real terminal, the plain REPL for pipes. */

import { render } from "ink";
import type { Session } from "../commands.ts";
import { App } from "./App.tsx";

export { App } from "./App.tsx";
export { runPlain } from "./plain.ts";

/** Run the Ink UI until the user quits. */
export async function runInk(session: Session, intro: string[]): Promise<void> {
  const app = render(<App session={session} intro={intro} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
}
