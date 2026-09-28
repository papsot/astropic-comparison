(() => {
  "use strict";

  const DB_NAME = "image-compare";
  const STORE = "images";
  const SLOTS = ["a", "b"];

  const $ = (sel, root = document) => root.querySelector(sel);

  const state = { a: null, b: null };

  const els = {
    zones: { a: $('.dropzone[data-slot="a"]'), b: $('.dropzone[data-slot="b"]') },
    swap: $("#swap-btn"),
    clear: $("#clear-btn"),
    error: $("#error"),
    hint: $("#hint"),
    results: $("#results"),
    compare: $("#compare"),
    handle: $("#compare-handle"),
    compareA: $("#compare-a"),
    compareB: $("#compare-b"),
    labelA: $("#label-a"),
    labelB: $("#label-b"),
    sizeNote: $("#size-note"),
    statsBody: $("#stats-body"),
  };

  // ---------- Storage (IndexedDB, since images easily exceed localStorage limits) ----------

  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);

  async function withStore(mode, fn) {
    const db = await dbPromise;
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const readStored = (slot) => withStore("readonly", (s) => s.get(slot));

  function persist(slot) {
    const data = state[slot];
    const op = data
      ? withStore("readwrite", (s) => s.put(data.file, slot))
      : withStore("readwrite", (s) => s.delete(slot));
    op.catch(() => {});
  }

  // ---------- Image analysis ----------

  function analyze(img) {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    let r = 0, g = 0, b = 0, luma = 0, weight = 0, transparent = false;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (data[i + 3] < 255) transparent = true;
      r += data[i] * alpha;
      g += data[i + 1] * alpha;
      b += data[i + 2] * alpha;
      luma += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * alpha;
      weight += alpha;
    }

    if (weight === 0) return { color: null, brightness: null, transparent: true };
    return {
      color: [r, g, b].map((v) => Math.round(v / weight)),
      brightness: (luma / weight / 255) * 100,
      transparent,
    };
  }

  function loadFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ file, url, width: img.naturalWidth, height: img.naturalHeight, ...analyze(img) });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("this file could not be read as an image."));
      };
      img.src = url;
    });
  }

  // ---------- Formatting ----------

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
  }

  function formatType(file) {
    const sub = file.type.split("/")[1];
    if (sub) return sub.replace(/\+xml$/, "").toUpperCase();
    return file.name.includes(".") ? file.name.split(".").pop().toUpperCase() : "Unknown";
  }

  function aspectRatio(w, h) {
    if (!w || !h) return "—";
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    const d = gcd(w, h);
    const rw = w / d;
    const rh = h / d;
    return rw <= 50 && rh <= 50 ? `${rw}:${rh}` : `${(w / h).toFixed(2)}:1`;
  }

  const toHex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

  function swatch(color) {
    if (!color) return "—";
    const hex = toHex(color);
    const wrap = document.createElement("span");
    wrap.className = "swatch";
    const chip = document.createElement("i");
    chip.style.background = hex;
    wrap.append(chip, hex);
    return wrap;
  }

  // ---------- Diffs ----------

  function numericDiff(a, b, { relative = true, unit = "" } = {}) {
    if (a == null || b == null) return null;
    const delta = relative ? (a === 0 ? NaN : ((b - a) / a) * 100) : b - a;
    if (!Number.isFinite(delta)) return null;
    if (Math.abs(delta) < 0.05) return { text: "Same", tone: "same" };
    const sign = delta > 0 ? "+" : "−";
    return {
      text: `${sign}${Math.abs(delta).toFixed(1)}${relative ? "%" : unit}`,
      tone: delta > 0 ? "up" : "down",
    };
  }

  const matchDiff = (a, b) =>
    a === b ? { text: "Match", tone: "same" } : { text: "Differs", tone: "warn" };

  function buildRows(A, B) {
    const pixels = (s) => s.width * s.height;
    const megapixels = (s) => `${(pixels(s) / 1e6).toFixed(2)} MP`;
    const bpp = (s) => (pixels(s) ? (s.file.size * 8) / pixels(s) : null);
    const fmtBpp = (s) => (bpp(s) == null ? "—" : bpp(s).toFixed(2));
    const fmtBrightness = (s) => (s.brightness == null ? "—" : `${s.brightness.toFixed(1)}%`);
    const dims = (s) => `${s.width} × ${s.height}`;
    const date = (s) => new Date(s.file.lastModified).toLocaleString();
    const yesNo = (v) => (v ? "Yes" : "No");

    return [
      { label: "File name", a: A.file.name, b: B.file.name },
      { label: "Format", a: formatType(A.file), b: formatType(B.file), diff: matchDiff(formatType(A.file), formatType(B.file)) },
      { label: "File size", a: formatBytes(A.file.size), b: formatBytes(B.file.size), diff: numericDiff(A.file.size, B.file.size) },
      { label: "Dimensions", a: dims(A), b: dims(B), diff: matchDiff(dims(A), dims(B)) },
      { label: "Resolution", a: megapixels(A), b: megapixels(B), diff: numericDiff(pixels(A), pixels(B)) },
      { label: "Aspect ratio", a: aspectRatio(A.width, A.height), b: aspectRatio(B.width, B.height), diff: matchDiff(aspectRatio(A.width, A.height), aspectRatio(B.width, B.height)) },
      { label: "Bits per pixel", hint: "Lower = more compressed", a: fmtBpp(A), b: fmtBpp(B), diff: numericDiff(bpp(A), bpp(B)) },
      { label: "Average color", a: swatch(A.color), b: swatch(B.color), diff: A.color && B.color ? matchDiff(toHex(A.color), toHex(B.color)) : null },
      { label: "Brightness", a: fmtBrightness(A), b: fmtBrightness(B), diff: numericDiff(A.brightness, B.brightness, { relative: false, unit: " pts" }) },
      { label: "Transparency", a: yesNo(A.transparent), b: yesNo(B.transparent), diff: matchDiff(A.transparent, B.transparent) },
      { label: "Last modified", a: date(A), b: date(B) },
    ];
  }

  // ---------- Rendering ----------

  function cell(content) {
    const td = document.createElement("td");
    td.append(content);
    return td;
  }

  function diffCell(diff) {
    if (!diff) return cell("—");
    const pill = document.createElement("span");
    pill.className = `pill pill-${diff.tone}`;
    pill.textContent = diff.text;
    return cell(pill);
  }

  function renderStats() {
    const rows = buildRows(state.a, state.b).map((row) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = row.label;
      if (row.hint) {
        const small = document.createElement("small");
        small.textContent = row.hint;
        th.append(small);
      }
      tr.append(th, cell(row.a), cell(row.b), diffCell(row.diff));
      return tr;
    });
    els.statsBody.replaceChildren(...rows);
  }

  function render() {
    for (const slot of SLOTS) {
      const zone = els.zones[slot];
      const data = state[slot];
      const preview = $(".dropzone-preview", zone);
      zone.classList.toggle("has-image", Boolean(data));
      if (data) {
        preview.src = data.url;
        $(".dropzone-name", zone).textContent = data.file.name;
        $(".dropzone-meta", zone).textContent = `${data.width} × ${data.height} · ${formatBytes(data.file.size)}`;
      } else {
        preview.removeAttribute("src");
      }
    }

    const hasAny = Boolean(state.a || state.b);
    const hasBoth = Boolean(state.a && state.b);
    els.swap.disabled = !hasAny;
    els.clear.disabled = !hasAny;
    els.hint.hidden = hasBoth;
    els.results.hidden = !hasBoth;
    if (!hasBoth) return;

    els.compareA.src = state.a.url;
    els.compareB.src = state.b.url;
    els.labelA.textContent = `A · ${state.a.file.name}`;
    els.labelB.textContent = `B · ${state.b.file.name}`;
    const { width, height } = state.a;
    els.compare.style.setProperty("--ratio", width && height ? `${width} / ${height}` : "16 / 9");
    els.sizeNote.hidden = state.a.width === state.b.width && state.a.height === state.b.height;
    renderStats();
  }

  let errorTimer;
  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (els.error.hidden = true), 5000);
  }

  // ---------- State changes ----------

  async function setImage(slot, file) {
    if (!file.type.startsWith("image/")) {
      showError(`"${file.name}" is not an image.`);
      return;
    }
    try {
      const data = await loadFile(file);
      if (state[slot]) URL.revokeObjectURL(state[slot].url);
      state[slot] = data;
      persist(slot);
      render();
    } catch (err) {
      showError(`"${file.name}": ${err.message}`);
    }
  }

  function clearImage(slot) {
    if (state[slot]) URL.revokeObjectURL(state[slot].url);
    state[slot] = null;
    persist(slot);
    render();
  }

  // ---------- Upload interactions ----------

  for (const slot of SLOTS) {
    const zone = els.zones[slot];
    const input = $("input", zone);

    input.addEventListener("change", () => {
      if (input.files[0]) setImage(slot, input.files[0]);
      input.value = "";
    });

    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("is-dragover");
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return showError("Please drop an image file.");
      if (files.length > 1) {
        setImage("a", files[0]);
        setImage("b", files[1]);
      } else {
        setImage(slot, files[0]);
      }
    });

    $(".remove-btn", zone).addEventListener("click", (e) => {
      e.preventDefault();
      clearImage(slot);
    });
  }

  // Keep the browser from navigating to a file dropped outside a dropzone.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  els.swap.addEventListener("click", () => {
    [state.a, state.b] = [state.b, state.a];
    SLOTS.forEach(persist);
    render();
  });

  els.clear.addEventListener("click", () => SLOTS.forEach(clearImage));

  // ---------- Comparison slider ----------

  function setPosition(percent) {
    const pos = Math.min(100, Math.max(0, percent));
    els.compare.style.setProperty("--pos", `${pos}%`);
    els.handle.setAttribute("aria-valuenow", String(Math.round(pos)));
  }

  function positionFromEvent(e) {
    const rect = els.compare.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * 100;
  }

  els.compare.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    els.compare.setPointerCapture(e.pointerId);
    els.compare.classList.add("is-dragging");
    setPosition(positionFromEvent(e));
  });

  els.compare.addEventListener("pointermove", (e) => {
    if (els.compare.hasPointerCapture(e.pointerId)) setPosition(positionFromEvent(e));
  });

  const stopDrag = () => els.compare.classList.remove("is-dragging");
  els.compare.addEventListener("pointerup", stopDrag);
  els.compare.addEventListener("pointercancel", stopDrag);

  els.handle.addEventListener("keydown", (e) => {
    const current = Number(els.handle.getAttribute("aria-valuenow"));
    const step = e.shiftKey ? 10 : 2;
    const next = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      Home: 0,
      End: 100,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setPosition(next);
  });

  // ---------- Init ----------

  (async () => {
    for (const slot of SLOTS) {
      try {
        const file = await readStored(slot);
        if (file) state[slot] = await loadFile(file);
      } catch {
        state[slot] = null;
        persist(slot);
      }
    }
    render();
  })();
})();
