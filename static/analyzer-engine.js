// Browser-side analysis engine.
// Port of analyzer.py + the benchmark/comparison logic in main.py's /api/analyze endpoint.
// Reads rulebook + bench data from static JSON files in data/specs/.
// Fetches live WCL events via wcl.js (must be loaded first).

// ── Static data paths ─────────────────────────────────────────────────────────

const _DATA_BASE = (() => {
  const path = window.location.pathname;
  const idx  = path.indexOf('/static/');
  const root = idx >= 0 ? path.slice(0, idx) : '';
  return root + '/data/specs/';
})();

async function loadBenchData(spec, encounterId) {
  try {
    const r = await fetch(`${_DATA_BASE}${spec}/encounters/${encounterId}.json`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function loadRulebook(spec) {
  try {
    const r = await fetch(`${_DATA_BASE}${spec}/rulebook.json`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// Load the per-spec list of encounters that have ingested bench data.
async function loadSpecEncounters(spec) {
  try {
    const r = await fetch(`${_DATA_BASE}${spec}/encounters.json`);
    return r.ok ? r.json() : [];
  } catch { return []; }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function _fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function _mean(a)   { return a.reduce((s, x) => s + x, 0) / a.length; }
function _stdev(a)  {
  if (a.length < 2) return 0;
  const m = _mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// ── Rules engine ──────────────────────────────────────────────────────────────

function _evaluateRules(rules, completedCasts, fightStart, fightDurS) {
  const findings  = [];
  const castTimes = {};
  for (const c of completedCasts) {
    if (c.type === 'cast') {
      const sid = c.abilityGameID;
      if (sid) (castTimes[sid] ??= []).push((c.timestamp - fightStart) / 1000);
    }
  }

  for (const rule of rules) {
    const cond     = rule.condition;
    if (!cond) continue;
    const severity = rule.priority === 'critical' ? 'critical' : 'warning';
    const action   = rule.action || '';

    if (cond.kind === 'cast_without_prior') {
      const {spell_id: sid, required_spell_id: reqSid, spell_name, required_spell_name,
             window_s: win = 5, exception} = cond;
      const primary  = [...(castTimes[sid]  ?? [])].sort((a,b) => a-b);
      const required =   (castTimes[reqSid] ?? []);
      const violations = [];
      for (const t of primary) {
        if (required.some(rt => Math.abs(t - rt) <= win)) continue;
        if (exception) {
          const ctxCasts = castTimes[exception.context_spell_id] ?? [];
          const cw = exception.context_window_s ?? 20;
          const exempted = exception.position === 'before'
            ? ctxCasts.some(ct => t - ct >= 0 && t - ct <= cw)
            : ctxCasts.some(ct => ct - t >= 0 && ct - t <= cw);
          const la = exception.also_look_ahead_s;
          if (exempted || (la && ctxCasts.some(ct => ct - t > 0 && ct - t <= la))) continue;
        }
        violations.push(t);
      }
      if (violations.length) findings.push({
        severity, category: 'rule_violation',
        timestamp_ms: Math.round(violations[0] * 1000),
        message: `${spell_name} without ${required_spell_name}: ${violations.length} of ${primary.length} cast(s) lacked a paired ${required_spell_name} within ${win}s. Unpaired ${spell_name} windows waste the burst amplification.`,
        details: action ? {remedy: action} : null,
      });

    } else if (cond.kind === 'hold_cooldown_for_anchor') {
      const {spell_ids, spell_names, anchor_spell_id: aSid, anchor_spell_name, hold_window_s: hw = 15} = cond;
      const anchorTimes = [...(castTimes[aSid] ?? [])].sort((a,b) => a-b);
      const violations  = [];
      let firstT = null;
      for (const at of anchorTimes.slice(1)) {
        for (let i = 0; i < spell_ids.length; i++) {
          const sname = spell_names?.[i] ?? String(spell_ids[i]);
          for (const ct of (castTimes[spell_ids[i]] ?? [])) {
            if (ct >= at - hw && ct < at) {
              violations.push([sname, _fmt(ct), _fmt(at)]);
              firstT ??= ct;
            }
          }
        }
      }
      if (violations.length) {
        const sl = [...new Set(violations.map(v => v[0]))].sort().join(' / ');
        findings.push({
          severity, category: 'rule_violation',
          timestamp_ms: firstT !== null ? Math.round(firstT * 1000) : null,
          message: `${sl} spent in the ${hw}s hold window before ${anchor_spell_name}: ${violations.length} charge(s) used just before the burst window, reducing ${anchor_spell_name}-amplified damage.`,
          details: action ? {remedy: action} : null,
        });
      }
    }
  }
  return findings;
}

// ── Cooldown + efficiency analysis (port of analyzer.py) ─────────────────────

function _analyzePlayerCore({playerName, spec, fightStart, fightEnd,
                              castEvents, buffEvents, specCds, rules, bench}) {
  const fightDurMs = fightEnd - fightStart;
  const fightDurS  = fightDurMs / 1000;
  const rel = ts => ts - fightStart;

  const completedCasts = castEvents
    .filter(e => e.type === 'cast' && e.timestamp >= fightStart && e.timestamp <= fightEnd)
    .sort((a, b) => a.timestamp - b.timestamp);

  const findings = [];

  // Bloodlust
  let blTimeS = null;
  for (const e of buffEvents) {
    if (e.type === 'applybuff' && BLOODLUST_SPELL_IDS.has(e.abilityGameID)
        && e.timestamp >= fightStart && e.timestamp <= fightEnd) {
      blTimeS = rel(e.timestamp) / 1000; break;
    }
  }

  const downtimeThreshMs = bench?.downtime_threshold_ms ?? 1500;
  const perCdBench       = bench?.per_cd_benchmarks ?? {};
  const topEffPct        = bench?.top_avg_efficiency ?? null;
  const topEffStdev      = bench?.top_efficiency_stddev ?? null;

  if (!specCds) {
    findings.push({severity:'info', category:'unsupported_spec', timestamp_ms:null,
      message:`${spec} is not yet in the rulebook - cooldown rules will be added soon. Cast efficiency analysis still applies.`});
  } else {
    for (const cd of specCds) {
      const {spell_id: spellId, name: cdName, cooldown: cooldownS} = cd;
      const wantsBL = cd.align_with_bloodlust !== false;
      const cdCasts = completedCasts.filter(c => c.abilityGameID === spellId);
      const actual  = cdCasts.length;
      const expected = 1 + Math.floor(fightDurS / cooldownS);
      const cdIssues = [], cdSugg = [];

      // Lost casts
      if (actual === 0) {
        cdIssues.push({severity:'critical', category:'lost_cooldown', timestamp_ms:null,
          message:`${cdName} was never used. In a ${_fmt(fightDurS)} fight with a ${cooldownS}s cooldown you should have ${expected} cast(s). Use it at pull and on cooldown every ${cooldownS}s.`});
      } else if (actual < expected) {
        const lost = expected - actual;
        cdIssues.push({severity:'critical', category:'lost_cooldown', timestamp_ms:null,
          message:`${cdName} - ${actual} of ${expected} expected casts. Lost ${lost} use(s) in a ${_fmt(fightDurS)} fight (${cooldownS}s cooldown) - roughly ${Math.round(lost/expected*100)}% of this CD's potential.`});
      }

      const b = perCdBench[cdName];

      // First-cast delay
      if (cdCasts.length) {
        const firstS = rel(cdCasts[0].timestamp) / 1000;
        if (b?.avg_first_cast_s != null) {
          const avgF = b.avg_first_cast_s, sdF = b.stddev_first_cast_s ?? 10;
          if (firstS > avgF + 2 * sdF) cdIssues.push({severity:'warning', category:'cooldown_delay',
            timestamp_ms: rel(cdCasts[0].timestamp),
            message:`${cdName} opener at ${_fmt(firstS)} - ${(firstS-avgF).toFixed(0)}s later than top parsers (${_fmt(avgF)} avg ±${sdF.toFixed(0)}s on this encounter). A delayed opener on a ${cooldownS}s cooldown risks losing a use later.`});
        } else if (firstS > 30) {
          cdIssues.push({severity:'warning', category:'cooldown_delay',
            timestamp_ms: rel(cdCasts[0].timestamp),
            message:`${cdName} first cast at ${_fmt(firstS)} (${firstS.toFixed(0)}s into the fight). A late opener on a ${cooldownS}s cooldown risks losing a full use later.`});
        }
      }

      // BL alignment
      let blAligned = false;
      if (blTimeS !== null && cdCasts.length) {
        const blWin = cdCasts.filter(c => {
          const t = rel(c.timestamp)/1000;
          return t >= blTimeS - 30 && t <= blTimeS + BLOODLUST_DURATION_S + 15;
        });
        blAligned = blWin.length > 0;
        if (!blAligned && wantsBL) {
          const firstS = rel(cdCasts[0].timestamp)/1000;
          cdIssues.push({severity:'critical', category:'cooldown_alignment',
            timestamp_ms: rel(cdCasts[0].timestamp),
            message:`${cdName} missed Bloodlust (BL at ${_fmt(blTimeS)}, first cast at ${_fmt(firstS)} - ${Math.abs(firstS-blTimeS).toFixed(0)}s apart). Stacking all major CDs inside BL multiplies their value by ~30%.`});
        } else if (blAligned && wantsBL && b) {
          const offsets = blWin.map(c => rel(c.timestamp)/1000 - blTimeS);
          const po = offsets.reduce((best,x) => Math.abs(x)<Math.abs(best)?x:best);
          if (b.avg_bl_offset_s != null) {
            const sd = b.stddev_bl_offset_s ?? 5;
            if (Math.abs(po - b.avg_bl_offset_s) > 2 * sd) {
              const dir  = po > b.avg_bl_offset_s ? 'late' : 'early';
              const sign = v => v >= 0 ? `+${v.toFixed(0)}` : v.toFixed(0);
              cdIssues.push({severity:'warning', category:'cooldown_alignment',
                timestamp_ms: rel(blWin[0].timestamp),
                message:`${cdName} used at BL ${sign(po)}s - top parsers use it at BL ${sign(b.avg_bl_offset_s)}s (±${sd.toFixed(0)}s) on this encounter. Using it ${dir} in the Bloodlust window reduces overlap with the damage buff.`});
            }
          }
        }
      }

      // Gaps between casts
      for (let i = 1; i < cdCasts.length; i++) {
        const prevS = rel(cdCasts[i-1].timestamp)/1000;
        const currS = rel(cdCasts[i].timestamp)/1000;
        const gap   = currS - prevS;
        if (b?.avg_gap_s != null) {
          const sdG = b.stddev_gap_s ?? (cooldownS * 0.2);
          if (gap > b.avg_gap_s + 2 * sdG) cdIssues.push({severity:'warning', category:'cooldown_delay',
            timestamp_ms: rel(cdCasts[i].timestamp),
            message:`${cdName} at ${_fmt(currS)}: ${gap.toFixed(0)}s gap vs top-parse avg ${b.avg_gap_s.toFixed(0)}s (±${sdG.toFixed(0)}s) on this encounter. Held ${(gap-b.avg_gap_s).toFixed(0)}s longer than top performers typically do here.`});
        } else if (gap > cooldownS * 1.2) {
          cdIssues.push({severity:'warning', category:'cooldown_delay',
            timestamp_ms: rel(cdCasts[i].timestamp),
            message:`${cdName} held ${(gap-cooldownS).toFixed(0)}s past reset at ${_fmt(currS)} (${gap.toFixed(0)}s gap vs ${cooldownS}s cooldown). Each second held past reset is direct throughput loss.`});
        }
      }

      // Hold suggestions
      if (b?.hold_targets && cdCasts.length) {
        const times = cdCasts.map(c => rel(c.timestamp)/1000);
        for (const [idxStr, target] of Object.entries(b.hold_targets)) {
          const k = parseInt(idxStr, 10) - 1;
          if (k >= times.length) continue;
          const playerT = times[k], tol = Math.max(target.stddev_s ?? 20, 15);
          if (playerT < target.target_s - tol) cdSugg.push({severity:'info', category:'hold_suggestion',
            timestamp_ms: rel(cdCasts[k].timestamp),
            message:`${cdName} cast ${idxStr} used at ${_fmt(playerT)} - ${target.count}/${target.total_samples} top parsers hold until ~${_fmt(target.target_s)} here. A burst window or mechanic at ~${_fmt(target.target_s)} likely makes this optimal.`,
            details:{remedy:`Consider holding ${cdName} until ~${_fmt(target.target_s)} - top parsers consistently delay cast ${idxStr} here.`, actual_s:Math.round(playerT*10)/10, target_s:Math.round(target.target_s*10)/10, cd_name:cdName}});
        }
      }

      if (cdIssues.length) {
        cdIssues.forEach(f => f.cd_name = cdName);
        findings.push(...cdIssues);
      } else if (actual > 0) {
        const parts = [actual <= expected ? `${actual}/${expected} casts on cooldown` : `${actual} casts`];
        if (blTimeS !== null && wantsBL) parts.push(blAligned ? 'BL-aligned' : 'note: no BL overlap');
        findings.push({severity:'success', category:'cooldown_usage', timestamp_ms:null, cd_name:cdName,
          message:`${cdName} - ${parts.join(', ')}.`});
      }
      if (actual > 0) findings.push(...cdSugg);
    }
  }

  if (rules?.length) findings.push(..._evaluateRules(rules, completedCasts, fightStart, fightDurS));

  // Cast efficiency
  if (completedCasts.length >= 2) {
    const gaps = [];
    for (let i = 1; i < completedCasts.length; i++) {
      const gMs = rel(completedCasts[i].timestamp) - rel(completedCasts[i-1].timestamp);
      if (gMs > downtimeThreshMs) gaps.push({start_ms: rel(completedCasts[i-1].timestamp), duration_ms: gMs});
    }
    const totalDtS = gaps.reduce((s,g) => s+g.duration_ms, 0) / 1000;
    const effPct   = Math.max(0, (1 - totalDtS / fightDurS) * 100);
    if (totalDtS > 5) {
      const worst    = [...gaps].sort((a,b) => b.duration_ms-a.duration_ms).slice(0,3);
      const worstStr = worst.map(g => `${_fmt(g.start_ms/1000)} (${(g.duration_ms/1000).toFixed(1)}s gap)`).join(', ');
      let severity = 'warning', benchStr = 'no benchmark - run top-parse analysis for context';
      if (topEffPct != null) {
        const delta = effPct - topEffPct;
        benchStr = `top parses avg ${topEffPct.toFixed(0)}%`;
        severity = delta >= 0 ? 'success' : (topEffStdev != null && delta >= -topEffStdev ? 'warning' : (delta >= -7 ? 'warning' : 'critical'));
      }
      findings.push({severity, category:'cast_efficiency', timestamp_ms:null,
        message:`Cast efficiency: ${effPct.toFixed(1)}% (${benchStr}) - ${totalDtS.toFixed(1)}s in gaps >${(downtimeThreshMs/1000).toFixed(1)}s. Worst: ${worstStr}.`,
        details:{efficiency_pct:Math.round(effPct*10)/10, top_efficiency_pct:topEffPct, total_downtime_s:Math.round(totalDtS*10)/10, gap_count:gaps.length}});
    }
  }

  const order = {critical:0, warning:1, info:2, success:3};
  findings.sort((a,b) => (order[a.severity]??4)-(order[b.severity]??4));

  return {
    player: playerName, spec, fight_duration_s: Math.round(fightDurS*10)/10,
    bloodlust_time: blTimeS != null ? _fmt(blTimeS) : null,
    total_casts: completedCasts.length, findings,
  };
}

// ── Player burst windows ──────────────────────────────────────────────────────

function _findPlayerBurstWindows(dmgEvents, fightStart, specCds, castEvents) {
  if (!dmgEvents?.length) { console.warn('[BurstWindows] dmgEvents empty'); return []; }
  const sorted = dmgEvents.filter(e=>e.timestamp>=fightStart&&((e.amount||0)+(e.absorbed||0))>0)
    .sort((a,b)=>a.timestamp-b.timestamp);
  if (dmgEvents.length > 0 && sorted.length === 0)
    console.warn('[BurstWindows] all events filtered out - sample:', JSON.stringify(dmgEvents[0]));
  if (!sorted.length) return [];

  const WINDOW_S = 8;
  const totalDmg = sorted.reduce((s,e)=>s+(e.amount||0)+(e.absorbed||0),0) || 1;

  const candidates = sorted.map(e => {
    const tS = (e.timestamp-fightStart)/1000;
    const tot = sorted.filter(f=>{const ft=(f.timestamp-fightStart)/1000;return ft>=tS&&ft<tS+WINDOW_S;})
                      .reduce((s,f)=>s+(f.amount||0)+(f.absorbed||0),0);
    return {time_s:Math.round(tS*10)/10, total:tot};
  });

  const peaks = [...candidates].sort((a,b)=>b.total-a.total);
  const result = [];
  for (const w of peaks) {
    if (result.length >= 4) break;
    if (result.some(r=>Math.abs(r.time_s-w.time_s)<WINDOW_S)) continue;
    result.push(w);
  }
  result.sort((a,b)=>a.time_s-b.time_s);

  return result.map(w => {
    const active = [];
    if (specCds) {
      for (const cd of specCds) {
        if (!(cd.duration>0)) continue;
        const casts = castEvents.filter(c=>c.type==='cast'&&c.abilityGameID===cd.spell_id&&c.timestamp>=fightStart);
        for (const c of casts) {
          const ct = (c.timestamp-fightStart)/1000;
          if (ct<=w.time_s&&w.time_s<=ct+cd.duration){active.push(cd.name);break;}
        }
      }
    }
    // Per-ability breakdown within this 8s window
    const winEvents = sorted.filter(e => {
      const tS = (e.timestamp-fightStart)/1000;
      return tS >= w.time_s && tS < w.time_s + WINDOW_S;
    });
    const winTotal = winEvents.reduce((s,e)=>s+(e.amount||0)+(e.absorbed||0),0) || 1;
    const byAb = {};
    for (const e of winEvents) {
      if (e.abilityGameID) byAb[e.abilityGameID] = (byAb[e.abilityGameID]||0) + (e.amount||0) + (e.absorbed||0);
    }
    const ability_breakdown = Object.entries(byAb)
      .sort((a,b)=>b[1]-a[1]).slice(0,10)
      .map(([sid,dmg])=>({spell_id:parseInt(sid,10), pct:Math.round(dmg/winTotal*1000)/1000}));

    return {time_s:w.time_s, pct_of_total:Math.round(w.total/totalDmg*1000)/1000, active_cds:active, ability_breakdown};
  });
}

// ── Defensives ────────────────────────────────────────────────────────────────

const SPEC_DEFENSIVES_JS = {
  "SubtletyRogue":      [{name:"Cloak of Shadows",spell_id:31224,cooldown:60,duration:5},{name:"Evasion",spell_id:5277,cooldown:120,duration:10}],
  "AssassinationRogue": [{name:"Cloak of Shadows",spell_id:31224,cooldown:60,duration:5},{name:"Evasion",spell_id:5277,cooldown:120,duration:10}],
  "OutlawRogue":        [{name:"Cloak of Shadows",spell_id:31224,cooldown:60,duration:5},{name:"Evasion",spell_id:5277,cooldown:120,duration:10}],
  "HavocDemonHunter":   [{name:"Blur",spell_id:198589,cooldown:60,duration:10},{name:"Darkness",spell_id:196718,cooldown:180,duration:8}],
  "FireMage":           [{name:"Ice Block",spell_id:45438,cooldown:240,duration:10}],
  "ArcaneMage":         [{name:"Ice Block",spell_id:45438,cooldown:240,duration:10}],
  "FrostMage":          [{name:"Ice Block",spell_id:45438,cooldown:240,duration:10}],
  "RetributionPaladin": [{name:"Divine Shield",spell_id:642,cooldown:300,duration:8},{name:"Lay on Hands",spell_id:633,cooldown:600,duration:0}],
  "ShadowPriest":       [{name:"Dispersion",spell_id:47585,cooldown:120,duration:6},{name:"Fade",spell_id:586,cooldown:30,duration:10}],
  "FuryWarrior":        [{name:"Die by the Sword",spell_id:118038,cooldown:120,duration:10}],
  "ArmsWarrior":        [{name:"Die by the Sword",spell_id:118038,cooldown:120,duration:10}],
  "UnholyDeathKnight":  [{name:"Anti-Magic Shell",spell_id:48707,cooldown:45,duration:5},{name:"Icebound Fortitude",spell_id:48792,cooldown:180,duration:8}],
  "FrostDeathKnight":   [{name:"Anti-Magic Shell",spell_id:48707,cooldown:45,duration:5},{name:"Icebound Fortitude",spell_id:48792,cooldown:180,duration:8}],
  "BalanceDruid":       [{name:"Barkskin",spell_id:22812,cooldown:60,duration:12},{name:"Survival Instincts",spell_id:61336,cooldown:180,duration:6}],
  "FeralDruid":         [{name:"Survival Instincts",spell_id:61336,cooldown:180,duration:6},{name:"Barkskin",spell_id:22812,cooldown:60,duration:12}],
  "WindwalkerMonk":     [{name:"Fortifying Brew",spell_id:115203,cooldown:90,duration:15},{name:"Touch of Karma",spell_id:122470,cooldown:90,duration:10}],
  "ElementalShaman":    [{name:"Astral Shift",spell_id:108271,cooldown:90,duration:12}],
  "EnhancementShaman":  [{name:"Astral Shift",spell_id:108271,cooldown:90,duration:12}],
  "AfflictionWarlock":  [{name:"Dark Pact",spell_id:108416,cooldown:60,duration:20}],
  "DemonologyWarlock":  [{name:"Dark Pact",spell_id:108416,cooldown:60,duration:20}],
  "DestructionWarlock": [{name:"Dark Pact",spell_id:108416,cooldown:60,duration:20}],
  "DevastationEvoker":  [{name:"Obsidian Scales",spell_id:363916,cooldown:90,duration:12},{name:"Renewing Blaze",spell_id:374348,cooldown:90,duration:8}],
  "AugmentationEvoker": [{name:"Obsidian Scales",spell_id:363916,cooldown:90,duration:12}],
  "BeastMasteryHunter": [{name:"Exhilaration",spell_id:109304,cooldown:120,duration:0}],
  "MarksmanshipHunter": [{name:"Exhilaration",spell_id:109304,cooldown:120,duration:0}],
  "SurvivalHunter":     [{name:"Exhilaration",spell_id:109304,cooldown:120,duration:0}],
};

function _analyzeDefensives(spec, castEvents, buffEvents, dtEvents, fightStart, fightEnd) {
  const defs = SPEC_DEFENSIVES_JS[spec] || [];
  const rel  = ts => ts-fightStart;
  const buffWin = {};
  for (const e of buffEvents) {
    const sid = e.abilityGameID, tS = rel(e.timestamp)/1000;
    if (e.type==='applybuff') (buffWin[sid]??=[]).push([tS,null]);
    else if (e.type==='removebuff') {
      for (let i=(buffWin[sid]?.length??0)-1;i>=0;i--)
        if (buffWin[sid][i][1]===null){buffWin[sid][i][1]=tS;break;}
    }
  }
  return defs.map(def => {
    const {spell_id:sid, duration:dur=0} = def;
    let windows = (buffWin[sid]||[]).map(([wS,wE]) => {
      const end = wE??(wS+(dur||5));
      const dmg = dtEvents.filter(e=>e.type==='damage')
        .reduce((s,e)=>{const t=rel(e.timestamp)/1000;return t>=wS&&t<=end?s+(e.amount||0)+(e.absorbed||0):s;},0);
      return {start_s:Math.round(wS*10)/10, end_s:Math.round(end*10)/10, dmg_during:Math.round(dmg)};
    });
    if (!windows.length) {
      windows = castEvents.filter(c=>c.type==='cast'&&c.abilityGameID===sid&&c.timestamp>=fightStart&&c.timestamp<=fightEnd)
        .map(c=>{
          const tS=rel(c.timestamp)/1000, wE=tS+(dur||5);
          const dmg=dtEvents.filter(e=>e.type==='damage').reduce((s,e)=>{const t=rel(e.timestamp)/1000;return t>=tS&&t<=wE?s+(e.amount||0)+(e.absorbed||0):s;},0);
          return {start_s:Math.round(tS*10)/10, end_s:Math.round(wE*10)/10, dmg_during:Math.round(dmg)};
        });
    }
    return {name:def.name, spell_id:sid, cooldown:def.cooldown, uses:windows.length, windows};
  });
}

// ── Damage taken ──────────────────────────────────────────────────────────────

function _analyzeDamageTaken(dtEvents, abilityMap, fightStart, fightEnd) {
  const fightDurS = (fightEnd-fightStart)/1000, segS=30;
  const nSegs = Math.max(1, Math.floor(fightDurS/segS)+1);
  const segs  = Array(nSegs).fill(0);
  const byAb  = {};
  for (const e of dtEvents) {
    const amt=(e.amount||0)+(e.absorbed||0); if(!amt) continue;
    const tS=(e.timestamp-fightStart)/1000;
    segs[Math.min(Math.floor(tS/segS),nSegs-1)] += amt;
    if (e.abilityGameID) byAb[e.abilityGameID]=(byAb[e.abilityGameID]||0)+amt;
  }
  const total = segs.reduce((a,b)=>a+b,0);
  const segmentPcts = segs.map(s => total ? Math.round(s/total*10000)/10000 : 0);
  const top = Object.entries(byAb).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([sid,dmg])=>({spell_id:parseInt(sid,10), name:abilityMap[sid]?.name||'', damage:Math.round(dmg), pct:total?Math.round(dmg/total*1000)/1000:0}));
  return {segments:segs, segmentPcts, top, total:Math.round(total)};
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runAnalysis({reportCode, fightId, playerId, fights, masterAbilities, playerName}) {
  const fight = fights.find(f=>f.id===fightId);
  if (!fight) throw new Error('Fight not found');
  const {startTime:fStart, endTime:fEnd, encounterID} = fight;

  const abilityMap = {};
  for (const a of (masterAbilities||[])) if (a.gameID) abilityMap[String(a.gameID)]={name:a.name||'',icon:a.icon||''};

  // Resolve spec first (needed to load rulebook + bench in parallel with events)
  const specMap = await wclGetPlayerDetails(reportCode, fightId);
  const spec    = specMap[playerId] || 'Unknown';
  const pName   = specMap[`name_${playerId}`] || playerName || `Player ${playerId}`;

  // Now parallelise all remaining network calls
  const [castEvents, buffEvents, dmgEvents, dtEvents, rulebook, bench] = await Promise.all([
    wclGetAllEvents(reportCode, fightId, 'Casts',       fStart, fEnd, playerId, null),
    wclGetAllEvents(reportCode, fightId, 'Buffs',       fStart, fEnd, null,     playerId),
    wclGetAllEvents(reportCode, fightId, 'DamageDone',  fStart, fEnd, playerId, null),
    wclGetAllEvents(reportCode, fightId, 'DamageTaken', fStart, fEnd, null, playerId),
    spec !== 'Unknown' ? loadRulebook(spec) : Promise.resolve(null),
    (encounterID && spec !== 'Unknown') ? loadBenchData(spec, encounterID) : Promise.resolve(null),
  ]);
  const specCds = rulebook?.major_cooldowns ?? null;
  const rules   = rulebook?.rules ?? [];
  const rbSrc   = rulebook ? 'generated' : (spec !== 'Unknown' ? 'none' : 'none');
  console.log(`[Analysis] spec=${spec} cast=${castEvents.length} buff=${buffEvents.length} dmg=${dmgEvents.length} dtk=${dtEvents.length}`);

  const result = _analyzePlayerCore({
    playerName: pName, spec, fightStart: fStart, fightEnd: fEnd,
    castEvents, buffEvents, specCds, rules, bench,
  });
  result.spec                   = spec;
  result.rulebook_source        = rbSrc;
  result.player_fight_duration_s = result.fight_duration_s;
  result.cd_spell_ids           = Object.fromEntries((specCds||[]).map(cd=>[cd.name,cd.spell_id]));
  result.ability_icons          = abilityMap;

  if (bench && specCds) {
    if (bench.downtime_threshold_ms != null) result.downtime_threshold_ms = bench.downtime_threshold_ms;
    if (bench.top_avg_efficiency  != null) result.top_efficiency_pct   = bench.top_avg_efficiency;
    if (bench.top_efficiency_stddev!=null) result.top_efficiency_stddev = bench.top_efficiency_stddev;
    if (bench.burst_windows?.length) result.burst_windows = bench.burst_windows;
  }

  result.player_burst_windows        = _findPlayerBurstWindows(dmgEvents, fStart, specCds, castEvents);
  result.player_defensives           = _analyzeDefensives(spec, castEvents, buffEvents, dtEvents, fStart, fEnd);
  if (bench?.top_defensives_summary?.length) result.top_defensives_summary = bench.top_defensives_summary;
  if (bench?.top_dtk_comparison?.length)    result.top_dtk_comparison     = bench.top_dtk_comparison;
  if (bench?.top_dtk_segments?.length)      result.top_dtk_segments       = bench.top_dtk_segments;
  const dtk                                = _analyzeDamageTaken(dtEvents, abilityMap, fStart, fEnd);
  result.player_dmg_taken_segments        = dtk.segments;
  result.player_dmg_taken_segment_pcts    = dtk.segmentPcts;
  result.player_dmg_taken_by_ability      = dtk.top;
  result.player_total_dmg_taken           = dtk.total;
  result.dmg_segment_size_s               = 30;

  return result;
}
