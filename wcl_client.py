import os
import time
from typing import Optional
import httpx
from dotenv import load_dotenv

load_dotenv()

WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token"
WCL_API_URL = "https://www.warcraftlogs.com/api/v2/client"

REPORT_QUERY = """
query GetReport($code: String!) {
  reportData {
    report(code: $code) {
      title
      fights(killType: All) {
        id
        name
        startTime
        endTime
        kill
        encounterID
        difficulty
        friendlyPlayers
      }
      masterData {
        actors(type: "Player") {
          id
          name
          subType
          server
        }
        abilities {
          gameID
          name
          icon
        }
      }
    }
  }
}
"""

PLAYER_DETAILS_QUERY = """
query GetPlayerDetails($code: String!, $fightIDs: [Int]!) {
  reportData {
    report(code: $code) {
      playerDetails(fightIDs: $fightIDs)
    }
  }
}
"""

EVENTS_QUERY = """
query GetEvents(
  $code: String!
  $fightIDs: [Int]!
  $dataType: EventDataType
  $sourceID: Int
  $targetID: Int
  $startTime: Float
  $endTime: Float
  $filterExpression: String
) {
  reportData {
    report(code: $code) {
      events(
        fightIDs: $fightIDs
        dataType: $dataType
        sourceID: $sourceID
        targetID: $targetID
        startTime: $startTime
        endTime: $endTime
        filterExpression: $filterExpression
        limit: 10000
      ) {
        data
        nextPageTimestamp
      }
    }
  }
}
"""


CHARACTER_QUERY = """
query($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      classID
      recentReports(limit: 5) {
        data { code startTime }
      }
    }
  }
}
"""


class WCLClient:
    def __init__(self):
        self.client_id = os.environ.get("WCL_CLIENT_ID", "")
        self.client_secret = os.environ.get("WCL_CLIENT_SECRET", "")
        if not self.client_id or not self.client_secret:
            raise RuntimeError("WCL_CLIENT_ID and WCL_CLIENT_SECRET must be set in .env")
        self._token: str | None = None
        self._token_expiry: float = 0.0

    async def _get_token(self) -> str:
        # Reuse cached token until 60s before expiry
        if self._token and time.time() < self._token_expiry - 60:
            return self._token
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                WCL_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
                timeout=15.0,
            )
            resp.raise_for_status()
            body = resp.json()
            self._token = body["access_token"]
            # WCL tokens are valid for 86400s; default to 3600s if not specified
            self._token_expiry = time.time() + body.get("expires_in", 3600)
            return self._token

    async def query(self, gql: str, variables: dict | None = None) -> dict:
        token = await self._get_token()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                WCL_API_URL,
                json={"query": gql, "variables": variables or {}},
                headers={"Authorization": f"Bearer {token}"},
                timeout=30.0,
            )
            resp.raise_for_status()
            body = resp.json()
            if "errors" in body:
                raise ValueError(f"GraphQL error: {body['errors']}")
            return body["data"]

    async def get_report(self, code: str) -> dict:
        return await self.query(REPORT_QUERY, {"code": code})

    async def get_character(self, name: str, server_slug: str, server_region: str) -> dict:
        return await self.query(CHARACTER_QUERY, {
            "name": name,
            "serverSlug": server_slug,
            "serverRegion": server_region,
        })

    async def get_player_details(self, code: str, fight_id: int) -> dict:
        return await self.query(PLAYER_DETAILS_QUERY, {"code": code, "fightIDs": [fight_id]})

    async def get_enchant_names(self, enchant_ids: list[int]) -> dict[int, str]:
        """Return {enchant_id: name} via gameData.enchant(id) aliased queries."""
        if not enchant_ids:
            return {}
        parts = [f"e{eid}: enchant(id: {eid}) {{ id name }}" for eid in enchant_ids]
        gql = "query { gameData { " + " ".join(parts) + " } }"
        data = await self.query(gql)
        game_data = (data or {}).get("gameData") or {}
        return {
            eid: (game_data.get(f"e{eid}") or {}).get("name") or ""
            for eid in enchant_ids
        }

    async def get_all_events(
        self,
        code: str,
        fight_id: int,
        data_type: str,
        start_time: float,
        end_time: float,
        source_id: Optional[int] = None,
        target_id: Optional[int] = None,
        filter_expression: Optional[str] = None,
    ) -> list[dict]:
        events: list[dict] = []
        current_start = start_time

        while True:
            variables: dict = {
                "code": code,
                "fightIDs": [fight_id],
                "dataType": data_type,
                "startTime": current_start,
                "endTime": end_time,
            }
            if source_id is not None:
                variables["sourceID"] = source_id
            if target_id is not None:
                variables["targetID"] = target_id
            if filter_expression is not None:
                variables["filterExpression"] = filter_expression

            data = await self.query(EVENTS_QUERY, variables)
            page = data["reportData"]["report"]["events"]

            events.extend(page.get("data") or [])

            next_ts = page.get("nextPageTimestamp")
            if next_ts is None:
                break
            current_start = next_ts

        return events
