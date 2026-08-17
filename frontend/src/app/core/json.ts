import * as z from './zod-mini';
import { logWarn } from './log';

// Syntax errors and shape mismatches are deliberately one outcome; do not give callers a second malformed-input path.
export function parseJson<S extends z.ZodMiniType>(schema: S, raw: string, context: string): z.infer<S> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    logWarn(context, err);
    return null;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  logWarn(context, parsed.error);
  return null;
}
