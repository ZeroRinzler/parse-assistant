// Importing zod/mini's own `z` namespace instead of these named validators re-inflates the lazy chunk 12x.
export { object, looseObject, array, string, number, optional, nullable, catch, minLength, positive } from 'zod/mini';
export type { ZodMiniType, infer } from 'zod/mini';
