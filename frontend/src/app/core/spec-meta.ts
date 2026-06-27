/**
 * Single source of truth for spec metadata: the class/spec a WCL spec folder maps to, human
 * display labels, and the zamimg icon stems. Both the rankings query (`wcl-api.ts`) and the
 * selection dropdowns read from here, so there is exactly one 39-entry table.
 *
 * Only the spec-icon stem is hand-listed (in-game spec icons have no formulaic name). The class
 * icon is formulaic (`class_<lowercase-class>`) and the labels are derived by spacing the camel
 * case, so nothing else is duplicated.
 */
export interface SpecMeta {
  /** Folder key, e.g. 'SubtletyRogue'. */
  spec: string;
  /** No-space class form, e.g. 'DeathKnight' (WCL className for the rankings query). */
  className: string;
  /** No-space spec form, e.g. 'BeastMastery' (WCL specName for the rankings query). */
  specName: string;
  /** Display label, e.g. 'Death Knight'. */
  classLabel: string;
  /** Display label, e.g. 'Subtlety'. */
  specLabel: string;
  /** zamimg class-icon file stem (no extension), e.g. 'class_rogue'. */
  classIcon: string;
  /** zamimg spec spell-icon file stem (no extension), e.g. 'ability_stealth'. */
  specIcon: string;
}

const ZAM = 'https://wow.zamimg.com/images/wow/icons/small';

/** Split a camel-case identifier into spaced words: 'DeathKnight' -> 'Death Knight'. */
function splitWords(camel: string): string {
  return camel.replace(/([A-Z])/g, ' $1').trim();
}

/** Class-icon stem for a class name (space-tolerant): 'Death Knight' -> 'class_deathknight'. */
function classIconStem(className: string): string {
  return `class_${className.toLowerCase().replace(/ /g, '')}`;
}

/** Source table: folder -> [className, specName, verified spec-icon stem]. */
const SOURCE: Record<string, [string, string, string]> = {
  RetributionPaladin: ['Paladin', 'Retribution', 'spell_holy_auraoflight'],
  HolyPaladin: ['Paladin', 'Holy', 'spell_holy_holybolt'],
  ProtectionPaladin: ['Paladin', 'Protection', 'ability_paladin_shieldofthetemplar'],
  FireMage: ['Mage', 'Fire', 'spell_fire_firebolt02'],
  ArcaneMage: ['Mage', 'Arcane', 'spell_holy_magicalsentry'],
  FrostMage: ['Mage', 'Frost', 'spell_frost_frostbolt02'],
  HavocDemonHunter: ['DemonHunter', 'Havoc', 'ability_demonhunter_specdps'],
  VengeanceDemonHunter: ['DemonHunter', 'Vengeance', 'ability_demonhunter_spectank'],
  FuryWarrior: ['Warrior', 'Fury', 'ability_warrior_innerrage'],
  ArmsWarrior: ['Warrior', 'Arms', 'ability_warrior_savageblow'],
  ProtectionWarrior: ['Warrior', 'Protection', 'ability_warrior_defensivestance'],
  UnholyDeathKnight: ['DeathKnight', 'Unholy', 'spell_deathknight_unholypresence'],
  FrostDeathKnight: ['DeathKnight', 'Frost', 'spell_deathknight_frostpresence'],
  BloodDeathKnight: ['DeathKnight', 'Blood', 'spell_deathknight_bloodpresence'],
  BalanceDruid: ['Druid', 'Balance', 'spell_nature_starfall'],
  FeralDruid: ['Druid', 'Feral', 'ability_druid_catform'],
  GuardianDruid: ['Druid', 'Guardian', 'ability_racial_bearform'],
  RestorationDruid: ['Druid', 'Restoration', 'spell_nature_healingtouch'],
  BeastMasteryHunter: ['Hunter', 'BeastMastery', 'ability_hunter_bestialdiscipline'],
  MarksmanshipHunter: ['Hunter', 'Marksmanship', 'ability_hunter_focusedaim'],
  SurvivalHunter: ['Hunter', 'Survival', 'ability_hunter_camouflage'],
  BrewmasterMonk: ['Monk', 'Brewmaster', 'spell_monk_brewmaster_spec'],
  WindwalkerMonk: ['Monk', 'Windwalker', 'spell_monk_windwalker_spec'],
  MistweaverMonk: ['Monk', 'Mistweaver', 'spell_monk_mistweaver_spec'],
  DisciplinePriest: ['Priest', 'Discipline', 'spell_holy_powerwordshield'],
  HolyPriest: ['Priest', 'Holy', 'spell_holy_guardianspirit'],
  ShadowPriest: ['Priest', 'Shadow', 'spell_shadow_shadowwordpain'],
  AssassinationRogue: ['Rogue', 'Assassination', 'ability_rogue_deadlybrew'],
  OutlawRogue: ['Rogue', 'Outlaw', 'inv_sword_30'],
  SubtletyRogue: ['Rogue', 'Subtlety', 'ability_stealth'],
  ElementalShaman: ['Shaman', 'Elemental', 'spell_nature_lightning'],
  EnhancementShaman: ['Shaman', 'Enhancement', 'spell_shaman_improvedstormstrike'],
  RestorationShaman: ['Shaman', 'Restoration', 'spell_nature_magicimmunity'],
  AfflictionWarlock: ['Warlock', 'Affliction', 'spell_shadow_deathcoil'],
  DemonologyWarlock: ['Warlock', 'Demonology', 'spell_shadow_metamorphosis'],
  DestructionWarlock: ['Warlock', 'Destruction', 'spell_shadow_rainoffire'],
  DevastationEvoker: ['Evoker', 'Devastation', 'classicon_evoker_devastation'],
  PreservationEvoker: ['Evoker', 'Preservation', 'classicon_evoker_preservation'],
  AugmentationEvoker: ['Evoker', 'Augmentation', 'classicon_evoker_augmentation'],
};

export const SPEC_META: Record<string, SpecMeta> = Object.fromEntries(
  Object.entries(SOURCE).map(([spec, [className, specName, specIcon]]) => [
    spec,
    {
      spec,
      className,
      specName,
      classLabel: splitWords(className),
      specLabel: splitWords(specName),
      classIcon: classIconStem(className),
      specIcon,
    },
  ]),
);

/** Stems of every real class icon, so the player fallback never points at a bogus class. */
const KNOWN_CLASS_ICONS = new Set(Object.values(SPEC_META).map(meta => meta.classIcon));

/** One entry per class, in stable display order, for the Class dropdown. */
export function classList(): { className: string; classLabel: string; classIcon: string }[] {
  const byClass = new Map<string, { className: string; classLabel: string; classIcon: string }>();
  for (const meta of Object.values(SPEC_META)) {
    if (!byClass.has(meta.className)) {
      byClass.set(meta.className, { className: meta.className, classLabel: meta.classLabel, classIcon: meta.classIcon });
    }
  }
  return [...byClass.values()].sort((first, second) => first.classLabel.localeCompare(second.classLabel));
}

/** Spec metas for `className`, restricted to the `available` folder keys (those with data), sorted by spec label. */
export function specsForClass(className: string, available: string[]): SpecMeta[] {
  return available
    .map(spec => SPEC_META[spec])
    .filter((meta): meta is SpecMeta => !!meta && meta.className === className)
    .sort((first, second) => first.specLabel.localeCompare(second.specLabel));
}

/** Lookup a spec folder's metadata, or `undefined` for an unknown spec. */
export function specMetaOf(spec: string | null | undefined): SpecMeta | undefined {
  return spec ? SPEC_META[spec] : undefined;
}

/**
 * zamimg class-icon URL for a class name (space-tolerant: accepts 'Death Knight' or 'DeathKnight').
 * Returns '' for an unknown class, so a name-only fallback never shows a broken image.
 */
export function classIconUrl(className: string): string {
  const stem = classIconStem(className);
  return KNOWN_CLASS_ICONS.has(stem) ? `${ZAM}/${stem}.jpg` : '';
}

/** zamimg spec-icon URL for a spec folder key, or '' when the spec is unknown. */
export function specIconUrl(spec: string): string {
  const meta = SPEC_META[spec];
  return meta ? `${ZAM}/${meta.specIcon}.jpg` : '';
}
