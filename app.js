/* ============================================================
   app.js — SPA logic for Personal Expense OCR
   Backend: Google Apps Script Web App (POST text/plain JSON)
   ============================================================ */
'use strict';

// ---------------- Config & API client ----------------
const CFG_KEY = 'expense_ocr_cfg';
const cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');

async function api(action, payload = {}, { silent = false } = {}) {
  if (!cfg.url || !cfg.token) {
    toast('Chưa cấu hình kết nối. Vào mục Cài đặt để nhập URL và token.');
    showPage('settings');
    throw new Error('Not configured');
  }
  if (!silent) loader(true);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
      body: JSON.stringify({ token: cfg.token, action, payload })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Unknown API error');
    return json.data;
  } finally {
    if (!silent) loader(false);
  }
}

// ---------------- UI helpers ----------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtVND = (n) => (n === null || n === undefined || n === '' ? '—'
  : Number(n).toLocaleString('vi-VN') + ' ₫');

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4000);
}
function loader(on, text = 'Đang xử lý…') {
  $('#loader-text').textContent = text;
  $('#loader').hidden = !on;
}

// ---------------- Navigation ----------------
const pageLoaders = {
  dashboard: loadDashboard, transactions: loadTransactions, review: loadReviewList,
  budgets: loadBudgets, categories: loadCategoriesPage, rules: loadRules,
  settings: loadSettingsPage, logs: loadLogs, upload: () => {}
};
function showPage(name) {
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  (pageLoaders[name] || (() => {}))().catch?.(e => toast(e.message));
}
$$('.nav-btn').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));

// ---------------- Categories cache ----------------
let CATS = { types: [], groups: [] };
async function ensureCategories() {
  if (CATS.types.length) return CATS;
  const rows = await api('getCategories', {}, { silent: true });
  CATS.types = rows.filter(r => r.kind === 'transaction_type' && r.active !== false).map(r => r.name);
  CATS.groups = rows.filter(r => r.kind === 'expense_group' && r.active !== false).map(r => r.name);
  return CATS;
}
function fillSelect(el, options, { empty = null, value = null } = {}) {
  el.innerHTML = (empty !== null ? `<option value="">${esc(empty)}</option>` : '') +
    options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  if (value !== null) el.value = value;
}

// ============================================================
// DASHBOARD
// ============================================================
const charts = {};
function makeChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($('#' + id), config);
}
const PALETTE = ['#657166','#99CDD8','#F3C3B2','#CFD6C4','#DBA24A','#4E8577',
                 '#D3705B','#7FA8B8','#B98E6A','#8AA398','#C9A0A0','#6F7F7A','#3C6A5E'];
const C_UP = '#3E8E6E', C_DOWN = '#D3705B';

/** % change vs previous value, rendered as a colored delta line. */
function deltaHTML(cur, prev, { invert = false } = {}) {
  if (prev === undefined || prev === null || prev === 0) return '';
  const pct = Math.round((cur - prev) / Math.abs(prev) * 100);
  if (!isFinite(pct)) return '';
  const good = invert ? pct <= 0 : pct >= 0;
  const arrow = pct > 0 ? '↗' : pct < 0 ? '↘' : '→';
  return `<span class="delta ${good ? 'up' : 'down'}">${arrow} ${Math.abs(pct)}% so với tháng trước</span>`;
}

function setHealthScore(score, label) {
  const gauge = $('#health-gauge');
  if (!gauge) return;
  gauge.style.setProperty('--pct', score);
  gauge.style.setProperty('--gauge-color',
    score >= 75 ? '#8FD0B5' : score >= 50 ? '#F0C883' : '#F0A28E');
  $('#health-score').textContent = score;
  $('#health-label').textContent = label;
}

async function loadDashboard() {
  const month = $('#dash-month').value || new Date().toISOString().slice(0, 7);
  $('#dash-month').value = month;
  const [my, mm] = month.split('-');
  $('#dash-greeting').textContent =
    (cfg.name ? `Xin chào, ${cfg.name} — ` : '') + `bức tranh tài chính tháng ${mm}/${my} của bạn.`;

  const d = await api('getDashboard', { month });

  // ----- Previous-month values for delta badges -----
  const trend = d.monthlyTrend || [];
  const idx = trend.findIndex(x => x.month === month);
  const cur = idx >= 0 ? trend[idx] : { income: d.kpi.monthIncome, expense: d.kpi.monthExpense };
  const prev = idx > 0 ? trend[idx - 1] : null;

  // ----- KPI row 1 -----
  $('#kpi-income').textContent = fmtVND(d.kpi.monthIncome);
  $('#d-income').innerHTML = prev ? deltaHTML(cur.income, prev.income) : '';
  $('#kpi-expense').textContent = fmtVND(d.kpi.monthExpense);
  $('#d-expense').innerHTML = prev ? deltaHTML(cur.expense, prev.expense, { invert: true }) : '';
  const net = $('#kpi-net');
  net.textContent = fmtVND(d.kpi.netCashFlow);
  net.className = 'money ' + (d.kpi.netCashFlow >= 0 ? 'income' : 'expense');
  $('#d-net').innerHTML = prev ? deltaHTML(cur.income - cur.expense, prev.income - prev.expense) : '';

  // Budget remaining (sum of monthly budgets)
  const mb = d.monthlyBudgets || [];
  if (mb.length) {
    const left = mb.reduce((s, b) => s + b.remaining, 0);
    const bl = $('#kpi-budget-left');
    bl.textContent = fmtVND(left);
    bl.className = 'money ' + (left >= 0 ? 'income' : 'expense');
    $('#d-budget').textContent = `trên tổng ${fmtVND(mb.reduce((s, b) => s + b.budget, 0))}`;
  } else {
    $('#kpi-budget-left').textContent = '—';
    $('#d-budget').textContent = 'chưa đặt ngân sách tháng';
  }

  // ----- KPI row 2 -----
  const savings = d.kpi.monthIncome > 0
    ? Math.round(d.kpi.netCashFlow / d.kpi.monthIncome * 100) : null;
  $('#kpi-savings').textContent = savings === null ? '—' : savings + '%';

  const now = new Date();
  const isCurrentMonth = month === now.toISOString().slice(0, 7);
  const daysInMonth = new Date(Number(my), Number(mm), 0).getDate();
  const daysElapsed = isCurrentMonth ? now.getDate() : daysInMonth;
  const avgDay = d.kpi.monthExpense / Math.max(daysElapsed, 1);
  $('#kpi-avgday').textContent = fmtVND(Math.round(avgDay));
  $('#d-avgday').textContent = `qua ${daysElapsed} ngày`;
  $('#kpi-forecast').textContent = fmtVND(Math.round(avgDay * daysInMonth));

  $('#kpi-pending').textContent = d.kpi.pendingReviews;
  $('#kpi-errors').textContent = d.kpi.ocrErrors;
  const badge = $('#pending-badge');
  badge.hidden = d.kpi.pendingReviews === 0;
  badge.textContent = d.kpi.pendingReviews;

  // ----- Financial health score (simple heuristic) -----
  const overCount = mb.filter(b => b.pct >= 100).length;
  const warnCount = mb.filter(b => b.warning && b.pct < 100).length;
  let score;
  if (savings !== null) score = 50 + savings / 2 - overCount * 15 - warnCount * 5;
  else if (mb.length) score = 80 - overCount * 20 - warnCount * 8;
  else score = 60;
  score = Math.max(5, Math.min(100, Math.round(score)));
  setHealthScore(score, score >= 75 ? 'Chi tiêu đang trong mức an toàn'
    : score >= 50 ? 'Cần chú ý một vài khoản chi' : 'Chi tiêu đang vượt kiểm soát');

  // ----- Alerts & suggestions panel -----
  const alerts = [];
  (d.budgetWarnings || []).forEach(b => alerts.push(
    `<div class="alert ${b.pct >= 100 ? 'over' : ''}">⚠️ Ngân sách <b>${esc(b.expense_group)}</b> đã dùng <b>${b.pct}%</b> (${fmtVND(b.spent)} / ${fmtVND(b.budget)})</div>`));
  if (prev && prev.expense > 0 && cur.expense > prev.expense * 1.1)
    alerts.push(`<div class="alert">📈 Chi tiêu tháng này đang cao hơn tháng trước ${Math.round((cur.expense - prev.expense) / prev.expense * 100)}%.</div>`);
  if (d.kpi.pendingReviews > 0)
    alerts.push(`<div class="alert">🧾 Có ${d.kpi.pendingReviews} hóa đơn OCR đang chờ duyệt.</div>`);
  if (!alerts.length || (mb.length && !overCount && !warnCount))
    alerts.push(`<div class="alert ok">✅ Nếu giữ nhịp chi hiện tại, bạn đang trong tầm kiểm soát tháng này.</div>`);
  $('#dash-alerts').innerHTML = alerts.join('');

  // ----- Charts -----
  const catLabels = Object.keys(d.expenseByCategory);
  makeChart('chart-category', {
    type: 'doughnut',
    data: { labels: catLabels, datasets: [{ data: catLabels.map(k => d.expenseByCategory[k]), backgroundColor: PALETTE, borderWidth: 0 }] },
    options: { cutout: '62%', plugins: { legend: { position: 'right' } } }
  });

  const days = Object.keys(d.dailyTrend).sort();
  makeChart('chart-daily', {
    type: 'line',
    data: { labels: days.map(x => x.slice(8)), datasets: [{ label: 'Chi tiêu', data: days.map(k => d.dailyTrend[k]), borderColor: C_DOWN, backgroundColor: 'rgba(243,195,178,.35)', fill: true, tension: .35, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false } } }
  });

  const mt = trend;
  makeChart('chart-monthly', {
    type: 'bar',
    data: { labels: mt.map(x => x.month), datasets: [{ label: 'Chi tiêu', data: mt.map(x => x.expense), backgroundColor: '#657166', borderRadius: 8 }] },
    options: { plugins: { legend: { display: false } } }
  });
  makeChart('chart-income-expense', {
    type: 'bar',
    data: { labels: mt.map(x => x.month), datasets: [
      { label: 'Thu nhập', data: mt.map(x => x.income), backgroundColor: C_UP, borderRadius: 8 },
      { label: 'Chi tiêu', data: mt.map(x => x.expense), backgroundColor: C_DOWN, borderRadius: 8 }
    ] }
  });

  // ----- Budgets -----
  const budgetRow = (b) => `
    <div class="budget-row ${b.pct >= 100 ? 'over' : b.warning ? 'warn' : ''}">
      <div class="meta"><span>${esc(b.expense_group)}</span><b>${fmtVND(b.spent)} / ${fmtVND(b.budget)}</b></div>
      <div class="bar"><i style="width:${Math.min(b.pct, 100)}%"></i></div>
    </div>`;
  $('#budget-month-list').innerHTML = mb.map(budgetRow).join('') || '<p class="muted">Chưa đặt ngân sách tháng.</p>';
  $('#budget-year-list').innerHTML = (d.yearlyBudgets || []).map(budgetRow).join('') || '<p class="muted">Chưa đặt ngân sách năm.</p>';

  // ----- Ranked top lists -----
  const totalExp = d.kpi.monthExpense || 0;
  const rankList = (arr) => arr.map((x, i) =>
    `<div class="rank-row"><span class="rank-num">${i + 1}</span>
      <span class="rank-name">${esc(x.name)}</span>
      <span class="rank-amt">${fmtVND(x.amount)}</span>
      <span class="rank-pct">${totalExp ? Math.round(x.amount / totalExp * 100) + '%' : ''}</span></div>`
  ).join('') || '<p class="muted">Chưa có dữ liệu.</p>';
  $('#top-cats').innerHTML = rankList(d.topCategories || []);
  $('#top-vendors').innerHTML = rankList(d.topVendors || []);

  // ----- Recent transactions -----
  $('#recent-list').innerHTML = (d.recentTransactions || []).map(txRowHTML).join('') || '<p class="muted">Chưa có giao dịch.</p>';

  // ----- Recent OCR activity (separate lightweight call) -----
  try {
    const logs = await api('getLogs', { limit: 6 }, { silent: true });
    $('#recent-ocr').innerHTML = logs.map(l => `<div class="ocr-row">
      <span class="ocr-time">${esc(String(l.timestamp).replace('T', ' ').slice(0, 16))}</span>
      <span class="ocr-name">${esc(l.file_name || l.message)}</span>
      <span class="ocr-status ${l.status === 'OK' ? 'ok' : l.status === 'ERROR' ? 'err' : 'info'}">${l.status === 'OK' ? 'Đã xử lý' : l.status === 'ERROR' ? 'Lỗi OCR' : 'Thông tin'}</span>
    </div>`).join('') || '<p class="muted">Chưa có hoạt động OCR.</p>';
  } catch (e) { $('#recent-ocr').innerHTML = '<p class="muted">Không tải được nhật ký.</p>'; }
}
$('#dash-month').addEventListener('change', () => loadDashboard().catch(e => toast(e.message)));

// Dashboard quick actions
$('#btn-quick-add').addEventListener('click', () => {
  showPage('transactions');
  $('#tx-form').hidden = false;
  $('#mtx-date').value = new Date().toISOString().slice(0, 10);
});
$('#btn-quick-scan').addEventListener('click', () => { showPage('upload'); scanIncoming(); });
$('#btn-export').addEventListener('click', exportCSV);

/** Export the selected month's transactions as a CSV file (Excel-friendly, UTF-8 BOM). */
async function exportCSV() {
  try {
    const month = $('#dash-month').value || new Date().toISOString().slice(0, 7);
    const rows = await api('getTransactions', { month, limit: 1000 });
    if (!rows.length) return toast('Tháng này chưa có giao dịch để xuất.');
    const cols = ['receipt_id', 'receipt_date', 'supplier', 'transaction_type', 'expense_group',
                  'total_amount', 'payment_method', 'source', 'notes'];
    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + cols.join(',') + '\n' +
      rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `so-chi-tieu_${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Đã xuất báo cáo ' + month + '.');
  } catch (e) { toast('Lỗi xuất báo cáo: ' + e.message); }
}

function txRowHTML(r) {
  const sign = r.transaction_type === 'Income' || r.transaction_type === 'Refund' ? 'income' : 'expense';
  return `<div class="tx-row">
    <span class="tx-date">${esc(r.receipt_date)}</span>
    <span class="tx-main">${esc(r.supplier || '(không rõ)')}<small>${esc(r.transaction_type)}${r.expense_group ? ' · ' + esc(r.expense_group) : ''}${r.source ? ' · ' + esc(r.source) : ''}</small></span>
    <span class="tx-amt ${sign}">${sign === 'income' ? '+' : '−'}${fmtVND(r.total_amount)}</span>
  </div>`;
}

// ============================================================
// TRANSACTIONS
// ============================================================
async function loadTransactions() {
  await ensureCategories();
  fillSelect($('#tx-type'), CATS.types, { empty: '— Loại —', value: $('#tx-type').value });
  fillSelect($('#tx-group'), CATS.groups, { empty: '— Nhóm —', value: $('#tx-group').value });
  fillSelect($('#mtx-type'), CATS.types, { value: 'Expense' });
  fillSelect($('#mtx-group'), CATS.groups);

  const rows = await api('getTransactions', {
    month: $('#tx-month').value || undefined,
    type: $('#tx-type').value || undefined,
    group: $('#tx-group').value || undefined
  });
  $('#tx-table').innerHTML = rows.map(txRowHTML).join('') || '<p class="muted">Không có giao dịch.</p>';
}
$('#btn-tx-filter').addEventListener('click', () => loadTransactions().catch(e => toast(e.message)));
$('#btn-add-tx').addEventListener('click', () => {
  $('#tx-form').hidden = false;
  $('#mtx-date').value = new Date().toISOString().slice(0, 10);
});
$('#btn-cancel-tx').addEventListener('click', () => $('#tx-form').hidden = true);
$('#btn-save-tx').addEventListener('click', async () => {
  try {
    await api('addTransaction', {
      receipt_date: $('#mtx-date').value,
      supplier: $('#mtx-supplier').value.trim(),
      transaction_type: $('#mtx-type').value,
      expense_group: $('#mtx-group').value,
      total_amount: $('#mtx-amount').value,
      payment_method: $('#mtx-payment').value,
      notes: $('#mtx-notes').value.trim()
    });
    toast('Đã lưu giao dịch.');
    $('#tx-form').hidden = true;
    $('#mtx-amount').value = ''; $('#mtx-supplier').value = ''; $('#mtx-notes').value = '';
    loadTransactions();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

// ============================================================
// UPLOAD / TAKE PHOTO / SCAN
// ============================================================
$('#btn-take-photo').addEventListener('click', () => $('#camera-input').click());
$('#btn-pick-file').addEventListener('click', () => $('#file-input').click());
$('#camera-input').addEventListener('change', e => handleFiles(e.target.files));
$('#file-input').addEventListener('change', e => handleFiles(e.target.files));
$('#btn-scan-incoming').addEventListener('click', scanIncoming);

/** Compress an image client-side (max 1600px, JPEG q0.85) to keep payloads small. */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      let { width: w, height: h } = img;
      if (Math.max(w, h) > MAX) { const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve(dataUrl.split(',')[1]); // base64 only
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Không đọc được file ảnh: ' + file.name));
    img.src = URL.createObjectURL(file);
  });
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const status = $('#upload-status');
  status.hidden = false; status.innerHTML = '';
  const runOcrNow = $('#ocr-now').checked;

  for (const [i, file] of files.entries()) {
    try {
      loader(true, `Đang nén & tải ảnh ${i + 1}/${files.length}…`);
      const base64 = await compressImage(file);
      loader(true, runOcrNow ? `Đang OCR ảnh ${i + 1}/${files.length} (Gemini)…` : `Đang tải ảnh ${i + 1}/${files.length}…`);
      const r = await api('uploadImage', {
        base64, mimeType: 'image/jpeg',
        fileName: file.name.replace(/\.[^.]+$/, '') + '_' + Date.now() + '.jpg',
        runOcrNow
      }, { silent: true });
      status.innerHTML += `<p>✅ <b>${esc(file.name)}</b> — đã lưu vào Drive${r.ocr ? `, OCR xong (draft ${esc(r.ocr.draftId)})` : ''}.</p>`;
    } catch (e) {
      status.innerHTML += `<p>❌ <b>${esc(file.name)}</b> — ${esc(e.message)}</p>`;
    }
  }
  loader(false);
  $('#camera-input').value = ''; $('#file-input').value = '';
  if (runOcrNow) status.innerHTML += `<p><button class="btn primary" onclick="showPage('review')">→ Sang trang Duyệt OCR</button></p>`;
}

async function scanIncoming() {
  try {
    loader(true, 'Đang quét Incoming_Invoices và chạy OCR… (có thể mất vài phút)');
    const r = await api('scanIncoming', {}, { silent: true });
    loader(false);
    const status = $('#upload-status');
    status.hidden = false;
    status.innerHTML = `<p><b>Kết quả quét:</b> ${r.total} file — ✅ ${r.ok} thành công, ❌ ${r.failed} lỗi.</p>` +
      r.details.map(d => `<p>${d.status === 'OK' ? '✅' : '❌'} ${esc(d.fileName)} ${d.error ? '— ' + esc(d.error) : ''}</p>`).join('');
    if (r.ok > 0) status.innerHTML += `<p><button class="btn primary" onclick="showPage('review')">→ Sang trang Duyệt OCR</button></p>`;
  } catch (e) { loader(false); toast('Lỗi: ' + e.message); }
}

// ============================================================
// OCR REVIEW
// ============================================================
let currentDraft = null;

async function loadReviewList() {
  $('#review-detail').hidden = true;
  $('#review-list').hidden = false;
  const drafts = await api('getPendingReviews');
  $('#review-list').innerHTML = drafts.length
    ? drafts.map(d => `<div class="tx-row review-item" data-id="${esc(d.draft_id)}">
        <span class="tx-date">${esc(String(d.receipt_date).slice(0, 10))}</span>
        <span class="tx-main">${esc(d.supplier || '(chưa rõ nhà cung cấp)')}<small>${esc(d.drive_file_name)} · ${esc(d.expense_group || '')}</small></span>
        <span class="tx-amt expense">${fmtVND(d.total_amount)}</span>
      </div>`).join('')
    : '<p class="muted">🎉 Không có hóa đơn nào chờ duyệt.</p>';
  $$('#review-list .review-item').forEach(el =>
    el.addEventListener('click', () => openDraft(el.dataset.id)));
}
$('#btn-refresh-review').addEventListener('click', () => loadReviewList().catch(e => toast(e.message)));
$('#btn-back-review').addEventListener('click', () => loadReviewList().catch(e => toast(e.message)));

async function openDraft(draftId) {
  await ensureCategories();
  loader(true, 'Đang tải bản nháp & ảnh…');
  try {
    const d = await api('getDraft', { draftId, withImage: true }, { silent: true });
    currentDraft = d;
    const r = d.receipt;
    $('#review-list').hidden = true;
    $('#review-detail').hidden = false;

    $('#review-image').src = d.image ? `data:${d.image.mimeType};base64,${d.image.base64}` : '';
    $('#rv-date').value = String(r.receipt_date).slice(0, 10);
    $('#rv-supplier').value = r.supplier || '';
    fillSelect($('#rv-type'), CATS.types, { value: r.transaction_type || 'Expense' });
    fillSelect($('#rv-group'), CATS.groups, { value: r.expense_group || 'Other' });
    $('#rv-subtotal').value = r.subtotal ?? '';
    $('#rv-tax').value = r.tax ?? '';
    $('#rv-service').value = r.service_charge ?? '';
    $('#rv-discount').value = r.discount ?? '';
    $('#rv-total').value = r.total_amount ?? '';
    $('#rv-payment').value = r.payment_method || 'unknown';
    $('#rv-notes').value = r.notes || '';
    $('#rv-save-rule').checked = false;

    renderItemRows(d.items);
  } finally { loader(false); }
}

function renderItemRows(items) {
  const tbody = $('#rv-items tbody');
  tbody.innerHTML = '';
  items.forEach(it => tbody.appendChild(itemRow(it)));
}
function itemRow(it = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="i-name" value="${esc(it.product_name || '')}"></td>
    <td style="width:70px"><input type="number" class="i-qty" value="${it.quantity ?? 1}"></td>
    <td style="width:110px"><input type="number" class="i-unit" value="${it.unit_price ?? ''}"></td>
    <td style="width:120px"><input type="number" class="i-total" value="${it.total_price ?? ''}"></td>
    <td style="width:150px"><select class="i-group"></select></td>
    <td style="width:60px" class="money">${it.confidence != null && it.confidence !== '' ? Math.round(it.confidence * 100) + '%' : '—'}</td>
    <td style="width:40px"><button class="btn small danger i-del" title="Xóa dòng">✕</button></td>`;
  fillSelect(tr.querySelector('.i-group'), CATS.groups, { value: it.suggested_expense_group || 'Other' });
  tr.querySelector('.i-del').addEventListener('click', () => tr.remove());
  // Auto total = qty * unit price
  const recalc = () => {
    const q = Number(tr.querySelector('.i-qty').value) || 0;
    const u = Number(tr.querySelector('.i-unit').value) || 0;
    if (q && u) tr.querySelector('.i-total').value = q * u;
  };
  tr.querySelector('.i-qty').addEventListener('input', recalc);
  tr.querySelector('.i-unit').addEventListener('input', recalc);
  return tr;
}
$('#btn-add-item').addEventListener('click', () => $('#rv-items tbody').appendChild(itemRow()));

function collectDraftEdits() {
  return {
    draftId: currentDraft.receipt.draft_id,
    receipt: {
      receipt_date: $('#rv-date').value,
      supplier: $('#rv-supplier').value.trim(),
      transaction_type: $('#rv-type').value,
      expense_group: $('#rv-group').value,
      subtotal: $('#rv-subtotal').value, tax: $('#rv-tax').value,
      service_charge: $('#rv-service').value, discount: $('#rv-discount').value,
      total_amount: $('#rv-total').value,
      payment_method: $('#rv-payment').value,
      notes: $('#rv-notes').value.trim()
    },
    items: $$('#rv-items tbody tr').map(tr => ({
      product_name: tr.querySelector('.i-name').value.trim(),
      quantity: tr.querySelector('.i-qty').value,
      unit_price: tr.querySelector('.i-unit').value,
      total_price: tr.querySelector('.i-total').value,
      suggested_transaction_type: $('#rv-type').value,
      suggested_expense_group: tr.querySelector('.i-group').value
    })).filter(it => it.product_name)
  };
}

$('#btn-save-draft').addEventListener('click', async () => {
  try { await api('updateDraft', collectDraftEdits()); toast('Đã lưu nháp.'); }
  catch (e) { toast('Lỗi: ' + e.message); }
});

$('#btn-approve').addEventListener('click', async () => {
  const p = collectDraftEdits();
  if (!p.receipt.total_amount) return toast('Thiếu tổng tiền — không thể duyệt.');
  if ($('#rv-save-rule').checked && p.receipt.supplier) {
    p.saveAsRule = {
      match_type: 'vendor', match_value: p.receipt.supplier,
      transaction_type: p.receipt.transaction_type, expense_group: p.receipt.expense_group
    };
  }
  try {
    const r = await api('approveDraft', p);
    toast('✅ Đã duyệt — mã giao dịch ' + r.receiptId);
    loadReviewList();
  } catch (e) {
    if (/duplicate/i.test(e.message) && confirm('Có thể trùng hóa đơn đã có:\n' + e.message + '\n\nVẫn duyệt?')) {
      try { const r = await api('approveDraft', { ...p, forceDuplicate: true }); toast('✅ Đã duyệt — ' + r.receiptId); loadReviewList(); }
      catch (e2) { toast('Lỗi: ' + e2.message); }
    } else toast('Lỗi: ' + e.message);
  }
});

$('#btn-reject').addEventListener('click', async () => {
  const reason = prompt('Lý do từ chối (không bắt buộc):') ?? '';
  try {
    await api('rejectDraft', { draftId: currentDraft.receipt.draft_id, reason });
    toast('Đã từ chối bản nháp.');
    loadReviewList();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

// ============================================================
// BUDGETS
// ============================================================
async function loadBudgets() {
  await ensureCategories();
  fillSelect($('#bd-group'), CATS.groups);
  if (!$('#bd-period').value) $('#bd-period').value = new Date().toISOString().slice(0, 7);
  const rows = await api('getBudgets');
  $('#budget-table').innerHTML = rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Kỳ</th><th>Thời gian</th><th>Nhóm</th><th>Số tiền</th></tr></thead>
    <tbody>${rows.map(b => `<tr><td>${b.period_type === 'monthly' ? 'Tháng' : 'Năm'}</td>
      <td class="money">${esc(String(b.period).slice(0, b.period_type === 'monthly' ? 7 : 4))}</td><td>${esc(b.expense_group)}</td>
      <td class="money">${fmtVND(b.amount)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Chưa có ngân sách nào.</p>';
}
$('#bd-period-type').addEventListener('change', () => {
  $('#bd-period').value = $('#bd-period-type').value === 'yearly'
    ? String(new Date().getFullYear()) : new Date().toISOString().slice(0, 7);
});
$('#btn-save-budget').addEventListener('click', async () => {
  try {
    await api('saveBudget', {
      period_type: $('#bd-period-type').value, period: $('#bd-period').value.trim(),
      expense_group: $('#bd-group').value, amount: $('#bd-amount').value
    });
    toast('Đã lưu ngân sách.'); $('#bd-amount').value = ''; loadBudgets();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

// ============================================================
// CATEGORIES / RULES / SETTINGS / LOGS
// ============================================================
async function loadCategoriesPage() {
  CATS = { types: [], groups: [] };
  await ensureCategories();
  $('#cat-types').innerHTML = CATS.types.map(t => `<span class="chip">${esc(t)}</span>`).join('');
  $('#cat-groups').innerHTML = CATS.groups.map(g => `<span class="chip">${esc(g)}</span>`).join('');
}

async function loadRules() {
  await ensureCategories();
  fillSelect($('#rl-tx-type'), CATS.types, { value: 'Expense' });
  fillSelect($('#rl-group'), CATS.groups);
  const rows = await api('getRules');
  $('#rule-table').innerHTML = rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Kiểu</th><th>Giá trị</th><th>Loại</th><th>Nhóm</th><th>Nguồn</th><th>Trạng thái</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(r.match_type)}</td><td><b>${esc(r.match_value)}</b></td>
      <td>${esc(r.transaction_type)}</td><td>${esc(r.expense_group)}</td>
      <td>${r.source === 'learned' ? '🤖 tự học' : '✍️ thủ công'}</td>
      <td><button class="btn small rule-toggle" data-id="${esc(r.rule_id)}">${String(r.active) === 'true' || r.active === true ? '🟢 Bật' : '⚪ Tắt'}</button></td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Chưa có quy tắc nào.</p>';
  $$('.rule-toggle').forEach(b => b.addEventListener('click', async () => {
    try { await api('toggleRule', { ruleId: b.dataset.id }); loadRules(); }
    catch (e) { toast('Lỗi: ' + e.message); }
  }));
}
$('#btn-save-rule').addEventListener('click', async () => {
  try {
    await api('saveRule', {
      match_type: $('#rl-type').value, match_value: $('#rl-value').value.trim(),
      transaction_type: $('#rl-tx-type').value, expense_group: $('#rl-group').value,
      source: 'manual'
    });
    toast('Đã lưu quy tắc.'); $('#rl-value').value = ''; loadRules();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

async function loadSettingsPage() {
  $('#cfg-url').value = cfg.url || '';
  $('#cfg-token').value = cfg.token || '';
  $('#cfg-name').value = cfg.name || '';
  if (!cfg.url) return;
  try {
    const rows = await api('getSettings', {}, { silent: true });
    $('#settings-table').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Key</th><th>Value</th><th>Mô tả</th></tr></thead>
      <tbody>${rows.map(s => `<tr><td class="money">${esc(s.key)}</td><td class="money">${esc(s.value)}</td><td>${esc(s.description)}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { /* not configured yet */ }
}
$('#btn-save-cfg').addEventListener('click', async () => {
  cfg.url = $('#cfg-url').value.trim();
  cfg.token = $('#cfg-token').value.trim();
  cfg.name = $('#cfg-name').value.trim();
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  $('#cfg-status').textContent = 'Đang kiểm tra kết nối…';
  try {
    await api('ping');
    $('#cfg-status').textContent = '✅ Kết nối thành công!';
    toast('Đã kết nối backend.');
    loadSettingsPage();
  } catch (e) {
    $('#cfg-status').textContent = '❌ Kết nối thất bại: ' + e.message;
  }
});

async function loadLogs() {
  const rows = await api('getLogs', { limit: 100 });
  $('#log-table').innerHTML = rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Thời gian</th><th>File</th><th>Trạng thái</th><th>Thông báo</th><th>ms</th></tr></thead>
    <tbody>${rows.map(l => `<tr>
      <td class="money">${esc(String(l.timestamp).replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(l.file_name)}</td>
      <td>${l.status === 'ERROR' ? '❌' : l.status === 'OK' ? '✅' : 'ℹ️'} ${esc(l.status)}</td>
      <td>${esc(l.message)}</td><td class="money">${esc(l.duration_ms)}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Chưa có log nào.</p>';
}
$('#btn-refresh-logs').addEventListener('click', () => loadLogs().catch(e => toast(e.message)));

// ---------------- Boot ----------------
window.showPage = showPage;

// Nav show/hide toggle (persisted per device)
const NAV_KEY = 'expense_ocr_nav_hidden';
if (localStorage.getItem(NAV_KEY) === '1') document.body.classList.add('nav-hidden');
$('#nav-toggle').addEventListener('click', () => {
  const hidden = document.body.classList.toggle('nav-hidden');
  localStorage.setItem(NAV_KEY, hidden ? '1' : '0');
});

(function boot() {
  if (!cfg.url || !cfg.token) showPage('settings');
  else showPage('dashboard');
})();
