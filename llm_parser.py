import json
import os
import re

import anthropic

_SYSTEM = """\
You are a World of Warcraft expert specializing in Mythic raiding optimization.

Analyze the provided guide text(s) for {spec} and extract a structured rotation rulebook.
This rulebook will drive an automated analysis system that evaluates real player logs.

Return ONLY valid JSON — no markdown fences, no explanation — matching this exact schema:
{{
  "spec": "{spec}",
  "major_cooldowns": [
    {{
      "name": "Exact Ability Name",
      "spell_id": 12345,
      "cooldown": 120,
      "duration": 20,
      "align_with_bloodlust": true,
      "opener_priority": 1,
      "usage_rule": "One concise sentence on when/how to use this ability"
    }}
  ],
  "rules": [
    {{
      "type": "cooldown_pairing|cd_hold|opener|rotation|positioning|aoe_switch",
      "priority": "critical|high|medium|low",
      "description": "Clear, actionable rule title",
      "condition": null,
      "action": "Prescriptive fix the player should take"
    }}
  ],
  "source_summary": "One sentence describing what these sources cover"
}}

Field guidelines:
- spell_id: exact WoW spell ID if you are certain; 0 if unsure
- cooldown: base cooldown in seconds before talents/CDR
- duration: buff/effect duration in seconds; 0 for instant-effects
- align_with_bloodlust: true when this CD should be held for or synced with Bloodlust
- opener_priority: 1 = cast first in pull, 2 = second, etc.; 0 = not part of opener
- Include only major offensive cooldowns that define DPS burst windows
- Rules: prefer evaluatable types (cooldown_pairing, cd_hold) over vague ones
- condition: leave null unless you can express it as one of these machine-readable objects:
  - cast_without_prior: {{"kind":"cast_without_prior","spell_id":N,"spell_name":"Name","required_spell_id":N,"required_spell_name":"Name","window_s":5,"exception":{{"context_spell_id":N,"context_window_s":25,"position":"before"}}}}
  - hold_cooldown_for_anchor: {{"kind":"hold_cooldown_for_anchor","spell_ids":[N,N],"spell_names":["A","B"],"anchor_spell_id":N,"anchor_spell_name":"Name","hold_window_s":15}}
"""


async def parse_guides(spec: str, guide_texts: list[str], parse_context: str = "") -> dict:
    """Send guide text(s) to Claude and return a parsed rulebook dict."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError(
            "ANTHROPIC_API_KEY is not set. Add it to your .env file."
        )

    combined = "\n\n---\n\n".join(
        f"[Source {i + 1}]\n{text}" for i, text in enumerate(guide_texts)
    )
    if parse_context:
        combined += f"\n\n---\n\n[Top Parse Context]\n{parse_context}"

    # Hard cap to avoid token limits
    if len(combined) > 90_000:
        combined = combined[:90_000] + "\n\n[Content truncated for length]"

    client = anthropic.AsyncAnthropic(api_key=api_key)

    msg = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        system=_SYSTEM.format(spec=spec),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Produce the structured rulebook for {spec} "
                    f"based on the following sources:\n\n{combined}"
                ),
            }
        ],
    )

    raw = msg.content[0].text.strip()
    # Strip any accidental markdown fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    return json.loads(raw)
