/* =========================================================
   MyExpense Tracker — script.js
   Features: Monthly budget, Category pie (Chart.js),
             CSV export/import, Undo delete, Dark mode
   ========================================================= */

/* ---------- App storage (versioned & namespaced) ---------- */
const STORAGE_VERSION = 1;
const NS = `myExpenseTracker:v${STORAGE_VERSION}`;
const STORE = {
  tx: `${NS}:transactions`, // array of { id, date, note, cat, amt }
  prefs: `${NS}:prefs`, // { theme: "light" | "dark" }
  bud: `${NS}:budget`, // number
};

const readJSON = (k, fb) => {
  try {
    const r = localStorage.getItem(k);
    return r ? JSON.parse(r) : fb;
  } catch {
    return fb;
  }
};
const writeJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));

/* ------------------- DOM shortcuts ----------------------- */
const $ = (s) => document.querySelector(s);
const ui = {
  // form inputs
  form: $("#tx-form"),
  date: $("#tx-date"),
  note: $("#tx-note"),
  cat: $("#tx-cat"),
  amt: $("#tx-amt"),

  // table & summary
  tbody: $("#tx-body"),
  empty: $("#empty"),
  monthTotal: $("#sum-total"),

  // controls
  btnSeed: $("#btn-seed"),
  btnReset: $("#btn-reset"),
  btnDark: $("#btn-dark"),

  // budget UI
  budgetInput: $("#budget-input"),
  budgetRemaining: $("#budget-remaining"),

  // chart canvas
  chartCanvas: $("#catChart"),

  // csv + undo
  btnExport: $("#btn-export"),
  btnImport: $("#btn-import"),
  fileInput: $("#csv-file"),
  snackbar: $("#snackbar"),
  snackbarText: $("#snackbar-text"),
  snackbarUndo: $("#snackbar-undo"),
};

// chart + undo state
let catChart = null; // Chart.js instance
let undoTimer = null; // snackbar timeout
let lastDeletedTx = null; // holds last deleted tx for undo

/* ------------------------- init -------------------------- */
init();

function init() {
  // default date = today
  ui.date.value = new Date().toISOString().slice(0, 10);

  // theme boot
  const prefs = readJSON(STORE.prefs, { theme: "light" });
  document.documentElement.setAttribute("data-theme", prefs.theme);
  ui.btnDark.textContent = prefs.theme === "dark" ? "☀️ Light" : "🌙 Dark";

  // budget boot
  const b = Number(readJSON(STORE.bud, 0));
  if (b > 0) ui.budgetInput.value = b;

  // events: form + controls
  ui.form.addEventListener("submit", onAddTx);
  ui.btnSeed.addEventListener("click", onSeedData);
  ui.btnReset.addEventListener("click", onFactoryReset);
  ui.btnDark.addEventListener("click", onToggleTheme);
  ui.budgetInput.addEventListener("change", onBudgetChange);

  // events: csv + undo
  ui.btnExport.addEventListener("click", onExportCSV);
  ui.btnImport.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", onImportCSVFile);
  ui.snackbarUndo.addEventListener("click", onUndoDelete);

  // first render
  renderAll();
}

/* -------------------- core actions ----------------------- */

// add transaction
function onAddTx(e) {
  e.preventDefault();
  const tx = {
    id: crypto.randomUUID(),
    date: ui.date.value,
    note: (ui.note.value || "").trim(),
    cat: ui.cat.value,
    amt: Number(ui.amt.value),
  };
  if (!tx.date || !tx.note || !Number.isFinite(tx.amt) || tx.amt <= 0) return;

  const list = getTxs();
  list.push(tx);
  setTxs(list);

  ui.form.reset();
  ui.date.value = new Date().toISOString().slice(0, 10);
  renderAll();
}

// delete + show undo
function onDeleteTx(id) {
  const list = getTxs();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return;

  lastDeletedTx = list[idx];
  list.splice(idx, 1);
  setTxs(list);

  renderAll();
  showSnackbar("Transaction deleted. Undo?");
}

// sample data
function onSeedData() {
  if (!confirm("Replace current data with sample data?")) return;
  const sample = [
    mkTx(-20, "Groceries", "Food", 42.37),
    mkTx(-18, "Bus pass", "Transport", 63.0),
    mkTx(-15, "Rent", "Rent", 900.0),
    mkTx(-7, "T-Shirt", "Shopping", 19.99),
    mkTx(-3, "Snacks", "Food", 8.25),
  ];
  setTxs(sample);
  renderAll();
}

// factory reset
function onFactoryReset() {
  if (!confirm("Delete ALL saved data for MyExpense Tracker?")) return;
  [STORE.tx, STORE.prefs, STORE.bud].forEach((k) => localStorage.removeItem(k));
  renderAll();
}

// theme toggle
function onToggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  const prefs = readJSON(STORE.prefs, { theme: next });
  prefs.theme = next;
  writeJSON(STORE.prefs, prefs);
  ui.btnDark.textContent = next === "dark" ? "☀️ Light" : "🌙 Dark";
}

// budget change
function onBudgetChange() {
  const v = Number(ui.budgetInput.value);
  writeJSON(STORE.bud, Number.isFinite(v) && v > 0 ? v : 0);
  renderBudgetSummary();
}

/* ---------------------- rendering ------------------------ */

function renderAll() {
  renderTable();
  renderBudgetSummary();
  renderCategoryChart();
}

// table
function renderTable() {
  const list = getTxs().sort((a, b) => a.date.localeCompare(b.date));
  ui.tbody.innerHTML = "";

  list.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.date}</td>
      <td>${escapeHtml(t.note)}</td>
      <td>${escapeHtml(t.cat)}</td>
      <td class="align-right">${fmtMoney(t.amt)}</td>
      <td class="align-right">
        <button class="danger" data-id="${
          t.id
        }" aria-label="Delete transaction">Delete</button>
      </td>
    `;
    ui.tbody.appendChild(tr);
  });

  // bind deletes
  ui.tbody.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => onDeleteTx(btn.dataset.id));
  });

  // empty state
  ui.empty.style.display = list.length ? "none" : "block";
}

// monthly total + remaining badge
function renderBudgetSummary() {
  const { y, m } = nowYearMonth();
  const list = getTxs();
  const monthTotal = list.reduce((sum, t) => {
    const d = new Date(t.date);
    return d.getFullYear() === y && d.getMonth() === m ? sum + t.amt : sum;
  }, 0);

  ui.monthTotal.textContent = `Total: ${fmtMoney(monthTotal)}`;

  const budget = Number(readJSON(STORE.bud, 0));
  if (!budget || budget <= 0) {
    ui.budgetRemaining.textContent = "Remaining: —";
    ui.budgetRemaining.className = "badge";
    return;
  }
  const remaining = budget - monthTotal;
  ui.budgetRemaining.textContent = `Remaining: ${fmtMoney(remaining)}`;
  ui.budgetRemaining.className =
    "badge " +
    (remaining < 0 ? "danger" : remaining < budget * 0.2 ? "warn" : "good");
}

// category pie (current month)
function renderCategoryChart() {
  const { y, m } = nowYearMonth();
  const byCat = {};
  getTxs().forEach((t) => {
    const d = new Date(t.date);
    if (d.getFullYear() === y && d.getMonth() === m) {
      byCat[t.cat] = (byCat[t.cat] || 0) + t.amt;
    }
  });

  const labels = Object.keys(byCat);
  const data = Object.values(byCat);

  if (!labels.length) {
    if (catChart) {
      catChart.destroy();
      catChart = null;
    }
    return;
  }

  if (catChart) catChart.destroy();
  catChart = new Chart(ui.chartCanvas.getContext("2d"), {
    type: "pie",
    data: { labels, datasets: [{ data }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${fmtMoney(ctx.parsed)}`,
          },
        },
      },
    },
  });
}

/* ------------------- CSV + Undo -------------------------- */

// export to CSV
function onExportCSV() {
  const csv = toCSV(getTxs());
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `myexpense-transactions-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// build CSV text
function toCSV(list) {
  const header = "date,note,category,amount\n";
  const rows = list.map((t) =>
    [
      t.date,
      csvEscape(t.note),
      csvEscape(t.cat),
      String(Number(t.amt).toFixed(2)),
    ].join(",")
  );
  return header + rows.join("\n");
}

// safe CSV field
function csvEscape(v = "") {
  const needs = /[",\n]/.test(v);
  const out = String(v).replace(/"/g, '""');
  return needs ? `"${out}"` : out;
}

// import from CSV
function onImportCSVFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseCSV(String(reader.result || ""));
      if (!parsed.length) {
        alert("No valid rows found in CSV.");
        return;
      }
      const merged = getTxs().concat(parsed);
      setTxs(merged);
      renderAll();
      alert(`Imported ${parsed.length} transactions.`);
    } catch (err) {
      console.error(err);
      alert("Failed to import CSV. Please check the format.");
    } finally {
      ui.fileInput.value = ""; // allow re-choosing same file
    }
  };
  reader.readAsText(file);
}

// parse minimal CSV (expects: date,note,category,amount)
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase().trim();
  const expected = "date,note,category,amount";
  if (header !== expected)
    throw new Error(`Invalid header. Expected "${expected}". Got "${header}"`);

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]);
    if (cells.length !== 4) continue;
    const [date, note, cat, amtStr] = cells.map((s) => s.trim());
    const amt = Number(amtStr);
    if (!date || !note || !cat || !Number.isFinite(amt) || amt <= 0) continue;
    out.push({
      id: crypto.randomUUID(),
      date,
      note,
      cat,
      amt: Math.round(amt * 100) / 100,
    });
  }
  return out;
}

// split one CSV line (supports quotes)
function splitCSVLine(line) {
  const cells = [];
  let cur = "",
    inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } // escaped quote
        else {
          inQuotes = false;
        }
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/* -------------------- data helpers ----------------------- */
function getTxs() {
  return readJSON(STORE.tx, []);
}
function setTxs(list) {
  writeJSON(STORE.tx, list);
}

/* -------------------- small utils ------------------------ */
function fmtMoney(n) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  }).format(Number(n) || 0);
}
function escapeHtml(s = "") {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}
function nowYearMonth() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() };
}
function mkTx(offsetDays, note, cat, amt) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return {
    id: crypto.randomUUID(),
    date: d.toISOString().slice(0, 10),
    note,
    cat,
    amt,
  };
}
