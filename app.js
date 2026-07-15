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
  settings: loadSettingsPage, logs: loadLogs, upload: () => {},
  income: loadIncomePage, expense: loadExpensePage, debts: loadDebtsPage
};
function showPage(name) {
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $$('.nav-btn, .top-nav-link[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  (pageLoaders[name] || (() => {}))().catch?.(e => toast(e.message));
}
$$('.nav-btn, .top-nav-link[data-page]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));

// ---------------- Categories cache ----------------
let CATS = { types: [], groups: [], subs: {}, incomeGroups: [], raw: [] };
async function ensureCategories() {
  if (CATS.types.length) return CATS;
  const rows = await api('getCategories', {}, { silent: true });
  const active = rows.filter(r => r.active !== false && String(r.active).toLowerCase() !== 'false');
  CATS.raw = active;
  CATS.types = active.filter(r => r.kind === 'transaction_type').map(r => r.name);
  const groups = active.filter(r => r.kind === 'expense_group');
  CATS.groups = groups.filter(r => !r.parent).map(r => r.name);
  CATS.subs = {};
  groups.filter(r => r.parent).forEach(r => (CATS.subs[r.parent] = CATS.subs[r.parent] || []).push(r.name));
  CATS.incomeGroups = active.filter(r => r.kind === 'income_group').map(r => r.name);
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
const NESTED_PALETTE = ['#2A7A8C', '#38B2AC', '#E6B5A1', '#F6AD55', '#4F6773', '#CBD5E0', '#FBD38D', '#81E6D9', '#E2E8F0'];
const C_UP = '#3E8E6E', C_DOWN = '#D3705B';

// Chart.js global theme (Outfit font, muted axis text) — set once, applies to every chart on every page.
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#718096';
  Chart.defaults.font.family = "'Outfit', 'Be Vietnam Pro', sans-serif";
  Chart.defaults.font.size = 11;
}

/** Standard ranked-list markup shared by Dashboard/Income/Expense top-N panels. */
function rankListHTML(arr, total) {
  return (arr || []).map((x, i) =>
    `<div class="rank-row"><span class="rank-num">${i + 1}</span>
      <span class="rank-name">${esc(x.name)}</span>
      <span class="rank-amt">${fmtVND(x.amount)}</span>
      <span class="rank-pct">${total ? Math.round(x.amount / total * 100) + '%' : ''}</span></div>`
  ).join('') || '<p class="muted">Chưa có dữ liệu.</p>';
}

/** % change vs previous value, rendered as a colored delta line. */
function deltaHTML(cur, prev, { invert = false, label = 'so với tháng trước' } = {}) {
  if (prev === undefined || prev === null || prev === 0) return '';
  const pct = Math.round((cur - prev) / Math.abs(prev) * 100);
  if (!isFinite(pct)) return '';
  const good = invert ? pct <= 0 : pct >= 0;
  const arrow = pct > 0 ? '↗' : pct < 0 ? '↘' : '→';
  return `<span class="delta ${good ? 'up' : 'down'}">${arrow} ${Math.abs(pct)}% ${label}</span>`;
}

function setHealthScore(score, label) {
  const gauge = $('#health-gauge');
  if (!gauge) return;
  gauge.style.setProperty('--pct', score);
  gauge.style.setProperty('--gauge-color',
    score >= 75 ? '#4FD1A5' : score >= 50 ? '#ECC07B' : '#F3A390');
  $('#health-score').textContent = score;
  $('#health-label').textContent = label;
}

// --- New Render Functions for Dashboard ---

function renderWeeklyHeatmap(dailyTrend) {
  const container = $('#weekly-heatmap');
  if (!container) return;
  const days = Object.keys(dailyTrend || {}).sort();
  if (!days.length) { container.innerHTML = '<p class="muted">Không có dữ liệu</p>'; return; }
  
  // Build 7 columns (days of week)
  const gridHtml = ['<div class="heatmap-grid">'];
  
  // Fill the grid with the last 28 days (4 weeks)
  const recentDays = days.slice(-28);
  
  // Calculate max to find intensity
  const maxExpense = Math.max(...recentDays.map(d => dailyTrend[d]), 1);
  
  recentDays.forEach(day => {
    const val = dailyTrend[day];
    const pct = val / maxExpense;
    let level = 0;
    if (pct > 0.75) level = 4;
    else if (pct > 0.5) level = 3;
    else if (pct > 0.25) level = 2;
    else if (pct > 0) level = 1;
    
    gridHtml.push(`<div class="heatmap-cell level-${level}" title="${day}: ${fmtVND(val)}">
      <span class="heatmap-label">${day.slice(8)}</span>
    </div>`);
  });
  
  gridHtml.push('</div>');
  container.innerHTML = gridHtml.join('');
}

function renderMonthlyTactical(categoryData, budgetData) {
  const catLabels = Object.keys(categoryData || {});
  if (!catLabels.length) return;
  
  const budgetMap = {};
  (budgetData || []).forEach(b => { budgetMap[b.expense_group] = b.budget; });
  
  const actuals = catLabels.map(k => categoryData[k] || 0);
  const budgets = catLabels.map(k => budgetMap[k] || 0);

  makeChart('chart-bva-monthly', {
    type: 'bar',
    data: {
      labels: catLabels,
      datasets: [
        { label: 'Thực chi (Actual)', data: actuals, backgroundColor: '#FF7F50' },
        { label: 'Ngân sách (Budget)', data: budgets, backgroundColor: 'rgba(56, 178, 172, 0.5)' }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: {
        x: { grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { grid: { display: false } }
      }
    }
  });

  // Waterfall Chart for Variance Drivers (Mocked as simple bar with BvA differences)
  const variances = catLabels.map(k => (budgetMap[k] || 0) - (categoryData[k] || 0));
  const colors = variances.map(v => v >= 0 ? '#4FD1A5' : '#F3A390');
  
  makeChart('chart-waterfall', {
    type: 'bar',
    data: {
      labels: catLabels,
      datasets: [{
        label: 'Chênh lệch BvA (Variance)',
        data: variances,
        backgroundColor: colors
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: 'rgba(0,0,0,0.05)' } }
      }
    }
  });
}

function renderYearlyStrategic(d) {
  const trend = d.monthlyTrend || [];
  if (!trend.length) return;
  
  // Cumulative YTD
  let cumIncome = 0;
  let cumExpense = 0;
  const labels = [];
  const ytdIncome = [];
  const ytdExpense = [];
  
  trend.forEach(t => {
    labels.push(t.month);
    cumIncome += t.income;
    cumExpense += t.expense;
    ytdIncome.push(cumIncome);
    ytdExpense.push(cumExpense);
  });
  
  makeChart('chart-ytd-cumulative', {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'YTD Thu nhập', data: ytdIncome, borderColor: '#4FD1A5', backgroundColor: 'rgba(79, 209, 165, 0.2)', fill: true, tension: 0.3 },
        { label: 'YTD Chi tiêu', data: ytdExpense, borderColor: '#F3A390', backgroundColor: 'rgba(243, 163, 144, 0.2)', fill: true, tension: 0.3 }
      ]
    }
  });
  
  // Treemap (Requires Chart.js Treemap plugin included in index.html)
  const catLabels = Object.keys(d.expenseByCategory || {});
  const treeData = catLabels.map(k => ({ category: k, value: d.expenseByCategory[k] }));
  
  if (window.Chart && window.Chart.registry && window.Chart.registry.controllers.items.treemap) {
    makeChart('chart-treemap', {
      type: 'treemap',
      data: {
        datasets: [{
          tree: treeData,
          key: 'value',
          groups: ['category'],
          backgroundColor: (ctx) => {
            const idx = ctx.dataIndex % NESTED_PALETTE.length;
            return NESTED_PALETTE[idx];
          },
          labels: { display: true, formatter: (ctx) => ctx.raw.g }
        }]
      },
      options: {
        plugins: { legend: { display: false } }
      }
    });
  } else {
    const container = $('#chart-treemap');
    if (container) container.outerHTML = '<p class="muted">Treemap plugin not loaded</p>';
  }
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

  // Actual vs Budget (BvA) remaining
  const mb = d.monthlyBudgets || [];
  if (mb.length) {
    const totalBudget = mb.reduce((s, b) => s + b.budget, 0);
    const totalSpent = mb.reduce((s, b) => s + b.spent, 0);
    const left = totalBudget - totalSpent;
    const pct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
    const bl = $('#kpi-budget-left');
    bl.textContent = fmtVND(left);
    bl.className = 'money ' + (left >= 0 ? 'income' : 'expense');
    $('#d-budget').innerHTML = `<span class="delta ${pct > 100 ? 'down' : 'up'}">${pct}% utilized</span>`;
  } else {
    $('#kpi-budget-left').textContent = '—';
    $('#d-budget').textContent = 'chưa đặt ngân sách tháng';
  }

  // ----- KPI Daily (Hôm nay) -----
  const todayStr = new Date().toISOString().slice(0, 10);
  const isCurrentMonth = month === todayStr.slice(0, 7);
  
  if (isCurrentMonth) {
    const todayRows = await api('getTransactions', { month: todayStr.slice(0, 7), limit: 1000 }, { silent: true });
    
    let dailyInc = 0, dailyExp = 0;
    todayRows.forEach(r => {
      const rd = r.receipt_date ? String(r.receipt_date).slice(0, 10) : '';
      if (rd === todayStr) {
        if (r.transaction_type === 'Expense') dailyExp += r.total_amount;
        else if (r.transaction_type === 'Income' || r.transaction_type === 'Refund') dailyInc += r.total_amount;
      }
    });
    
    $('#kpi-daily-income').textContent = fmtVND(dailyInc);
    $('#kpi-daily-expense').textContent = fmtVND(dailyExp);
    
    const dailyNet = dailyInc - dailyExp;
    const dailyNetEl = $('#kpi-daily-net');
    dailyNetEl.textContent = fmtVND(dailyNet);
    dailyNetEl.className = 'money ' + (dailyNet >= 0 ? 'income' : 'expense');
    
    if (mb.length) {
      const totalBudget = mb.reduce((s, b) => s + b.budget, 0);
      const dailyBva = Math.round(totalBudget / 30);
      $('#kpi-daily-bva').textContent = fmtVND(dailyBva);
    } else {
      $('#kpi-daily-bva').textContent = '—';
    }
  } else {
    $('#kpi-daily-income').textContent = '0 ₫';
    $('#kpi-daily-expense').textContent = '0 ₫';
    $('#kpi-daily-net').textContent = '0 ₫';
    $('#kpi-daily-bva').textContent = '—';
  }

  // ----- KPI row 2 -----
  const savings = d.kpi.monthIncome > 0
    ? Math.round(d.kpi.netCashFlow / d.kpi.monthIncome * 100) : null;
  $('#kpi-savings').textContent = savings === null ? '—' : savings + '%';

  const now = new Date();
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
  if (score >= 85)
    alerts.push(`<div class="alert ok">✨ Điểm sức khỏe tài chính rất tốt (${score}/100)! Tiếp tục duy trì nhé.</div>`);
  $('#dash-alerts').innerHTML = alerts.join('');

  // ----- Charts -----
  const catLabels = Object.keys(d.expenseByCategory);

  makeChart('chart-category', {
    type: 'doughnut',
    data: { 
      labels: catLabels, 
      datasets: [{ 
        data: catLabels.map(k => d.expenseByCategory[k]), 
        backgroundColor: NESTED_PALETTE, 
        borderWidth: 2,
        borderColor: '#FFFFFF'
      }] 
    },
    options: { 
      cutout: '70%', 
      plugins: { 
        legend: { 
          position: 'right',
          labels: {
            color: '#2D3748',
            font: { weight: 500 },
            boxWidth: 10,
            padding: 12
          }
        } 
      } 
    }
  });

  const days = Object.keys(d.dailyTrend).sort();
  const canvasDaily = $('#chart-daily');
  const ctxDaily = canvasDaily.getContext('2d');
  const gradDaily = ctxDaily.createLinearGradient(0, 0, 0, 180);
  gradDaily.addColorStop(0, 'rgba(56, 178, 172, 0.35)'); /* Teal */
  gradDaily.addColorStop(1, 'rgba(56, 178, 172, 0.0)');

  // 7-day Moving Average Calculation
  const dailyRaw = days.map(k => d.dailyTrend[k]);
  const ma7 = dailyRaw.map((val, idx, arr) => {
    if (idx < 6) return null; // Not enough data for 7-day MA
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += arr[idx - i];
    return sum / 7;
  });

  makeChart('chart-daily', {
    type: 'line',
    data: { 
      labels: days.map(x => x.slice(8)), 
      datasets: [
        { 
          label: 'Chi tiêu hằng ngày', 
          data: dailyRaw, 
          borderColor: 'rgba(56, 178, 172, 0.4)', 
          borderWidth: 2,
          backgroundColor: gradDaily, 
          fill: true, 
          tension: .38, 
          pointRadius: 1
        },
        { 
          label: '7-day MA', 
          data: ma7, 
          borderColor: '#FF7F50', 
          borderWidth: 3,
          backgroundColor: 'transparent',
          fill: false, 
          tension: .38, 
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ] 
    },
    options: { 
      plugins: { legend: { display: true, position: 'top' } },
      scales: {
        x: {
          grid: { color: 'rgba(0, 0, 0, 0.05)', drawBorder: false },
          ticks: { color: '#718096' }
        },
        y: {
          grid: { color: 'rgba(0, 0, 0, 0.05)', drawBorder: false },
          ticks: { color: '#718096' }
        }
      }
    }
  });

  // Render Heatmap
  renderWeeklyHeatmap(d.dailyTrend);

  // Render Monthly Tactical View
  renderMonthlyTactical(d.expenseByCategory, mb);

  // Render Yearly Strategic View
  renderYearlyStrategic(d);

  const mt = trend;
  const canvasMonthly = $('#chart-monthly');
  const ctxMonthly = canvasMonthly.getContext('2d');
  const gradMonthly = ctxMonthly.createLinearGradient(0, 0, 0, 180);
  gradMonthly.addColorStop(0, 'rgba(42, 122, 140, 0.7)'); /* Deep Teal */
  gradMonthly.addColorStop(1, 'rgba(42, 122, 140, 0.1)');

  makeChart('chart-monthly', {
    type: 'bar',
    data: { 
      labels: mt.map(x => x.month), 
      datasets: [{ 
        label: 'Chi tiêu', 
        data: mt.map(x => x.expense), 
        backgroundColor: gradMonthly, 
        borderColor: 'rgba(42, 122, 140, 0.9)',
        borderWidth: 1,
        borderRadius: 6 
      }] 
    },
    options: { 
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { color: 'rgba(0, 0, 0, 0.05)', drawBorder: false },
          ticks: { color: '#718096' }
        },
        y: {
          grid: { color: 'rgba(0, 0, 0, 0.05)', drawBorder: false },
          ticks: { color: '#718096' }
        }
      }
    }
  });

  const canvasIncExp = $('#chart-income-expense');
  const ctxIncExp = canvasIncExp.getContext('2d');
  
  const gradInc = ctxIncExp.createLinearGradient(0, 0, 0, 180);
  gradInc.addColorStop(0, 'rgba(79, 209, 165, 0.7)');
  gradInc.addColorStop(1, 'rgba(79, 209, 165, 0.05)');

  const gradExp = ctxIncExp.createLinearGradient(0, 0, 0, 180);
  gradExp.addColorStop(0, 'rgba(243, 163, 144, 0.7)');
  gradExp.addColorStop(1, 'rgba(243, 163, 144, 0.05)');

  makeChart('chart-income-expense', {
    type: 'bar',
    data: { 
      labels: mt.map(x => x.month), 
      datasets: [
        { 
          label: 'Thu nhập', 
          data: mt.map(x => x.income), 
          backgroundColor: gradInc, 
          borderColor: 'rgba(79, 209, 165, 0.3)',
          borderWidth: 1,
          borderRadius: 6 
        },
        { 
          label: 'Chi tiêu', 
          data: mt.map(x => x.expense), 
          backgroundColor: gradExp, 
          borderColor: 'rgba(243, 163, 144, 0.3)',
          borderWidth: 1,
          borderRadius: 6 
        }
      ] 
    },
    options: { 
      plugins: { 
        legend: { 
          display: true,
          position: 'top',
          labels: { color: '#F2F7F5' }
        } 
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)', drawBorder: false },
          ticks: { color: '#8AA09A' }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.03)', drawBorder: false },
          ticks: { color: '#8AA09A' }
        }
      }
    }
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
  $('#top-cats').innerHTML = rankListHTML(d.topCategories, totalExp);
  $('#top-vendors').innerHTML = rankListHTML(d.topVendors, totalExp);

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

// ============================================================
// ADD-TRANSACTION MODAL (shared by Dashboard / Income / Expense / Transactions)
// ============================================================
async function openTxModal(presetType) {
  await ensureCategories();
  fillSelect($('#mtx-type'), CATS.types, { value: presetType || 'Expense' });
  refreshTxGroupSelects();
  $('#tx-modal-title').textContent =
    presetType === 'Income' ? 'Thêm thu nhập' :
    presetType === 'Expense' ? 'Thêm chi tiêu' : 'Thêm giao dịch thủ công';
  $('#mtx-date').value = new Date().toISOString().slice(0, 10);
  $('#tx-modal').hidden = false;
  $('#mtx-supplier').focus();
}
function closeTxModal() { $('#tx-modal').hidden = true; }

/** Group select follows Loại (expense groups vs income groups); the
 * sub-category select only shows for groups that actually have children. */
function refreshTxGroupSelects() {
  const isIncome = $('#mtx-type').value === 'Income';
  $('#mtx-group-label').textContent = isIncome ? 'Nhóm thu nhập' : 'Nhóm chi tiêu';
  fillSelect($('#mtx-group'), isIncome ? (CATS.incomeGroups.length ? CATS.incomeGroups : ['Other Income']) : CATS.groups,
    { value: $('#mtx-group').value || null });
  refreshTxSubSelect();
}
function refreshTxSubSelect() {
  const isIncome = $('#mtx-type').value === 'Income';
  const subs = isIncome ? [] : (CATS.subs[$('#mtx-group').value] || []);
  $('#mtx-sub-wrap').hidden = subs.length === 0;
  fillSelect($('#mtx-sub'), subs, { empty: '— Không chọn —' });
}
$('#mtx-type').addEventListener('change', refreshTxGroupSelects);
$('#mtx-group').addEventListener('change', refreshTxSubSelect);

$('#btn-close-tx').addEventListener('click', closeTxModal);
$('#btn-cancel-tx').addEventListener('click', closeTxModal);
$('#tx-modal').addEventListener('click', (e) => { if (e.target === $('#tx-modal')) closeTxModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#tx-modal').hidden) closeTxModal(); });

$('#btn-save-tx').addEventListener('click', async () => {
  try {
    await api('addTransaction', {
      receipt_date: $('#mtx-date').value,
      supplier: $('#mtx-supplier').value.trim(),
      transaction_type: $('#mtx-type').value,
      expense_group: $('#mtx-group').value,
      sub_group: $('#mtx-sub-wrap').hidden ? '' : $('#mtx-sub').value,
      total_amount: $('#mtx-amount').value,
      payment_method: $('#mtx-payment').value,
      notes: $('#mtx-notes').value.trim()
    });
    toast('Đã lưu giao dịch.');
    closeTxModal();
    $('#mtx-amount').value = ''; $('#mtx-supplier').value = ''; $('#mtx-notes').value = '';
    // Refresh whatever page is currently on screen
    const active = $('.page.active');
    const name = active ? active.id.replace('page-', '') : '';
    (pageLoaders[name] || (() => {}))().catch?.(e => toast(e.message));
  } catch (e) { toast('Lỗi: ' + e.message); }
});

// Dashboard quick actions
$('#btn-quick-add').addEventListener('click', () => openTxModal().catch(e => toast(e.message)));
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
    <span class="tx-main">${esc(r.supplier || '(không rõ)')}<small>${esc(r.transaction_type)}${r.expense_group ? ' · ' + esc(r.expense_group) : ''}${r.sub_group ? ' › ' + esc(r.sub_group) : ''}${r.source ? ' · ' + esc(r.source) : ''}</small></span>
    <span class="tx-amt ${sign}">${sign === 'income' ? '+' : '−'}${fmtVND(r.total_amount)}</span>
  </div>`;
}

/** Preset the manual-transaction-form type when opened from the Income/Expense quick-add buttons. */

// ============================================================
// INCOME
// ============================================================
async function loadIncomePage() {
  const month = $('#inc-month').value || new Date().toISOString().slice(0, 7);
  $('#inc-month').value = month;
  const d = await api('getDashboard', { month });

  const trend = d.monthlyTrend || [];
  const idx = trend.findIndex(x => x.month === month);
  const cur = idx >= 0 ? trend[idx] : { income: d.kpi.monthIncome };
  const prev = idx > 0 ? trend[idx - 1] : null;

  $('#inc-kpi-total').textContent = fmtVND(d.kpi.monthIncome);
  $('#inc-kpi-delta').innerHTML = prev ? deltaHTML(cur.income, prev.income) : '';

  // Yearly income KPIs (total this year + avg/month this year vs last year)
  const my = month.slice(0, 4);
  const iy = d.incomeYear || {};
  const curYear = iy.year || my;
  const prevYear = iy.prevYear || String(Number(my) - 1);
  $('#inc-lbl-year').textContent = `Tổng thu nhập năm ${curYear}`;
  $('#inc-kpi-year').textContent = fmtVND(iy.yearIncome || 0);
  $('#inc-kpi-year-delta').innerHTML = iy.prevYearSamePeriod
    ? deltaHTML(iy.yearIncome, iy.prevYearSamePeriod, { label: `so với cùng kỳ năm ${prevYear}` })
    : `<span class="delta flat">chưa có dữ liệu năm ${esc(prevYear)}</span>`;
  $('#inc-lbl-avgcur').textContent = `Thu nhập BQ/tháng năm ${curYear}`;
  $('#inc-kpi-avgmonth-cur').textContent = fmtVND(iy.avgMonthThisYear || 0);
  $('#inc-lbl-avgprev').textContent = `Thu nhập BQ/tháng năm ${prevYear}`;
  $('#inc-kpi-avgmonth-prev').textContent = iy.prevYearIncome > 0 ? fmtVND(iy.avgMonthPrevYear) : '—';

  const sources = d.incomeBySource || {};
  const srcLabels = Object.keys(sources);

  const rows = await api('getTransactions', { month, limit: 500 }, { silent: true });
  const incomeRows = rows.filter(r => r.transaction_type === 'Income' || r.transaction_type === 'Refund');

  makeChart('chart-income-source', {
    type: 'doughnut',
    data: { labels: srcLabels, datasets: [{ data: srcLabels.map(k => sources[k]), backgroundColor: NESTED_PALETTE, borderWidth: 2, borderColor: '#FFFFFF' }] },
    options: { cutout: '70%', plugins: { legend: { position: 'right', labels: { color: '#2D3748', font: { weight: 500 }, boxWidth: 10, padding: 12 } } } }
  });

  makeChart('chart-income-monthly', {
    type: 'bar',
    data: { labels: trend.map(x => x.month), datasets: [{ label: 'Thu nhập', data: trend.map(x => x.income), backgroundColor: 'rgba(56, 178, 172, 0.55)', borderColor: 'rgba(56,178,172,0.9)', borderWidth: 1, borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } } }
  });

  $('#inc-top-sources').innerHTML = rankListHTML(d.topIncomeSources, d.kpi.monthIncome);
  $('#inc-recent').innerHTML = incomeRows.slice(0, 10).map(txRowHTML).join('') || '<p class="muted">Chưa có giao dịch thu nhập tháng này.</p>';
}
$('#inc-month').addEventListener('change', () => loadIncomePage().catch(e => toast(e.message)));
$('#btn-inc-add').addEventListener('click', () => openTxModal('Income').catch(e => toast(e.message)));

// ============================================================
// EXPENSE
// ============================================================
async function loadExpensePage() {
  const month = $('#exp-month').value || new Date().toISOString().slice(0, 7);
  $('#exp-month').value = month;
  const d = await api('getDashboard', { month });

  const trend = d.monthlyTrend || [];
  const idx = trend.findIndex(x => x.month === month);
  const cur = idx >= 0 ? trend[idx] : { expense: d.kpi.monthExpense };
  const prev = idx > 0 ? trend[idx - 1] : null;

  // Track the raw data to use in the dropdown change handler
  window._currentExpenseData = {
    month: d.kpi.monthExpense,
    prevMonth: prev ? prev.expense : null,
    day: 0,
    prevDay: null,
    year: 0,
    prevYear: null
  };
  
  // Calculate today's expense if in current month
  const todayStr = new Date().toISOString().slice(0, 10);
  if (month === todayStr.slice(0, 7)) {
    window._currentExpenseData.day = d.dailyTrend[todayStr] || 0;
    // We could fetch yesterday's, but for simplicity, we leave prevDay as null or try to find it
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    window._currentExpenseData.prevDay = d.dailyTrend[yesterday] || 0;
  }
  
  // Year expense from YearlyBudgets (summing spent) or we can approximate
  // We can just calculate total spent this year from d.yearlyBudgets if available
  if (d.yearlyBudgets && d.yearlyBudgets.length > 0) {
    window._currentExpenseData.year = d.yearlyBudgets.reduce((sum, b) => sum + b.spent, 0);
  }

  // Update total based on current dropdown selection
  const periodSel = $('#exp-kpi-period');
  const updateExpenseKPI = () => {
    const p = periodSel ? periodSel.value : 'month';
    let val = 0;
    let deltaHtml = '';
    
    if (p === 'day') {
      val = window._currentExpenseData.day;
      if (window._currentExpenseData.prevDay !== null) {
        deltaHtml = deltaHTML(val, window._currentExpenseData.prevDay, { invert: true, label: 'so với hôm qua' });
      }
    } else if (p === 'year') {
      val = window._currentExpenseData.year;
      deltaHtml = '';
    } else {
      val = window._currentExpenseData.month;
      deltaHtml = window._currentExpenseData.prevMonth !== null 
        ? deltaHTML(val, window._currentExpenseData.prevMonth, { invert: true, label: 'so với tháng trước' }) 
        : '';
    }
    
    $('#exp-kpi-total').textContent = fmtVND(val);
    $('#exp-kpi-delta').innerHTML = deltaHtml;
  };

  if (periodSel) {
    periodSel.removeEventListener('change', updateExpenseKPI);
    periodSel.addEventListener('change', updateExpenseKPI);
  }
  updateExpenseKPI();

  const [my, mm] = month.split('-');
  const now = new Date();
  const isCurrentMonth = month === now.toISOString().slice(0, 7);
  const daysInMonth = new Date(Number(my), Number(mm), 0).getDate();
  const daysElapsed = isCurrentMonth ? now.getDate() : daysInMonth;
  const avgDay = d.kpi.monthExpense / Math.max(daysElapsed, 1);
  $('#exp-kpi-avgday').textContent = fmtVND(Math.round(avgDay));
  $('#exp-kpi-forecast').textContent = fmtVND(Math.round(avgDay * daysInMonth));

  const catLabels = Object.keys(d.expenseByCategory);
  $('#exp-kpi-groups').textContent = catLabels.length;

  makeChart('chart-expense-category', {
    type: 'doughnut',
    data: { labels: catLabels, datasets: [{ data: catLabels.map(k => d.expenseByCategory[k]), backgroundColor: NESTED_PALETTE, borderWidth: 2, borderColor: '#FFFFFF' }] },
    options: { cutout: '70%', plugins: { legend: { position: 'right', labels: { color: '#2D3748', font: { weight: 500 }, boxWidth: 10, padding: 12 } } } }
  });

  const days = Object.keys(d.dailyTrend).sort();
  makeChart('chart-expense-daily', {
    type: 'line',
    data: { labels: days.map(x => x.slice(8)), datasets: [{ label: 'Chi tiêu', data: days.map(k => d.dailyTrend[k]), borderColor: '#E6B5A1', borderWidth: 3, backgroundColor: 'rgba(230, 181, 161, 0.2)', fill: true, tension: .38, pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: '#E6B5A1', pointBorderColor: '#FFFFFF' }] },
    options: { plugins: { legend: { display: false } } }
  });

  makeChart('chart-expense-monthly', {
    type: 'bar',
    data: { labels: trend.map(x => x.month), datasets: [{ label: 'Chi tiêu', data: trend.map(x => x.expense), backgroundColor: 'rgba(230, 181, 161, 0.55)', borderColor: 'rgba(230,181,161,0.9)', borderWidth: 1, borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } } }
  });

  $('#exp-top-cats').innerHTML = rankListHTML(d.topCategories, d.kpi.monthExpense);
  $('#exp-top-vendors').innerHTML = rankListHTML(d.topVendors, d.kpi.monthExpense);

  const rows = await api('getTransactions', { month, type: 'Expense', limit: 10 }, { silent: true });
  $('#exp-recent').innerHTML = rows.map(txRowHTML).join('') || '<p class="muted">Chưa có giao dịch chi tiêu tháng này.</p>';
}
$('#exp-month').addEventListener('change', () => loadExpensePage().catch(e => toast(e.message)));
$('#btn-exp-add').addEventListener('click', () => openTxModal('Expense').catch(e => toast(e.message)));

// ============================================================
// TRANSACTIONS
// ============================================================
async function loadTransactions() {
  await ensureCategories();
  fillSelect($('#tx-type'), CATS.types, { empty: '— Loại —', value: $('#tx-type').value });
  fillSelect($('#tx-group'), CATS.groups, { empty: '— Nhóm —', value: $('#tx-group').value });

  const rows = await api('getTransactions', {
    month: $('#tx-month').value || undefined,
    type: $('#tx-type').value || undefined,
    group: $('#tx-group').value || undefined
  });
  $('#tx-table').innerHTML = rows.map(txRowHTML).join('') || '<p class="muted">Không có giao dịch.</p>';
}
$('#btn-tx-filter').addEventListener('click', () => loadTransactions().catch(e => toast(e.message)));
$('#btn-add-tx').addEventListener('click', () => openTxModal().catch(e => toast(e.message)));

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

let dupPendingPayload = null; // approve payload waiting on the duplicate modal

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
    if (/duplicate/i.test(e.message)) {
      dupPendingPayload = p;
      $('#dup-msg').textContent = e.message;
      $('#dup-modal').hidden = false;
    } else toast('Lỗi: ' + e.message);
  }
});

function closeDupModal() { $('#dup-modal').hidden = true; dupPendingPayload = null; }
$('#btn-dup-close').addEventListener('click', closeDupModal);
$('#dup-modal').addEventListener('click', (e) => { if (e.target === $('#dup-modal')) closeDupModal(); });

// "Xóa bản nháp trùng": reject the draft so it disappears from the review tab —
// the already-approved receipt stays untouched.
$('#btn-dup-delete').addEventListener('click', async () => {
  const p = dupPendingPayload; closeDupModal();
  if (!p) return;
  try {
    await api('rejectDraft', { draftId: p.draftId, reason: 'Trùng hóa đơn — ' + $('#dup-msg').textContent });
    toast('🗑 Đã xóa bản nháp trùng — bản ghi cũ được giữ nguyên.');
    loadReviewList();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

$('#btn-dup-force').addEventListener('click', async () => {
  const p = dupPendingPayload; closeDupModal();
  if (!p) return;
  try {
    const r = await api('approveDraft', { ...p, forceDuplicate: true });
    toast('✅ Đã duyệt — ' + r.receiptId);
    loadReviewList();
  } catch (e) { toast('Lỗi: ' + e.message); }
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
// DEBTS
// ============================================================
const DEBT_TYPE_LABELS = {
  home_loan: 'Vay mua nhà', car_loan: 'Vay mua xe', personal_loan: 'Vay tiêu dùng',
  credit_card: 'Thẻ tín dụng', student_loan: 'Vay du học / học phí', other: 'Khác'
};
let currentDebtId = null;   // debt being edited in #debt-form (null = creating new)
let paymentDebtId = null;   // debt being paid in #debt-payment-form
let lastDebts = [];         // cache of debts from the last getDebtDashboard call

/** Next installment estimate, same formula as the bank / backend schedule:
 *  fixed principal slice + day-count interest on the current balance. */
function estimateNextEMI(deb) {
  const slice = deb.term_months > 0 && deb.principal > 0
    ? Math.round(deb.principal / deb.term_months) : 0;
  if (!slice || !deb.due_day) return deb.monthly_payment || null;
  const today = new Date();
  let due = new Date(today.getFullYear(), today.getMonth(), deb.due_day);
  if (due <= today) due = new Date(today.getFullYear(), today.getMonth() + 1, deb.due_day);
  const prev = new Date(due.getFullYear(), due.getMonth() - 1, deb.due_day);
  const days = Math.round((due - prev) / 86400000);
  const interest = Math.round(deb.current_balance * (deb.interest_rate / 100) * days / 365);
  return Math.min(slice, Math.round(deb.current_balance)) + interest;
}

async function loadDebtsPage() {
  const d = await api('getDebtDashboard');
  lastDebts = d.debts;

  $('#debt-kpi-outstanding').textContent = fmtVND(d.kpi.totalOutstanding);
  $('#debt-kpi-monthly').textContent = fmtVND(d.kpi.totalMonthlyPayment);
  $('#debt-kpi-paid').textContent = fmtVND(d.kpi.totalPaid);
  $('#debt-kpi-active').textContent = d.kpi.activeCount;
  $('#debt-kpi-paidoff').textContent = d.kpi.paidOffCount;

  const typeKeys = Object.keys(d.byType);
  makeChart('chart-debt-type', {
    type: 'doughnut',
    data: {
      labels: typeKeys.map(t => DEBT_TYPE_LABELS[t] || t),
      datasets: [{ data: typeKeys.map(k => d.byType[k]), backgroundColor: NESTED_PALETTE, borderWidth: 2, borderColor: '#FFFFFF' }]
    },
    options: { cutout: '70%', plugins: { legend: { position: 'right', labels: { color: '#2D3748', font: { weight: 500 }, boxWidth: 10, padding: 12 } } } }
  });

  $('#debt-upcoming').innerHTML = d.upcoming.length ? d.upcoming.map(deb => `
    <div class="tx-row">
      <span class="tx-date">Ngày ${esc(deb.due_day)}</span>
      <span class="tx-main">${esc(deb.name)}<small>${esc(DEBT_TYPE_LABELS[deb.type] || deb.type)}</small></span>
      <span class="tx-amt expense">${fmtVND(deb.monthly_payment)}</span>
    </div>`).join('') : '<p class="muted">Không có khoản nợ nào có ngày đến hạn hàng tháng.</p>';

  $('#debt-list').innerHTML = d.debts.length
    ? d.debts.map(debtCardHTML).join('')
    : '<p class="muted">Chưa có khoản nợ nào. Bấm "+ Thêm khoản nợ" để bắt đầu.</p>';
  $$('#debt-list .btn-debt-pay').forEach(b => b.addEventListener('click', () => openPaymentForm(b.dataset.id, b.dataset.name)));
  $$('#debt-list .btn-debt-schedule').forEach(b => b.addEventListener('click', () => openScheduleView(b.dataset.id)));
  $$('#debt-list .btn-debt-edit').forEach(b => b.addEventListener('click', () => openDebtForm(b.dataset.id, d.debts)));
  $$('#debt-list .btn-debt-status').forEach(b => b.addEventListener('click', () => toggleDebtStatus(b.dataset.id, b.dataset.status)));
  $$('#debt-list .btn-debt-delete').forEach(b => b.addEventListener('click', () => deleteDebtRow(b.dataset.id)));

  payFilterId = null;
  lastRecentPayments = d.recentPayments;
  renderDebtPayments(d.recentPayments);
  renderPayFilter(d.debts);
}

let payFilterId = null;        // debt_id filtering the payments table (null = all)
let lastRecentPayments = [];   // unfiltered list from the last getDebtDashboard call

function renderDebtPayments(rows) {
  $('#debt-payments-table').innerHTML = rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Ngày</th><th>Khoản nợ</th><th>Số tiền</th><th>Gốc</th><th>Lãi</th><th>Ghi chú</th></tr></thead>
    <tbody>${rows.map(p => `<tr>
      <td class="money">${esc(p.payment_date)}</td><td>${esc(p.debt_name)}</td>
      <td class="money">${fmtVND(p.amount)}</td><td class="money">${fmtVND(p.principal_portion)}</td>
      <td class="money">${fmtVND(p.interest_portion)}</td><td>${esc(p.notes)}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Chưa có khoản thanh toán nào.</p>';
}

function renderPayFilter(debts) {
  const opts = [{ id: '', label: 'Tất cả' }]
    .concat(debts.map(x => ({ id: x.debt_id, label: x.name })));
  $('#debt-pay-filter').innerHTML = opts.map(o =>
    `<button class="btn small ${(payFilterId || '') === o.id ? 'primary' : ''}" data-fid="${esc(o.id)}">${esc(o.label)}</button>`
  ).join('');
  $$('#debt-pay-filter button').forEach(b => b.addEventListener('click', async () => {
    payFilterId = b.dataset.fid || null;
    renderPayFilter(debts); // refresh active state
    try {
      if (!payFilterId) return renderDebtPayments(lastRecentPayments);
      const rows = await api('getDebtPayments', { debtId: payFilterId }, { silent: true });
      const nameOf = id => (lastDebts.find(x => x.debt_id === id) || {}).name || id;
      renderDebtPayments(rows.slice(0, 24).map(p => Object.assign({ debt_name: nameOf(p.debt_id) }, p)));
    } catch (e) { toast('Lỗi: ' + e.message); }
  }));
}

function debtCardHTML(deb) {
  const paidOff = deb.status === 'paid_off';
  return `<div class="debt-card ${paidOff ? 'paid-off' : ''}">
    <div class="debt-card-head">
      <div>
        <span class="debt-type-badge">${esc(DEBT_TYPE_LABELS[deb.type] || deb.type)}</span>
        <h3>${esc(deb.name)}</h3>
        <span class="muted">${deb.lender ? esc(deb.lender) + ' · ' : ''}bắt đầu ${esc(String(deb.start_date).slice(0, 10))}</span>
      </div>
      <div class="debt-card-amounts">
        <strong class="money ${paidOff ? 'income' : 'expense'}">${paidOff ? 'Đã tất toán' : fmtVND(deb.current_balance)}</strong>
        <span class="muted">/ gốc ${fmtVND(deb.principal)}</span>
      </div>
    </div>
    <div class="debt-bar"><i style="width:${deb.pct_paid}%"></i></div>
    <div class="debt-card-meta">
      <span>Trả hàng tháng: <b>${fmtVND(deb.monthly_payment)}</b></span>
      <span>Lãi suất: <b>${deb.interest_rate}%/năm</b></span>
      ${deb.due_day ? `<span>Đến hạn: <b>ngày ${esc(deb.due_day)}</b></span>` : ''}
      ${!paidOff && deb.months_remaining != null ? `<span>Còn ~<b>${deb.months_remaining} tháng</b></span>` : ''}
      <span>Đã trả: <b>${deb.pct_paid}%</b></span>
    </div>
    ${deb.notes ? `<p class="muted debt-notes">${esc(deb.notes)}</p>` : ''}
    <div class="btn-row">
      ${!paidOff ? `<button class="btn small primary btn-debt-pay" data-id="${esc(deb.debt_id)}" data-name="${esc(deb.name)}">Ghi nhận thanh toán</button>` : ''}
      ${!paidOff ? `<button class="btn small btn-debt-schedule" data-id="${esc(deb.debt_id)}">📅 Lịch trả nợ</button>` : ''}
      <button class="btn small btn-debt-edit" data-id="${esc(deb.debt_id)}">Sửa</button>
      ${!paidOff
        ? `<button class="btn small btn-debt-status" data-id="${esc(deb.debt_id)}" data-status="paid_off">Đánh dấu đã tất toán</button>`
        : `<button class="btn small btn-debt-status" data-id="${esc(deb.debt_id)}" data-status="active">Mở lại</button>`}
      <button class="btn small danger btn-debt-delete" data-id="${esc(deb.debt_id)}">Xóa</button>
    </div>
  </div>`;
}

function openDebtForm(debtId, debts) {
  $('#debt-payment-form').hidden = true;
  $('#debt-schedule').hidden = true;
  $('#debt-form').hidden = false;
  currentDebtId = debtId || null;
  const deb = debtId ? (debts || []).find(x => x.debt_id === debtId) : null;
  $('#debt-form-title').textContent = deb ? 'Sửa khoản nợ' : 'Thêm khoản nợ';
  $('#dbt-name').value = deb ? deb.name : '';
  $('#dbt-type').value = deb ? deb.type : 'home_loan';
  $('#dbt-lender').value = deb ? (deb.lender || '') : '';
  $('#dbt-principal').value = deb ? deb.principal : '';
  $('#dbt-rate').value = deb ? deb.interest_rate : '';
  $('#dbt-term').value = deb && deb.term_months != null ? deb.term_months : '';
  $('#dbt-start').value = deb ? String(deb.start_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  $('#dbt-payment').value = deb ? deb.monthly_payment : '';
  $('#dbt-due').value = deb && deb.due_day != null ? deb.due_day : '';
  // On edit, prefill so the balance can be adjusted manually (e.g. bank rate reset
  // after the fixed-rate period). Routine changes still go through "Ghi nhận thanh toán".
  $('#dbt-balance').value = deb ? deb.current_balance : '';
  $('#dbt-balance-wrap').hidden = false;
  $('#dbt-notes').value = deb ? (deb.notes || '') : '';
}
$('#btn-debt-add').addEventListener('click', () => openDebtForm(null, []));
$('#btn-cancel-debt').addEventListener('click', () => $('#debt-form').hidden = true);
$('#btn-save-debt').addEventListener('click', async () => {
  try {
    await api('saveDebt', {
      debt_id: currentDebtId || undefined,
      name: $('#dbt-name').value.trim(),
      type: $('#dbt-type').value,
      lender: $('#dbt-lender').value.trim(),
      principal: $('#dbt-principal').value,
      interest_rate: $('#dbt-rate').value,
      term_months: $('#dbt-term').value,
      start_date: $('#dbt-start').value,
      monthly_payment: $('#dbt-payment').value,
      due_day: $('#dbt-due').value,
      current_balance: $('#dbt-balance').value,
      notes: $('#dbt-notes').value.trim()
    });
    toast('Đã lưu khoản nợ.');
    $('#debt-form').hidden = true;
    loadDebtsPage();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

function openPaymentForm(debtId, name) {
  $('#debt-form').hidden = true;
  $('#debt-schedule').hidden = true;
  $('#debt-payment-form').hidden = false;
  paymentDebtId = debtId;
  $('#dpy-debt-name').textContent = name;
  $('#dpy-date').value = new Date().toISOString().slice(0, 10);
  // Pre-fill with the estimated next installment; user overwrites with the
  // actual amount from the bank statement if it differs.
  const deb = lastDebts.find(x => x.debt_id === debtId);
  const est = deb ? estimateNextEMI(deb) : null;
  $('#dpy-amount').value = est || '';
  $('#dpy-notes').value = '';
}

async function openScheduleView(debtId) {
  $('#debt-form').hidden = true;
  $('#debt-payment-form').hidden = true;
  try {
    const s = await api('getDebtSchedule', { debtId });
    $('#debt-schedule').hidden = false;
    $('#dsc-debt-name').textContent = s.debt.name;
    $('#dsc-summary').innerHTML =
      `Còn <b>${s.summary.installments}</b> kỳ · Tổng lãi còn phải trả: <b class="expense">${fmtVND(s.summary.totalInterest)}</b> · ` +
      `Tổng gốc + lãi: <b>${fmtVND(s.summary.totalPayment)}</b> · Dự kiến tất toán: <b>${esc(s.summary.payoffDate)}</b>`;
    $('#dsc-table').innerHTML = `<table>
      <thead><tr><th>Kỳ</th><th>Ngày đến hạn</th><th>Gốc</th><th>Lãi</th><th>Tổng trả (EMI)</th><th>Dư nợ còn lại</th></tr></thead>
      <tbody>${s.rows.map((r, i) => `<tr class="${i === 0 ? 'next-installment' : ''}">
        <td class="money">${r.k}</td><td class="money">${esc(r.due_date)}</td>
        <td class="money">${fmtVND(r.principal)}</td><td class="money">${fmtVND(r.interest)}</td>
        <td class="money"><b>${fmtVND(r.emi)}</b></td><td class="money">${fmtVND(r.balance_after)}</td>
      </tr>`).join('')}</tbody></table>`;
    $('#debt-schedule').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast('Lỗi: ' + e.message); }
}
$('#btn-close-schedule').addEventListener('click', () => $('#debt-schedule').hidden = true);
$('#btn-cancel-payment').addEventListener('click', () => $('#debt-payment-form').hidden = true);
$('#btn-save-payment').addEventListener('click', async () => {
  try {
    await api('addDebtPayment', {
      debt_id: paymentDebtId,
      payment_date: $('#dpy-date').value,
      amount: $('#dpy-amount').value,
      payment_method: $('#dpy-payment').value,
      notes: $('#dpy-notes').value.trim()
    });
    toast('Đã ghi nhận thanh toán.');
    $('#debt-payment-form').hidden = true;
    loadDebtsPage();
  } catch (e) { toast('Lỗi: ' + e.message); }
});

async function toggleDebtStatus(debtId, status) {
  try {
    await api('setDebtStatus', { debt_id: debtId, status });
    toast(status === 'paid_off' ? 'Đã đánh dấu tất toán.' : 'Đã mở lại khoản nợ.');
    loadDebtsPage();
  } catch (e) { toast('Lỗi: ' + e.message); }
}
async function deleteDebtRow(debtId) {
  if (!confirm('Xóa khoản nợ này? (Chỉ xóa được khi chưa có lịch sử thanh toán.)')) return;
  try {
    await api('deleteDebt', { debt_id: debtId });
    toast('Đã xóa khoản nợ.');
    loadDebtsPage();
  } catch (e) { toast('Lỗi: ' + e.message); }
}

// ============================================================
// CATEGORIES / RULES / SETTINGS / LOGS
// ============================================================
async function loadCategoriesPage() {
  CATS = { types: [], groups: [], subs: {}, incomeGroups: [], raw: [] };
  await ensureCategories();
  const idOf = (kind, name, parent) => {
    const r = CATS.raw.find(x => x.kind === kind && x.name === name && String(x.parent || '') === (parent || ''));
    return r ? r.category_id : '';
  };
  const chip = (kind, name, parent) =>
    `<span class="chip">${esc(name)}<button class="chip-del" title="Xóa" data-id="${esc(idOf(kind, name, parent))}" data-name="${esc(name)}">×</button></span>`;

  $('#cat-types').innerHTML = CATS.types.map(t => chip('transaction_type', t)).join('') || '<p class="muted">Chưa có.</p>';
  $('#cat-incomes').innerHTML = CATS.incomeGroups.map(g => chip('income_group', g)).join('') || '<p class="muted">Chưa có.</p>';
  $('#cat-groups-tree').innerHTML = CATS.groups.map(g => `
    <div class="cat-group-row">
      <div class="cat-group-head">${chip('expense_group', g)}
        <button class="btn small btn-cat-add-sub" data-group="${esc(g)}">＋ Danh mục con</button>
      </div>
      <div class="chip-list cat-sub-list">${(CATS.subs[g] || []).map(sc => chip('expense_group', sc, g)).join('') || '<span class="muted" style="font-size:12px">Chưa có danh mục con</span>'}</div>
    </div>`).join('');

  $$('#page-categories .chip-del').forEach(b => b.addEventListener('click', async () => {
    if (!b.dataset.id) return toast('Không tìm thấy mã danh mục.');
    if (!confirm(`Xóa danh mục "${b.dataset.name}"?`)) return;
    try { await api('deleteCategory', { categoryId: b.dataset.id }); toast('Đã xóa.'); loadCategoriesPage(); }
    catch (e) { toast('Lỗi: ' + e.message); }
  }));
  $$('#page-categories .btn-cat-add-sub').forEach(b => b.addEventListener('click', async () => {
    const name = prompt(`Tên danh mục con cho "${b.dataset.group}":\n(VD: Breakfast, Lunch, Dinner, Cafe)`);
    if (!name || !name.trim()) return;
    try { await api('saveCategory', { kind: 'expense_group', name: name.trim(), parent: b.dataset.group }); toast('Đã thêm.'); loadCategoriesPage(); }
    catch (e) { toast('Lỗi: ' + e.message); }
  }));
}

async function addCategoryFromInput(inputSel, kind) {
  const el = $(inputSel);
  const name = el.value.trim();
  if (!name) return toast('Nhập tên danh mục trước.');
  try {
    await api('saveCategory', { kind, name });
    el.value = '';
    toast('Đã thêm "' + name + '".');
    loadCategoriesPage();
  } catch (e) { toast('Lỗi: ' + e.message); }
}
$('#btn-cat-add-type').addEventListener('click', () => addCategoryFromInput('#cat-new-type', 'transaction_type'));
$('#btn-cat-add-income').addEventListener('click', () => addCategoryFromInput('#cat-new-income', 'income_group'));
$('#btn-cat-add-group').addEventListener('click', () => addCategoryFromInput('#cat-new-group', 'expense_group'));

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
    const r = await api('ping');
    $('#cfg-status').textContent = '✅ Kết nối thành công!' +
      (r.version ? ` Backend v${r.version}.` : ' ⚠️ Backend đang chạy bản CŨ (trước v0.4.3) — cần deploy phiên bản mới trên Apps Script.');
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

(function boot() {
  if (!cfg.url || !cfg.token) showPage('settings');
  else showPage('dashboard');
})();
