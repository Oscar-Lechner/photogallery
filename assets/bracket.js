/**
 * bracket.js — screens and wiring for the photo bracket.
 *
 * Desktop only, by request: on a narrow or touch-first screen the entry button
 * is never rendered and openBracket() refuses, so the feature does not exist
 * there rather than existing badly.
 */

import {
  createTournament,
  pickWinner,
  deferMatch,
  progress,
  standings,
  nearMisses,
  remainingIds,
  estimateTotal,
  upcomingPair,
  MIN_ENTRANTS,
  WINNERS_TARGET,
  FINALS_FIELD,
} from "./bracket-engine.js";

const STORAGE_KEY = "photogallery:bracket:v1";
const UNDO_DEPTH = 40;

const el = {};
let deps = {
  getPhotos: () => [],
  albumLabel: (a) => a,
  albumDate: () => null,
  onExit: () => {},
};
let byId = new Map();
let state = null;
let history = [];
let chosenSets = new Set();
// Framing per photo, keyed the same way the tournament keys entrants. Kept
// outside tournament state: the crop is the user's, not the bracket's, and it
// should survive being deferred, undone, or met again in a later round.
let crops = {};

// ── Environment ───────────────────────────────────────────────────────────────

export function isDesktop() {
  return window.matchMedia("(min-width: 900px) and (pointer: fine)").matches;
}

// ── Storage ───────────────────────────────────────────────────────────────────
// A 240-match run is a lot to lose to a stray refresh, so every pick is saved.

function saveSession() {
  if (!state) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ savedAt: Date.now(), sets: [...chosenSets], state, crops })
    );
  } catch {
    /* private mode or full quota — the run still works, it just will not resume */
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved?.state?.entrants?.length || saved.state.phase === "done") return null;
    // Photos can disappear between sessions; a stale run is not resumable.
    if (!saved.state.entrants.every((id) => byId.has(id))) return null;
    return saved;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clean up */
  }
}

// ── Setup screen ──────────────────────────────────────────────────────────────

function photosInSets(sets) {
  const all = deps.getPhotos();
  if (!sets.size) return [];
  return all.filter((p) => sets.has(p.album || "Loose Photos"));
}

// Newest set first, matching the order the entry wheel already uses — the two
// screens listing the same sets in different orders would be its own bug.
// Undated sets sink to the bottom rather than claiming 1970.
function byNewestFirst(a, b) {
  const da = deps.albumDate(a) ? new Date(deps.albumDate(a)).getTime() : -Infinity;
  const db = deps.albumDate(b) ? new Date(deps.albumDate(b)).getTime() : -Infinity;
  if (da !== db) return db - da;
  return deps.albumLabel(a).localeCompare(deps.albumLabel(b));
}

function formatSetDate(iso) {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function renderSets() {
  const counts = new Map();
  for (const p of deps.getPhotos()) {
    const a = p.album || "Loose Photos";
    counts.set(a, (counts.get(a) || 0) + 1);
  }

  el.sets.replaceChildren(
    ...[...counts.keys()]
      .sort(byNewestFirst)
      .map((album) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bracket-set";
        btn.dataset.album = album;
        btn.setAttribute("aria-pressed", String(chosenSets.has(album)));
        btn.classList.toggle("is-on", chosenSets.has(album));

        const name = document.createElement("span");
        name.className = "bracket-set-name";
        name.textContent = deps.albumLabel(album);

        const count = document.createElement("span");
        count.className = "bracket-set-count";
        count.textContent = counts.get(album);

        const when = document.createElement("span");
        when.className = "bracket-set-date";
        when.textContent = formatSetDate(deps.albumDate(album));

        btn.append(name, count, when);
        btn.addEventListener("click", () => {
          if (chosenSets.has(album)) chosenSets.delete(album);
          else chosenSets.add(album);
          renderSets();
          renderEstimate();
        });
        return btn;
      })
  );
}

function renderEstimate() {
  const n = photosInSets(chosenSets).length;
  const ready = n >= MIN_ENTRANTS;
  el.start.disabled = !ready;

  if (!chosenSets.size) {
    el.estimate.textContent = "No sets chosen.";
  } else if (!ready) {
    el.estimate.textContent = `${n} photo${n === 1 ? "" : "s"} — a bracket needs at least ${MIN_ENTRANTS}. Add another set.`;
  } else {
    const matches = estimateTotal(n);
    const mins = Math.max(1, Math.round((matches * 2.5) / 60));
    el.estimate.textContent = `${n} photos · ~${matches} matches · about ${mins} min`;
  }
  el.estimate.classList.toggle("is-short", Boolean(chosenSets.size) && !ready);
}

function renderResume() {
  const saved = loadSession();
  if (!saved) {
    el.resume.hidden = true;
    return;
  }
  const done = saved.state.matchNo;
  const total = estimateTotal(saved.state.entrants.length);
  el.resumeCopy.textContent = `Unfinished bracket — ${done} of ~${total} matches, ${remainingIds(saved.state).length} photos still in.`;
  el.resume.hidden = false;
}

// ── Run screen ────────────────────────────────────────────────────────────────

function preload(ids) {
  for (const id of ids) {
    const photo = byId.get(id);
    if (photo?.src) new Image().src = photo.src;
  }
}

// ── Square crops ──────────────────────────────────────────────────────────────
// These photos are headed for a square Instagram post, so the square is what
// gets judged, not the full frame. Each photo remembers its own framing:
//   z  — zoom, 1 = the whole short edge fits (a plain centre crop)
//   ox — horizontal position, -1 hard left .. 0 centred .. 1 hard right
//   oy — vertical position, same range
// Positions are stored normalised so they survive a window resize and mean the
// same thing at any zoom.
const DEFAULT_CROP = { z: 1, ox: 0, oy: 0 };
const MAX_ZOOM = 4;

function cropFor(id) {
  return crops[id] ?? DEFAULT_CROP;
}

function setCrop(id, next) {
  crops = { ...crops, [id]: next };
}

// Geometry of one crop box: how big the image is drawn, and how far it can
// travel before a gap would open at an edge.
function cropMetrics(box, img, crop) {
  const side = box.clientWidth;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!side || !w || !h) return null;

  const cover = Math.max(side / w, side / h) * crop.z;
  const drawnW = w * cover;
  const drawnH = h * cover;
  return {
    drawnW,
    drawnH,
    maxX: Math.max(0, (drawnW - side) / 2),
    maxY: Math.max(0, (drawnH - side) / 2),
  };
}

function applyCropTo(box, img, id) {
  const crop = cropFor(id);
  const m = cropMetrics(box, img, crop);
  if (!m) return;

  img.style.width = m.drawnW + "px";
  img.style.height = m.drawnH + "px";
  img.style.transform = `translate(-50%, -50%) translate(${crop.ox * m.maxX}px, ${
    crop.oy * m.maxY
  }px)`;
}

function applyCrop(pane) {
  applyCropTo(pane.querySelector(".bracket-crop"), pane.querySelector("img"), pane.dataset.id);
  const crop = cropFor(pane.dataset.id);
  const zoom = pane.querySelector(".bracket-zoom");
  if (zoom) zoom.textContent = crop.z > 1.02 ? crop.z.toFixed(1) + "x" : "";
}

function applyAllCrops() {
  for (const pane of [el.paneA, el.paneB]) {
    if (pane?.dataset.id) applyCrop(pane);
  }
}

// Drag to reframe. A click only counts as a pick if the pointer barely moved,
// so nudging the crop never accidentally decides the match.
const DRAG_SLOP = 5;

function startDrag(pane, event) {
  const box = pane.querySelector(".bracket-crop");
  const img = pane.querySelector("img");
  const id = pane.dataset.id;
  const start = cropFor(id);
  const m = cropMetrics(box, img, start);
  if (!m) return;

  const originX = event.clientX;
  const originY = event.clientY;
  let moved = 0;

  const onMove = (e) => {
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    setCrop(id, {
      ...start,
      ox: m.maxX ? clamp(start.ox + dx / m.maxX, -1, 1) : 0,
      oy: m.maxY ? clamp(start.oy + dy / m.maxY, -1, 1) : 0,
    });
    applyCrop(pane);
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    box.classList.remove("is-dragging");
    if (moved <= DRAG_SLOP) choose(id);
    else saveSession();
  };

  box.classList.add("is-dragging");
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function zoomPane(pane, delta) {
  const id = pane.dataset.id;
  const crop = cropFor(id);
  const z = clamp(crop.z * (1 - delta * 0.0015), 1, MAX_ZOOM);
  setCrop(id, { ...crop, z });
  applyCrop(pane);
  saveSession();
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// Thumbnails are square center-crops, so they are the wrong thing to judge on.
// They paint instantly though, so show one and swap in the original behind it.
function paintPane(pane, photo) {
  pane.dataset.id = photo.relativePath;
  pane.querySelector(".bracket-pane-title").textContent = photo.title || "";
  pane.querySelector(".bracket-pane-album").textContent = deps.albumLabel(photo.album);

  const img = pane.querySelector("img");
  img.alt = photo.title || "";

  // A pane's img fires load on every src it is given — thumbnail and original
  // both — and applyCrop is wired to that once in initBracket, so the framing
  // reapplies itself as soon as real dimensions are known.
  if (!photo.src || photo.src === photo.thumbSrc) {
    img.src = photo.thumbSrc || photo.src;
    pane.classList.remove("is-placeholder");
    return;
  }

  // Preloading means the original is usually already in cache by now, and a
  // cached image reports complete synchronously — so paint it directly and skip
  // the thumbnail entirely, which keeps the crop from jumping mid-comparison.
  const full = new Image();
  full.src = photo.src;
  if (full.complete && full.naturalWidth) {
    img.src = photo.src;
    pane.classList.remove("is-placeholder");
    applyCrop(pane);
    return;
  }

  img.src = photo.thumbSrc;
  pane.classList.add("is-placeholder");
  full.addEventListener("load", () => {
    // The user may have clicked through already; only swap if still showing.
    if (pane.dataset.id !== photo.relativePath) return;
    img.src = photo.src;
    pane.classList.remove("is-placeholder");
  });
}

function renderMatch() {
  const p = progress(state);

  if (state.phase === "done") {
    renderResults();
    return;
  }

  el.setup.hidden = true;
  el.results.hidden = true;
  el.run.hidden = false;

  const [a, b] = state.match;
  paintPane(el.paneA, byId.get(a));
  paintPane(el.paneB, byId.get(b));

  const pct = Math.min(100, (p.matchNo / Math.max(1, p.total)) * 100);
  el.progressFill.style.width = pct + "%";

  el.phase.textContent = state.phase === "cuts" ? "Cuts" : "Finals";
  el.meta.textContent =
    state.phase === "cuts"
      ? `Match ${p.matchNo + 1} · ${p.alive} left · one loss and out`
      : `Match ${p.matchNo + 1} · ${p.alive} left · two losses and out`;

  el.undo.hidden = history.length === 0;
  preload(upcomingPair(state));
}

function choose(winnerId) {
  if (!state || state.phase === "done" || !state.match) return;
  history = [...history.slice(-(UNDO_DEPTH - 1)), state];
  state = pickWinner(state, winnerId);
  saveSession();
  renderMatch();
}

function undo() {
  if (!history.length) return;
  state = history[history.length - 1];
  history = history.slice(0, -1);
  saveSession();
  renderMatch();
}

// Put both back in the pile rather than forcing a call. Costs neither photo a
// loss, and the engine keeps them apart when it deals the next match.
function defer() {
  if (!state || state.phase === "done" || !state.match) return;
  history = [...history.slice(-(UNDO_DEPTH - 1)), state];
  state = deferMatch(state);
  saveSession();
  renderMatch();
}

function resetCrop(pane) {
  if (!pane.dataset.id) return;
  setCrop(pane.dataset.id, DEFAULT_CROP);
  applyCrop(pane);
  saveSession();
}

// ── Results screen ────────────────────────────────────────────────────────────

function renderResults() {
  el.run.hidden = true;
  el.setup.hidden = true;
  el.results.hidden = false;
  el.undo.hidden = true;
  el.phase.textContent = "Winners";
  el.meta.textContent = `${state.entrants.length} photos · ${state.matchNo} matches`;

  const winners = standings(state);
  el.winners.replaceChildren(
    ...winners.map((id, i) => {
      const photo = byId.get(id);
      const fig = document.createElement("figure");
      fig.className = "bracket-winner";

      // The square you framed is the thing you picked, so it is the thing shown
      // back to you — a centre-cropped thumbnail here would misreport the result.
      const box = document.createElement("div");
      box.className = "bracket-crop is-static";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = photo.title || "";
      img.draggable = false;
      img.addEventListener("load", () => applyCropTo(box, img, id));
      img.src = photo.src || photo.thumbSrc;
      box.append(img);

      const rank = document.createElement("span");
      rank.className = "bracket-rank";
      rank.textContent = i + 1;

      const cap = document.createElement("figcaption");
      cap.textContent = photo.title || "";

      const record = document.createElement("span");
      record.className = "bracket-record";
      record.textContent = `${state.wins[id]}W ${state.losses[id]}L`;

      fig.append(rank, box, cap, record);
      fig.addEventListener("click", () => window.open(photo.src, "_blank", "noopener"));
      return fig;
    })
  );

  const missed = nearMisses(state, 6)
    .map((id) => byId.get(id)?.title)
    .filter(Boolean);
  el.nearMiss.textContent = missed.length ? "Last out: " + missed.join(", ") : "";
}

function downloadWinners() {
  for (const id of standings(state)) {
    const photo = byId.get(id);
    if (!photo) continue;
    const a = document.createElement("a");
    a.href = photo.src;
    a.download = (photo.relativePath || "").split("/").pop() || "photo.jpg";
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }
  el.download.textContent = "Started";
  setTimeout(() => {
    el.download.textContent = `Download Top ${WINNERS_TARGET}`;
  }, 1400);
}

// ── Entry points ──────────────────────────────────────────────────────────────

function startRun(entrantIds) {
  crops = {};
  try {
    state = createTournament(entrantIds);
  } catch (err) {
    el.estimate.textContent = err.message;
    return;
  }
  history = [];
  saveSession();
  renderMatch();
}

export function openBracket() {
  if (!isDesktop()) return;
  byId = new Map(deps.getPhotos().map((p) => [p.relativePath, p]));

  state = null;
  history = [];
  el.root.hidden = false;
  el.root.classList.remove("is-out");
  el.run.hidden = true;
  el.results.hidden = true;
  el.setup.hidden = false;
  el.undo.hidden = true;
  el.phase.textContent = "Bracket";
  el.meta.textContent = `${FINALS_FIELD} advance to the finals · top ${WINNERS_TARGET} win`;

  renderSets();
  renderEstimate();
  renderResume();
}

function closeBracket() {
  el.root.hidden = true;
  state = null;
  history = [];
  deps.onExit();
}

export function initBracket(options) {
  deps = { ...deps, ...options };

  el.root = document.querySelector("#bracket");
  if (!el.root) return;

  el.setup = document.querySelector("#bracketSetup");
  el.sets = document.querySelector("#bracketSets");
  el.estimate = document.querySelector("#bracketEstimate");
  el.start = document.querySelector("#bracketStart");
  el.resume = document.querySelector("#bracketResume");
  el.resumeCopy = document.querySelector("#bracketResumeCopy");
  el.run = document.querySelector("#bracketRun");
  el.paneA = document.querySelector('.bracket-pane[data-side="0"]');
  el.paneB = document.querySelector('.bracket-pane[data-side="1"]');
  el.progressFill = document.querySelector("#bracketProgressFill");
  el.phase = document.querySelector("#bracketPhase");
  el.meta = document.querySelector("#bracketMeta");
  el.undo = document.querySelector("#bracketUndo");
  el.defer = document.querySelector("#bracketDefer");
  el.results = document.querySelector("#bracketResults");
  el.winners = document.querySelector("#bracketWinners");
  el.nearMiss = document.querySelector("#bracketNearMiss");
  el.download = document.querySelector("#bracketDownload");

  el.start.addEventListener("click", () => {
    clearSession();
    startRun(photosInSets(chosenSets).map((p) => p.relativePath));
  });

  document.querySelector("#bracketResumeGo").addEventListener("click", () => {
    const saved = loadSession();
    if (!saved) {
      renderResume();
      return;
    }
    chosenSets = new Set(saved.sets);
    state = saved.state;
    crops = saved.crops ?? {};
    history = [];
    renderMatch();
  });

  document.querySelector("#bracketResumeDrop").addEventListener("click", () => {
    clearSession();
    renderResume();
  });

  for (const pane of [el.paneA, el.paneB]) {
    const box = pane.querySelector(".bracket-crop");
    const img = pane.querySelector("img");

    // Reapply on every src the pane is given, so the framing is restored the
    // moment real dimensions exist — thumbnail first, then the original.
    img.addEventListener("load", () => applyCrop(pane));

    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startDrag(pane, e);
    });

    box.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        zoomPane(pane, e.deltaY);
      },
      { passive: false }
    );

    pane.querySelector('[data-tool="reset"]').addEventListener("click", (e) => {
      e.stopPropagation();
      resetCrop(pane);
    });
  }

  // Reframing is stored as a fraction of the travel available, so a resize only
  // needs the pixel maths run again.
  window.addEventListener("resize", applyAllCrops);

  el.defer.addEventListener("click", defer);
  el.undo.addEventListener("click", undo);
  el.download.addEventListener("click", downloadWinners);

  document.querySelector("#bracketBack").addEventListener("click", closeBracket);
  document.querySelector("#bracketAgain").addEventListener("click", () => {
    clearSession();
    openBracket();
  });

  document.addEventListener("keydown", (e) => {
    if (el.root.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!el.run.hidden) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        choose(el.paneA.dataset.id);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        choose(el.paneB.dataset.id);
      } else if (e.key === " ") {
        e.preventDefault();
        defer();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    }
    if (e.key === "Escape") closeBracket();
  });
}
