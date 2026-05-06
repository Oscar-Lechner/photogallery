# Photo Gallery

A minimal static gallery for sharing camera rolls without pushing everything through a cloud service. Drop photos, run one command, get a shareable URL.

## Workflow

```
photos/
  costa rica/
    DSCF3001.JPG
    DSCF3002.JPG
    cooper/
      DSCF3048.JPG
  discolines/
    IMG_1489.JPG
```

1. **Drop photos** into `photos/`. Subfolders become albums automatically — nesting is preserved in the album name (`costa rica › cooper`).

2. **Index**: `npm run index`
   Walks `photos/`, writes `data/photos.json` with metadata (album paths, file timestamps, sizes). Prints a summary by album.

3. **Dev server**: `npm run dev` (or `npm start`)
   Runs the indexer, then starts a local server. Open the printed URL.

4. **Share**: use the **Share album** button to copy the current URL to your clipboard. The URL encodes album, sort, and search state so recipients see exactly your view.

## URL state

| Parameter | Values | Default |
|-----------|--------|---------|
| `?album=` | album path (e.g. `cameraflicks / costa rica`) | all photos |
| `?sort=` | `album`, `name`, `date`, `random` | `album` |
| `?q=` | search query | — |

## Deploy

After `npm run index`, the site is a folder of static files. Copy everything except `node_modules/` and `photos/` to any static host (Netlify, Vercel, Caddy, nginx, S3, etc.).

Photos are gitignored by default. If you want to commit them, remove the `photos/*` line from `.gitignore`.

## Adding photos later

Drop new files into `photos/`, run `npm run index` again, redeploy. Existing album links continue working.
