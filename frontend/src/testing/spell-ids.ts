/** Named spell-id constants for tests, since production code never hardcodes spec spell IDs (they come from the rulebook). */

// Bloodlust / Heroism family - must match the real IDs the engine detects.
export const BLOODLUST = 2825;
export const HEROISM = 32182;
export const TIME_WARP = 80353;
export const ANCIENT_HYSTERIA = 90355;
export const PRIMAL_RAGE = 264667;
export const FURY_OF_THE_ASPECTS = 390386;

export const SHADOW_BLADES = 121471;
export const SHADOW_DANCE = 185313;
export const SECRET_TECHNIQUE = 280719;
export const VANISH = 1856;
export const SYMBOLS_OF_DEATH = 212283;

export const CLOAK_OF_SHADOWS = 31224;
export const EVASION = 5277;
export const CRIMSON_VIAL = 185311;
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
