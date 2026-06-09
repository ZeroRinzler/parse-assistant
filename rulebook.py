BLOODLUST_SPELL_IDS = {2825, 32182, 80353, 90355, 264667, 390386}
BLOODLUST_DURATION_S = 40

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
