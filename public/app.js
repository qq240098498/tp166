/* 运单计费与账单核对台 —— 前端逻辑（原生 JS，无任何外部依赖） */
(function () {
  'use strict';

  /* ================= 常量 ================= */
  var STATUSES = ['待发', '在途', '已签收', '退回'];
  var SERVICE_OPTIONS = ['保价', '签收', '上门'];
  var TAB_LABELS = { overview: '概览', waybills: '运单', zones: '分区', customers: '客户', bills: '账单' };
  var FIELD_LABELS = {
    code: '编码/运单号', name: '名称', status: '状态', customerId: '客户',
    fromCity: '寄件城市', toCity: '收件城市', weightKg: '实际重量', volumeM3: '体积',
    pieces: '件数', insuredAmountYuan: '保价金额', services: '附加服务', createdAt: '创建时刻',
    cities: '覆盖城市', aliases: '城市别名', settle: '结算方式', discountPermille: '折扣',
    periodDay: '账期日', period: '账期', firstWeightKg: '首重公斤', firstPriceYuan: '首重价',
    addUnitKg: '续重单位', addPriceYuan: '续重价', remoteFeeYuan: '偏远附加', billId: '账单'
  };

  /* ================= 状态 ================= */
  var state = {
    tab: 'overview',
    summary: null,
    zones: [],
    customers: [],
    waybills: { waybills: [], total: 0, lockedCount: 0, unzonedCount: 0 },
    bills: { bills: [], total: 0, issued: 0, voided: 0 },
    periods: [],
    filters: { keyword: '', customerId: '', status: '', unzoned: false },
    zoneFilter: { keyword: '', status: '' },
    customerFilter: { keyword: '', settle: '', status: '' },
    selectedWaybillId: '',
    waybillMode: 'view',      // view | create | edit
    selectedZoneId: '',
    zoneMode: 'view',
    selectedCustomerId: '',
    customerMode: 'view',
    selectedBillId: '',
    billDetail: null,
    billLoading: false,
    quote: null,              // 最近一次单条计费结果
    confirm: null             // { kind, id } 二次确认删除
  };

  var els = {};

  /* ================= 工具 ================= */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function attr(value) { return esc(value); }

  function money(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(value) {
    var n = Number(value);
    return isFinite(n) ? String(n) : '0';
  }
  function kg(value) { return money(value) + ' kg'; }
  function m3(value) { return (Number(value) || 0).toFixed(3) + ' m³'; }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function nowText() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function stampText(iso) {
    if (!iso) return '—';
    return String(iso).replace('T', ' ').slice(0, 19);
  }
  function timeTextOf(value) {
    if (!value) return '';
    return String(value).replace('T', ' ').slice(0, 16);
  }
  // 千分比折算成「折」：900 千分比 = 9.0 折
  function discountTextOf(permille) {
    var p = Number(permille);
    if (!isFinite(p) || p <= 0 || p >= 1000) return '不打折';
    return (p / 100).toFixed(1) + ' 折';
  }
  function statusClass(status) {
    if (status === '在途') return 'st-transit';
    if (status === '已签收') return 'st-done';
    if (status === '退回') return 'st-return';
    return 'st-pending';
  }
  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(null, args); }, wait);
    };
  }

  /* ================= 接口 ================= */
  function api(method, path, body) {
    var options = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        if (text) { try { payload = JSON.parse(text); } catch (e) { payload = null; } }
        if (!res.ok) {
          var raw = (payload && payload.error) || {};
          var err = new Error(raw.message || ('请求失败（HTTP ' + res.status + '）'));
          err.code = raw.code || 'HTTP_' + res.status;
          err.field = (raw.details && raw.details.field) ? raw.details.field : '';
          err.details = raw.details || null;
          throw err;
        }
        return payload;
      });
    });
  }

  /* ================= 数据加载 ================= */
  function loadSummary() { return api('GET', '/api/summary').then(function (r) { state.summary = r; }); }
  function loadZones() { return api('GET', '/api/zones').then(function (r) { state.zones = (r && r.zones) || []; }); }
  function loadCustomers() { return api('GET', '/api/customers').then(function (r) { state.customers = (r && r.customers) || []; }); }
  function loadPeriods() { return api('GET', '/api/periods').then(function (r) { state.periods = (r && r.periods) || []; }); }
  function loadBills() { return api('GET', '/api/bills').then(function (r) { state.bills = r || { bills: [], total: 0, issued: 0, voided: 0 }; }); }

  function waybillQuery() {
    var qs = [];
    if (state.filters.keyword) qs.push('keyword=' + encodeURIComponent(state.filters.keyword));
    if (state.filters.customerId) qs.push('customerId=' + encodeURIComponent(state.filters.customerId));
    if (state.filters.status) qs.push('status=' + encodeURIComponent(state.filters.status));
    if (state.filters.unzoned) qs.push('unzoned=1');
    return qs.length ? ('?' + qs.join('&')) : '';
  }
  function loadWaybills() {
    return api('GET', '/api/waybills' + waybillQuery()).then(function (r) {
      state.waybills = r || { waybills: [], total: 0, lockedCount: 0, unzonedCount: 0 };
    });
  }

  function refreshAll() {
    var errors = [];
    function keep(promise) { return promise.catch(function (err) { errors.push(err); }); }
    return Promise.all([
      keep(loadSummary()), keep(loadZones()), keep(loadCustomers()),
      keep(loadWaybills()), keep(loadBills()), keep(loadPeriods())
    ]).then(function () {
      if (errors.length) throw errors[0];
    });
  }

  /* ================= 提示 ================= */
  function setStatus(text, tone) {
    els.statusMessage.textContent = text;
    els.statusDot.className = 'status-dot' + (tone ? ' is-' + tone : '');
  }
  function clearNotice() {
    els.notice.hidden = true;
    els.notice.className = 'notice';
    els.noticeText.textContent = '';
  }
  function clearFieldErrors() {
    var list = document.querySelectorAll('.field.is-error');
    Array.prototype.forEach.call(list, function (wrap) {
      wrap.classList.remove('is-error');
      var msg = wrap.querySelector('.field-msg');
      if (msg) msg.textContent = '';
    });
  }
  function markFieldError(field) {
    if (!field) return;
    var wrap = document.querySelector('[data-field-wrap="' + field + '"]');
    if (!wrap) return;
    wrap.classList.add('is-error');
    var msg = wrap.querySelector('.field-msg');
    if (msg) msg.textContent = '此项需要修改：' + (FIELD_LABELS[field] || field);
    var focusable = wrap.querySelector('input, select, textarea');
    if (focusable) { try { focusable.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }
    try { wrap.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
  }
  // 接口报错：把 error.message 显示在页面提示区，校验失败再把对应输入框标出来
  function fail(err) {
    var message = (err && err.message) ? err.message : '请求失败';
    var code = (err && err.code) ? err.code : '';
    clearFieldErrors();
    els.notice.hidden = false;
    els.notice.className = 'notice';
    els.noticeText.textContent = '操作失败：' + message + (code ? '（' + code + '）' : '');
    setStatus('操作失败：' + message, 'error');
    if (err && err.field) markFieldError(err.field);
  }
  function ok(text) {
    clearNotice();
    setStatus(text, 'ok');
  }

  /* ================= 渲染骨架 ================= */
  function paneBlock(title, meta, body) {
    return '<div class="pane-head"><h2>' + esc(title) + '</h2>' +
      (meta ? '<span class="pane-meta">' + esc(meta) + '</span>' : '') + '</div>' +
      '<div class="pane-body">' + body + '</div>';
  }
  function emptyBlock(title, hint) {
    return '<div class="empty"><strong>' + esc(title) + '</strong>' + esc(hint || '') + '</div>';
  }
  function loadingBlock(text) { return '<div class="loading">' + esc(text || '加载中…') + '</div>'; }

  function setLeft(html) { els.leftPane.innerHTML = html; }
  function setMid(html) { els.midPane.innerHTML = html; }
  function setRight(html) { els.rightPane.innerHTML = html; }

  function renderTabs() {
    var tabs = els.tabs.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (btn) {
      var key = btn.getAttribute('data-tab');
      btn.classList.toggle('is-active', key === state.tab);
    });
  }
  function renderStamp() {
    els.dataStamp.textContent = '数据更新时间：' + stampText(state.summary && state.summary.updatedAt);
  }
  function renderStatusCount() {
    var s = state.summary || {};
    var text;
    switch (state.tab) {
      case 'overview':
        text = '概览：运单 ' + num(s.waybillCount) + ' 条 / 客户 ' + num(s.customerCount) + ' 个 / 分区 ' + num(s.zoneCount) + ' 个 / 账单 ' + num(s.billCount) + ' 张';
        break;
      case 'waybills':
        text = '运单清单 ' + num(state.waybills.total) + ' 条';
        break;
      case 'zones':
        text = '分区清单 ' + num(state.zones.length) + ' 个';
        break;
      case 'customers':
        text = '客户清单 ' + num(state.customers.length) + ' 个';
        break;
      case 'bills':
        text = '账单清单 ' + num(state.bills.total) + ' 张';
        break;
      default:
        text = '清单 0 条';
    }
    els.statusCount.textContent = text;
  }

  function render() {
    renderTabs();
    renderStamp();
    renderLeft();
    renderMid();
    renderRight();
    renderStatusCount();
  }
  function renderList() { renderMid(); renderStatusCount(); }

  /* ================= 概览 ================= */
  function renderOverviewLeft() {
    var s = state.summary;
    if (!s) return paneBlock('统计概览', '', loadingBlock('正在读取概览数据…'));
    var max = 1;
    (s.statusCounts || []).forEach(function (item) { max = Math.max(max, Number(item.count) || 0); });
    var rows = (s.statusCounts || []).map(function (item) {
      var cls = statusClass(item.status);
      var width = Math.round((Number(item.count) || 0) / max * 100);
      return '<button type="button" class="stat-row" data-action="goto-status" data-status="' + attr(item.status) + '">' +
        '<span class="stat-name"><i class="dot ' + cls + '"></i>' + esc(item.status) + '</span>' +
        '<span class="stat-val">' + num(item.count) + ' 条</span>' +
        '<span class="stat-bar"><i class="' + cls + '" style="width:' + width + '%"></i></span>' +
        '</button>';
    }).join('');

    var body =
      '<div class="block"><h3 class="block-title">运单状态分布</h3>' +
      '<p class="block-hint">点状态可以带着筛选跳到运单标签。</p>' +
      '<div class="stat-list">' + rows + '</div></div>' +
      '<div class="block"><h3 class="block-title">快捷入口</h3>' +
      '<div class="btn-stack">' +
      '<button type="button" class="btn btn-amber" data-action="goto-unzoned">只看未归属城市的运单</button>' +
      '<button type="button" class="btn" data-action="tab" data-tab="bills">去出账</button>' +
      '<button type="button" class="btn btn-ghost" data-action="refresh-all">刷新全部数据</button>' +
      '</div></div>';

    return paneBlock('统计概览', '数据源 /api/summary', body);
  }

  function renderOverviewMid() {
    var s = state.summary;
    var meta = s ? ('运单 ' + num(s.waybillCount) + ' 条') : '';
    if (!s) return paneBlock('概览数字', '', loadingBlock('正在读取概览数据…'));
    var unzonedHint = (s.unzonedCities && s.unzonedCities.length)
      ? ('涉及城市：' + s.unzonedCities.join('、'))
      : '所有收件城市都已归属分区';
    var cards = [
      { label: '运单数', value: num(s.waybillCount), unit: '条', tone: 'brand', hint: '已缓存计费结果 ' + num(s.cachedCount) + ' 条' },
      { label: '客户数', value: num(s.customerCount), unit: '个', hint: '含启用与停用' },
      { label: '分区数', value: num(s.zoneCount), unit: '个', hint: '覆盖城市见分区标签' },
      { label: '已出账账单', value: num(s.issuedCount), unit: '张', hint: '账单共 ' + num(s.billCount) + ' 张，已作废 ' + num(s.voidedCount) + ' 张' },
      { label: '已出账金额', value: money(s.issuedAmountYuan), unit: '元', tone: 'amber', hint: '已出账账单金额合计' },
      { label: '锁定运单', value: num(s.lockedCount), unit: '条', hint: '已进账单，不能直接删改' },
      { label: '未归属城市运单', value: num(s.unzonedCount), unit: '条', tone: (Number(s.unzonedCount) > 0 ? 'warn' : ''), hint: unzonedHint }
    ];
    var grid = cards.map(function (card) {
      return '<div class="metric-card' + (card.tone ? ' tone-' + card.tone : '') + '">' +
        '<div class="metric-label">' + esc(card.label) + '</div>' +
        '<div class="metric-value">' + esc(card.value) + '<span class="unit">' + esc(card.unit) + '</span></div>' +
        (card.hint ? '<div class="metric-hint">' + esc(card.hint) + '</div>' : '') +
        '</div>';
    }).join('');

    var body = '<div class="card-grid">' + grid + '</div>';
    if (Number(s.driftedBillCount) > 0) {
      var adj = Number(s.driftAdjustmentTotalYuan) || 0;
      body += '<div class="panel is-warn overview-alert">' +
        '<h4 class="panel-title">已出账账单存在出账后改动</h4>' +
        '<div class="amount-row"><span>有差额的账单</span><b>' + num(s.driftedBillCount) + ' 张 / ' + num(s.driftedLineCount) + ' 条运单</b></div>' +
        '<div class="amount-row is-total"><span>调整合计（' + (adj >= 0 ? '净少收' : '净多收') + '）</span>' +
        '<b class="is-warn">' + (adj >= 0 ? '+' : '') + money(adj) + ' 元</b></div>' +
        '<p class="panel-note">这些运单在出账后被改过，差额已逐单算好并以单独一笔调整列在对应账单上，原账单金额未改动。点开账单即可看到差在哪一条、当时与现在各是多少。</p>' +
        '<button type="button" class="btn btn-amber" data-action="tab" data-tab="bills">去账单核对</button>' +
        '</div>';
    }
    body += '<div class="hr"></div>' +
      '<p class="foot-note">数据更新时间：' + esc(stampText(s.updatedAt)) + '；金额单位为元，保留两位小数。</p>';
    return paneBlock('概览数字', meta, body);
  }

  function renderOverviewRight() {
    var s = state.summary;
    if (!s) return paneBlock('关注项', '', loadingBlock('正在读取概览数据…'));
    var cities = s.unzonedCities || [];
    var cityHtml = cities.length
      ? '<div class="chips">' + cities.map(function (city) {
        return '<button type="button" class="chip chip-btn is-amber" data-action="goto-unzoned">' + esc(city) + '</button>';
      }).join('') + '</div>'
      : '<p class="block-hint">没有未归属的收件城市。</p>';

    var periods = s.periods || [];
    var periodHtml = periods.length
      ? '<div class="chips">' + periods.map(function (p) { return '<span class="chip">' + esc(p) + '</span>'; }).join('') + '</div>'
      : '<p class="block-hint">还没有可用的账期（账期按运单创建月份归集）。</p>';

    var st = s.settings || {};
    var settingsHtml =
      '<dl class="kv-list">' +
      '<dt>体积系数</dt><dd>' + esc(num(st.volumetricDivisor)) + '</dd>' +
      '<dt>最低收费</dt><dd>' + esc(money(st.minChargeYuan)) + ' 元</dd>' +
      '<dt>超规线</dt><dd>' + esc(num(st.oversizeWeightKg)) + ' kg 或 ' + esc(num(st.oversizePieces)) + ' 件</dd>' +
      '<dt>超规附加</dt><dd>' + esc(money(st.oversizeFeeYuan)) + ' 元</dd>' +
      '<dt>保价费率</dt><dd>' + esc((Number(st.insurancePermille) || 0) / 10) + ' %（千分比 ' + esc(num(st.insurancePermille)) + '）</dd>' +
      '</dl>';

    var body =
      '<div class="block"><h3 class="block-title">未归属城市（' + num(cities.length) + ' 个）</h3>' +
      '<p class="block-hint">这些收件城市没有登记到任何分区，对应的运单算不出运费、也进不了账单。</p>' + cityHtml + '</div>' +
      '<div class="block"><h3 class="block-title">已有账期（' + num(periods.length) + ' 个）</h3>' + periodHtml + '</div>' +
      '<div class="block"><h3 class="block-title">计费参数</h3>' + settingsHtml + '</div>';

    return paneBlock('关注项与参数', '', body);
  }

  /* ================= 运单 ================= */
  function customerOptionsHtml(selectedId, placeholder) {
    var head = '<option value="">' + esc(placeholder || '全部客户') + '</option>';
    return head + state.customers.map(function (c) {
      return '<option value="' + attr(c.id) + '"' + (c.id === selectedId ? ' selected' : '') + '>' +
        esc(c.code + ' ' + c.name + '（' + c.settle + '）') + '</option>';
    }).join('');
  }

  function renderWaybillsLeft() {
    var f = state.filters;
    var statusOptions = '<option value="">全部状态</option>' + STATUSES.map(function (s) {
      return '<option value="' + attr(s) + '"' + (f.status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');

    var body =
      '<div class="block"><h3 class="block-title">筛选</h3>' +
      '<label class="field"><span class="field-label">关键词</span>' +
      '<input type="search" id="wbKeyword" placeholder="运单号 / 城市 / 客户" value="' + attr(f.keyword) + '"></label>' +
      '<label class="field" data-field-wrap="filter-customer"><span class="field-label">客户</span>' +
      '<select id="wbCustomer">' + customerOptionsHtml(f.customerId, '全部客户') + '</select></label>' +
      '<label class="field"><span class="field-label">状态</span>' +
      '<select id="wbStatus">' + statusOptions + '</select></label>' +
      '<label class="check"><input type="checkbox" id="wbUnzoned"' + (f.unzoned ? ' checked' : '') + '>只看未归属城市</label>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-primary" data-action="apply-filters">查询</button>' +
      '<button type="button" class="btn btn-ghost" data-action="reset-filters">重置</button>' +
      '</div>' +
      '<div class="block"><h3 class="block-title">清单统计</h3>' +
      '<div class="stat-list">' +
      '<div class="stat-row"><span class="stat-name">当前清单</span><span class="stat-val">' + num(state.waybills.total) + ' 条</span></div>' +
      '<div class="stat-row"><span class="stat-name">已入账</span><span class="stat-val">' + num(state.waybills.lockedCount) + ' 条</span></div>' +
      '<div class="stat-row"><span class="stat-name">未归属城市</span><span class="stat-val">' + num(state.waybills.unzonedCount) + ' 条</span></div>' +
      '</div></div>' +
      '<button type="button" class="btn btn-amber btn-block" data-action="new-waybill">新增运单</button>' +
      '<button type="button" class="btn btn-ghost btn-block" data-action="refresh-waybills">刷新运单清单</button>' +
      (state.customers.length === 0 ? '<p class="foot-note warn-text">还没有客户，先到「客户」标签新增一个客户，运单必须挂在客户名下。</p>' : '');

    return paneBlock('筛选与统计', 'GET /api/waybills', body);
  }

  function renderWaybillsMid() {
    var list = state.waybills.waybills || [];
    var meta = '共 ' + num(state.waybills.total) + ' 条';
    if (!list.length) {
      return paneBlock('运单清单', meta, emptyBlock('没有符合条件的运单', '调整左侧筛选条件，或点「新增运单」登记一条。'));
    }
    var html = list.map(function (item) {
      var cached = Number(item.quoteCacheYuan);
      var selected = item.id === state.selectedWaybillId;
      return '<article class="card' + (selected ? ' is-selected' : '') + '" data-action="select-waybill" data-id="' + attr(item.id) + '">' +
        '<div class="card-top">' +
        '<span class="card-code">' + esc(item.code) + '</span>' +
        '<span class="badge ' + statusClass(item.status) + '">' + esc(item.status) + '</span>' +
        '</div>' +
        '<div class="card-sub">' + esc(item.customerName) + ' · ' + esc(timeTextOf(item.createdAt)) + '</div>' +
        '<div class="card-route"><span>' + esc(item.fromCity) + '</span><span class="arrow">→</span><span>' + esc(item.toCity) + '</span>' +
        (item.zoneKnown ? '' : '<span class="tag tag-warn">未归属</span>') + '</div>' +
        '<div class="card-metrics">' +
        '<div class="card-metric">实际重量<b>' + esc(item.weightText || kg(item.weightKg)) + '</b></div>' +
        '<div class="card-metric">体积<b>' + esc(item.volumeText || m3(item.volumeM3)) + '</b></div>' +
        '<div class="card-metric">件数<b>' + esc(num(item.pieces)) + ' 件</b></div>' +
        '</div>' +
        '<div class="card-tags">' +
        '<span class="tag">分区 ' + esc(item.zoneName) + '</span>' +
        '<span class="tag' + (item.locked ? ' tag-lock' : '') + '">' + (item.locked ? ('已入账 ' + esc(item.billCode)) : '未入账') + '</span>' +
        (item.billDrift
          ? '<span class="tag tag-warn">账单' + esc(item.billDrift.direction) + ' ' + esc(item.billDrift.diffText) + ' 元</span>'
          : '') +
        '<span class="tag' + (cached > 0 ? ' tag-amber' : '') + '">上次计费 ' + (cached > 0 ? esc(money(cached)) : '未计费') + '</span>' +
        '</div>' +
        '</article>';
    }).join('');
    return paneBlock('运单清单', meta, html);
  }

  function waybillFormHtml(item) {
    var isEdit = Boolean(item);
    var v = item || {};
    var services = Array.isArray(v.services) ? v.services : [];
    var statusOptions = STATUSES.map(function (s) {
      var current = v.status || '待发';
      return '<option value="' + attr(s) + '"' + (current === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
    var serviceBoxes = SERVICE_OPTIONS.map(function (s) {
      return '<label class="check-inline"><input type="checkbox" name="services" value="' + attr(s) + '"' +
        (services.indexOf(s) >= 0 ? ' checked' : '') + '>' + esc(s) + '</label>';
    }).join('');
    var createdAt = v.createdAt ? timeTextOf(v.createdAt) : nowText();

    return '<form id="waybillForm" autocomplete="off" onsubmit="return false;">' +
      '<div class="block"><h3 class="block-title">运单字段</h3>' +
      '<label class="field" data-field-wrap="code"><span class="field-label">运单号（YD + 数字）</span>' +
      '<input type="text" data-field="code" placeholder="YD20260901001" value="' + attr(v.code || '') + '">' +
      '<span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="customerId"><span class="field-label">客户</span>' +
      '<select data-field="customerId">' + customerOptionsHtml(v.customerId, '请选择客户') + '</select>' +
      '<span class="field-msg"></span></label>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="fromCity"><span class="field-label">寄件城市</span>' +
      '<input type="text" data-field="fromCity" value="' + attr(v.fromCity || '') + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="toCity"><span class="field-label">收件城市</span>' +
      '<input type="text" data-field="toCity" value="' + attr(v.toCity || '') + '"><span class="field-msg"></span></label>' +
      '</div>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="weightKg"><span class="field-label">实际重量（kg）</span>' +
      '<input type="number" step="0.01" min="0" data-field="weightKg" value="' + attr(v.weightKg === undefined || v.weightKg === null ? '' : v.weightKg) + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="volumeM3"><span class="field-label">体积（m³）</span>' +
      '<input type="number" step="0.001" min="0" data-field="volumeM3" value="' + attr(v.volumeM3 === undefined || v.volumeM3 === null ? '' : v.volumeM3) + '"><span class="field-msg"></span></label>' +
      '</div>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="pieces"><span class="field-label">件数（1-99）</span>' +
      '<input type="number" step="1" min="1" max="99" data-field="pieces" value="' + attr(v.pieces === undefined || v.pieces === null ? 1 : v.pieces) + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="insuredAmountYuan"><span class="field-label">保价金额（元）</span>' +
      '<input type="number" step="0.01" min="0" data-field="insuredAmountYuan" value="' + attr(v.insuredAmountYuan === undefined || v.insuredAmountYuan === null ? 0 : v.insuredAmountYuan) + '"><span class="field-msg"></span></label>' +
      '</div>' +
      '<label class="field" data-field-wrap="status"><span class="field-label">状态</span>' +
      '<select data-field="status">' + statusOptions + '</select><span class="field-msg"></span></label>' +
      '<div class="field" data-field-wrap="services"><span class="field-label">附加服务</span>' +
      '<div class="check-inline-row">' + serviceBoxes + '</div><span class="field-msg"></span></div>' +
      '<label class="field" data-field-wrap="createdAt"><span class="field-label">创建时刻（决定账期）</span>' +
      '<input type="text" data-field="createdAt" placeholder="2026-09-01 10:30" value="' + attr(createdAt) + '">' +
      '<span class="field-msg"></span></label>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-primary" data-action="save-waybill">' + (isEdit ? '保存修改' : '创建运单') + '</button>' +
      '<button type="button" class="btn btn-ghost" data-action="cancel-waybill-form">取消</button>' +
      '</div>' +
      '<p class="foot-note">选了「保价」就要填大于 0 的保价金额；账期按创建时刻所在月份归集。</p>' +
      '</form>';
  }

  function renderWaybillsRight() {
    if (state.waybillMode === 'create' || state.waybillMode === 'edit') {
      var editing = null;
      if (state.waybillMode === 'edit') {
        editing = (state.waybills.waybills || []).filter(function (w) { return w.id === state.selectedWaybillId; })[0];
        if (!editing) { state.waybillMode = 'view'; }
      }
      if (state.waybillMode !== 'view') {
        return paneBlock(state.waybillMode === 'edit' ? '编辑运单' : '新增运单', state.waybillMode === 'edit' ? 'PATCH /api/waybills/:id' : 'POST /api/waybills',
          waybillFormHtml(editing));
      }
    }

    var item = (state.waybills.waybills || []).filter(function (w) { return w.id === state.selectedWaybillId; })[0];
    if (!item) {
      return paneBlock('运单详情', '', emptyBlock('还没有选中运单', '在中间清单里点一张卡片查看详情，或点「新增运单」登记一条。'));
    }

    var cached = Number(item.quoteCacheYuan);
    var quote = (state.quote && state.quote.waybillId === item.id) ? state.quote : null;
    var quoteHtml = '';
    if (quote) {
      quoteHtml = '<div class="panel is-amber">' +
        '<h4 class="panel-title">本次计费结果（' + esc(quote.zoneName || '—') + '）</h4>' +
        '<div class="amount-row"><span>计费重量</span><b>' + esc(kg(quote.billableKg)) + '</b></div>' +
        '<div class="amount-row"><span>运费</span><b>' + esc(money(quote.freightYuan)) + ' 元</b></div>' +
        '<div class="amount-row"><span>附加费</span><b>' + esc(money(quote.surchargeYuan)) + ' 元</b></div>' +
        '<div class="amount-row"><span>折扣</span><b>' + esc(discountTextOf(quote.discountPermille)) + '</b></div>' +
        '<div class="amount-row is-total"><span>合计</span><b>' + esc(money(quote.totalYuan)) + ' 元</b></div>' +
        '</div>';
    }

    var detail =
      '<div class="detail-head">' +
      '<span class="detail-title">' + esc(item.code) + '</span>' +
      '<span class="badge ' + statusClass(item.status) + '">' + esc(item.status) + '</span>' +
      '</div>' +
      '<dl class="kv-list">' +
      '<dt>客户</dt><dd>' + esc(item.customerName) + '（' + esc(item.customerCode || '-') + '）</dd>' +
      '<dt>结算方式</dt><dd>' + esc(item.settle || '-') + '</dd>' +
      '<dt>寄件城市</dt><dd>' + esc(item.fromCity) + '</dd>' +
      '<dt>收件城市</dt><dd>' + esc(item.toCity) + '</dd>' +
      '<dt>实际重量</dt><dd>' + esc(item.weightText || kg(item.weightKg)) + '</dd>' +
      '<dt>体积</dt><dd>' + esc(item.volumeText || m3(item.volumeM3)) + '</dd>' +
      '<dt>件数</dt><dd>' + esc(num(item.pieces)) + ' 件</dd>' +
      '<dt>保价金额</dt><dd>' + esc(money(item.insuredAmountYuan)) + ' 元</dd>' +
      '<dt>附加服务</dt><dd>' + esc((item.services && item.services.length) ? item.services.join('、') : '无') + '</dd>' +
      '<dt>创建时刻</dt><dd>' + esc(timeTextOf(item.createdAt)) + '</dd>' +
      '<dt>分区</dt><dd class="' + (item.zoneKnown ? '' : 'is-warn') + '">' + esc(item.zoneName) + (item.zoneKnown ? '' : '（该城市未登记分区，不能计费）') + '</dd>' +
      '<dt>入账情况</dt><dd class="' + (item.locked ? 'is-amber' : '') + '">' + (item.locked ? ('已入账：' + esc(item.billCode) + '（' + esc(item.billStatus) + '）') : '未入账') + '</dd>' +
      '<dt>上次计费</dt><dd class="' + (cached > 0 ? 'is-amber' : '') + '">' + (cached > 0 ? (esc(money(cached)) + ' 元（' + esc(timeTextOf(item.quoteCachedAt)) + '）') : '未计费') + '</dd>' +
      '</dl>' +
      (item.billDrift
        ? '<div class="panel is-warn"><h4 class="panel-title">账单差额提示</h4>' +
        '<div class="amount-row"><span>所属账单</span><b>' + esc(item.billDrift.billCode) + '</b></div>' +
        '<div class="amount-row is-total"><span>出账后改动产生的差额（' + esc(item.billDrift.direction) + '）</span>' +
        '<b class="is-warn">' + esc(item.billDrift.diffText) + ' 元</b></div>' +
        '<p class="panel-note">这条运单在出账后被动过，差额已在账单上以单独一笔调整体现，原账单金额不变。到「账单」标签打开该账单可看逐单核对。</p>' +
        '<button type="button" class="btn btn-amber" data-action="goto-bill-drift" data-id="' + attr(item.billDrift.billId) + '">打开对应账单</button>' +
        '</div>'
        : '') +
      quoteHtml +
      '<div class="btn-stack">' +
      '<button type="button" class="btn btn-primary" data-action="quote-waybill" data-id="' + attr(item.id) + '">单条计费</button>' +
      '<button type="button" class="btn" data-action="edit-waybill" data-id="' + attr(item.id) + '">编辑这条运单</button>' +
      (item.locked
        ? '<button type="button" class="btn" disabled>已进账单，不能删除</button>'
        : '<button type="button" class="btn btn-danger' + (state.confirm && state.confirm.kind === 'waybill' && state.confirm.id === item.id ? ' is-armed' : '') + '" data-action="delete-waybill" data-id="' + attr(item.id) + '">' +
        (state.confirm && state.confirm.kind === 'waybill' && state.confirm.id === item.id ? '确认删除（再点一次）' : '删除这条运单') + '</button>') +
      '</div>' +
      (item.locked ? '<p class="foot-note">这条运单已经进账单，先作废对应账单才能删除。</p>' : '');

    return paneBlock('运单详情', item.id, detail);
  }

  function readWaybillForm() {
    var form = document.getElementById('waybillForm');
    if (!form) return null;
    function val(name) {
      var el = form.querySelector('[data-field="' + name + '"]');
      return el ? String(el.value).trim() : '';
    }
    var services = Array.prototype.slice.call(form.querySelectorAll('input[name="services"]:checked'))
      .map(function (el) { return el.value; });
    return {
      code: val('code'),
      customerId: val('customerId'),
      fromCity: val('fromCity'),
      toCity: val('toCity'),
      status: val('status'),
      weightKg: Number(val('weightKg')),
      volumeM3: Number(val('volumeM3')),
      pieces: Number(val('pieces')),
      insuredAmountYuan: Number(val('insuredAmountYuan')),
      services: services,
      createdAt: val('createdAt')
    };
  }

  function selectWaybill(id) {
    if (state.selectedWaybillId !== id) state.quote = null;
    state.selectedWaybillId = id;
    state.waybillMode = 'view';
    state.confirm = null;
    renderMid();
    renderRight();
    setStatus('已选中运单 ' + id);
  }

  async function saveWaybill() {
    var payload = readWaybillForm();
    if (!payload) return;
    var editingId = state.waybillMode === 'edit' ? state.selectedWaybillId : '';
    try {
      var saved = editingId
        ? await api('PATCH', '/api/waybills/' + encodeURIComponent(editingId), payload)
        : await api('POST', '/api/waybills', payload);
      state.selectedWaybillId = saved.id;
      state.waybillMode = 'view';
      state.quote = null;
      state.confirm = null;
      await refreshAll();
      render();
      ok((editingId ? '已保存运单修改：' : '已新增运单：') + saved.code + '（' + saved.customerName + ' · ' + saved.zoneName + '）');
      if (editingId && saved.warning) {
        els.notice.hidden = false;
        els.notice.className = 'notice is-warn';
        els.noticeText.textContent = saved.warning.message;
        setStatus('运单改动产生账单差额：' + saved.billDrift.diffText + ' 元（' + saved.billDrift.direction + '）', 'error');
      }
    } catch (err) {
      fail(err);
    }
  }

  async function deleteWaybill(id) {
    try {
      await api('DELETE', '/api/waybills/' + encodeURIComponent(id));
      if (state.selectedWaybillId === id) { state.selectedWaybillId = ''; state.quote = null; }
      state.confirm = null;
      await refreshAll();
      render();
      ok('已删除运单 ' + id + '，清单已刷新');
    } catch (err) {
      fail(err);
    }
  }

  async function quoteWaybill(id) {
    try {
      var result = await api('POST', '/api/waybills/' + encodeURIComponent(id) + '/quote');
      state.quote = result;
      state.waybillMode = 'view';
      await refreshAll();
      render();
      ok('运单 ' + result.waybill.code + ' 计费完成：计费重量 ' + money(result.billableKg) + ' kg，合计 ' + money(result.totalYuan) + ' 元');
    } catch (err) {
      fail(err);
    }
  }

  /* ================= 分区 ================= */
  function filteredZones() {
    var f = state.zoneFilter;
    var needle = f.keyword.trim().toLowerCase();
    return state.zones.filter(function (zone) {
      if (f.status && zone.status !== f.status) return false;
      if (!needle) return true;
      var hay = [zone.code, zone.name, zone.citiesText, zone.aliasesText].join(' ').toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
  }

  function renderZonesLeft() {
    var enabled = state.zones.filter(function (z) { return z.status === '启用'; }).length;
    var body =
      '<div class="block"><h3 class="block-title">筛选</h3>' +
      '<label class="field"><span class="field-label">关键词</span>' +
      '<input type="search" id="zoneKeyword" placeholder="编码 / 名称 / 城市" value="' + attr(state.zoneFilter.keyword) + '"></label>' +
      '<label class="field"><span class="field-label">状态</span>' +
      '<select id="zoneStatus">' +
      '<option value="">全部状态</option>' +
      '<option value="启用"' + (state.zoneFilter.status === '启用' ? ' selected' : '') + '>启用</option>' +
      '<option value="停用"' + (state.zoneFilter.status === '停用' ? ' selected' : '') + '>停用</option>' +
      '</select></label>' +
      '</div>' +
      '<div class="block"><h3 class="block-title">分区统计</h3>' +
      '<div class="stat-list">' +
      '<div class="stat-row"><span class="stat-name">分区总数</span><span class="stat-val">' + num(state.zones.length) + ' 个</span></div>' +
      '<div class="stat-row"><span class="stat-name">启用</span><span class="stat-val">' + num(enabled) + ' 个</span></div>' +
      '<div class="stat-row"><span class="stat-name">停用</span><span class="stat-val">' + num(state.zones.length - enabled) + ' 个</span></div>' +
      '<div class="stat-row"><span class="stat-name">当前筛选结果</span><span class="stat-val">' + num(filteredZones().length) + ' 个</span></div>' +
      '</div></div>' +
      '<button type="button" class="btn btn-amber btn-block" data-action="new-zone">新增分区</button>' +
      '<button type="button" class="btn btn-ghost btn-block" data-action="refresh-zones">刷新分区清单</button>' +
      '<p class="foot-note">分区按编码（Z 加数字）唯一；城市与别名决定运单收件城市能不能归属到这个分区。</p>';
    return paneBlock('分区筛选', 'GET /api/zones', body);
  }

  function renderZonesMid() {
    var list = filteredZones();
    var meta = '共 ' + num(state.zones.length) + ' 个，显示 ' + num(list.length) + ' 个';
    if (!list.length) {
      return paneBlock('分区清单', meta, emptyBlock('没有符合条件的分区', '换个关键词，或点「新增分区」建一个。'));
    }
    var html = list.map(function (zone) {
      var selected = zone.id === state.selectedZoneId;
      return '<article class="card' + (selected ? ' is-selected' : '') + '" data-action="select-zone" data-id="' + attr(zone.id) + '">' +
        '<div class="card-top">' +
        '<span class="card-code">' + esc(zone.code) + ' · ' + esc(zone.name) + '</span>' +
        '<span class="badge ' + (zone.status === '启用' ? 'st-transit' : 'badge-plain') + '">' + esc(zone.status) + '</span>' +
        '</div>' +
        '<div class="card-sub">城市：' + esc(zone.citiesText || '（没登记城市）') + '</div>' +
        (zone.aliasesText ? '<div class="card-sub">别名：' + esc(zone.aliasesText) + '</div>' : '') +
        '<div class="card-metrics">' +
        '<div class="card-metric">首重<b>' + esc(money(zone.firstWeightKg)) + ' kg / ' + esc(money(zone.firstPriceYuan)) + ' 元</b></div>' +
        '<div class="card-metric">续重<b>' + esc(money(zone.addUnitKg)) + ' kg / ' + esc(money(zone.addPriceYuan)) + ' 元</b></div>' +
        '<div class="card-metric">偏远附加<b>' + esc(money(zone.remoteFeeYuan)) + ' 元</b></div>' +
        '</div>' +
        '</article>';
    }).join('');
    return paneBlock('分区清单', meta, '<div class="card-grid">' + html + '</div>');
  }

  function zoneFormHtml(zone) {
    var isEdit = Boolean(zone);
    var z = zone || {};
    var aliasLines = '';
    if (z.aliases && typeof z.aliases === 'object') {
      aliasLines = Object.keys(z.aliases).map(function (key) { return key + '=' + z.aliases[key]; }).join('\n');
    }
    return '<form id="zoneForm" autocomplete="off" onsubmit="return false;">' +
      '<div class="block"><h3 class="block-title">分区字段</h3>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="code"><span class="field-label">分区编码（Z + 数字）</span>' +
      '<input type="text" data-field="code" placeholder="Z5" value="' + attr(z.code || '') + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="status"><span class="field-label">状态</span>' +
      '<select data-field="status">' +
      '<option value="启用"' + ((z.status || '启用') === '启用' ? ' selected' : '') + '>启用</option>' +
      '<option value="停用"' + (z.status === '停用' ? ' selected' : '') + '>停用</option>' +
      '</select><span class="field-msg"></span></label>' +
      '</div>' +
      '<label class="field" data-field-wrap="name"><span class="field-label">分区名称</span>' +
      '<input type="text" data-field="name" value="' + attr(z.name || '') + '"><span class="field-msg"></span></label>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="firstWeightKg"><span class="field-label">首重（kg）</span>' +
      '<input type="number" step="0.01" min="0" data-field="firstWeightKg" value="' + attr(z.firstWeightKg === undefined ? '' : z.firstWeightKg) + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="firstPriceYuan"><span class="field-label">首重价（元）</span>' +
      '<input type="number" step="0.01" min="0" data-field="firstPriceYuan" value="' + attr(z.firstPriceYuan === undefined ? '' : z.firstPriceYuan) + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="addUnitKg"><span class="field-label">续重单位（kg）</span>' +
      '<input type="number" step="0.01" min="0" data-field="addUnitKg" value="' + attr(z.addUnitKg === undefined ? '' : z.addUnitKg) + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="addPriceYuan"><span class="field-label">续重价（元）</span>' +
      '<input type="number" step="0.01" min="0" data-field="addPriceYuan" value="' + attr(z.addPriceYuan === undefined ? '' : z.addPriceYuan) + '"><span class="field-msg"></span></label>' +
      '</div>' +
      '<label class="field" data-field-wrap="remoteFeeYuan"><span class="field-label">偏远附加（元）</span>' +
      '<input type="number" step="0.01" min="0" data-field="remoteFeeYuan" value="' + attr(z.remoteFeeYuan === undefined ? 0 : z.remoteFeeYuan) + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="cities"><span class="field-label">覆盖城市（逗号分隔）</span>' +
      '<textarea data-field="cities" placeholder="杭州，宁波，温州">' + esc(z.citiesText || (z.cities || []).join('，')) + '</textarea>' +
      '<span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="aliases"><span class="field-label">城市别名（每行一条，别名=城市）</span>' +
      '<textarea data-field="aliases" placeholder="杭城=杭州">' + esc(aliasLines) + '</textarea>' +
      '<span class="field-msg"></span></label>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-primary" data-action="save-zone">' + (isEdit ? '保存修改' : '创建分区') + '</button>' +
      '<button type="button" class="btn btn-ghost" data-action="cancel-zone-form">取消</button>' +
      '</div>' +
      '<p class="foot-note">别名要写明对应哪个城市，例如「杭城=杭州」；别名优先级高于直接登记的城市。</p>' +
      '</form>';
  }

  function renderZonesRight() {
    if (state.zoneMode === 'create' || state.zoneMode === 'edit') {
      var editing = null;
      if (state.zoneMode === 'edit') {
        editing = state.zones.filter(function (z) { return z.id === state.selectedZoneId; })[0];
        if (!editing) state.zoneMode = 'view';
      }
      if (state.zoneMode !== 'view') {
        return paneBlock(state.zoneMode === 'edit' ? '编辑分区' : '新增分区', state.zoneMode === 'edit' ? 'PATCH /api/zones/:id' : 'POST /api/zones', zoneFormHtml(editing));
      }
    }

    var zone = state.zones.filter(function (z) { return z.id === state.selectedZoneId; })[0];
    if (!zone) {
      return paneBlock('分区详情', '', emptyBlock('还没有选中分区', '在中间网格里点一张分区卡片查看详情，或点「新增分区」。'));
    }
    var aliasRows = Object.keys(zone.aliases || {}).map(function (key) {
      return '<span class="chip">' + esc(key) + ' → ' + esc(zone.aliases[key]) + '</span>';
    }).join('') || '<span class="muted">没有别名</span>';
    var cityChips = (zone.cities || []).map(function (city) { return '<span class="chip">' + esc(city) + '</span>'; }).join('') || '<span class="muted">没有登记城市</span>';

    var detail =
      '<div class="detail-head">' +
      '<span class="detail-title">' + esc(zone.code) + ' · ' + esc(zone.name) + '</span>' +
      '<span class="badge ' + (zone.status === '启用' ? 'st-transit' : 'badge-plain') + '">' + esc(zone.status) + '</span>' +
      '</div>' +
      '<dl class="kv-list">' +
      '<dt>首重</dt><dd>' + esc(money(zone.firstWeightKg)) + ' kg / ' + esc(money(zone.firstPriceYuan)) + ' 元</dd>' +
      '<dt>续重</dt><dd>' + esc(money(zone.addUnitKg)) + ' kg / ' + esc(money(zone.addPriceYuan)) + ' 元</dd>' +
      '<dt>偏远附加</dt><dd>' + esc(money(zone.remoteFeeYuan)) + ' 元</dd>' +
      '<dt>名下城市</dt><dd>' + esc(num((zone.cities || []).length)) + ' 个</dd>' +
      '</dl>' +
      '<div class="block" style="margin-top:12px;"><h3 class="block-title">覆盖城市</h3><div class="chips">' + cityChips + '</div></div>' +
      '<div class="block"><h3 class="block-title">城市别名</h3><div class="chips">' + aliasRows + '</div></div>' +
      '<div class="btn-stack">' +
      '<button type="button" class="btn" data-action="edit-zone" data-id="' + attr(zone.id) + '">编辑这个分区</button>' +
      '<button type="button" class="btn btn-danger' + (state.confirm && state.confirm.kind === 'zone' && state.confirm.id === zone.id ? ' is-armed' : '') + '" data-action="delete-zone" data-id="' + attr(zone.id) + '">' +
      (state.confirm && state.confirm.kind === 'zone' && state.confirm.id === zone.id ? '确认删除（再点一次）' : '删除这个分区') + '</button>' +
      '</div>' +
      '<p class="foot-note">分区下还有运单在用的时候删除会被拒绝，后端会返回运单条数。</p>';

    return paneBlock('分区详情', zone.id, detail);
  }

  function readZoneForm() {
    var form = document.getElementById('zoneForm');
    if (!form) return null;
    function val(name) {
      var el = form.querySelector('[data-field="' + name + '"]');
      return el ? String(el.value).trim() : '';
    }
    var cities = val('cities').split(/[,，、;；\s]+/).map(function (item) { return item.trim(); }).filter(Boolean);
    var aliases = {};
    val('aliases').split(/\r?\n/).forEach(function (line) {
      var text = line.trim();
      if (!text) return;
      var parts = text.split(/[=＝:：\t]+/);
      var alias = String(parts[0] || '').trim();
      var target = String(parts.slice(1).join('=') || '').trim();
      if (alias) aliases[alias] = target;
    });
    return {
      code: val('code'),
      name: val('name'),
      status: val('status'),
      firstWeightKg: Number(val('firstWeightKg')),
      firstPriceYuan: Number(val('firstPriceYuan')),
      addUnitKg: Number(val('addUnitKg')),
      addPriceYuan: Number(val('addPriceYuan')),
      remoteFeeYuan: Number(val('remoteFeeYuan')),
      cities: cities,
      aliases: aliases
    };
  }

  async function saveZone() {
    var payload = readZoneForm();
    if (!payload) return;
    var editingId = state.zoneMode === 'edit' ? state.selectedZoneId : '';
    try {
      var saved = editingId
        ? await api('PATCH', '/api/zones/' + encodeURIComponent(editingId), payload)
        : await api('POST', '/api/zones', payload);
      state.selectedZoneId = saved.id;
      state.zoneMode = 'view';
      state.confirm = null;
      await refreshAll();
      render();
      ok((editingId ? '已保存分区修改：' : '已新增分区：') + saved.code + ' ' + saved.name);
    } catch (err) {
      fail(err);
    }
  }

  async function deleteZone(id) {
    try {
      await api('DELETE', '/api/zones/' + encodeURIComponent(id));
      if (state.selectedZoneId === id) state.selectedZoneId = '';
      state.confirm = null;
      await refreshAll();
      render();
      ok('已删除分区 ' + id + '，清单已刷新');
    } catch (err) {
      fail(err);
    }
  }

  /* ================= 客户 ================= */
  function filteredCustomers() {
    var f = state.customerFilter;
    var needle = f.keyword.trim().toLowerCase();
    return state.customers.filter(function (customer) {
      if (f.settle && customer.settle !== f.settle) return false;
      if (f.status && customer.status !== f.status) return false;
      if (!needle) return true;
      var hay = [customer.code, customer.name, customer.settle].join(' ').toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
  }

  function renderCustomersLeft() {
    var monthly = state.customers.filter(function (c) { return c.settle === '月结'; }).length;
    var body =
      '<div class="block"><h3 class="block-title">筛选</h3>' +
      '<label class="field"><span class="field-label">关键词</span>' +
      '<input type="search" id="customerKeyword" placeholder="编码 / 名称" value="' + attr(state.customerFilter.keyword) + '"></label>' +
      '<label class="field"><span class="field-label">结算方式</span>' +
      '<select id="customerSettle">' +
      '<option value="">全部</option>' +
      '<option value="月结"' + (state.customerFilter.settle === '月结' ? ' selected' : '') + '>月结</option>' +
      '<option value="现结"' + (state.customerFilter.settle === '现结' ? ' selected' : '') + '>现结</option>' +
      '</select></label>' +
      '<label class="field"><span class="field-label">状态</span>' +
      '<select id="customerStatus">' +
      '<option value="">全部状态</option>' +
      '<option value="启用"' + (state.customerFilter.status === '启用' ? ' selected' : '') + '>启用</option>' +
      '<option value="停用"' + (state.customerFilter.status === '停用' ? ' selected' : '') + '>停用</option>' +
      '</select></label>' +
      '</div>' +
      '<div class="block"><h3 class="block-title">客户统计</h3>' +
      '<div class="stat-list">' +
      '<div class="stat-row"><span class="stat-name">客户总数</span><span class="stat-val">' + num(state.customers.length) + ' 个</span></div>' +
      '<div class="stat-row"><span class="stat-name">月结客户</span><span class="stat-val">' + num(monthly) + ' 个</span></div>' +
      '<div class="stat-row"><span class="stat-name">现结客户</span><span class="stat-val">' + num(state.customers.length - monthly) + ' 个</span></div>' +
      '<div class="stat-row"><span class="stat-name">当前筛选结果</span><span class="stat-val">' + num(filteredCustomers().length) + ' 个</span></div>' +
      '</div></div>' +
      '<button type="button" class="btn btn-amber btn-block" data-action="new-customer">新增客户</button>' +
      '<button type="button" class="btn btn-ghost btn-block" data-action="refresh-customers">刷新客户清单</button>' +
      '<p class="foot-note">折扣用千分比表示（900 等于 9 折），现结客户必须填 1000。</p>';
    return paneBlock('客户筛选', 'GET /api/customers', body);
  }

  function renderCustomersMid() {
    var list = filteredCustomers();
    var meta = '共 ' + num(state.customers.length) + ' 个，显示 ' + num(list.length) + ' 个';
    if (!list.length) {
      return paneBlock('客户清单', meta, emptyBlock('没有符合条件的客户', '换个关键词，或点「新增客户」建一个。'));
    }
    var html = list.map(function (c) {
      var selected = c.id === state.selectedCustomerId;
      return '<div class="row' + (selected ? ' is-selected' : '') + '" data-action="select-customer" data-id="' + attr(c.id) + '">' +
        '<div class="row-main">' +
        '<div class="row-title"><span class="code">' + esc(c.code) + '</span><span>' + esc(c.name) + '</span>' +
        '<span class="badge ' + (c.settle === '月结' ? 'st-transit' : 'badge-plain') + '">' + esc(c.settle) + '</span>' +
        (c.status === '停用' ? '<span class="badge st-return">停用</span>' : '') +
        '</div>' +
        '<div class="row-sub">折扣 ' + esc(discountTextOf(c.discountPermille)) + '（千分比 ' + esc(num(c.discountPermille)) + '）· 账期日 ' + esc(num(c.periodDay)) + ' 号</div>' +
        '</div>' +
        '<div class="row-side"><b>' + esc(num(c.waybillCount)) + '</b>名下运单</div>' +
        '</div>';
    }).join('');
    return paneBlock('客户清单', meta, html);
  }

  function customerFormHtml(customer) {
    var isEdit = Boolean(customer);
    var c = customer || {};
    var settle = c.settle || '月结';
    var permille = c.discountPermille === undefined || c.discountPermille === null ? (settle === '现结' ? 1000 : 1000) : c.discountPermille;
    return '<form id="customerForm" autocomplete="off" onsubmit="return false;">' +
      '<div class="block"><h3 class="block-title">客户字段</h3>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="code"><span class="field-label">客户编码（C + 数字）</span>' +
      '<input type="text" data-field="code" placeholder="C05" value="' + attr(c.code || '') + '"><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="status"><span class="field-label">状态</span>' +
      '<select data-field="status">' +
      '<option value="启用"' + ((c.status || '启用') === '启用' ? ' selected' : '') + '>启用</option>' +
      '<option value="停用"' + (c.status === '停用' ? ' selected' : '') + '>停用</option>' +
      '</select><span class="field-msg"></span></label>' +
      '</div>' +
      '<label class="field" data-field-wrap="name"><span class="field-label">客户名称</span>' +
      '<input type="text" data-field="name" value="' + attr(c.name || '') + '"><span class="field-msg"></span></label>' +
      '<div class="field-grid">' +
      '<label class="field" data-field-wrap="settle"><span class="field-label">结算方式</span>' +
      '<select data-field="settle">' +
      '<option value="月结"' + (settle === '月结' ? ' selected' : '') + '>月结</option>' +
      '<option value="现结"' + (settle === '现结' ? ' selected' : '') + '>现结</option>' +
      '</select><span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="periodDay"><span class="field-label">账期日（1-28）</span>' +
      '<input type="number" step="1" min="1" max="28" data-field="periodDay" value="' + attr(c.periodDay === undefined ? 1 : c.periodDay) + '"><span class="field-msg"></span></label>' +
      '</div>' +
      '<label class="field" data-field-wrap="discountPermille"><span class="field-label">折扣（千分比 100-1000）</span>' +
      '<input type="number" step="1" min="100" max="1000" data-field="discountPermille" id="custDiscount" value="' + attr(permille) + '">' +
      '<span class="field-msg"></span></label>' +
      '<p class="foot-note" id="discountPreview">当前折扣：' + esc(discountTextOf(permille)) + '</p>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-primary" data-action="save-customer">' + (isEdit ? '保存修改' : '创建客户') + '</button>' +
      '<button type="button" class="btn btn-ghost" data-action="cancel-customer-form">取消</button>' +
      '</div>' +
      '<p class="foot-note">折扣只对月结客户生效，作用于运费与附加费的合计。</p>' +
      '</form>';
  }

  function renderCustomersRight() {
    if (state.customerMode === 'create' || state.customerMode === 'edit') {
      var editing = null;
      if (state.customerMode === 'edit') {
        editing = state.customers.filter(function (c) { return c.id === state.selectedCustomerId; })[0];
        if (!editing) state.customerMode = 'view';
      }
      if (state.customerMode !== 'view') {
        return paneBlock(state.customerMode === 'edit' ? '编辑客户' : '新增客户',
          state.customerMode === 'edit' ? 'PATCH /api/customers/:id' : 'POST /api/customers',
          customerFormHtml(editing));
      }
    }

    var customer = state.customers.filter(function (c) { return c.id === state.selectedCustomerId; })[0];
    if (!customer) {
      return paneBlock('客户详情', '', emptyBlock('还没有选中客户', '在中间清单里点一行查看详情，或点「新增客户」。'));
    }
    var detail =
      '<div class="detail-head">' +
      '<span class="detail-title">' + esc(customer.code) + ' · ' + esc(customer.name) + '</span>' +
      '<span class="badge ' + (customer.settle === '月结' ? 'st-transit' : 'badge-plain') + '">' + esc(customer.settle) + '</span>' +
      '</div>' +
      '<dl class="kv-list">' +
      '<dt>编码</dt><dd>' + esc(customer.code) + '</dd>' +
      '<dt>名称</dt><dd>' + esc(customer.name) + '</dd>' +
      '<dt>结算方式</dt><dd>' + esc(customer.settle) + '</dd>' +
      '<dt>折扣</dt><dd class="' + (Number(customer.discountPermille) < 1000 ? 'is-amber' : '') + '">' + esc(discountTextOf(customer.discountPermille)) + '（千分比 ' + esc(num(customer.discountPermille)) + '）</dd>' +
      '<dt>账期日</dt><dd>每月 ' + esc(num(customer.periodDay)) + ' 号</dd>' +
      '<dt>状态</dt><dd>' + esc(customer.status) + '</dd>' +
      '<dt>名下运单</dt><dd>' + esc(num(customer.waybillCount)) + ' 条</dd>' +
      '</dl>' +
      '<div class="btn-stack" style="margin-top:12px;">' +
      '<button type="button" class="btn" data-action="edit-customer" data-id="' + attr(customer.id) + '">编辑这个客户</button>' +
      '<button type="button" class="btn btn-ghost" data-action="filter-waybills-customer" data-id="' + attr(customer.id) + '">在运单里按这个客户筛选</button>' +
      '<button type="button" class="btn btn-danger' + (state.confirm && state.confirm.kind === 'customer' && state.confirm.id === customer.id ? ' is-armed' : '') + '" data-action="delete-customer" data-id="' + attr(customer.id) + '">' +
      (state.confirm && state.confirm.kind === 'customer' && state.confirm.id === customer.id ? '确认删除（再点一次）' : '删除这个客户') + '</button>' +
      '</div>' +
      '<p class="foot-note">名下还有运单的客户不能删除，后端会返回条数。</p>';
    return paneBlock('客户详情', customer.id, detail);
  }

  function readCustomerForm() {
    var form = document.getElementById('customerForm');
    if (!form) return null;
    function val(name) {
      var el = form.querySelector('[data-field="' + name + '"]');
      return el ? String(el.value).trim() : '';
    }
    return {
      code: val('code'),
      name: val('name'),
      settle: val('settle'),
      discountPermille: Number(val('discountPermille')),
      periodDay: Number(val('periodDay')),
      status: val('status')
    };
  }

  async function saveCustomer() {
    var payload = readCustomerForm();
    if (!payload) return;
    var editingId = state.customerMode === 'edit' ? state.selectedCustomerId : '';
    try {
      var saved = editingId
        ? await api('PATCH', '/api/customers/' + encodeURIComponent(editingId), payload)
        : await api('POST', '/api/customers', payload);
      state.selectedCustomerId = saved.id;
      state.customerMode = 'view';
      state.confirm = null;
      await refreshAll();
      render();
      ok((editingId ? '已保存客户修改：' : '已新增客户：') + saved.code + ' ' + saved.name);
    } catch (err) {
      fail(err);
    }
  }

  async function deleteCustomer(id) {
    try {
      await api('DELETE', '/api/customers/' + encodeURIComponent(id));
      if (state.selectedCustomerId === id) state.selectedCustomerId = '';
      state.confirm = null;
      await refreshAll();
      render();
      ok('已删除客户 ' + id + '，清单已刷新');
    } catch (err) {
      fail(err);
    }
  }

  /* ================= 账单 ================= */
  function defaultPeriod() {
    var periods = state.periods || [];
    if (periods.length) return periods[periods.length - 1];
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function renderBillsLeft() {
    var bills = state.bills.bills || [];
    var issuedAmount = bills.reduce(function (sum, bill) {
      return bill.status === '已出账' ? sum + Number(bill.amountYuan || 0) : sum;
    }, 0);
    var periodOptions = (state.periods || []).map(function (p) {
      return '<option value="' + attr(p) + '"></option>';
    }).join('');
    var body =
      '<div class="block"><h3 class="block-title">出账</h3>' +
      '<label class="field" data-field-wrap="period"><span class="field-label">账期（形如 2026-09）</span>' +
      '<input type="text" id="billPeriod" list="periodList" placeholder="2026-09" value="' + attr(defaultPeriod()) + '">' +
      '<datalist id="periodList">' + periodOptions + '</datalist>' +
      '<span class="field-msg"></span></label>' +
      '<label class="field" data-field-wrap="customerId"><span class="field-label">客户</span>' +
      '<select id="billCustomerId">' + customerOptionsHtml('', '请选择客户') + '</select>' +
      '<span class="field-msg"></span></label>' +
      '<button type="button" class="btn btn-primary btn-block" data-action="generate-bill">按账期与客户出账</button>' +
      '<p class="foot-note">可选账期来自现有运单与账单（GET /api/periods）。同一账期同一客户可以重复出账，编号会自动顺延。</p>' +
      '</div>' +
      '<div class="block"><h3 class="block-title">账单统计</h3>' +
      '<div class="stat-list">' +
      '<div class="stat-row"><span class="stat-name">账单总数</span><span class="stat-val">' + num(state.bills.total) + ' 张</span></div>' +
      '<div class="stat-row"><span class="stat-name">已出账</span><span class="stat-val">' + num(state.bills.issued) + ' 张</span></div>' +
      '<div class="stat-row"><span class="stat-name">已作废</span><span class="stat-val">' + num(state.bills.voided) + ' 张</span></div>' +
      '<div class="stat-row"><span class="stat-name">已出账金额</span><span class="stat-val">' + money(issuedAmount) + ' 元</span></div>' +
      '<div class="stat-row"><span class="stat-name' + (Number(state.bills.driftedCount) > 0 ? ' is-warn-name' : '') + '">出账后有改动</span><span class="stat-val' + (Number(state.bills.driftedCount) > 0 ? ' is-warn' : '') + '">' + num(state.bills.driftedCount) + ' 张</span></div>' +
      '<div class="stat-row"><span class="stat-name">调整合计（净少收）</span><span class="stat-val' + (Number(state.bills.adjustmentTotalYuan) !== 0 ? ' is-warn' : '') + '">' + money(state.bills.adjustmentTotalYuan) + ' 元</span></div>' +
      '</div></div>' +
      '<button type="button" class="btn btn-ghost btn-block" data-action="refresh-bills">刷新账单清单</button>';
    return paneBlock('出账与统计', 'GET /api/bills', body);
  }

  function renderBillsMid() {
    var bills = state.bills.bills || [];
    var meta = '共 ' + num(state.bills.total) + ' 张';
    if (!bills.length) {
      return paneBlock('账单清单', meta, emptyBlock('还没有账单', '在左侧选好账期与客户，点「按账期与客户出账」。'));
    }
    var html = bills.map(function (bill) {
      var selected = bill.id === state.selectedBillId;
      var mismatch = money(bill.amountYuan) !== money(bill.lineSumYuan);
      var drift = bill.drift;
      var hasDrift = bill.status === '已出账' && drift && drift.hasDrift;
      return '<article class="card' + (selected ? ' is-selected' : '') + '" data-action="select-bill" data-id="' + attr(bill.id) + '">' +
        '<div class="card-top">' +
        '<span class="card-code">' + esc(bill.code) + '</span>' +
        '<span class="badge ' + (bill.status === '已出账' ? 'st-transit' : 'st-return') + '">' + esc(bill.status) + '</span>' +
        '</div>' +
        '<div class="card-sub">' + esc(bill.period) + ' · ' + esc(bill.customerName) + '（' + esc(bill.customerCode || '-') + '）</div>' +
        '<div class="card-metrics">' +
        '<div class="card-metric">金额<b>' + esc(bill.amountText || money(bill.amountYuan)) + ' 元</b></div>' +
        '<div class="card-metric">明细条数<b>' + esc(num(bill.waybillCount)) + ' 条</b></div>' +
        '<div class="card-metric">明细合计<b>' + esc(bill.lineSumText || money(bill.lineSumYuan)) + ' 元</b></div>' +
        '</div>' +
        '<div class="card-tags">' +
        (hasDrift
          ? '<span class="tag tag-warn">出账后改动 ' + esc(num(drift.lineCount)) + ' 条 · ' + esc(drift.adjustmentDirection) + ' ' + esc(drift.adjustmentText) + ' 元</span>'
          : '<span class="tag' + (mismatch ? ' tag-warn' : '') + '">' + (mismatch ? '金额与明细合计不一致' : '出账后无改动') + '</span>') +
        '<span class="tag">折扣 ' + esc(discountTextOf(bill.discountPermille)) + '</span>' +
        '</div>' +
        '</article>';
    }).join('');
    return paneBlock('账单清单', meta, html);
  }

  function renderBillsRight() {
    var bill = state.billDetail;
    if (!bill || bill.id !== state.selectedBillId) {
      if (state.selectedBillId && state.billLoading) {
        return paneBlock('账单详情', '', loadingBlock('正在读取账单明细…'));
      }
      return paneBlock('账单详情', '', emptyBlock('还没有选中账单', '在中间清单里点一张账单查看逐条明细，或先在左侧出账。'));
    }
    var lines = bill.lines || [];
    var rows = lines.map(function (line) {
      var d = line.drift;
      return '<tr' + (d ? ' class="row-drift"' : '') + '>' +
        '<td>' + esc(line.code) + (d ? '<br><span class="mini-warn">出账后改动：' + esc(d.changedFieldsText || '计费数据') + '</span>' : '') + '</td>' +
        '<td>' + esc(line.toCity) + '</td>' +
        '<td>' + esc(line.zoneName || '-') + '</td>' +
        '<td class="num">' + esc(line.billableText || kg(line.billableKg)) + (d ? '<br><span class="mini-now">现在 ' + esc(d.billableNowText) + '</span>' : '') + '</td>' +
        '<td class="num">' + esc(line.amountText || money(line.amountYuan)) + (d ? '<br><span class="mini-' + (d.diffYuan >= 0 ? 'warn' : 'ok') + '">差额 ' + esc(d.diffText) + '</span>' : '') + '</td>' +
        '<td>' + (line.fromCache ? '取自上次计费' : '本次计算') + '</td>' +
        '</tr>';
    }).join('');

    var table = lines.length
      ? '<div class="table-wrap"><table><thead><tr>' +
      '<th>运单号</th><th>收件城市</th><th>分区</th><th class="num">出账时计费重量</th><th class="num">出账时金额(元)</th><th>计费来源</th>' +
      '</tr></thead><tbody>' + rows + '</tbody>' +
      '<tfoot><tr class="tfoot-row"><td colspan="4">明细合计（出账时）</td><td class="num">' + esc(bill.lineSumText || money(bill.lineSumYuan)) + '</td><td>' + esc(num(bill.waybillCount)) + ' 条</td></tr></tfoot>' +
      '</table></div>'
      : emptyBlock('这张账单没有明细行', '可以作废后重新出账。');

    var drift = bill.drift;
    var hasDrift = bill.status === '已出账' && drift && drift.hasDrift;
    var driftPanel = '';
    if (bill.status === '已出账') {
      if (hasDrift) {
        var driftRows = lines.filter(function (l) { return l.drift; }).map(function (line) {
          var d = line.drift;
          return '<tr>' +
            '<td>' + esc(line.code) + '</td>' +
            '<td>' + esc(d.changedFieldsText || '计费数据') + '</td>' +
            '<td class="num">' + esc(d.billableThenText) + '</td>' +
            '<td class="num">' + esc(d.billableNowText) + '</td>' +
            '<td class="num">' + esc(d.amountThenText) + '</td>' +
            '<td class="num">' + esc(d.amountNowText) + '</td>' +
            '<td class="num ' + (d.diffYuan >= 0 ? 'is-warn' : 'is-ok') + '"><b>' + esc(d.diffText) + '</b></td>' +
            '<td><span class="tag ' + (d.diffYuan >= 0 ? 'tag-warn' : 'tag-ok') + '">' + esc(d.direction) + '</span></td>' +
            '</tr>';
        }).join('');
        var adjWarn = drift.adjustmentDirection === '少收'
          ? '出账后运单数据有改动，按现在数据应向客户补收；金额以单独一笔调整体现，不改动原账单。'
          : '出账后运单数据有改动，按现在数据应退给客户；金额以单独一笔调整体现，不改动原账单。';
        driftPanel = '<div class="panel is-warn">' +
          '<h4 class="panel-title">出账后差额调整（核对时间 ' + esc(stampText(drift.checkedAt)) + '）</h4>' +
          '<div class="amount-row"><span>原账单金额（保持不变）</span><b>' + esc(drift.billedText) + ' 元</b></div>' +
          '<div class="amount-row"><span>调整（单独一笔 · ' + esc(drift.lineCount) + ' 条运单 · ' + esc(drift.adjustmentDirection) + '）</span>' +
          '<b class="' + (drift.adjustmentYuan >= 0 ? 'is-warn' : 'is-ok') + '">' + esc(drift.adjustmentText) + ' 元</b></div>' +
          '<div class="amount-row is-total"><span>按现在数据应收合计</span><b>' + esc(drift.expectedNowText) + ' 元</b></div>' +
          '<p class="panel-note">' + esc(adjWarn) + '</p></div>' +
          '<div class="block"><h3 class="block-title">逐单核对（当时数据 vs 现在数据）</h3>' +
          '<div class="table-wrap"><table><thead><tr>' +
          '<th>运单号</th><th>改动项</th><th class="num">当时计费重量</th><th class="num">现在计费重量</th>' +
          '<th class="num">当时应收(元)</th><th class="num">现在应收(元)</th><th class="num">差额</th><th>方向</th>' +
          '</tr></thead><tbody>' + driftRows + '</tbody>' +
          '<tfoot><tr class="tfoot-row"><td colspan="6">调整合计（' + esc(drift.adjustmentDirection) + '）</td>' +
          '<td class="num ' + (drift.adjustmentYuan >= 0 ? 'is-warn' : 'is-ok') + '"><b>' + esc(drift.adjustmentText) + '</b></td><td></td></tr></tfoot>' +
          '</table></div></div>';
      } else {
        driftPanel = '<div class="panel is-ok-soft"><h4 class="panel-title">出账后核对</h4>' +
          '<p class="panel-note">已按现在的运单数据逐单核对，没有发现出账后的改动，无需调整。</p></div>';
      }
    }

    var head =
      '<div class="detail-head">' +
      '<span class="detail-title">' + esc(bill.code) + '</span>' +
      '<span class="badge ' + (bill.status === '已出账' ? 'st-transit' : 'st-return') + '">' + esc(bill.status) + '</span>' +
      '</div>' +
      '<dl class="kv-list">' +
      '<dt>账期</dt><dd>' + esc(bill.period) + '</dd>' +
      '<dt>客户</dt><dd>' + esc(bill.customerName) + '（' + esc(bill.customerCode || '-') + '）</dd>' +
      '<dt>明细条数</dt><dd>' + esc(num(bill.waybillCount)) + ' 条</dd>' +
      '<dt>折扣</dt><dd>' + esc(discountTextOf(bill.discountPermille)) + '</dd>' +
      '<dt>创建时刻</dt><dd>' + esc(timeTextOf(bill.createdAt)) + '</dd>' +
      '<dt>作废时刻</dt><dd>' + esc(bill.voidedAt ? timeTextOf(bill.voidedAt) : '—') + '</dd>' +
      '</dl>' +
      '<div class="panel"><h4 class="panel-title">金额核对</h4>' +
      '<div class="amount-row"><span>账单金额（出账时已定）</span><b>' + esc(bill.amountText || money(bill.amountYuan)) + ' 元</b></div>' +
      '<div class="amount-row is-total"><span>明细合计</span><b>' + esc(bill.lineSumText || money(bill.lineSumYuan)) + ' 元</b></div>' +
      '</div>' +
      driftPanel +
      '<div class="block"><h3 class="block-title">出账时逐条明细</h3>' + table + '</div>' +
      '<div class="btn-stack">' +
      (bill.status === '已出账'
        ? '<button type="button" class="btn btn-danger' + (state.confirm && state.confirm.kind === 'bill' && state.confirm.id === bill.id ? ' is-armed' : '') + '" data-action="void-bill" data-id="' + attr(bill.id) + '">' +
        (state.confirm && state.confirm.kind === 'bill' && state.confirm.id === bill.id ? '确认作废（再点一次）' : '作废这张账单') + '</button>'
        : '<button type="button" class="btn" disabled>账单已作废</button>') +
      '<button type="button" class="btn btn-ghost" data-action="reload-bill" data-id="' + attr(bill.id) + '">重新核对</button>' +
      '</div>' +
      '<p class="foot-note">出账后运单再被改动不会动原账单金额，差额以单独一笔调整列在上方；作废只是把账单状态改成已作废。</p>';

    return paneBlock('账单详情', bill.id, head);
  }

  async function loadBillDetail(id) {
    state.billDetail = null;
    state.billLoading = true;
    renderRight();
    try {
      var bill = await api('GET', '/api/bills/' + encodeURIComponent(id));
      if (state.selectedBillId === id) {
        state.billDetail = bill;
      }
    } catch (err) {
      fail(err);
    } finally {
      state.billLoading = false;
      renderRight();
    }
  }

  async function selectBill(id) {
    state.selectedBillId = id;
    state.confirm = null;
    renderMid();
    renderRight();
    setStatus('已打开账单 ' + id + '，正在读取明细');
    await loadBillDetail(id);
    if (state.billDetail) {
      setStatus('账单 ' + state.billDetail.code + '：' + num(state.billDetail.waybillCount) + ' 条明细，金额 ' + money(state.billDetail.amountYuan) + ' 元');
    }
  }

  async function generateBill() {
    var periodEl = document.getElementById('billPeriod');
    var customerEl = document.getElementById('billCustomerId');
    if (!periodEl || !customerEl) return;
    clearFieldErrors();
    var payload = { period: String(periodEl.value).trim(), customerId: String(customerEl.value).trim() };
    try {
      var created = await api('POST', '/api/bills/generate', payload);
      state.selectedBillId = created.id;
      state.confirm = null;
      await refreshAll();
      render();
      await loadBillDetail(created.id);
      ok('已出账：' + created.code + '（' + created.customerName + ' · ' + created.period + '，金额 ' + money(created.amountYuan) + ' 元）');
    } catch (err) {
      fail(err);
    }
  }

  async function voidBill(id) {
    try {
      var voided = await api('POST', '/api/bills/' + encodeURIComponent(id) + '/void');
      state.confirm = null;
      await refreshAll();
      state.billDetail = voided;
      render();
      ok('已作废账单 ' + voided.code + '，状态：' + voided.status);
    } catch (err) {
      fail(err);
    }
  }

  /* ================= 渲染总入口 ================= */
  function renderLeft() {
    if (state.tab === 'overview') setLeft(renderOverviewLeft());
    else if (state.tab === 'waybills') setLeft(renderWaybillsLeft());
    else if (state.tab === 'zones') setLeft(renderZonesLeft());
    else if (state.tab === 'customers') setLeft(renderCustomersLeft());
    else setLeft(renderBillsLeft());
  }
  function renderMid() {
    if (state.tab === 'overview') setMid(renderOverviewMid());
    else if (state.tab === 'waybills') setMid(renderWaybillsMid());
    else if (state.tab === 'zones') setMid(renderZonesMid());
    else if (state.tab === 'customers') setMid(renderCustomersMid());
    else setMid(renderBillsMid());
  }
  function renderRight() {
    if (state.tab === 'overview') setRight(renderOverviewRight());
    else if (state.tab === 'waybills') setRight(renderWaybillsRight());
    else if (state.tab === 'zones') setRight(renderZonesRight());
    else if (state.tab === 'customers') setRight(renderCustomersRight());
    else setRight(renderBillsRight());
  }

  /* ================= 交互 ================= */
  async function switchTab(key) {
    if (!TAB_LABELS[key]) return;
    state.tab = key;
    state.confirm = null;
    renderTabs();
    render();
    try {
      await refreshAll();
      render();
      if (key === 'bills' && state.selectedBillId) await loadBillDetail(state.selectedBillId);
      ok('已切换到「' + TAB_LABELS[key] + '」');
    } catch (err) {
      fail(err);
    }
  }

  function applyFilters() {
    var keyword = document.getElementById('wbKeyword');
    var customer = document.getElementById('wbCustomer');
    var status = document.getElementById('wbStatus');
    var unzoned = document.getElementById('wbUnzoned');
    state.filters.keyword = keyword ? keyword.value.trim() : '';
    state.filters.customerId = customer ? customer.value : '';
    state.filters.status = status ? status.value : '';
    state.filters.unzoned = unzoned ? unzoned.checked : false;
    clearNotice();
    loadWaybills().then(function () {
      renderList();
      setStatus('运单清单已按筛选条件刷新，共 ' + state.waybills.total + ' 条');
    }).catch(fail);
  }

  function resetFilters() {
    state.filters = { keyword: '', customerId: '', status: '', unzoned: false };
    renderLeft();
    loadWaybills().then(function () {
      renderList();
      setStatus('已重置运单筛选条件，共 ' + state.waybills.total + ' 条');
    }).catch(fail);
  }

  var liveWaybillFilter = debounce(function () {
    var keyword = document.getElementById('wbKeyword');
    if (!keyword) return;
    state.filters.keyword = keyword.value.trim();
    loadWaybills().then(function () {
      renderList();
      setStatus('已按关键词「' + (state.filters.keyword || '空') + '」筛出 ' + state.waybills.total + ' 条运单');
    }).catch(fail);
  }, 280);

  function onLeftInput(event) {
    var el = event.target;
    if (el.id === 'wbKeyword') { liveWaybillFilter(); return; }
    if (el.id === 'zoneKeyword') { state.zoneFilter.keyword = el.value; renderMid(); return; }
    if (el.id === 'customerKeyword') { state.customerFilter.keyword = el.value; renderMid(); return; }
  }

  function onLeftChange(event) {
    var el = event.target;
    if (el.id === 'wbCustomer' || el.id === 'wbStatus' || el.id === 'wbUnzoned') { applyFilters(); return; }
    if (el.id === 'zoneStatus') { state.zoneFilter.status = el.value; renderMid(); renderLeft(); return; }
    if (el.id === 'customerSettle') { state.customerFilter.settle = el.value; renderMid(); renderLeft(); return; }
    if (el.id === 'customerStatus') { state.customerFilter.status = el.value; renderMid(); renderLeft(); return; }
  }

  function onLeftKeydown(event) {
    if (event.key === 'Enter' && event.target.id === 'wbKeyword') {
      event.preventDefault();
      applyFilters();
    }
  }

  function onRightInput(event) {
    var el = event.target;
    var wrap = el.closest ? el.closest('[data-field-wrap]') : null;
    if (wrap && wrap.classList.contains('is-error')) {
      wrap.classList.remove('is-error');
      var msg = wrap.querySelector('.field-msg');
      if (msg) msg.textContent = '';
    }
    if (el.id === 'custDiscount') {
      var preview = document.getElementById('discountPreview');
      if (preview) preview.textContent = '当前折扣：' + discountTextOf(el.value);
    }
  }

  async function handleAction(action, target) {
    var id = target.getAttribute('data-id') || '';
    // 除了正在等待二次确认的删除，其它操作都会取消确认状态
    if (action !== 'delete-waybill' && action !== 'delete-zone' && action !== 'delete-customer' && action !== 'void-bill') {
      if (state.confirm) { state.confirm = null; renderRight(); }
    }

    switch (action) {
      case 'tab':
        await switchTab(target.getAttribute('data-tab'));
        break;
      case 'notice-close':
        clearNotice();
        break;
      case 'refresh-all':
        try { await refreshAll(); render(); ok('已刷新全部数据'); } catch (err) { fail(err); }
        break;
      case 'goto-status':
        state.tab = 'waybills';
        state.filters.status = target.getAttribute('data-status') || '';
        state.filters.unzoned = false;
        try { await refreshAll(); render(); ok('已按状态「' + state.filters.status + '」筛选运单，共 ' + state.waybills.total + ' 条'); } catch (err) { fail(err); }
        break;
      case 'goto-unzoned':
        state.tab = 'waybills';
        state.filters.unzoned = true;
        state.filters.status = '';
        try { await refreshAll(); render(); ok('已筛选未归属城市的运单，共 ' + state.waybills.total + ' 条'); } catch (err) { fail(err); }
        break;

      case 'apply-filters': applyFilters(); break;
      case 'reset-filters': resetFilters(); break;
      case 'refresh-waybills':
        try { await loadWaybills(); renderList(); ok('运单清单已刷新，共 ' + state.waybills.total + ' 条'); } catch (err) { fail(err); }
        break;

      case 'new-waybill':
        state.waybillMode = 'create';
        state.selectedWaybillId = '';
        state.quote = null;
        clearNotice();
        clearFieldErrors();
        renderMid();
        renderRight();
        setStatus('开始登记新运单，填完点「创建运单」');
        break;
      case 'select-waybill': selectWaybill(id); break;
      case 'edit-waybill':
        state.selectedWaybillId = id;
        state.waybillMode = 'edit';
        clearNotice();
        clearFieldErrors();
        renderRight();
        setStatus('正在编辑运单 ' + id);
        break;
      case 'cancel-waybill-form':
        state.waybillMode = 'view';
        clearNotice();
        clearFieldErrors();
        renderRight();
        setStatus('已取消编辑');
        break;
      case 'save-waybill': await saveWaybill(); break;
      case 'delete-waybill':
        if (state.confirm && state.confirm.kind === 'waybill' && state.confirm.id === id) {
          await deleteWaybill(id);
        } else {
          state.confirm = { kind: 'waybill', id: id };
          renderRight();
          setStatus('再点一次「确认删除」就会真的删除这条运单');
        }
        break;
      case 'quote-waybill': await quoteWaybill(id || state.selectedWaybillId); break;

      case 'new-zone':
        state.zoneMode = 'create';
        state.selectedZoneId = '';
        clearNotice();
        clearFieldErrors();
        renderMid();
        renderRight();
        setStatus('开始新增分区，城市用逗号分隔，别名每行一条');
        break;
      case 'select-zone':
        state.selectedZoneId = id;
        state.zoneMode = 'view';
        state.confirm = null;
        renderMid();
        renderRight();
        setStatus('已选中分区 ' + id);
        break;
      case 'edit-zone':
        state.selectedZoneId = id;
        state.zoneMode = 'edit';
        clearNotice();
        clearFieldErrors();
        renderRight();
        setStatus('正在编辑分区 ' + id);
        break;
      case 'cancel-zone-form':
        state.zoneMode = 'view';
        clearNotice();
        clearFieldErrors();
        renderRight();
        setStatus('已取消编辑');
        break;
      case 'save-zone': await saveZone(); break;
      case 'delete-zone':
        if (state.confirm && state.confirm.kind === 'zone' && state.confirm.id === id) {
          await deleteZone(id);
        } else {
          state.confirm = { kind: 'zone', id: id };
          renderRight();
          setStatus('再点一次「确认删除」就会真的删除这个分区');
        }
        break;
      case 'refresh-zones':
        try { await loadZones(); await loadSummary(); render(); ok('分区清单已刷新，共 ' + state.zones.length + ' 个'); } catch (err) { fail(err); }
        break;

      case 'new-customer':
        state.customerMode = 'create';
        state.selectedCustomerId = '';
        clearNotice();
        clearFieldErrors();
        renderMid();
        renderRight();
        setStatus('开始新增客户，现结客户的折扣要填 1000');
        break;
      case 'select-customer':
        state.selectedCustomerId = id;
        state.customerMode = 'view';
        state.confirm = null;
        renderMid();
        renderRight();
        setStatus('已选中客户 ' + id);
        break;
      case 'edit-customer':
        state.selectedCustomerId = id;
        state.customerMode = 'edit';
        clearNotice();
        clearFieldErrors();
        renderRight();
        setStatus('正在编辑客户 ' + id);
        break;
      case 'cancel-customer-form':
        state.customerMode = 'view';
        clearNotice();
        clearFieldErrors();
        renderRight();
        setStatus('已取消编辑');
        break;
      case 'save-customer': await saveCustomer(); break;
      case 'delete-customer':
        if (state.confirm && state.confirm.kind === 'customer' && state.confirm.id === id) {
          await deleteCustomer(id);
        } else {
          state.confirm = { kind: 'customer', id: id };
          renderRight();
          setStatus('再点一次「确认删除」就会真的删除这个客户');
        }
        break;
      case 'filter-waybills-customer':
        state.tab = 'waybills';
        state.filters.customerId = id;
        state.filters.unzoned = false;
        state.filters.status = '';
        state.filters.keyword = '';
        try { await refreshAll(); render(); ok('已在运单里按客户筛选，共 ' + state.waybills.total + ' 条'); } catch (err) { fail(err); }
        break;
      case 'refresh-customers':
        try { await loadCustomers(); await loadSummary(); render(); ok('客户清单已刷新，共 ' + state.customers.length + ' 个'); } catch (err) { fail(err); }
        break;

      case 'generate-bill': await generateBill(); break;
      case 'select-bill': await selectBill(id); break;
      case 'goto-bill-drift':
        state.tab = 'bills';
        try {
          await refreshAll();
          render();
          await selectBill(id);
        } catch (err) { fail(err); }
        break;
      case 'reload-bill': await loadBillDetail(id); if (state.billDetail) setStatus('已重新读取账单 ' + state.billDetail.code + ' 的明细'); break;
      case 'void-bill':
        if (state.confirm && state.confirm.kind === 'bill' && state.confirm.id === id) {
          await voidBill(id);
        } else {
          state.confirm = { kind: 'bill', id: id };
          renderRight();
          setStatus('再点一次「确认作废」就会把这张账单作废');
        }
        break;
      case 'refresh-bills':
        try { await loadBills(); await loadPeriods(); await loadSummary(); render(); ok('账单清单已刷新，共 ' + state.bills.total + ' 张'); } catch (err) { fail(err); }
        break;
      default:
        break;
    }
  }

  /* ================= 启动 ================= */
  function bind() {
    els.tabs = document.getElementById('tabs');
    els.leftPane = document.getElementById('leftPane');
    els.midPane = document.getElementById('midPane');
    els.rightPane = document.getElementById('rightPane');
    els.notice = document.getElementById('notice');
    els.noticeText = document.getElementById('noticeText');
    els.statusMessage = document.getElementById('statusMessage');
    els.statusCount = document.getElementById('statusCount');
    els.statusDot = document.getElementById('statusDot');
    els.dataStamp = document.getElementById('dataStamp');

    document.addEventListener('click', function (event) {
      var target = event.target.closest ? event.target.closest('[data-action]') : null;
      if (!target) return;
      event.preventDefault();
      handleAction(target.getAttribute('data-action'), target).catch(fail);
    });

    els.leftPane.addEventListener('input', onLeftInput);
    els.leftPane.addEventListener('change', onLeftChange);
    els.leftPane.addEventListener('keydown', onLeftKeydown);
    els.rightPane.addEventListener('input', onRightInput);
    els.rightPane.addEventListener('change', onRightInput);
  }

  function boot() {
    bind();
    renderTabs();
    renderLeft();
    renderMid();
    renderRight();
    renderStatusCount();
    setStatus('正在读取数据…');
    refreshAll().then(function () {
      render();
      ok('数据已就绪，共 ' + num((state.summary || {}).waybillCount) + ' 条运单');
    }).catch(fail);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
