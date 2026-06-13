# Frontend

Angular 22 app. All commands run from this directory (`frontend/`).

## Dev server

```bash
npm start        # Angular dev server on http://localhost:4200
```

## Build

```bash
npm run build    # Production build → ../static/angular/browser/ (gitignored)
```

The build is deployed to GitHub Pages via `.github/workflows/deploy-pages.yml` - never commit the output manually.

## Scripts

```bash
npm run ingest   # Fetch top WCL parses → write bench + sample files
npm run scrape   # Add and scrape guide URLs
npm run admin    # Rulebook management (generate prompt, save AI output)
```

All scripts write to `public/data/specs/` which Angular serves as static assets at `/data/specs/`.
