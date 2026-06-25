/**
 * Named spell/ability ids for ingest tests, so specs read as sentences rather
 * than magic numbers. Values are real-ish WoW ids but only their identity (and,
 * for Bloodlust, membership in BLOODLUST_IDS) matters to the analysis code.
 */

// Offensive cooldowns.
export const SHADOW_BLADES = 121471;
export const SHADOW_DANCE = 185313;
export const SECRET_TECHNIQUE = 280719;
export const SYMBOLS_OF_DEATH = 212283;

// Defensives.
export const CLOAK_OF_SHADOWS = 31224;
export const FEINT = 1966;
export const EVASION = 5277;

// Damage abilities (for burst/defensive window damage events).
export const EVISCERATE = 196819;
export const BLACK_POWDER = 319175;
export const MELEE = 1;

// Boss/enemy damage abilities (damage taken).
export const BOSS_SWING = 6603;
export const BOSS_NUKE = 999001;
