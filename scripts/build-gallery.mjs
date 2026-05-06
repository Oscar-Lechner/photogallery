import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const photosDir = path.join(root, "photos");
const dataDir   = path.join(root, "data");
const outputFile    = path.join(dataDir, "photos.json");
const configFile    = path.join(dataDir, "album-config.json");

const imageExtensions = new Set([
  ".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"
]);

// ── Config ──
let config = { dates: {}, collapse: {} };
try {
  config = { dates: {}, collapse: {}, ...JSON.parse(await readFile(configFile, "utf8")) };
  console.log("Using album-config.json");
} catch {
  // No config — proceed without it
}

// ── Helpers ──
function toUrlPath(value) {
  return value.split(path.sep).map(encodeURIComponent).join("/");
}

function titleFromFile(fileName) {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Walk photos/ ──
async function walk(dir, base = dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walk(absolute, base)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!imageExtensions.has(path.extname(entry.name).toLowerCase())) continue;

    const relativePath = path.relative(base, absolute);
    const fileStat = await stat(absolute);
    files.push({ relativePath, mtime: fileStat.mtimeMs, size: fileStat.size });
  }

  return files;
}

// ── Build ──
const rawFiles = await walk(photosDir);
rawFiles.sort((a, b) =>
  a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: "base" })
);

// Build photos with collapse applied
const allPhotos = rawFiles.map(({ relativePath, mtime, size }) => {
  const parts    = relativePath.split(path.sep);
  const rawAlbum = parts.length > 1 ? parts.slice(0, -1).join(" / ") : "Loose Photos";
  const album    = config.collapse[rawAlbum] ?? rawAlbum;
  const encodedPath = toUrlPath(relativePath);

  return {
    album,
    title: titleFromFile(relativePath),
    relativePath: relativePath.split(path.sep).join("/"),
    src: `photos/${encodedPath}`,
    mtime,
    size
  };
});

// Deduplicate within each album (same filename = likely same photo after collapse)
const seen = new Set();
const photos = allPhotos.filter((p) => {
  const key = `${p.album}\x00${p.relativePath.split("/").pop().toLowerCase()}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const removed = allPhotos.length - photos.length;

await mkdir(dataDir, { recursive: true });
await writeFile(
  outputFile,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: photos.length,
      albumDates:   config.dates   || {},
      albumDisplay: config.display || {},
      photos
    },
    null,
    2
  )}\n`
);

// ── Summary ──
const albumCounts = new Map();
for (const p of photos) albumCounts.set(p.album, (albumCounts.get(p.album) || 0) + 1);
const albums = [...albumCounts.keys()].sort();

console.log(`\nIndexed ${photos.length} photo${photos.length !== 1 ? "s" : ""} across ${albums.length} album${albums.length !== 1 ? "s" : ""}${removed ? ` (${removed} duplicate${removed !== 1 ? "s" : ""} removed)` : ""}:\n`);
for (const album of albums) {
  const date = config.dates[album];
  const dateStr = date
    ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).padEnd(14)
    : "              ";
  console.log(`  ${albumCounts.get(album).toString().padStart(4)}  ${dateStr}  ${album}`);
}
console.log(`\nWrote → ${path.relative(root, outputFile)}\n`);
