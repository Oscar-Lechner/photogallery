/**
 * deploy.mjs — full publish pipeline
 *
 * Drop photos into photos/cameraflicks/<album>/, then run:
 *   npm run deploy
 *
 * What it does:
 *   1. Reads GITHUB_TOKEN from .env (or environment)
 *   2. Detects the GitHub repo from your git remote
 *   3. Gets or creates a GitHub Release tagged "photos" to store originals
 *   4. Uploads only NEW photos to the release (incremental — skips already-uploaded)
 *   5. Generates WebP thumbnails for new photos
 *   6. Updates data/release-manifest.json (tracks what's been uploaded)
 *   7. Rebuilds data/photos.json
 *   8. Untracks photos/ from git if currently tracked (moves them to gitignored)
 *   9. Commits thumbnails + data + any git removals, then pushes
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkPhotos, ensureThumbnail, buildIndex } from "./build-gallery.mjs";

const root         = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir      = path.join(root, "data");
const manifestPath = path.join(dataDir, "release-manifest.json");
const RELEASE_TAG  = "photos";

// ── Concurrency helpers ───────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Auth & repo detection ─────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  readFileSync(envPath, "utf8").replace(/^﻿/, "").split(/\r?\n/).forEach(line => {
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/);
    if (!m) return;
    const val = m[2].replace(/^["']|["']$/g, "").trim();
    if (!process.env[m[1]]) process.env[m[1]] = val;
  });
}

function requireToken() {
  loadDotEnv();
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("\nGITHUB_TOKEN not set.");
    console.error("1. Go to https://github.com/settings/tokens");
    console.error("2. Generate a classic token with the 'repo' scope");
    console.error("3. Create a .env file in this directory:");
    console.error("   GITHUB_TOKEN=ghp_your_token_here\n");
    process.exit(1);
  }
  return token;
}

function detectRepo() {
  const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
  const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse GitHub repo from remote: ${remote}`);
  const [owner, repo] = m[1].split("/");
  return { owner, repo };
}

// ── GitHub API ────────────────────────────────────────────────────────────────

async function ghFetch(token, method, url, body) {
  const isBuffer = Buffer.isBuffer(body);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(isBuffer
        ? { "Content-Type": "application/octet-stream" }
        : body
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: isBuffer ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${url}\n  → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getOrCreateRelease(token, owner, repo) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    return await ghFetch(token, "GET", `${base}/releases/tags/${RELEASE_TAG}`);
  } catch {
    console.log(`  Creating GitHub Release "${RELEASE_TAG}"...`);
    return await ghFetch(token, "POST", `${base}/releases`, {
      tag_name: RELEASE_TAG,
      name: "Photo Archive",
      body: "Original-quality photos. Auto-managed by deploy.mjs — do not edit manually.",
      draft: false,
      prerelease: false,
    });
  }
}

// Release assets are flat — encode path separators as "--"
function toAssetName(relPath) {
  return relPath.replace(/\//g, "--");
}

function toDownloadUrl(owner, repo, assetName) {
  return `https://github.com/${owner}/${repo}/releases/download/${RELEASE_TAG}/${encodeURIComponent(assetName)}`;
}

async function uploadAsset(token, owner, repo, releaseId, assetName, data) {
  return await ghFetch(
    token,
    "POST",
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    data
  );
}

// ── Manifest ──────────────────────────────────────────────────────────────────

function loadManifest() {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const token         = requireToken();
  const { owner, repo } = detectRepo();

  console.log(`\nDeploying to github.com/${owner}/${repo}\n`);

  const manifest   = loadManifest();
  const localPhotos = await walkPhotos();

  const newPhotos = localPhotos.filter(p => !manifest[p.relativePath]);

  console.log(`  Local photos   : ${localPhotos.length}`);
  console.log(`  Already uploaded: ${localPhotos.length - newPhotos.length}`);
  console.log(`  New to upload  : ${newPhotos.length}\n`);

  if (newPhotos.length > 0) {
    const release = await getOrCreateRelease(token, owner, repo);
    console.log(`  Release id: ${release.id}\n`);

    // Phase 1: generate all thumbnails locally (fast, 6 workers)
    process.stdout.write(`  Generating ${newPhotos.length} thumbnail(s)...`);
    await Promise.all(
      chunk(newPhotos, 6).map(batch =>
        Promise.all(batch.map(p => ensureThumbnail(p.absolute, p.relativePath, p.mtime)))
      )
    );
    console.log(" done.\n");

    // Phase 2: upload originals (4 parallel)
    let uploaded = 0;
    let failed   = 0;
    const total  = newPhotos.length;

    await mapLimit(newPhotos, 4, async photo => {
      try {
        const assetName = toAssetName(photo.relativePath);
        const data      = await readFile(photo.absolute);
        await uploadAsset(token, owner, repo, release.id, assetName, data);

        manifest[photo.relativePath] = {
          url:        toDownloadUrl(owner, repo, assetName),
          size:       photo.size,
          mtime:      photo.mtime,
          uploadedAt: new Date().toISOString(),
        };

        uploaded++;
        process.stdout.write(`\r  Uploading: ${uploaded}/${total} done, ${failed} failed   `);

        // Checkpoint every 20 uploads so a crash doesn't lose progress
        if (uploaded % 20 === 0) saveManifest(manifest);

      } catch (err) {
        failed++;
        process.stdout.write(`\r  Uploading: ${uploaded}/${total} done, ${failed} failed   `);
        // Print the error on a new line so it doesn't get overwritten
        console.log(`\n  ✗ ${photo.relativePath}: ${err.message}`);
      }
    });

    console.log(); // newline after progress
    saveManifest(manifest);
    console.log(`\n  Uploaded: ${uploaded}  Failed: ${failed}\n`);

    if (failed > 0) {
      console.log("  Re-run 'npm run deploy' to retry failed uploads.\n");
    }
  }

  // Rebuild photos.json with release URLs
  console.log("Rebuilding index...\n");
  await buildIndex();

  // Untrack photos/ from git if currently tracked (one-time migration)
  try {
    const tracked = execSync("git ls-files -- photos/", { encoding: "utf8" }).trim();
    if (tracked) {
      console.log("Untracking photos/ from git (they're now in GitHub Releases)...");
      execSync("git rm -r --cached photos/", { stdio: "inherit" });
    }
  } catch { /* not tracked, nothing to do */ }

  // Stage generated/updated files
  const toStage = ["thumbnails/", "data/"];
  for (const p of toStage) {
    if (existsSync(path.join(root, p))) {
      execSync(`git add ${p}`, { stdio: "inherit" });
    }
  }
  // Also catch .gitignore changes
  try { execSync("git add .gitignore", { stdio: "inherit" }); } catch { /* ok */ }

  const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
  if (!status) {
    console.log("Nothing to commit — already up to date.\n");
    return;
  }

  const summary = newPhotos.length > 0
    ? `deploy: add ${newPhotos.length} photo(s)`
    : "deploy: rebuild index";

  execSync(`git commit -m "${summary}"`, { stdio: "inherit" });
  execSync("git push", { stdio: "inherit" });

  console.log("\nDone. Photos are live.\n");
  console.log(`  Browse: https://${owner}.github.io/${repo}/`);
  console.log(`  Download originals: https://github.com/${owner}/${repo}/releases/tag/${RELEASE_TAG}\n`);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}\n`);
  process.exit(1);
});
