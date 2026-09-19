# access-search

UKY-backed documentation search for the ACCESS support /find page.

Deployed at <https://connectci-access-search.netlify.app>.

## Embedding

The widget mounts on a div and renders no heading of its own, so the embedding
page supplies its own section heading and styling context.

```html
<link rel="stylesheet" href="https://connectci-access-search.netlify.app/search.css" />
<div id="access-search"
     data-api-base="https://connectci-access-search.netlify.app/api/search"></div>
<script src="https://connectci-access-search.netlify.app/search.js"></script>
```

`data-api-base` is required when embedding from another origin: without it the
widget falls back to a relative `/api/search`, which would resolve against the
embedding page rather than this site. The embedding origin must also appear in
`ALLOWED_ORIGINS` or the browser will block the request.

Load `search.js` as a classic script, not a module.

### The support site's /find page

`/find` on support.access-ci.org is Drupal node 459, and the embed lives in the
node's **body field**, not in a theme template. The body uses the
`full_no_editor` text format, which passes `<script>` and `<link>` through
unchanged.

This replaces the old Elastic-backed React app, which loaded from
`musical-bubblegum-000179.netlify.app` into `<div id="root">`. Paste the
following into the body field to cut over, and restore the previous markup to
roll back. Nothing needs redeploying on either side, so both the switch and its
rollback are a content edit.

```html
<div class="bg-white pb-20">
  <div class="prose text-dark-teal text-2xl leading-9 mb-10">Search ACCESS and Resource Provider websites and documentation.</div>
  <link href="https://connectci-access-search.netlify.app/search.css" rel="stylesheet" />
  <div class="app-container text-start" id="access-search" data-api-base="https://connectci-access-search.netlify.app/api/search"></div>
  <script src="https://connectci-access-search.netlify.app/search.js"></script>
</div>
```

Do not cut over until queries return results across every content type. As of
2026-09-18 the upstream corpus returns HTTP 500 for event and announcement
queries while documentation queries succeed, so `/find` would error on a whole
category of content. See D8-2828.

## Environment variables

- `UKY_API_KEY`: API key for UKY backend
- `UKY_RETRIEVE_URL`: URL for UKY retrieve endpoint
- `ALLOWED_ORIGINS`: Comma-separated list of allowed origins for CORS

## Local development

Copy `.env.example` to `.env` and fill in the UKY values. `.env` is gitignored
and must stay that way — the API key is server-side only.

```bash
npm ci
npm test        # typecheck + vitest
netlify dev     # serves public/ and the function at /api/search
```

## Deploying

The Netlify site `connectci-access-search` is linked to this repository, so
merging to `main` deploys to <https://connectci-access-search.netlify.app>.
Pull requests get their own deploy preview.

There is no build step — `public/` is published as-is and `netlify.toml` points
at the functions directory.

To deploy from a working copy without merging:

```bash
netlify deploy --prod
```

## License

Apache-2.0. See [LICENSE](LICENSE).
