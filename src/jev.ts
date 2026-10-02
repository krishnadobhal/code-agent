/** Jev (TypeSafe AI): fast yes/no side decisions. The only module that imports `@typesafe-ai/sdk`. */

import { AuthenticationError, noul, TypeSafeClient } from "@typesafe-ai/sdk";

let client: TypeSafeClient | undefined;
let rejected = false; // the key was refused once; don't retry it every command

/** Jev is optional: off when no key is set, or after the API rejects the key. */
export function enabled(): boolean {
  return !rejected && Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

/** Probability (0-1) that a shell command only reads. 0 when Jev is off. Throws on API errors. */
export async function readOnlyCommand(command: string): Promise<number> {
  if (!enabled()) return 0; // safety then just asks the user
  client ??= new TypeSafeClient();
  try {
    const { answers } = await client.systemOne(
      {
        state: { shell_command: command, platform: process.platform },
        questions: {
          readOnly: noul(
            "This shell command only reads information and cannot modify files, processes, " +
              "network, or system settings.",
          ),
        },
      },
      // it gates an interactive prompt: fail fast and let the user decide
      { timeout: 3000, retry: { maxRetries: 0 } },
    );
    return answers.readOnly.noul;
  } catch (error) {
    if (!(error instanceof AuthenticationError)) throw error;
    rejected = true;
    throw new Error("TYPESAFE_API_KEY was rejected; Jev is off for this session", { cause: error });
  }
}
