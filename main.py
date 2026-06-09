import json
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
from analyzer import analyze_player
from parses_analyzer import get_encounters, fetch_top_rankings, analyze_parse, build_parse_context
from scraper import scrape
from llm_parser import parse_guides
from wcl_client import WCLClient

app = FastAPI(title="WoW Progression Analyzer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

wcl = WCLClient()
STATIC_DIR = Path(__file__).parent / "static"


@app.on_event("startup")
async def startup():
    await db.init_db()


# ── Utilities ─────────────────────────────────────────────────────────────────

def _extract_code(url_or_code: str) -> str:
    m = re.search(r"/reports/([a-zA-Z0-9]+)", url_or_code)
    return m.group(1) if m else url_or_code.strip()


# ── Frontend ──────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def frontend():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/admin", include_in_schema=False)
async def admin_frontend():
    return FileResponse(STATIC_DIR / "admin.html")


# ── Player analysis API ───────────────────────────────────────────────────────

@app.get("/api/report/{code}")
async def get_report(code: str):
    try:
        data = await wcl.get_report(_extract_code(code))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    report = data["reportData"]["report"]
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    fights = sorted(
        [
            {
                "id": f["id"],
                "name": f["name"],
                "startTime": f["startTime"],
                "endTime": f["endTime"],
                "kill": f.get("kill"),
                "duration_s": round((f["endTime"] - f["startTime"]) / 1000, 1),
                "encounterID": f.get("encounterID"),
            }
            for f in report["fights"]
            if (f.get("encounterID") or 0) > 0
        ],
        key=lambda x: x["startTime"],
    )
    players = sorted(
        [
            {
                "id": a["id"],
                "name": a["name"],
                "spec": a.get("subType") or "Unknown",
                "server": a.get("server") or "",
            }
            for a in report["masterData"]["actors"]
        ],
        key=lambda x: x["name"],
    )
    return {"title": report.get("title", code), "fights": fights, "players": players}


class AnalyzeRequest(BaseModel):
    report_url: str
    fight_id: int
    player_id: int


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    code = _extract_code(req.report_url)

    try:
        report_data = await wcl.get_report(code)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    report = report_data["reportData"]["report"]
    fight = next((f for f in report["fights"] if f["id"] == req.fight_id), None)
    if not fight:
        raise HTTPException(status_code=404, detail="Fight not found")

    player = next(
        (a for a in report["masterData"]["actors"] if a["id"] == req.player_id), None
    )
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    start, end = fight["startTime"], fight["endTime"]
    try:
        cast_events = await wcl.get_all_events(code, req.fight_id, "Casts", start, end, source_id=req.player_id)
        buff_events = await wcl.get_all_events(code, req.fight_id, "Buffs", start, end, target_id=req.player_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Event fetch failed: {exc}")

    # Use dynamic rulebook when available (falls back to static inside analyze_player)
    spec = player.get("subType", "Unknown")
    spec_cds = db.get_spec_cooldowns(spec)

    return analyze_player(
        player=player,
        fight_start=start,
        fight_end=end,
        cast_events=cast_events,
        buff_events=buff_events,
        spec_cds_override=spec_cds,
    )


# ── Admin — Guides ────────────────────────────────────────────────────────────

class AddGuideRequest(BaseModel):
    spec: str
    url: str
    guide_type: str = "web"  # 'web' | 'youtube'


@app.get("/api/admin/guides/{spec}")
async def list_guides(spec: str):
    guides = await db.get_guides(spec)
    return {"guides": guides}


@app.post("/api/admin/guides")
async def add_guide(req: AddGuideRequest):
    guide_id = await db.add_guide(req.spec, req.url, req.guide_type)
    return {"id": guide_id, "message": "Guide added"}


@app.delete("/api/admin/guides/{guide_id}")
async def delete_guide(guide_id: int):
    guide = await db.get_guide(guide_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")
    await db.delete_guide(guide_id)
    return {"message": "Deleted"}


@app.post("/api/admin/guides/{guide_id}/scrape")
async def scrape_guide(guide_id: int):
    guide = await db.get_guide(guide_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")

    try:
        title, content = await scrape(guide["url"], guide["guide_type"])
        word_count = len(content.split())
        await db.update_guide_content(guide_id, title, content, word_count)
        return {"status": "scraped", "title": title, "word_count": word_count}
    except Exception as exc:
        await db.update_guide_error(guide_id, str(exc))
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/admin/guides/spec/{spec}/scrape-stream")
async def scrape_all_stream(spec: str):
    """SSE stream — yields one event per guide as it is scraped."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        guides = await db.get_guides(spec)
        total = len(guides)
        yield _evt({"type": "start", "total": total})
        scraped = errors = 0
        for i, g in enumerate(guides):
            yield _evt({"type": "progress", "step": i + 1, "total": total,
                        "url": g["url"], "guide_type": g["guide_type"]})
            try:
                title, content = await scrape(g["url"], g["guide_type"])
                word_count = len(content.split())
                await db.update_guide_content(g["id"], title, content, word_count)
                scraped += 1
                yield _evt({"type": "done", "step": i + 1, "total": total,
                            "id": g["id"], "title": title, "word_count": word_count})
            except Exception as exc:
                await db.update_guide_error(g["id"], str(exc))
                errors += 1
                yield _evt({"type": "error", "step": i + 1, "total": total,
                            "id": g["id"], "error": str(exc)})
        yield _evt({"type": "complete", "scraped": scraped, "errors": errors})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Admin — Rulebook generation ───────────────────────────────────────────────

@app.post("/api/admin/rulebook/{spec}/generate-stream")
async def generate_rulebook_stream(spec: str, encounter_id: Optional[int] = None):
    """SSE stream for rulebook generation — surfaces each stage to the UI."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        guides = await db.get_guides(spec)
        scraped = [g for g in guides if g["status"] == "scraped" and g.get("content")]
        if not scraped:
            yield _evt({"type": "error",
                        "error": "No scraped guides. Add and scrape at least one guide first."})
            return

        yield _evt({"type": "status", "message": f"Loaded {len(scraped)} guide(s)…",
                    "guide_count": len(scraped)})

        parse_context = ""
        if encounter_id:
            samples = await db.get_parse_samples(spec, encounter_id)
            if samples:
                parse_context = build_parse_context([s["cooldown_data"] for s in samples])
                yield _evt({"type": "status",
                            "message": f"Including {len(samples)} top-parse sample(s) as context…"})

        yield _evt({"type": "status",
                    "message": "Sending to Claude — extracting cooldown rules from guide text…"})

        texts = [g["content"] for g in scraped]
        try:
            rulebook = await parse_guides(spec, texts, parse_context)
        except Exception as exc:
            yield _evt({"type": "error", "error": str(exc)})
            return

        await db.save_rulebook(spec, rulebook, guide_count=len(scraped))
        yield _evt({"type": "complete", "rulebook": rulebook})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ManualRulebookRequest(BaseModel):
    rulebook: dict


@app.put("/api/admin/rulebook/{spec}")
async def save_manual_rulebook(spec: str, req: ManualRulebookRequest):
    """Persist a hand-crafted rulebook JSON directly, bypassing the LLM."""
    rb = req.rulebook
    if "major_cooldowns" not in rb:
        raise HTTPException(
            status_code=422,
            detail="JSON must contain a 'major_cooldowns' array.",
        )
    rb.setdefault("spec", spec)
    rb.setdefault("source_summary", "Manually defined")
    await db.save_rulebook(spec, rb, guide_count=0)
    return {"message": "Rulebook saved", "rulebook": rb}


@app.get("/api/admin/rulebook/{spec}")
async def get_rulebook(spec: str):
    row = await db.get_rulebook_row(spec)
    if row:
        import json
        return {
            "source": "generated",
            "spec": spec,
            "generated_at": row["generated_at"],
            "guide_count": row["guide_count"],
            "rulebook": json.loads(row["rulebook"]),
        }
    from rulebook import SPEC_COOLDOWNS
    static_cds = SPEC_COOLDOWNS.get(spec)
    if static_cds:
        return {"source": "static", "spec": spec, "cooldowns": static_cds}
    return {"source": "none", "spec": spec}


# ── Admin — Top parses ────────────────────────────────────────────────────────

@app.get("/api/admin/encounters")
async def list_encounters():
    try:
        encounters = await get_encounters(wcl)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"encounters": encounters}


class FetchParsesRequest(BaseModel):
    spec: str
    encounter_id: int
    count: int = 10
    analyze: bool = False  # if True, also fetch + analyze each parse's events


@app.post("/api/admin/parses/fetch")
async def fetch_parses(req: FetchParsesRequest):
    """Non-streaming rankings fetch (no deep analysis)."""
    try:
        result = await fetch_top_rankings(wcl, req.spec, req.encounter_id, req.count)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


@app.post("/api/admin/parses/analyze-stream")
async def analyze_parses_stream(req: FetchParsesRequest):
    """SSE stream — fetches rankings then deep-analyzes each parse one by one."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        # Step 1: rankings
        yield _evt({"type": "rankings_start"})
        try:
            result = await fetch_top_rankings(wcl, req.spec, req.encounter_id, req.count)
        except Exception as exc:
            yield _evt({"type": "error", "error": str(exc)})
            return
        yield _evt({"type": "rankings_done", "rankings": result["rankings"],
                    "encounter_name": result["encounter_name"]})

        # Step 2: per-parse event analysis
        rankings = result["rankings"]
        total = len(rankings)
        analyzed = []
        for i, ranking in enumerate(rankings):
            code = ranking.get("report_code")
            fight_id = ranking.get("fight_id")
            yield _evt({"type": "parse_progress", "step": i + 1, "total": total,
                        "player": ranking.get("player")})
            if not code or not fight_id:
                yield _evt({"type": "parse_skip", "step": i + 1, "player": ranking.get("player")})
                continue
            summary = await analyze_parse(wcl, req.spec, code, fight_id)
            if summary:
                await db.save_parse_sample(
                    spec=req.spec,
                    encounter_id=req.encounter_id,
                    encounter_name=result["encounter_name"],
                    report_code=code,
                    fight_id=fight_id,
                    player_name=summary["player"],
                    cooldown_data=summary,
                )
                analyzed.append(summary)
                yield _evt({"type": "parse_done", "step": i + 1, "total": total,
                            "summary": summary})
            else:
                yield _evt({"type": "parse_skip", "step": i + 1, "player": ranking.get("player")})

        parse_context = build_parse_context(analyzed)
        yield _evt({"type": "complete", "analyzed": len(analyzed),
                    "parse_context": parse_context})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
