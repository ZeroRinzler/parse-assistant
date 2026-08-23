import { inject, Injectable } from '@angular/core';
import * as z from './zod-mini';
import { LoggerService } from '../observability/logger-service';

@Injectable({ providedIn: 'root' })
export class JsonCodecService {
  private readonly logger = inject(LoggerService);

  // Syntax errors and shape mismatches are deliberately one outcome; do not give callers a second malformed-input path.
  parseJson<S extends z.ZodMiniType>(schema: S, raw: string, context: string): z.infer<S> | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      this.logger.logWarn(context, err);
      return null;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    this.logger.logWarn(context, parsed.error);
    return null;
  }
}
