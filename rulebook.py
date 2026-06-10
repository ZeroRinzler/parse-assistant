BLOODLUST_SPELL_IDS = {2825, 32182, 80353, 90355, 264667, 390386}
BLOODLUST_DURATION_S = 40

# Major defensive cooldowns by spec — used for defensive usage analysis.
# duration: buff/effect duration in seconds (for damage-prevented estimate).
SPEC_DEFENSIVES: dict[str, list[dict]] = {
    # Warriors
    "ArmsWarrior":   [{"name": "Die by the Sword",   "spell_id": 118038, "cooldown": 120, "duration": 10}],
    "FuryWarrior":   [{"name": "Die by the Sword",   "spell_id": 118038, "cooldown": 120, "duration": 10}],
    # Death Knights
    "UnholyDeathKnight": [
        {"name": "Anti-Magic Shell",   "spell_id": 48707, "cooldown": 45,  "duration": 5},
        {"name": "Icebound Fortitude","spell_id": 48792, "cooldown": 180, "duration": 8},
    ],
    "FrostDeathKnight": [
        {"name": "Anti-Magic Shell",   "spell_id": 48707, "cooldown": 45,  "duration": 5},
        {"name": "Icebound Fortitude","spell_id": 48792, "cooldown": 180, "duration": 8},
    ],
    # Druids
    "BalanceDruid":  [
        {"name": "Barkskin",           "spell_id": 22812,  "cooldown": 60,  "duration": 12},
        {"name": "Survival Instincts", "spell_id": 61336,  "cooldown": 180, "duration": 6},
    ],
    "FeralDruid":    [
        {"name": "Survival Instincts", "spell_id": 61336,  "cooldown": 180, "duration": 6},
        {"name": "Barkskin",           "spell_id": 22812,  "cooldown": 60,  "duration": 12},
    ],
    # Demon Hunter
    "HavocDemonHunter": [
        {"name": "Blur",              "spell_id": 198589, "cooldown": 60,  "duration": 10},
        {"name": "Darkness",          "spell_id": 196718, "cooldown": 180, "duration": 8},
    ],
    # Hunters
    "BeastMasteryHunter": [{"name": "Exhilaration", "spell_id": 109304, "cooldown": 120, "duration": 0}],
    "MarksmanshipHunter": [{"name": "Exhilaration", "spell_id": 109304, "cooldown": 120, "duration": 0}],
    "SurvivalHunter":     [{"name": "Exhilaration", "spell_id": 109304, "cooldown": 120, "duration": 0}],
    # Mages
    "FireMage":    [{"name": "Ice Block",  "spell_id": 45438, "cooldown": 240, "duration": 10}],
    "ArcaneMage":  [{"name": "Ice Block",  "spell_id": 45438, "cooldown": 240, "duration": 10}],
    "FrostMage":   [{"name": "Ice Block",  "spell_id": 45438, "cooldown": 240, "duration": 10}],
    # Monks
    "WindwalkerMonk": [
        {"name": "Fortifying Brew",  "spell_id": 115203, "cooldown": 90,  "duration": 15},
        {"name": "Touch of Karma",   "spell_id": 122470, "cooldown": 90,  "duration": 10},
    ],
    # Paladins
    "RetributionPaladin": [
        {"name": "Divine Shield",    "spell_id": 642,    "cooldown": 300, "duration": 8},
        {"name": "Lay on Hands",     "spell_id": 633,    "cooldown": 600, "duration": 0},
    ],
    # Priests
    "ShadowPriest": [
        {"name": "Dispersion",       "spell_id": 47585,  "cooldown": 120, "duration": 6},
        {"name": "Fade",             "spell_id": 586,    "cooldown": 30,  "duration": 10},
    ],
    # Rogues
    "AssassinationRogue": [
        {"name": "Cloak of Shadows", "spell_id": 31224,  "cooldown": 60,  "duration": 5},
        {"name": "Evasion",          "spell_id": 5277,   "cooldown": 120, "duration": 10},
    ],
    "OutlawRogue": [
        {"name": "Cloak of Shadows", "spell_id": 31224,  "cooldown": 60,  "duration": 5},
        {"name": "Evasion",          "spell_id": 5277,   "cooldown": 120, "duration": 10},
    ],
    "SubtletyRogue": [
        {"name": "Cloak of Shadows", "spell_id": 31224,  "cooldown": 60,  "duration": 5},
        {"name": "Evasion",          "spell_id": 5277,   "cooldown": 120, "duration": 10},
    ],
    # Shamans
    "ElementalShaman":   [{"name": "Astral Shift",    "spell_id": 108271, "cooldown": 90,  "duration": 12}],
    "EnhancementShaman": [{"name": "Astral Shift",    "spell_id": 108271, "cooldown": 90,  "duration": 12}],
    # Warlocks
    "AfflictionWarlock":   [{"name": "Dark Pact",     "spell_id": 108416, "cooldown": 60,  "duration": 20}],
    "DemonologyWarlock":   [{"name": "Dark Pact",     "spell_id": 108416, "cooldown": 60,  "duration": 20}],
    "DestructionWarlock":  [{"name": "Dark Pact",     "spell_id": 108416, "cooldown": 60,  "duration": 20}],
    # Evokers
    "DevastationEvoker":   [
        {"name": "Obsidian Scales",  "spell_id": 363916, "cooldown": 90,  "duration": 12},
        {"name": "Renewing Blaze",   "spell_id": 374348, "cooldown": 90,  "duration": 8},
    ],
    "AugmentationEvoker":  [
        {"name": "Obsidian Scales",  "spell_id": 363916, "cooldown": 90,  "duration": 12},
    ],
}

# Major offensive cooldowns by WCL actor subType name.
# cooldown: base cooldown in seconds; duration: buff/effect duration in seconds.
SPEC_COOLDOWNS: dict[str, list[dict]] = {
    "RetributionPaladin": [
        {"name": "Avenging Wrath", "spell_id": 31884, "cooldown": 120, "duration": 20},
    ],
    "FireMage": [
        {"name": "Combustion", "spell_id": 190319, "cooldown": 120, "duration": 12},
    ],
    "ArcaneMage": [
        {"name": "Arcane Power", "spell_id": 12042, "cooldown": 120, "duration": 15},
    ],
    "FrostMage": [
        {"name": "Icy Veins", "spell_id": 12472, "cooldown": 180, "duration": 20},
    ],
    "HavocDemonHunter": [
        {"name": "Metamorphosis", "spell_id": 191427, "cooldown": 180, "duration": 30},
    ],
    "FuryWarrior": [
        {"name": "Recklessness", "spell_id": 1719, "cooldown": 90, "duration": 12},
    ],
    "ArmsWarrior": [
        {"name": "Avatar", "spell_id": 107574, "cooldown": 90, "duration": 20},
    ],
    "UnholyDeathKnight": [
        {"name": "Apocalypse", "spell_id": 220143, "cooldown": 90, "duration": 0},
        {"name": "Army of the Dead", "spell_id": 42650, "cooldown": 480, "duration": 0},
    ],
    "FrostDeathKnight": [
        {"name": "Pillar of Frost", "spell_id": 51271, "cooldown": 60, "duration": 12},
    ],
    "BalanceDruid": [
        {"name": "Celestial Alignment", "spell_id": 194223, "cooldown": 180, "duration": 20},
    ],
    "FeralDruid": [
        {"name": "Berserk", "spell_id": 106951, "cooldown": 180, "duration": 20},
    ],
    "BeastMasteryHunter": [
        {"name": "Bestial Wrath", "spell_id": 19574, "cooldown": 90, "duration": 15},
    ],
    "MarksmanshipHunter": [
        {"name": "Trueshot", "spell_id": 288613, "cooldown": 120, "duration": 15},
    ],
    "SurvivalHunter": [
        {"name": "Coordinated Assault", "spell_id": 360952, "cooldown": 120, "duration": 20},
    ],
    "WindwalkerMonk": [
        {"name": "Serenity", "spell_id": 152173, "cooldown": 90, "duration": 12},
    ],
    "ShadowPriest": [
        {"name": "Void Eruption", "spell_id": 228260, "cooldown": 90, "duration": 0},
    ],
    "AssassinationRogue": [
        {"name": "Deathmark", "spell_id": 360194, "cooldown": 120, "duration": 14},
    ],
    "OutlawRogue": [
        {"name": "Adrenaline Rush", "spell_id": 13750, "cooldown": 180, "duration": 20},
    ],
    "SubtletyRogue": [
        {"name": "Shadow Blades", "spell_id": 121471, "cooldown": 180, "duration": 20},
    ],
    "ElementalShaman": [
        {"name": "Fire Elemental", "spell_id": 198067, "cooldown": 150, "duration": 30},
    ],
    "EnhancementShaman": [
        {"name": "Ascendance", "spell_id": 114051, "cooldown": 180, "duration": 15},
    ],
    "AfflictionWarlock": [
        {"name": "Summon Darkglare", "spell_id": 205180, "cooldown": 180, "duration": 20},
    ],
    "DemonologyWarlock": [
        {"name": "Summon Demonic Tyrant", "spell_id": 265187, "cooldown": 60, "duration": 15},
    ],
    "DestructionWarlock": [
        {"name": "Summon Infernal", "spell_id": 1122, "cooldown": 180, "duration": 30},
    ],
    "DevastationEvoker": [
        {"name": "Dragonrage", "spell_id": 375087, "cooldown": 120, "duration": 18},
    ],
    "AugmentationEvoker": [
        {"name": "Breath of Eons", "spell_id": 403631, "cooldown": 120, "duration": 20},
    ],
}
