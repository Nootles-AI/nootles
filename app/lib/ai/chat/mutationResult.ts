/** A completed tool output carrying this first sentence made no mutation. */
export const NOTHING_WAS_WRITTEN = "Nothing was written.";

/**
 * A no-write result may be repeated with the same input. Keep the marker in
 * one place so replay protection never has to recognize a tool's prose.
 */
export function retryableMutationResult(...details: string[]): string {
  return [NOTHING_WAS_WRITTEN, ...details].join("\n");
}

export function isRetryableMutationResult(output: unknown): boolean {
  return typeof output === "string" && output.startsWith(NOTHING_WAS_WRITTEN);
}
