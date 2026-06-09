import asyncio
import re
from concurrent.futures import ThreadPoolExecutor

import httpx
from bs4 import BeautifulSoup

_EXECUTOR = ThreadPoolExecutor(max_workers=4)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}


async def scrape_web(url: str) -> tuple[str, str]:
    """Fetch a web page and return (title, cleaned_text)."""
    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        resp = await client.get(url, headers=_HEADERS)
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "lxml")

    for tag in soup.find_all(["script", "style", "nav", "footer", "aside", "header"]):
        tag.decompose()

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else url

    main = (
        soup.find("article")
        or soup.find(attrs={"class": re.compile(r"guide|content|article", re.I)})
        or soup.find("main")
        or soup.find("body")
    )

    raw = main.get_text(separator="\n", strip=True) if main else ""
    text = re.sub(r"\n{3,}", "\n\n", raw)
    text = re.sub(r" {2,}", " ", text)

    return title, text[:60_000]


async def scrape_youtube(url: str) -> tuple[str, str]:
    """Extract a YouTube transcript and return (title, transcript_text)."""
    from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound

    match = re.search(r"(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})", url)
    if not match:
        raise ValueError(f"Cannot parse YouTube video ID from: {url}")
    video_id = match.group(1)

    loop = asyncio.get_event_loop()
    try:
        entries = await loop.run_in_executor(
            _EXECUTOR,
            lambda: YouTubeTranscriptApi.get_transcript(video_id, languages=["en", "en-US"]),
        )
    except (TranscriptsDisabled, NoTranscriptFound) as exc:
        raise ValueError(f"No English transcript available: {exc}") from exc

    text = " ".join(e["text"] for e in entries)
    text = re.sub(r"\[.*?\]", "", text)          # strip [Music], [Applause] etc.
    text = re.sub(r" {2,}", " ", text).strip()

    return f"YouTube: {video_id}", text[:60_000]


async def scrape(url: str, guide_type: str) -> tuple[str, str]:
    """Dispatch to the correct scraper based on guide_type."""
    if guide_type == "youtube":
        return await scrape_youtube(url)
    return await scrape_web(url)
