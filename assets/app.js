import { initBracket, openBracket, isDesktop } from "./bracket.js";

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

// DOM
const entryScreen = document.querySelector("#entryScreen");
const wheelEl = document.querySelector("#wheel");
const wheelListEl = document.querySelector("#wheelList");
const wheelMetaEl = document.querySelector("#wheelMeta");
const enterBtn = document.querySelector("#enterBtn");
const enterAllBtn = document.querySelector("#enterAllBtn");
const bracketBtn = document.querySelector("#bracketBtn");
const entryError = document.querySelector("#entryError");

const gallery = document.querySelector("#gallery");
const galleryAlbumLabel = document.querySelector("#galleryAlbumLabel");
const galleryMeta = document.querySelector("#galleryMeta");
const backBtn = document.querySelector("#backBtn");
const copyAlbumLink = document.querySelector("#copyAlbumLink");
const downloadView = document.querySelector("#downloadView");

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
const galleryHeader = document.querySelector(".gallery-header");
const commandBar = document.querySelector(".command-bar");
const toast = document.querySelector("#toast");

// State
let photos = [];
let visiblePhotos = [];
let selectedAlbums = new Set();
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
  // Keep whatever state the entry carries — it is what tells the back button
  // this entry is the gallery rather than the set picker.
  history.replaceState(history.state, "", p.size ? `?${p}` : location.pathname);
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scrollBehavior = () => (prefersReducedMotion() ? "auto" : "smooth");

// Toast: one short status line at the foot of the screen, optionally with a
// single action (Cancel, Undo…). A new message replaces the old one.
let toastTimer = 0;
let toastAction = null;
const toastText = document.createElement("span");
const toastButton = document.createElement("button");
toastButton.type = "button";
toastButton.addEventListener("click", () => toastAction?.());
toast.append(toastText, toastButton);

function showToast(message, { action, onAction, duration = 2600 } = {}) {
  clearTimeout(toastTimer);
  // A modal dialog makes everything outside it inert, so a toast left in
  // <body> would sit unclickable behind the download sheet. Live inside
  // whichever dialog is open.
  const host = document.querySelector("dialog[open]") ?? document.body;
  if (toast.parentElement !== host) host.append(toast);
  // Update in place rather than rebuilding, so a progress count ticking over
  // never pulls the Cancel button out from under a finger.
  toastText.textContent = message;
  toastButton.hidden = !action;
  toastButton.textContent = action ?? "";
  toastAction = onAction ?? null;
  toast.hidden = false;
  if (duration) toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
  toastAction = null;
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

// Originals live on GitHub Releases, a different origin, so the browser ignores
// `download` and treats each click as a navigation — and every new navigation
// cancels the one before it. Firing a burst of link clicks therefore saved
// only the last photo. A hidden iframe per file, spaced out, downloads each
// one (GitHub serves them as attachments, so nothing ever renders).
const DOWNLOAD_GAP_MS = 450;
const DOWNLOAD_CONFIRM_OVER = 25;
let downloadQueue = null;

function downloadViaFrame(url) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = url;
  document.body.append(frame);
  // Long enough for the response headers to arrive and the download to be
  // handed to the browser; removing it sooner can abort a slow start.
  setTimeout(() => frame.remove(), 60_000);
}

function downloadMany(list) {
  if (downloadQueue) cancelDownloads();
  if (!list.length) return;
  if (list.length > DOWNLOAD_CONFIRM_OVER &&
      !confirm(`Download ${list.length} full-size photos? Your browser may ask to allow multiple downloads.`)) {
    return;
  }

  const queue = { list: [...list], done: 0, timer: 0 };
  downloadQueue = queue;

  const step = () => {
    if (downloadQueue !== queue) return;
    if (queue.done >= queue.list.length) {
      downloadQueue = null;
      showToast(`Started ${queue.list.length} download${queue.list.length !== 1 ? "s" : ""}`);
      updateDownloadButton();
      return;
    }
    downloadViaFrame(queue.list[queue.done].src);
    queue.done++;
    if (queue.list.length > 1) {
      showToast(`Downloading ${queue.done} / ${queue.list.length}`, {
        action: "Cancel",
        onAction: cancelDownloads,
        duration: 0,
      });
    }
    updateDownloadButton();
    queue.timer = setTimeout(step, DOWNLOAD_GAP_MS);
  };
  step();
}

function cancelDownloads() {
  if (!downloadQueue) return;
  clearTimeout(downloadQueue.timer);
  const { done, list } = downloadQueue;
  downloadQueue = null;
  showToast(`Stopped after ${done} of ${list.length}`);
  updateDownloadButton();
}

function updateDownloadButton() {
  if (downloadQueue) {
    downloadAllVisible.textContent = "Stop";
    downloadAllVisible.disabled = false;
  } else {
    downloadAllVisible.textContent = `Download Shown (${visiblePhotos.length})`;
    downloadAllVisible.disabled = !visiblePhotos.length;
  }
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

    // A drag that happens to end over another row must not also count as a
    // click on that row, or releasing the wheel yanks it somewhere else.
    this._moved = false;

    this.list.addEventListener("click", (e) => {
      if (this._moved) return;
      const el = e.target.closest("[data-idx]");
      if (!el) return;
      const idx = Number(el.dataset.idx);
      // Tapping the set that is already centred opens it — on a phone the
      // Open button is a thumb-stretch below the wheel.
      if (idx === this.index) doEnter();
      else this._go(idx);
    });

    // Trackpads report a scroll gesture as dozens of small wheel events; one
    // step per event sent the wheel flying past every set. Accumulate the
    // distance and step once per notch-sized chunk instead.
    const WHEEL_STEP = 40;
    let wheelAcc = 0;
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (Math.sign(dy) !== Math.sign(wheelAcc)) wheelAcc = 0;
      wheelAcc += dy;
      if (Math.abs(wheelAcc) < WHEEL_STEP) return;
      this._go(this.index + Math.sign(wheelAcc));
      wheelAcc = 0;
    }, { passive: false });

    const DRAG_SLOP = 6;
    const dragTo = (y) => {
      const dy = this._drag.y - y;
      if (Math.abs(dy) > DRAG_SLOP) this._moved = true;
      if (this._moved) this._go(this._drag.idx + Math.round(dy / IH), false);
    };

    vp.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this._drag = { y: e.clientY, idx: this.index };
      this._moved = false;
      vp.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (this._drag) dragTo(e.clientY);
    });
    window.addEventListener("mouseup", () => {
      if (!this._drag) return;
      this._drag = null;
      vp.style.cursor = "";
      if (this._moved) this._go(this.index, true);
    });

    vp.addEventListener("touchstart", (e) => {
      this._drag = { y: e.touches[0].clientY, idx: this.index };
      this._moved = false;
    }, { passive: true });
    vp.addEventListener("touchmove", (e) => {
      if (!this._drag) return;
      e.preventDefault();
      dragTo(e.touches[0].clientY);
    }, { passive: false });
    vp.addEventListener("touchend", () => {
      if (!this._drag) return;
      this._drag = null;
      if (this._moved) this._go(this.index, true);
    }, { passive: true });

    window.addEventListener("keydown", (e) => {
      if (entryScreen.hidden || entryScreen.classList.contains("is-out")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        this.go(1);
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        this.go(-1);
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        this._go(e.key === "Home" ? 0 : this.items.length - 1);
      }
      if (e.key === "Enter" || e.key === " ") {
        // Enter on a focused button (Full Archive, Bracket) belongs to that
        // button; swallowing it here opened the wheel's set instead.
        if (e.target.closest?.("button, a")) return;
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

  // Build the wheel once. Coming back from the gallery used to construct a
  // fresh WheelPicker each time, and every one of them registered its own
  // window key and mouse handlers — after a few round trips one arrow press
  // moved the wheel several sets.
  if (!picker) {
    picker = new WheelPicker(wheelEl, wheelListEl, items, (item) => {
      if (!item) {
        wheelMetaEl.textContent = "";
        return;
      }
      const parts = [`${item.count} photograph${item.count !== 1 ? "s" : ""}`];
      if (item.date) parts.push(item.date);
      wheelMetaEl.textContent = parts.join(" / ");
    });
  }

  entryScreen.hidden = false;
  entryScreen.classList.remove("is-out");
  gallery.hidden = true;
}

function doEnter() {
  const album = picker?.selected?.value ?? "";
  selectedAlbums = album ? new Set([album]) : new Set();
  transitionToGallery();
}

function enterAllPhotos() {
  selectedAlbums = new Set();
  transitionToGallery();
}

function transitionToGallery() {
  // Give the gallery its own history entry so a phone's back gesture returns
  // to the set picker instead of leaving the site.
  if (history.state?.view !== "gallery") {
    history.pushState({ view: "gallery", fromEntry: true }, "", location.href);
  }

  entryScreen.classList.add("is-out");
  setTimeout(() => {
    entryScreen.hidden = true;
  }, 490);

  renderAlbums();
  renderGrid(true);

  gallery.hidden = false;
  gallery.classList.remove("is-out");
  gallery.classList.add("is-entering");
  setTimeout(() => gallery.classList.remove("is-entering"), 540);
}

function transitionToEntry() {
  selectedAlbums = new Set();
  gallery.classList.add("is-out");
  setTimeout(() => {
    gallery.hidden = true;
    gallery.classList.remove("is-out");
    initEntry();
  }, 370);
  setParams({ album: "" });
  // Whatever got us here, this entry is now the picker.
  history.replaceState(null, "", location.href);
}

// Leave through history when the gallery was entered from the picker, so
// the in-page back arrow and the browser's back button are the same step.
// A gallery opened straight from a shared link has no picker behind it.
function leaveGallery() {
  if (history.state?.view === "gallery" && history.state?.fromEntry) history.back();
  else transitionToEntry();
}

function enterBracket() {
  entryScreen.hidden = true;
  entryScreen.classList.remove("is-out");
  openBracket();
}

// Desktop only, so the button is never rendered on a phone rather than being
// rendered and then refusing to work.
function setupBracket() {
  if (!isDesktop()) return;
  bracketBtn.hidden = false;
  initBracket({
    getPhotos: () => photos,
    albumLabel,
    albumDate: (album) => manifest?.albumDates?.[album] ?? null,
    // Just unhide what is already there. Calling initEntry() would build a
    // second WheelPicker over the same elements, and each one registers its
    // own global key handler that then fights the first.
    onExit: () => {
      entryScreen.hidden = false;
    },
  });
  bracketBtn.addEventListener("click", enterBracket);
}

enterBtn.addEventListener("click", doEnter);
enterAllBtn.addEventListener("click", enterAllPhotos);
backBtn.addEventListener("click", leaveGallery);

// Gallery: albums
function renderAlbums() {
  // Same newest-first order as the entry wheel, so the set just added is at
  // the front of the rail rather than buried alphabetically.
  const items = buildWheelItems();
  const displayMap = manifest?.albumDisplay ?? {};

  albumRail.innerHTML = "";
  albumRail.append(makeChip("", `All (${photos.length})`));
  for (const { value, display, count } of items) {
    const label = displayMap[value] || display.replace(/ \/ /g, " > ");
    albumRail.append(makeChip(value, `${label} (${count})`));
  }
  updateRailActive();
}

function makeChip(album, text) {
  const btn = document.createElement("button");
  btn.className = "album-chip";
  btn.type = "button";
  btn.dataset.album = album;
  btn.title = album || "All photos";

  if (album) {
    const toggle = document.createElement("span");
    toggle.className = "chip-toggle";
    toggle.dataset.toggle = album;
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("tabindex", "0");
    toggle.setAttribute("aria-label", `Blend in ${text}`);
    btn.append(toggle);
  }

  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = text;
  btn.append(label);

  return btn;
}

function updateRailActive() {
  const activeChips = [];
  albumRail.querySelectorAll(".album-chip").forEach((chip) => {
    const album = chip.dataset.album;
    const on = album ? isAlbumSelected(album) : selectedAlbums.size === 0;
    chip.classList.toggle("is-active", on);
    const toggle = chip.querySelector(".chip-toggle");
    if (toggle) {
      toggle.classList.toggle("is-checked", on);
      toggle.setAttribute("aria-checked", String(on));
    }
    if (on) activeChips.push(chip);
  });
  // Only auto-scroll when a single set is in view — with a blend open, any
  // one chip isn't more "current" than the others.
  if (activeChips.length === 1) revealChip(activeChips[0]);
  updateRailFades();
}

// Scroll the rail — and only the rail — so a chip is fully in view.
// scrollIntoView would also nudge the page vertically, and it fought the
// user's own finger when it fired mid-swipe.
function revealChip(chip) {
  const pad = 24;
  const viewL = albumRail.scrollLeft;
  const left = chip.getBoundingClientRect().left - albumRail.getBoundingClientRect().left + viewL;
  const right = left + chip.offsetWidth;
  const viewR = viewL + albumRail.clientWidth;
  if (left >= viewL + pad && right <= viewR - pad) return;
  const target = left < viewL + pad ? left - pad : right - albumRail.clientWidth + pad;
  albumRail.scrollTo({ left: Math.max(0, target), behavior: scrollBehavior() });
}

function updateRailFades() {
  const max = albumRail.scrollWidth - albumRail.clientWidth;
  albumRail.classList.toggle("has-more-start", albumRail.scrollLeft > 2);
  albumRail.classList.toggle("has-more-end", albumRail.scrollLeft < max - 2);
}

albumRail.addEventListener("scroll", updateRailFades, { passive: true });

// With the scrollbar hidden, a plain mouse wheel had no way to reach the sets
// past the right edge. Turn vertical wheel movement over the rail into
// sideways scrolling — until the rail hits its end, then let the page scroll.
albumRail.addEventListener("wheel", (e) => {
  if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  const max = albumRail.scrollWidth - albumRail.clientWidth;
  if (max <= 0) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const atEnd = dy > 0 ? albumRail.scrollLeft >= max - 1 : albumRail.scrollLeft <= 0;
  if (atEnd) return;
  e.preventDefault();
  albumRail.scrollLeft += dy;
}, { passive: false });

// Gallery: multi-set blending
function allAlbumKeys() {
  return [...getAlbumCounts().keys()];
}

function isAlbumSelected(album) {
  return selectedAlbums.size === 0 || selectedAlbums.has(album);
}

function currentAlbumsLabel() {
  if (selectedAlbums.size === 0) return "All photos";
  const names = [...selectedAlbums].map((a) => albumLabel(a));
  return names.length <= 3 ? names.join(" + ") : `${names.length} sets blended`;
}

function selectSingleAlbum(album) {
  selectedAlbums = album ? new Set([album]) : new Set();
  renderGrid(true);
  scrollGridToTop();
}

// Switching sets from deep in a long one left you staring at the middle of
// the new set (or past its end). Start the new set from its first row.
function scrollGridToTop() {
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
}

function toggleAlbumBlend(album) {
  if (isAlbumSelected(album)) {
    const base = selectedAlbums.size === 0 ? allAlbumKeys() : [...selectedAlbums];
    const next = new Set(base.filter((a) => a !== album));
    if (next.size === 0) {
      // Last remaining set was just closed — nothing left to view.
      leaveGallery();
      return;
    }
    selectedAlbums = next;
  } else {
    const next = new Set(selectedAlbums);
    next.add(album);
    selectedAlbums = next.size === allAlbumKeys().length ? new Set() : next;
  }
  renderGrid(true);
}

// Gallery: color model
//
// Each photo carries {h,s,l,c,u,b} from data/colors.json:
//   h,s,l  the dominant hue and the saturation/lightness of *only* those pixels
//   c      % of the frame that is coloured at all
//   u      % of the frame agreeing with the dominant hue
//   b      the whole image's average lightness

// True image brightness. Pre-v5 caches have no `b`; fall back to the old
// dominant-hue lightness so a stale colors.json still sorts sensibly.
const lum = (c) => c.b ?? c.l;

// Almost nothing in the frame is coloured, so its "hue" is noise. These are
// parked after the rainbow instead of being scattered through it.
const isNeutral = (c) => (c.c ?? 100) < 12;

// The colour a photo is represented by in Swatches view and the corner dot.
// Saturation is scaled by how much of the frame is actually coloured, and the
// lightness is the image's real brightness — so a dark, mostly-grey photo with
// one vivid accent reads as dark grey rather than as a bright saturated tile.
function swatchColor(c) {
  const sat = Math.round(c.s * ((c.c ?? 100) / 100));
  return `hsl(${c.h},${sat}%,${lum(c)}%)`;
}

// Shared comparator wrapper: photos with no extracted color always sink.
function byColor(compare) {
  return (a, b) => {
    const ca = a.color, cb = b.color;
    if (!ca && !cb) return 0;
    if (!ca) return 1;
    if (!cb) return -1;
    return compare(ca, cb);
  };
}

// Gallery: ordering
function sortPhotos(items) {
  switch (currentSort) {
    case "hue":
      // Rotate +15° so red is contiguous (345°–360° joins 0°–15°) instead of
      // split across both ends, then quantise to 10° steps. Stepping rather
      // than comparing raw hue lets near-identical hues group together
      // vivid-first, while the overall sweep stays a smooth rainbow.
      return [...items].sort(byColor((ca, cb) => {
        const na = isNeutral(ca), nb = isNeutral(cb);
        if (na !== nb) return na ? 1 : -1;
        if (na) return lum(ca) - lum(cb);
        const step = (c) => Math.floor(((c.h + 15) % 360) / 10);
        return (step(ca) - step(cb)) || (cb.s - ca.s) || (lum(cb) - lum(ca));
      }));

    case "flat":
      // Colour unity: how much of the frame agrees on a single hue. Graphic,
      // near-monochrome images first; busy multi-coloured ones last.
      return [...items].sort(byColor((ca, cb) =>
        ((cb.u ?? 0) - (ca.u ?? 0)) || (cb.s - ca.s)));

    case "value":
      // Actual image brightness, lightest first. Previously this used the
      // dominant hue's HSV value, which ranked a dark frame with one bright
      // accent as a bright photo.
      return [...items].sort(byColor((ca, cb) => lum(cb) - lum(ca)));

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

  // Build gradient from evenly-sampled photos (sorted by hue). Saturation is
  // forced high because this is a position index, not a preview — it needs to
  // read as a rainbow at 6px wide.
  const N = Math.min(visiblePhotos.length, 36);
  const stops = [];
  for (let i = 0; i < N; i++) {
    const t = N === 1 ? 0 : i / (N - 1);
    const c = visiblePhotos[Math.round(t * (visiblePhotos.length - 1))]?.color;
    // Neutrals sort last and carry h=0; drawing them literally would paint a
    // false red band at the foot of the ribbon.
    const stop = !c || isNeutral(c) ? `hsl(0,0%,${c ? lum(c) : 45}%)` : `hsl(${c.h},95%,50%)`;
    stops.push(`${stop} ${(t * 100).toFixed(1)}%`);
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
  visiblePhotos = sortPhotos(
    photos.filter((p) => {
      if (selectedAlbums.size === 0) return true;
      return selectedAlbums.has(p.album || "Loose Photos");
    })
  );

  emptyState.hidden = visiblePhotos.length !== 0;
  if (thumbObserver) thumbObserver.disconnect();
  grid.innerHTML = "";

  const albumName = currentAlbumsLabel();
  galleryAlbumLabel.textContent = albumName;
  galleryMeta.textContent = `${visiblePhotos.length} of ${photos.length} photos`;
  document.title = selectedAlbums.size ? `${albumName} - Photo Gallery` : "Photo Gallery";

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
      const hsl = swatchColor(photo.color);
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
    album: [...selectedAlbums].join(","),
    sort: currentSort !== "filename" ? currentSort : "",
    seed: "",
    q: "",
  });

  updateColorBar();
}

// Loads the full-resolution photo in the background and swaps it into the
// lightbox once ready. Retries once on failure — mobile connections drop
// requests often enough that a silent, permanent fallback to the thumbnail
// isn't acceptable.
function loadFullRes(photo, idx, isRetry = false) {
  const hd = new Image();
  hd.onload = () => { if (currentIndex === idx) lightboxImage.src = hd.src; };
  hd.onerror = () => {
    if (currentIndex !== idx || isRetry) return;
    setTimeout(() => { if (currentIndex === idx) loadFullRes(photo, idx, true); }, 1500);
  };
  hd.src = photo.src;
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
  downloadPhoto.href = photo.src;
  downloadPhoto.download = fileName(photo);

  // Try to upgrade to full-res in the background; swap only if still on this photo
  if (photo.src !== thumb) {
    loadFullRes(photo, idx);
  }

  if (!lightbox.open) openDialog(lightbox, "lightbox");
}

// Dialogs get a history entry of their own, so the back gesture on a phone
// closes the photo instead of dropping out of the gallery (or the site).
function openDialog(dialog, name) {
  history.pushState({ ...history.state, overlay: name }, "", location.href);
  dialog.showModal();
}

for (const [dialog, name] of [[lightbox, "lightbox"], [downloadSheet, "sheet"]]) {
  dialog.addEventListener("close", () => {
    // A download still in progress keeps reporting after the sheet closes.
    if (toast.parentElement === dialog) document.body.append(toast);
    // Closed by button, Esc or backdrop: drop the entry it pushed. Closed by
    // popstate: the entry is already gone and there is nothing to undo.
    if (history.state?.overlay === name) history.back();
  });
}

window.addEventListener("popstate", () => {
  const state = history.state;
  if (lightbox.open && state?.overlay !== "lightbox") lightbox.close();
  if (downloadSheet.open && state?.overlay !== "sheet") downloadSheet.close();
  if (state?.overlay) return;

  if (!gallery.hidden && state?.view !== "gallery") {
    transitionToEntry();
  } else if (gallery.hidden && state?.view === "gallery" && !entryScreen.hidden) {
    // Forward again from the picker: reopen whatever the URL names.
    const album = getParams().get("album") ?? "";
    selectedAlbums = new Set(album.split(",").map((s) => s.trim()).filter(Boolean));
    transitionToGallery();
  }
});

lightboxImage.addEventListener("load", () => lightboxImage.classList.remove("is-loading"));

// Download sheet
function renderDownloadSheet() {
  downloadTitle.textContent = currentAlbumsLabel();
  // The total matters before committing to a few hundred full-size files.
  const totalBytes = visiblePhotos.reduce((sum, p) => sum + (p.size || 0), 0);
  const count = `${visiblePhotos.length} photo${visiblePhotos.length !== 1 ? "s" : ""} shown`;
  downloadSummary.textContent = totalBytes ? `${count} · ${formatBytes(totalBytes)}` : `${count}.`;
  updateDownloadButton();

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
  if (!downloadSheet.open) openDialog(downloadSheet, "sheet");
}

// Share
// On a phone the button is an icon, so feedback goes through the toast; and
// where the OS has a share sheet (phones), that beats a silent clipboard copy.
const canNativeShare = () =>
  typeof navigator.share === "function" && window.matchMedia("(hover: none)").matches;

async function shareAlbum() {
  const url = location.href;
  if (canNativeShare()) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // the user closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied");
  } catch {
    // Previously this just relabelled the button "Copy URL", which read as
    // an instruction rather than a failure.
    showToast("Couldn't reach the clipboard — copy the link from the address bar");
  }
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
  const toggle = e.target.closest(".chip-toggle");
  if (toggle) {
    e.stopPropagation();
    toggleAlbumBlend(toggle.dataset.toggle);
    return;
  }
  const chip = e.target.closest(".album-chip");
  if (!chip) return;
  selectSingleAlbum(chip.dataset.album);
});

albumRail.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const toggle = e.target.closest(".chip-toggle");
  if (!toggle) return;
  e.preventDefault();
  toggleAlbumBlend(toggle.dataset.toggle);
});

// On a phone the grid is a fixed column count (see styles.css); each size
// option picks one, so the buttons do something there too.
const MOBILE_COLS = { 80: 6, 140: 4, 190: 3, 250: 2 };

function applyTileSize(value) {
  currentTileMin = parseInt(value, 10);
  const root = document.documentElement.style;
  root.setProperty("--tile-min", `${value}px`);
  const cols = MOBILE_COLS[currentTileMin];
  if (cols) root.setProperty("--mobile-cols", String(cols));
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
  // With the viewer or the download sheet open, re-sorting the grid behind
  // it silently re-pointed the viewer's prev/next at different photos.
  if (lightbox.open || downloadSheet.open) return;
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
    const gridWidth = grid.clientWidth;
    // Grid's distance from document top (stable regardless of current scroll position)
    const gridDocTop = grid.getBoundingClientRect().top + window.scrollY;
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
  if (downloadQueue) cancelDownloads();
  else downloadMany(visiblePhotos);
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
  const current = selectedAlbums.size === 1 ? [...selectedAlbums][0] : "";
  const idx = values.indexOf(current);
  const next = ((idx + delta) % values.length + values.length) % values.length;
  selectSingleAlbum(values[next]);
}

// A sideways swipe on the page flips to the next set. It must leave alone
// anything that scrolls sideways by itself — swiping the set rail used to
// change the set instead of scrolling the rail, which made every set past
// the first screenful unreachable on a phone — and pinch-zoom or panning
// a zoomed-in page, which look like swipes too.
const SWIPE_MIN = 60;
let gallerySwipe = null;

const isZoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;

gallery.addEventListener("touchstart", (e) => {
  const blocked =
    e.touches.length > 1 ||
    isZoomed() ||
    e.target.closest(".album-rail, .command-bar, .gallery-header");
  gallerySwipe = blocked ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
gallery.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) gallerySwipe = null;
}, { passive: true });
gallery.addEventListener("touchend", (e) => {
  if (!gallerySwipe || e.touches.length > 0) return;
  const dx = e.changedTouches[0].clientX - gallerySwipe.x;
  const dy = e.changedTouches[0].clientY - gallerySwipe.y;
  gallerySwipe = null;
  // Clearly sideways, not a slightly slanted scroll.
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  navigateAlbum(dx < 0 ? 1 : -1);
}, { passive: true });

// Touch swipe in lightbox
// Sideways flips photos; a firm downward swipe closes, like most phone
// viewers. Pinching to look closer must not count as either.
let lightboxSwipe = null;
lightbox.addEventListener("touchstart", (e) => {
  lightboxSwipe = e.touches.length > 1 || isZoomed()
    ? null
    : { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
lightbox.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) lightboxSwipe = null;
}, { passive: true });
lightbox.addEventListener("touchend", (e) => {
  if (!lightboxSwipe || e.touches.length > 0) return;
  const dx = e.changedTouches[0].clientX - lightboxSwipe.x;
  const dy = e.changedTouches[0].clientY - lightboxSwipe.y;
  lightboxSwipe = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
    showPhoto(currentIndex + (dx < 0 ? 1 : -1));
  } else if (dy > 90 && dy > Math.abs(dx) * 1.5) {
    lightbox.close();
  }
}, { passive: true });

window.addEventListener("keydown", (e) => {
  if (!lightbox.open) return;
  if (e.key === "ArrowLeft") showPhoto(currentIndex - 1);
  if (e.key === "ArrowRight") showPhoto(currentIndex + 1);
});

// Sticky offsets: the header grows with the notch inset and the command bar
// wraps to two rows on narrower windows, so hard-coded tops let the set rail
// slide underneath them. Measure instead.
function syncStickyOffsets() {
  const root = document.documentElement.style;
  if (galleryHeader.offsetHeight) root.setProperty("--header-h", `${galleryHeader.offsetHeight}px`);
  if (commandBar.offsetHeight) root.setProperty("--command-h", `${commandBar.offsetHeight}px`);
}

if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(syncStickyOffsets);
  ro.observe(galleryHeader);
  ro.observe(commandBar);
}
window.addEventListener("resize", updateRailFades, { passive: true });

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

    setupBracket();

    if (urlAlbum) {
      selectedAlbums = new Set(urlAlbum.split(",").map((s) => s.trim()).filter(Boolean));

      renderSkeleton();
      renderAlbums();
      renderGrid(true);

      entryScreen.hidden = true;
      gallery.hidden = false;
      // Opened from a shared link: mark this entry as the gallery so the
      // back handling knows where it stands.
      history.replaceState({ view: "gallery" }, "", location.href);
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
