/** Named spell-id constants for tests, since production code never hardcodes spec spell IDs (they come from the rulebook). */

// Bloodlust - must match the real ID the engine detects.
export const BLOODLUST = 2825;

export const SHADOW_BLADES = 121471;
export const SHADOW_DANCE = 185313;
export const SECRET_TECHNIQUE = 280719;
export const VANISH = 1856;

export const CLOAK_OF_SHADOWS = 31224;
export const EVASION = 5277;
export const FEINT = 1966;

export const EVISCERATE = 196819;
export const BLACK_POWDER = 319175;

export const RUPTURE = 1943;

export const WRATH = 190984;
export const STARFIRE = 194153;
export const ECLIPSE_SOLAR = 48517;

export const LIGHTNING_BOLT = 188196;
export const MAELSTROM_WEAPON = 344179;

// Moonfire, the clip fixture: the cast id and the debuff it applies are different ids sharing one name.
export const MOONFIRE = 8921;
export const MOONFIRE_DOT = 164812;

export const EXECUTE = 5308;
export const SLAM = 1464;

// WCL quirk: Shadow Blades casts as 121471 but its damage rows show up as 279043 - the name is the only bridge between the two.
export const SHADOW_BLADES_DAMAGE = 279043;

// These mirror the ids `normalizeAbilityId` folds onto, so changing one here without changing it there silently stops asserting its behavior.
export const WCL_MELEE_EVENT_ABILITY_ID = 1;
export const WOW_AUTO_ATTACK_SPELL_ID = 6603;
export const WCL_SYNTHETIC_SOURCE_FALLBACK_ID = 291807;
