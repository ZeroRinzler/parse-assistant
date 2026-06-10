#!/usr/bin/env python3
"""
Add and scrape a guide for a spec.

Used by:
  - GitHub Actions  (on workflow_dispatch — see .github/workflows/scrape-guides.yml)
  - Local dev       (python3 scripts/scrape_guides.py --spec SubtletyRogue --url https://... --type web)

This mirrors the admin page's Add + Scrape workflow in a CLI-friendly form.
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

import db
from scraper import scrape


async def main(spec: str, url: str, guide_type: str):
    await db.init_db()

    # Check if this URL already exists for the spec
    guides = await db.get_guides(spec)
    existing = next((g for g in guides if g["url"] == url), None)

    if existing:
        guide_id = existing["id"]
        print(f"Guide already exists (id={guide_id}), re-scraping...", flush=True)
    else:
        guide_id = await db.add_guide(spec, url, guide_type)
        print(f"Added guide id={guide_id} for {spec}", flush=True)

    print(f"Scraping {url} ...", flush=True)
    try:
        content = await scrape(url, guide_type)
    except Exception as exc:
        await db.update_guide_error(guide_id, str(exc))
        print(f"ERROR: {exc}", flush=True)
        sys.exit(1)

    await db.update_guide_content(guide_id, content)
    print(f"Done. Stored {len(content)} chars for {spec}.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Add and scrape a guide")
    parser.add_argument("--spec", required=True, help="WCL spec name, e.g. SubtletyRogue")
    parser.add_argument("--url", required=True, help="Guide URL")
    parser.add_argument("--type", dest="guide_type", default="web",
                        choices=["web", "youtube", "simc"],
                        help="Guide type (default: web)")
    args = parser.parse_args()
    asyncio.run(main(args.spec, args.url, args.guide_type))
