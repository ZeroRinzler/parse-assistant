import asyncio
import re
from concurrent.futures import ThreadPoolExecutor

from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession

_EXECUTOR = ThreadPoolExecutor(max_workers=4)

# curl_cffi impersonates Chrome at TLS level — bypasses Cloudflare (Wowhead, etc.)
_IMPERSONATE = "chrome120"

_GITHUB_BLOB_RE = re.compile(
    r"https://github\.com/([^/]+/[^/]+)/blob/([^/]+)/(.*)"
)


def _to_raw_url(url: str) -> str | None:
    """Convert a GitHub blob URL to its raw.githubusercontent.com equivalent."""
    m = _GITHUB_BLOB_RE.match(url)
    if m:
        repo, branch, path = m.groups()
        return f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
    return None


async def scrape_web(url: str) -> tuple[str, str]:
    """Fetch a web page and return (title, cleaned_text).
    Uses curl_cffi Chrome impersonation to bypass Cloudflare-protected sites."""
    async with AsyncSession() as session:
        resp = await session.get(url, impersonate=_IMPERSONATE, timeout=30)
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
    """Extract a YouTube transcript — (title, transcript_text).
    Uses youtube-transcript-api 1.x instance API."""
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound

    match = re.search(r"(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})", url)
    if not match:
        raise ValueError(f"Cannot parse YouTube video ID from: {url}")
    video_id = match.group(1)

    api = YouTubeTranscriptApi()
    loop = asyncio.get_event_loop()

    try:
        fetched = await loop.run_in_executor(
            _EXECUTOR,
            lambda: api.fetch(video_id, languages=["en", "en-US"]),
        )
    except (TranscriptsDisabled, NoTranscriptFound) as exc:
        raise ValueError(f"No English transcript available: {exc}") from exc

    text = " ".join(snippet.text for snippet in fetched)
    text = re.sub(r"\[.*?\]", "", text)  # strip [Music], [Applause] etc.
    text = re.sub(r" {2,}", " ", text).strip()

    return f"YouTube: {video_id}", text[:60_000]


async def scrape_raw(url: str) -> tuple[str, str]:
    """Fetch a plain-text file (SimC APL, raw GitHub, etc.) without HTML parsing."""
    async with AsyncSession() as session:
        resp = await session.get(url, impersonate=_IMPERSONATE, timeout=30)
        resp.raise_for_status()
    filename = url.rsplit("/", 1)[-1]
    return filename, resp.text[:60_000]


async def scrape(url: str, guide_type: str) -> tuple[str, str]:
    if guide_type == "youtube":
        return await scrape_youtube(url)
    raw_url = _to_raw_url(url)
    if raw_url:
        return await scrape_raw(raw_url)
    if guide_type == "simc":
        return await scrape_raw(url)
    return await scrape_web(url)
