import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const root       = path.resolve(path.dirname(__filename), "..");
const photosDir  = path.join(root, "photos");
const thumbsDir  = path.join(root, "thumbnails");
const dataDir    = path.join(root, "data");

const IMAGE_EXTS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function titleFromFile(relPath) {
  return path
    .basename(relPath, path.extname(relPath))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "cameraflicks / night1" → "Night 1", "europe_2026" → "Europe 2026"
function autoDisplayName(albumKey) {
  const leaf = albumKey.split(" / ").at(-1);
  return leaf
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function toThumbSrc(relPath) {
  const withWebp = relPath.replace(/\.[^.]+$/, ".webp");
  return "thumbnails/" + withWebp.split("/").map(encodeURIComponent).join("/");
}

function toPhotoSrc(relPath) {
  return "photos/" + relPath.split("/").map(encodeURIComponent).join("/");
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Exports ───────────────────────────────────────────────────────────────────

export async function walkPhotos(baseDir = photosDir) {
  async function recurse(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await recurse(abs));
      } else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const rel = path.relative(baseDir, abs).split(path.sep).join("/");
        const s = await stat(abs);
        files.push({ relativePath: rel, mtime: s.mtimeMs, size: s.size, absolute: abs });
      }
    }
    return files;
  }
  const files = await recurse(baseDir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

// Generates a WebP thumbnail if missing or older than source. Returns true on success.
export async function ensureThumbnail(srcAbs, relPath, mtime) {
  const thumbRel = relPath.replace(/\.[^.]+$/, ".webp");
  const thumbAbs = path.join(thumbsDir, thumbRel.split("/").join(path.sep));
  try {
    const ts = await stat(thumbAbs);
    if (ts.mtimeMs >= mtime) return true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await mkdir(path.dirname(thumbAbs), { recursive: true });
  try {
    await sharp(srcAbs, { failOn: "none", limitInputPixels: false })
      .rotate()
      .resize({ width: 600, height: 600, fit: "cover", withoutEnlargement: true })
      .webp({ quality: 72, effort: 4 })
      .toFile(thumbAbs);
    return true;
  } catch (e) {
    console.warn(`  Thumbnail failed: ${relPath}: ${e.message}`);
    return false;
  }
}

export async function buildIndex() {
  // Load optional album-config overrides
  let config = { dates: {}, display: {}, collapse: {} };
  try {
    config = { dates: {}, display: {}, collapse: {}, ...JSON.parse(await readFile(path.join(dataDir, "album-config.json"), "utf8")) };
  } catch { /* optional */ }

  // Load release manifest: relativePath → { url, size, mtime }
  let manifest = {};
  try {
    const raw = (await readFile(path.join(dataDir, "release-manifest.json"), "utf8")).replace(/^﻿/, "");
    manifest = JSON.parse(raw);
  } catch { /* optional */ }

  // Walk local photos (may be empty if photos/ is gitignored and not present)
  const localFiles = await walkPhotos();
  const localIndex = new Map(localFiles.map(f => [f.relativePath, f]));

  // Build unified photo list from manifest + local files
  // Manifest is source of truth for what's deployed; local adds new/un-deployed photos
  const allPaths = new Set([...Object.keys(manifest), ...localFiles.map(f => f.relativePath)]);

  // Generate thumbnails for locally present photos
  const needsThumbs = localFiles.filter(f => {
    const thumbAbs = path.join(thumbsDir, f.relativePath.replace(/\.[^.]+$/, ".webp").split("/").join(path.sep));
    // Always attempt generation; ensureThumbnail skips if already fresh
    return true;
  });

  if (needsThumbs.length > 0) {
    process.stdout.write(`Generating thumbnails for ${needsThumbs.length} local photo(s)...`);
    await mapLimit(needsThumbs, 6, f => ensureThumbnail(f.absolute, f.relativePath, f.mtime));
    console.log(" done.");
  }

  // Build photo entries
  const allPhotos = [...allPaths].map(relPath => {
    const local = localIndex.get(relPath);
    const released = manifest[relPath];

    const parts    = relPath.split("/");
    const rawAlbum = parts.length > 1 ? parts.slice(0, -1).join(" / ") : "Loose Photos";
    const album    = config.collapse[rawAlbum] ?? rawAlbum;
    const mtime    = local?.mtime ?? released?.mtime ?? 0;
    const size     = local?.size  ?? released?.size  ?? 0;

    // Prefer release URL for src (permanent download link); fall back to local path
    const src      = released?.url ?? toPhotoSrc(relPath);
    const thumbSrc = toThumbSrc(relPath);

    return { album, title: titleFromFile(relPath), relativePath: relPath, src, thumbSrc, mtime, size };
  });

  allPhotos.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: "base" }));

  // Deduplicate (same album + filename — handles collapse)
  const seen = new Set();
  const photos = allPhotos.filter(p => {
    const key = `${p.album}\x00${p.relativePath.split("/").pop().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Auto-compute album metadata
  const albumGroups = new Map();
  for (const p of photos) {
    if (!albumGroups.has(p.album)) albumGroups.set(p.album, []);
    albumGroups.get(p.album).push(p);
  }

  const albumDates   = { ...config.dates };
  const albumDisplay = { ...config.display };

  for (const [album, group] of albumGroups) {
    if (!albumDates[album]) {
      const maxMtime = Math.max(...group.map(p => p.mtime));
      albumDates[album] = new Date(maxMtime).toISOString();
    }
    if (!albumDisplay[album]) {
      albumDisplay[album] = autoDisplayName(album);
    }
  }

  await mkdir(dataDir, { recursive: true });
  const outputFile = path.join(dataDir, "photos.json");
  await writeFile(
    outputFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: photos.length, albumDates, albumDisplay, photos }, null, 2) + "\n"
  );

  // Summary
  console.log(`\nIndexed ${photos.length} photo(s) across ${albumGroups.size} album(s):\n`);
  for (const [album, group] of [...albumGroups].sort()) {
    const date    = albumDates[album];
    const dateStr = date
      ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).padEnd(14)
      : "              ";
    const display = albumDisplay[album] ?? album;
    console.log(`  ${group.length.toString().padStart(4)}  ${dateStr}  ${display}`);
  }
  console.log(`\nWrote → data/photos.json\n`);
}

// ── Standalone entry point ────────────────────────────────────────────────────

if (process.argv[1] === __filename) {
  await buildIndex();
}
