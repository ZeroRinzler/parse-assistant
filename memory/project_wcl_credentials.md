---
name: project-wcl-credentials
description: WCL OAuth2 client credentials stored in .env; as of 2026-06-11 the credentials returned 401
metadata:
  type: project
---

WCL client credentials (client_credentials OAuth2 flow) are in `.env` as `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET`.

As of 2026-06-11, the credentials in `.env` returned 401 from WCL's token endpoint. They likely expired or were rotated. The user will need to regenerate them at https://www.warcraftlogs.com/api/clients/.

**Why:** WCL OAuth client credentials can expire or be regenerated.

**How to apply:** If analysis endpoints return 401, suggest the user refresh their WCL API credentials and update `.env`. The static GitHub Pages frontend uses PKCE (browser-side) and is unaffected.
