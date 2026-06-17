if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

// DOM
const entryScreen = document.querySelector("#entryScreen");
const wheelEl = document.querySelector("#wheel");
const wheelListEl = document.querySelector("#wheelList");
const wheelMetaEl = document.querySelector("#wheelMeta");
const enterBtn = document.querySelector("#enterBtn");
const enterAllBtn = document.querySelector("#enterAllBtn");
const entryError = document.querySelector("#entryError");

const gallery = document.querySelector("#gallery");
const galleryAlbumLabel = document.querySelector("#galleryAlbumLabel");
const galleryMeta = document.querySelector("#galleryMeta");
const backBtn = document.querySelector("#backBtn");
const copyAlbumLink = document.querySelector("#copyAlbumLink");
const downloadView = document.querySelector("#downloadView");

const albumFilter = document.querySelector("#albumFilter");
const albumRail = document.querySelector("#albumRail");
const colorViewBtn = document.querySelector("#colorViewBtn");
const sortControl = document.querySelector("#sortControl");
const tileSizeControl = document.querySelector("#tileSizeControl");
const colorBar = document.querySelector("#colorBar");
const colorBarGradient = document.querySelector("#colorBarGradient");
const colorBarThumb = document.querySelector("#colorBarThumb");

const featurePanel = document.querySelector("#featurePanel");
const featurePhoto = document.querySelector("#featurePhoto");
const featureDownload = document.querySelector("#featureDownload");
const albumTitle = document.querySelector("#albumTitle");
const albumSummary = document.querySelector("#albumSummary");

const emptyState = document.querySelector("#emptyState");
const grid = document.querySelector("#photoGrid");

const lightbox = document.querySelector("#lightbox");
const lightboxImage = document.querySelector("#lightboxImage");
const lightboxTitle = document.querySelector("#lightboxTitle");
const lightboxAlbum = document.querySelector("#lightboxAlbum");
const lightboxCount = document.querySelector("#lightboxCount");
const openPhoto = document.querySelector("#openPhoto");
const downloadPhoto = document.querySelector("#downloadPhoto");
const closeLightbox = document.querySelector("#closeLightbox");
const prevPhoto = document.querySelector("#prevPhoto");
const nextPhoto = document.querySelector("#nextPhoto");

const downloadSheet = document.querySelector("#downloadSheet");
const closeDownloadSheet = document.querySelector("#closeDownloadSheet");
const downloadTitle = document.querySelector("#downloadTitle");
const downloadSummary = document.querySelector("#downloadSummary");
const downloadAllVisible = document.querySelector("#downloadAllVisible");
const visibleDownloadLinks = document.querySelector("#visibleDownloadLinks");

// State
let photos = [];
let visiblePhotos = [];
let currentIndex = -1;
let manifest = null;
let picker = null;
let thumbObserver = null;
let currentSort = "filename";
let currentTileMin = 140;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function getParams() {
  return new URLSearchParams(location.search);
}

function setParams(next) {
  const p = getParams();
  for (const [k, v] of Object.entries(next)) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  history.replaceState(null, "", p.size ? `?${p}` : location.pathname);
}

function pathToTitle(p) {
  return p.split("/").pop().replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

function fileName(photo) {
  return photo.relativePath ? photo.relativePath.split(/[\\/]/).pop() : `${photo.title || "photo"}.jpg`;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function albumLabel(a) {
  if (!a) return "All photos";
  const display = manifest?.albumDisplay ?? {};
  return display[a] || a.replace(/ \/ /g, " > ");
}

function getAlbumCounts() {
  const m = new Map();
  for (const p of photos) {
    const a = p.album || "Loose Photos";
    m.set(a, (m.get(a) || 0) + 1);
  }
  return m;
}

function triggerDownload(photo) {
  const a = document.createElement("a");
  a.href = photo.src;
  a.download = fileName(photo);
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

function thumbFor(photo) {
  return photo.thumbSrc || photo.src;
}

// Album wheel data
function stripCommonPrefix(albums) {
  if (!albums.length) return [];
  const split = albums.map((a) => a.split(" / "));
  let depth = 0;
  while (
    depth < split[0].length &&
    split.every((parts) => parts[depth] === split[0][depth])
  ) {
    depth++;
  }
  return albums.map((a) => ({
    value: a,
    display: a.split(" / ").slice(depth).join(" / ") || a,
  }));
}

function formatWheelDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric" }).toUpperCase();
}

function buildWheelItems() {
  const counts = getAlbumCounts();
  const dates = manifest?.albumDates ?? {};
  const display = manifest?.albumDisplay ?? {};

  const albums = [...counts.keys()];
  albums.sort((a, b) => {
    const da = dates[a] ? new Date(dates[a]).getTime() : 0;
    const db = dates[b] ? new Date(dates[b]).getTime() : 0;
    if (da !== db) return db - da;
    return collator.compare(a, b);
  });

  const stripped = stripCommonPrefix(albums);
  return stripped.map(({ value, display: auto }) => ({
    value,
    display: display[value] || auto,
    count: counts.get(value),
    date: dates[value] ? formatWheelDate(dates[value]) : null,
  }));
}

// Wheel picker
class WheelPicker {
  static ITEM_H = 48;
  static PAD = 2;

  constructor(viewport, list, items, onChange) {
    this.viewport = viewport;
    this.list = list;
    this.items = items;
    this.onChange = onChange;
    this.index = 0;
    this._drag = null;
    this._els = [];

    this._render();
    this._bind();
    this._go(0, false);
  }

  get selected() {
    return this.items[this.index];
  }

  _render() {
    const { PAD } = WheelPicker;
    this.list.innerHTML = "";

    for (let i = 0; i < PAD; i++) {
      const el = document.createElement("div");
      el.className = "wheel-option is-pad";
      el.setAttribute("aria-hidden", "true");
      this.list.append(el);
    }

    this.items.forEach((item, i) => {
      const el = document.createElement("div");
      el.className = "wheel-option";
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === 0));
      el.dataset.idx = String(i);

      const date = document.createElement("span");
      date.className = "wopt-date";
      date.textContent = item.date ?? "";

      const label = document.createElement("span");
      label.className = "wopt-label";
      label.textContent = item.display;

      const count = document.createElement("span");
      count.className = "wopt-count";
      count.textContent = String(item.count);

      el.append(date, label, count);
      this.list.append(el);
    });

    for (let i = 0; i < PAD; i++) {
      const el = document.createElement("div");
      el.className = "wheel-option is-pad";
      el.setAttribute("aria-hidden", "true");
      this.list.append(el);
    }

    this._els = [...this.list.querySelectorAll("[data-idx]")];
  }

  _go(index, animate = true) {
    const IH = WheelPicker.ITEM_H;
    this.index = Math.max(0, Math.min(index, this.items.length - 1));

    this.list.style.transition = animate
      ? "transform 0.44s cubic-bezier(0.18, 0.88, 0.38, 1)"
      : "none";
    this.list.style.transform = `translateY(${-this.index * IH}px)`;

    this._els.forEach((el, i) => {
      const d = Math.abs(i - this.index);
      el.classList.toggle("is-selected", d === 0);
      el.classList.toggle("is-near", d === 1);
      el.classList.toggle("is-far", d >= 2);
      el.setAttribute("aria-selected", String(d === 0));
    });

    this.onChange(this.items[this.index]);
  }

  go(delta) {
    this._go(this.index + delta);
  }

  set(i) {
    this._go(i);
  }

  _bind() {
    const vp = this.viewport;
    const IH = WheelPicker.ITEM_H;

    this.list.addEventListener("click", (e) => {
      const el = e.target.closest("[data-idx]");
      if (el) this._go(Number(el.dataset.idx));
    });

    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      this._go(this.index + Math.sign(e.deltaY));
    }, { passive: false });

    vp.addEventListener("mousedown", (e) => {
      this._drag = { y: e.clientY, idx: this.index };
      vp.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this._drag) return;
      const dy = this._drag.y - e.clientY;
      this._go(this._drag.idx + Math.round(dy / IH), false);
    });
    window.addEventListener("mouseup", () => {
      if (!this._drag) return;
      this._drag = null;
      vp.style.cursor = "";
      this._go(this.index, true);
    });

    vp.addEventListener("touchstart", (e) => {
      this._drag = { y: e.touches[0].clientY, idx: this.index };
    }, { passive: true });
    vp.addEventListener("touchmove", (e) => {
      if (!this._drag) return;
      e.preventDefault();
      const dy = this._drag.y - e.touches[0].clientY;
      this._go(this._drag.idx + Math.round(dy / IH), false);
    }, { passive: false });
    vp.addEventListener("touchend", () => {
      if (!this._drag) return;
      this._drag = null;
      this._go(this.index, true);
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      if (entryScreen.hidden || entryScreen.classList.contains("is-out")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        this.go(1);
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        this.go(-1);
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doEnter();
      }
    });
  }
}

// Entry screen
function initEntry() {
  const items = buildWheelItems();
  if (!items.length) {
    entryError.hidden = false;
    return;
  }

  picker = new WheelPicker(wheelEl, wheelListEl, items, (item) => {
    if (!item) {
      wheelMetaEl.textContent = "";
      return;
    }
    const parts = [`${item.count} photograph${item.count !== 1 ? "s" : ""}`];
    if (item.date) parts.push(item.date);
    wheelMetaEl.textContent = parts.join(" / ");
  });

  entryScreen.hidden = false;
  entryScreen.classList.remove("is-out");
  gallery.hidden = true;
}

function doEnter() {
  const album = picker?.selected?.value ?? "";
  setParams({ album });
  transitionToGallery(album);
}

function enterAllPhotos() {
  setParams({ album: "" });
  transitionToGallery("");
}

function transitionToGallery(album) {
  entryScreen.classList.add("is-out");
  setTimeout(() => {
    entryScreen.hidden = true;
  }, 490);

  renderAlbums(album);
  renderGrid(true);

  const label = albumLabel(album || "All photos");
  galleryAlbumLabel.textContent = label;
  document.title = album ? `${label} - Photo Gallery` : "Photo Gallery";

  gallery.hidden = false;
  gallery.classList.remove("is-out");
  gallery.classList.add("is-entering");
  setTimeout(() => gallery.classList.remove("is-entering"), 540);
}

function transitionToEntry() {
  gallery.classList.add("is-out");
  setTimeout(() => {
    gallery.hidden = true;
    gallery.classList.remove("is-out");
    initEntry();
  }, 370);
  setParams({ album: "" });
}

enterBtn.addEventListener("click", doEnter);
enterAllBtn.addEventListener("click", enterAllPhotos);
backBtn.addEventListener("click", transitionToEntry);

// Gallery: albums
function renderAlbums(activeAlbum = albumFilter.value) {
  const counts = getAlbumCounts();
  const displayMap = manifest?.albumDisplay ?? {};
  const albums = [...counts.keys()].sort(collator.compare);
  const stripped = stripCommonPrefix(albums);

  albumFilter.innerHTML = "";
  albumFilter.append(new Option("All", ""));
  for (const { value, display } of stripped) {
    const label = displayMap[value] || display.replace(/ \/ /g, " > ");
    albumFilter.append(new Option(`${label} (${counts.get(value)})`, value));
  }
  albumFilter.value = activeAlbum;

  albumRail.innerHTML = "";
  albumRail.append(makeChip("", `All (${photos.length})`));
  for (const { value, display: auto } of stripped) {
    const label = displayMap[value] || auto.replace(/ \/ /g, " > ");
    albumRail.append(makeChip(value, `${label} (${counts.get(value)})`));
  }
}

function makeChip(album, text) {
  const btn = document.createElement("button");
  btn.className = "album-chip";
  btn.type = "button";
  btn.dataset.album = album;
  btn.textContent = text;
  btn.title = album || "All photos";
  return btn;
}

function updateRailActive() {
  const current = albumFilter.value;
  let active = null;
  albumRail.querySelectorAll(".album-chip").forEach((chip) => {
    const on = chip.dataset.album === current;
    chip.classList.toggle("is-active", on);
    if (on) active = chip;
  });
  if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
}

// Gallery: ordering
function sortPhotos(items) {
  switch (currentSort) {
    case "hue": {
      // Rainbow buckets keep reds together (fixing 0°/360° wrap) and group
      // similar colors so the sort feels like a real rainbow.
      // Returns [bucketIndex, hueWithinBucket].
      function hueBucket(h) {
        if (h >= 345 || h < 15)  return [0, h >= 345 ? h - 345 : h + 15]; // red
        if (h < 45)  return [1, h - 15];   // orange
        if (h < 75)  return [2, h - 45];   // yellow
        if (h < 165) return [3, h - 75];   // green
        if (h < 210) return [4, h - 165];  // cyan
        if (h < 270) return [5, h - 210];  // blue
        if (h < 315) return [6, h - 270];  // purple
        return        [7, h - 315];        // pink / magenta
      }
      return [...items].sort((a, b) => {
        const ca = a.color, cb = b.color;
        if (!ca && !cb) return 0;
        if (!ca) return 1;
        if (!cb) return -1;
        const na = ca.s < 15 || (ca.c ?? 100) < 10;
        const nb = cb.s < 15 || (cb.c ?? 100) < 10;
        if (na !== nb) return na ? 1 : -1;
        if (na && nb) return ca.l - cb.l;
        const [ba, ha] = hueBucket(ca.h);
        const [bb, hb] = hueBucket(cb.h);
        if (ba !== bb) return ba - bb;
        // Within bucket: vivid first, then fine hue order, then most-chromatic
        return (cb.s - ca.s) || (ha - hb) || ((cb.c ?? 0) - (ca.c ?? 0));
      });
    }
    case "flat":
      return [...items].sort((a, b) => {
        const ca = a.color, cb = b.color;
        if (!ca && !cb) return 0;
        if (!ca) return 1;
        if (!cb) return -1;
        return ((cb.u ?? 0) - (ca.u ?? 0)) || (cb.s - ca.s);
      });
    case "value": {
      const v = c => { const l = c.l / 100, s = c.s / 100; return l + s * Math.min(l, 1 - l); };
      return [...items].sort((a, b) => {
        const ca = a.color, cb = b.color;
        if (!ca && !cb) return 0;
        if (!ca) return 1;
        if (!cb) return -1;
        return v(cb) - v(ca);
      });
    }
    default:
      return [...items].sort((a, b) => collator.compare(a.album, b.album) || collator.compare(a.title, b.title));
  }
}

// Gallery: feature
function renderFeature() {
  featurePanel.hidden = true;
}

function getThumbObserver() {
  if (!("IntersectionObserver" in window)) return null;
  if (thumbObserver) return thumbObserver;

  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      thumbObserver.unobserve(img);
      if (img.dataset.src) img.src = img.dataset.src;
    }
  }, {
    rootMargin: "480px 0px",
    threshold: 0.01
  });

  return thumbObserver;
}

// Gallery: skeleton
const SKELETONS = 18;

function renderSkeleton() {
  featurePanel.hidden = true;
  emptyState.hidden = true;
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < SKELETONS; i++) {
    const el = document.createElement("div");
    el.className = "photo-card is-skeleton";
    frag.append(el);
  }
  grid.append(frag);
}

// Color bar
function updateColorBar() {
  if (currentSort !== "hue" || !visiblePhotos.some(p => p.color)) {
    colorBar.hidden = true;
    return;
  }

  // Sit just left of the native scrollbar
  const sbw = window.innerWidth - document.documentElement.clientWidth;
  colorBar.style.right = sbw + "px";

  // Build gradient from evenly-sampled photos (sorted by hue)
  const N = Math.min(visiblePhotos.length, 36);
  const stops = [];
  for (let i = 0; i < N; i++) {
    const idx = Math.round((i / (N - 1)) * (visiblePhotos.length - 1));
    const h = visiblePhotos[idx]?.color?.h ?? 0;
    stops.push(`hsl(${h},95%,50%) ${((i / (N - 1)) * 100).toFixed(1)}%`);
  }
  colorBarGradient.style.background = `linear-gradient(to bottom,${stops.join(",")})`;

  colorBar.hidden = false;
  updateColorBarThumb();
}

function updateColorBarThumb() {
  if (colorBar.hidden) return;
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const fraction = scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0;
  colorBarThumb.style.top = (fraction * 100) + "%";
}

window.addEventListener("scroll", updateColorBarThumb, { passive: true });

// Gallery: grid
const ANIM_CAP = 28;

function renderGrid(animate = false) {
  const album = albumFilter.value;

  visiblePhotos = sortPhotos(
    photos.filter((p) => {
      if (album && p.album !== album) return false;
      return true;
    })
  );

  emptyState.hidden = visiblePhotos.length !== 0;
  if (thumbObserver) thumbObserver.disconnect();
  grid.innerHTML = "";

  const albumName = albumLabel(album || "All photos");
  galleryAlbumLabel.textContent = albumName;
  galleryMeta.textContent = `${visiblePhotos.length} of ${photos.length} photos`;
  document.title = album ? `${albumName} - Photo Gallery` : "Photo Gallery";

  const frag = document.createDocumentFragment();
  visiblePhotos.forEach((photo, i) => {
    const card = document.createElement("article");
    card.className = "photo-card";
    card.dataset.index = String(i);

    if (animate && i < ANIM_CAP) {
      card.dataset.enter = "";
      card.style.setProperty("--i", String(i));
    }

    const open = document.createElement("button");
    open.className = "photo-open";
    open.type = "button";
    open.setAttribute("aria-label", `Open ${photo.title}`);

    const img = document.createElement("img");
    img.dataset.src = thumbFor(photo);
    img.alt = photo.title;
    img.loading = "lazy";
    img.decoding = "async";
    img.fetchPriority = "low";
    img.className = "is-thumb-loading";
    img.addEventListener("load", () => {
      img.classList.remove("is-thumb-loading");
      img.classList.add("is-thumb-loaded");
    }, { once: true });
    img.addEventListener("error", () => {
      card.classList.add("is-missing");
      img.alt = "";
    });

    const cap = document.createElement("span");
    const b = document.createElement("b");
    const sm = document.createElement("small");
    b.textContent = photo.title;
    sm.textContent = albumLabel(photo.album || "");
    cap.append(b, sm);

    const dl = document.createElement("a");
    dl.className = "card-download";
    dl.href = photo.src;
    dl.download = fileName(photo);
    dl.setAttribute("aria-label", `Download ${photo.title}`);
    dl.textContent = "Download";

    open.append(img, cap);
    card.append(open, dl);
    if (photo.color) {
      const hsl = `hsl(${photo.color.h},${photo.color.s}%,${photo.color.l}%)`;
      card.style.setProperty("--card-color", hsl);
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.cssText = `--c:${hsl}`;
      card.append(dot);
    }
    frag.append(card);
  });

  grid.append(frag);
  const observer = getThumbObserver();
  grid.querySelectorAll("img[data-src]").forEach((img) => {
    if (observer) observer.observe(img);
    else img.src = img.dataset.src;
  });
  renderFeature();
  updateRailActive();

  setParams({
    album,
    sort: currentSort !== "filename" ? currentSort : "",
    seed: "",
    q: "",
  });

  updateColorBar();
}

// Lightbox
function showPhoto(index) {
  if (!visiblePhotos.length) return;
  const idx = ((index % visiblePhotos.length) + visiblePhotos.length) % visiblePhotos.length;
  currentIndex = idx;
  const photo = visiblePhotos[idx];

  // Show thumbnail immediately — it's already cached from the grid scroll
  const thumb = thumbFor(photo);
  lightboxImage.classList.add("is-loading");
  lightboxImage.src = thumb;
  lightboxImage.alt = photo.title;
  lightboxTitle.textContent = photo.title;
  lightboxAlbum.textContent = albumLabel(photo.album || "All photos");
  lightboxCount.textContent = `${idx + 1} / ${visiblePhotos.length}`;
  openPhoto.href = thumbFor(photo);
  downloadPhoto.href = photo.src;
  downloadPhoto.download = fileName(photo);

  // Try to upgrade to full-res in the background; swap only if still on this photo
  if (photo.src !== thumb) {
    const hd = new Image();
    hd.onload = () => { if (currentIndex === idx) lightboxImage.src = hd.src; };
    hd.src = photo.src;
  }

  if (!lightbox.open) lightbox.showModal();
}

lightboxImage.addEventListener("load", () => lightboxImage.classList.remove("is-loading"));

// Download sheet
function renderDownloadSheet() {
  const album = albumFilter.value;
  downloadTitle.textContent = albumLabel(album || "All photos");
  downloadSummary.textContent = `${visiblePhotos.length} photo${visiblePhotos.length !== 1 ? "s" : ""} shown.`;
  downloadAllVisible.disabled = !visiblePhotos.length;
  downloadAllVisible.textContent = "Download Shown";

  visibleDownloadLinks.innerHTML = "";
  const frag = document.createDocumentFragment();
  visiblePhotos.forEach((photo, i) => {
    const a = document.createElement("a");
    a.className = "download-row";
    a.href = photo.src;
    a.download = fileName(photo);

    const info = document.createElement("span");
    const title = document.createElement("strong");
    const albumName = document.createElement("small");
    const size = document.createElement("em");
    title.textContent = photo.title;
    albumName.textContent = albumLabel(photo.album || "");
    size.textContent = formatBytes(photo.size) || String(i + 1);

    info.append(title, albumName);
    a.append(info, size);
    frag.append(a);
  });
  visibleDownloadLinks.append(frag);
}

function openDownloadSheet() {
  renderDownloadSheet();
  if (!downloadSheet.open) downloadSheet.showModal();
}

// Share
async function shareAlbum() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    copyAlbumLink.textContent = "Copied";
  } catch {
    copyAlbumLink.textContent = "Copy URL";
  }
  setTimeout(() => {
    copyAlbumLink.textContent = "Copy Link";
  }, 1600);
}

// Event wiring
grid.addEventListener("click", (e) => {
  const card = e.target.closest(".photo-card[data-index]");
  if (!card || e.target.closest("a")) return;
  showPhoto(Number(card.dataset.index));
});

featurePhoto.addEventListener("click", () => {
  const idx = Number(featurePhoto.dataset.index);
  showPhoto(Number.isNaN(idx) ? 0 : idx);
});

albumRail.addEventListener("click", (e) => {
  const chip = e.target.closest(".album-chip");
  if (!chip) return;
  albumFilter.value = chip.dataset.album;
  renderGrid(true);
});

function applyTileSize(value) {
  currentTileMin = parseInt(value);
  document.documentElement.style.setProperty("--tile-min", `${value}px`);
}

tileSizeControl.addEventListener("click", (e) => {
  const button = e.target.closest("[data-tile-size]");
  if (!button) return;

  applyTileSize(button.dataset.tileSize);
  tileSizeControl.querySelectorAll("[data-tile-size]").forEach((option) => {
    const active = option === button;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-pressed", String(active));
  });
});

colorViewBtn.addEventListener("click", () => {
  const active = grid.classList.toggle("is-color-view");
  colorViewBtn.classList.toggle("is-active", active);
  colorViewBtn.setAttribute("aria-pressed", String(active));
});

sortControl.addEventListener("click", (e) => {
  const button = e.target.closest("[data-sort]");
  if (!button) return;
  currentSort = button.dataset.sort;
  sortControl.querySelectorAll("[data-sort]").forEach((opt) => {
    const active = opt === button;
    opt.classList.toggle("is-active", active);
    opt.setAttribute("aria-pressed", String(active));
  });
  renderGrid(false);
});

// Keyboard shortcuts: 1–4 for sort, [ / ] for tile size
document.addEventListener("keydown", (e) => {
  if (gallery.hidden) return;
  if (e.target.closest("input,textarea,select,[contenteditable]")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const SORT_MAP = { "1": "filename", "2": "hue", "3": "flat", "4": "value" };
  const TILE_SIZES = [80, 140, 190, 250];

  if (e.key === "s") {
    e.preventDefault();
    colorViewBtn.click();
  } else if (SORT_MAP[e.key] !== undefined) {
    e.preventDefault();
    currentSort = SORT_MAP[e.key];
    sortControl.querySelectorAll("[data-sort]").forEach(btn => {
      const active = btn.dataset.sort === currentSort;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    renderGrid(false);
  } else if (e.key === "[" || e.key === "]") {
    e.preventDefault();
    const cur = TILE_SIZES.indexOf(currentTileMin);
    const next = e.key === "[" ? Math.max(0, cur - 1) : Math.min(TILE_SIZES.length - 1, cur + 1);
    if (next !== cur) {
      const size = String(TILE_SIZES[next]);
      applyTileSize(size);
      tileSizeControl.querySelectorAll("[data-tile-size]").forEach(btn => {
        const active = btn.dataset.tileSize === size;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }
  } else if (e.key === "z") {
    e.preventDefault();
    const count = visiblePhotos.length;
    if (count === 0) return;
    const gap = 8;
    const gridWidth = photoGrid.clientWidth;
    // Grid's distance from document top (stable regardless of current scroll position)
    const gridDocTop = photoGrid.getBoundingClientRect().top + window.scrollY;
    const availableH = window.innerHeight - gridDocTop - 8;
    // Binary search: largest tileMin where all photos fit without scrolling
    let lo = 20, hi = gridWidth;
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      const cols = Math.max(1, Math.floor((gridWidth + gap) / (mid + gap)));
      const tileW = (gridWidth - (cols - 1) * gap) / cols;
      const rows = Math.ceil(count / cols);
      if (rows * tileW + (rows - 1) * gap <= availableH) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    applyTileSize(lo);
    tileSizeControl.querySelectorAll("[data-tile-size]").forEach(btn => {
      btn.classList.remove("is-active");
      btn.setAttribute("aria-pressed", "false");
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

copyAlbumLink.addEventListener("click", shareAlbum);
downloadView.addEventListener("click", openDownloadSheet);
closeDownloadSheet.addEventListener("click", () => downloadSheet.close());
downloadAllVisible.addEventListener("click", () => {
  visiblePhotos.forEach(triggerDownload);
  downloadAllVisible.textContent = "Started";
  setTimeout(() => {
    downloadAllVisible.textContent = "Download Shown";
  }, 1400);
});

closeLightbox.addEventListener("click", () => lightbox.close());
prevPhoto.addEventListener("click", () => showPhoto(currentIndex - 1));
nextPhoto.addEventListener("click", () => showPhoto(currentIndex + 1));

lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) lightbox.close();
});

downloadSheet.addEventListener("click", (e) => {
  if (e.target === downloadSheet) downloadSheet.close();
});

// Swipe between albums in gallery
function navigateAlbum(delta) {
  const chips = [...albumRail.querySelectorAll(".album-chip")];
  if (chips.length < 2) return;
  const values = chips.map((c) => c.dataset.album);
  const idx = values.indexOf(albumFilter.value);
  const next = ((idx + delta) % values.length + values.length) % values.length;
  albumFilter.value = values[next];
  renderGrid(true);
}

let _gsx = 0, _gsy = 0;
gallery.addEventListener("touchstart", (e) => {
  _gsx = e.touches[0].clientX;
  _gsy = e.touches[0].clientY;
}, { passive: true });
gallery.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - _gsx;
  const dy = e.changedTouches[0].clientY - _gsy;
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return;
  navigateAlbum(dx < 0 ? 1 : -1);
}, { passive: true });

// Touch swipe in lightbox
let _tx = 0;
lightbox.addEventListener("touchstart", (e) => {
  _tx = e.touches[0].clientX;
}, { passive: true });
lightbox.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - _tx;
  if (Math.abs(dx) > 40) showPhoto(currentIndex + (dx < 0 ? 1 : -1));
}, { passive: true });

window.addEventListener("keydown", (e) => {
  if (!lightbox.open) return;
  if (e.key === "ArrowLeft") showPhoto(currentIndex - 1);
  if (e.key === "ArrowRight") showPhoto(currentIndex + 1);
});

// Boot
async function boot() {
  try {
    const res = await fetch("data/photos.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();

    photos = (manifest.photos || []).map((p) => ({
      ...p,
      title: p.title || pathToTitle(p.relativePath || p.src),
    }));

    const params = getParams();
    const urlAlbum = params.get("album") ?? "";
    const urlSort = params.get("sort") ?? "";
    if (params.has("q") || params.has("seed")) {
      setParams({ q: "", seed: "" });
    }
    const validSorts = ["hue", "flat", "value"];
    if (validSorts.includes(urlSort)) {
      currentSort = urlSort;
      sortControl.querySelectorAll("[data-sort]").forEach((b) => {
        const active = b.dataset.sort === currentSort;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", String(active));
      });
    }

    if (urlAlbum) {
      renderSkeleton();
      renderAlbums(urlAlbum);
      renderGrid(true);

      entryScreen.hidden = true;
      gallery.hidden = false;
    } else {
      initEntry();
    }
  } catch (err) {
    console.error(err);
    photos = [];
    entryError.hidden = false;
  }
}

boot();
