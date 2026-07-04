/**
 * Named spell-id constants for tests.
 *
 * The production code never hardcodes spec spell IDs (they come from the
 * rulebook), but tests need *some* stable IDs to wire events to rules. Naming
 * them here keeps specs readable - `cast(SHADOW_BLADES, 1)` reads as
 * documentation - and the exact numeric values are irrelevant to the tests
 * as long as builders and rulebook fixtures agree.
 *
 * The Bloodlust family IDs are the real ones the engine recognizes
 * (`BLOODLUST_IDS` in the rotation slice); everything else is a
 * convenient real-ish Subtlety Rogue value used only as a label.
 */

// Bloodlust / Heroism family - must match the real IDs the engine detects.
export const BLOODLUST = 2825;          // Shaman Bloodlust
export const HEROISM = 32182;           // Alliance Heroism
export const TIME_WARP = 80353;         // Mage Time Warp
export const ANCIENT_HYSTERIA = 90355;  // Hunter pet (core hound)
export const PRIMAL_RAGE = 264667;      // Hunter pet (other)
export const FURY_OF_THE_ASPECTS = 390386;

// Subtlety Rogue cooldowns (labels for rule/cooldown fixtures).
export const SHADOW_BLADES = 121471;
export const SHADOW_DANCE = 185313;
export const SECRET_TECHNIQUE = 280719;
export const VANISH = 1856;
export const SYMBOLS_OF_DEATH = 212283;

// Defensives.
export const CLOAK_OF_SHADOWS = 31224;
export const EVASION = 5277;
export const CRIMSON_VIAL = 185311;
export const FEINT = 1966;

// Generic damage-ability labels.
export const EVISCERATE = 196819;
export const BLACK_POWDER = 319175;

// Real WCL quirk: an ability's damage event carries a different id than its cast
// event, but both share the same name. Shadow Blades is cast as 121471 yet its
// damage rows show up as 279043 - the name is the only bridge between the two.
export const SHADOW_BLADES_DAMAGE = 279043;
