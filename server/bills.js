const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 出账时快照下来的运单计价字段：之后运单再改，就拿现在的值跟这份快照比
const SNAPSHOT_FIELDS = ['weightKg', 'volumeM3', 'pieces', 'insuredAmountYuan', 'services', 'toCity'];
const FIELD_LABELS = {
  weightKg: '实际重量',
  volumeM3: '体积',
  pieces: '件数',
  insuredAmountYuan: '保价金额',
  services: '附加服务',
  toCity: '收件城市',
  billableKg: '计费数据（重量/体积）',
};

function snapshotOf(waybill) {
  const snapshot = {};
  SNAPSHOT_FIELDS.forEach((field) => {
    const value = waybill[field];
    snapshot[field] = Array.isArray(value) ? value.slice() : value;
  });
  return snapshot;
}

function sameServices(a, b) {
  const left = Array.isArray(a) ? a.slice().sort() : [];
  const right = Array.isArray(b) ? b.slice().sort() : [];
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

// 逐字段比对出账快照与运单当前数据，列出改动项（含当时值与现在值）
function describeChangedFields(snapshot, waybill, billableThenKg, billableNowKg) {
  const changed = [];
  if (snapshot) {
    SNAPSHOT_FIELDS.forEach((field) => {
      const thenValue = snapshot[field];
      const nowValue = waybill[field];
      let differs = false;
      if (field === 'services') differs = !sameServices(thenValue, nowValue);
      else if (field === 'toCity') differs = cleanCity(thenValue) !== cleanCity(nowValue);
      else differs = Math.abs(Number(thenValue || 0) - Number(nowValue || 0)) > 1e-9;
      if (differs) changed.push({ field, label: FIELD_LABELS[field] || field, thenValue, nowValue });
    });
  } else if (Math.abs(Number(billableThenKg) - Number(billableNowKg)) > 1e-9) {
    // 旧账单没有逐字段快照：至少能从计费重量看出被动过
    changed.push({ field: 'billableKg', label: FIELD_LABELS.billableKg, thenValue: billableThenKg, nowValue: billableNowKg });
  }
  return changed;
}

// 单票口径重算一条运单在给定分区、给定计费重量下折后应收
function standaloneYuan(zone, waybill, billableKg, permille, settings) {
  const freight = pricing.freightYuan(zone, billableKg, settings);
  const surcharge = pricing.surchargeYuan(zone, waybill, billableKg, settings);
  return pricing.roundFen((freight + surcharge) * Number(permille) / 1000);
}

// 差额核对用哪个分区：优先按当前收件城市归属，归属不到时退回出账时的分区名
function zoneForLine(data, bill, waybill) {
  const current = zones.zoneOfCity(data, waybill.toCity);
  if (current) return current;
  const line = (bill.lines || []).find((item) => item.waybillId === waybill.id);
  const name = line ? line.zoneName : '';
  return data.zones.find((zone) => zone.name === name) || zoneOf(data, waybill.toCity);
}

// 账单里的分区判断：拿收件城市跟各分区登记的城市直接比
function zoneOf(data, city) {
  const target = cleanCity(city);
  const matched = data.zones.find((zone) => (zone.cities || []).some((item) => cleanCity(item) === target));
  return matched || data.zones[0] || null;
}

// 账期：按运单创建时刻的年月
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 出账计费：同一账期同一客户的运单合起来算一次首重续重，再按各自的计费重量分摊
function priceBill(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille };
  const zone = zoneOf(data, waybills[0].toCity);
  const weights = waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freightAll = pricing.freightYuan(zone, totalWeight, settings);
  const surchargeAll = waybills.reduce((sum, waybill, index) => (
    sum + pricing.surchargeYuan(zone, waybill, weights[index], settings)
  ), 0);
  const grossAll = freightAll + surchargeAll;
  const amountYuan = grossAll * permille / 1000;
  const lines = waybills.map((waybill, index) => {
    const weight = weights[index];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const raw = (freightAll * share + pricing.surchargeYuan(zone, waybill, weight, settings)) * permille / 1000;
    const cached = Number(waybill.quoteCacheYuan);
    const amount = cached > 0 ? cached : pricing.roundFen(raw);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneName: zone ? zone.name : '',
      billableKg: weight,
      amountYuan: amount,
      fromCache: cached > 0,
      billingBasis: cached > 0 ? 'cache' : 'pooled',
      snapshot: snapshotOf(waybill),
    };
  });
  return { lines, amountYuan, permille };
}

// 出账后核对：按现在的运单数据重算，跟出账时逐行比对。
// 用单票口径（分区首重续重 + 附加费 + 折扣），这样改哪条就只体现在哪一条上，不会把差额摊到同票其它运单。
// 原账单金额一律不动，差额汇总成单独一笔调整：正数 = 少收要补，负数 = 多收要退。
function detectDrift(data, bill) {
  if (!bill || bill.status !== '已出账') return null;
  const settings = pricing.settingsOf(data);
  const permille = Number(bill.discountPermille) || 1000;
  const lineDrifts = [];
  (bill.lines || []).forEach((line) => {
    const waybill = data.waybills.find((item) => item.id === line.waybillId);
    if (!waybill) return;
    const zone = zoneForLine(data, bill, waybill);
    const kgThen = Number(line.billableKg) || 0;
    const kgNow = pricing.billableWeightKg(waybill, settings);
    const amountThen = standaloneYuan(zone, waybill, kgThen, permille, settings);
    const amountNow = standaloneYuan(zone, waybill, kgNow, permille, settings);
    const diffYuan = pricing.roundFen(amountNow - amountThen);
    const changedFields = describeChangedFields(line.snapshot, waybill, kgThen, kgNow);
    if (Math.abs(diffYuan) < 0.01 && changedFields.length === 0) return;
    lineDrifts.push({
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneName: zone ? zone.name : '',
      changedFields: changedFields,
      billableThenKg: kgThen,
      billableNowKg: kgNow,
      amountThenYuan: amountThen,
      amountNowYuan: amountNow,
      diffYuan,
      direction: diffYuan > 0 ? '少收' : (diffYuan < 0 ? '多收' : '金额无差'),
    });
  });
  const adjustmentYuan = pricing.roundFen(lineDrifts.reduce((sum, item) => sum + item.diffYuan, 0));
  const billedAmount = pricing.roundFen(Number(bill.amountYuan) || 0);
  return {
    checkedAt: new Date().toISOString(),
    lineCount: lineDrifts.length,
    lineDrifts,
    adjustmentYuan,
    adjustmentDirection: adjustmentYuan > 0 ? '少收' : (adjustmentYuan < 0 ? '多收' : '无差额'),
    expectedNowYuan: pricing.roundFen(billedAmount + adjustmentYuan),
    hasDrift: lineDrifts.length > 0,
  };
}

// 一次构建全部已出账账单的逐运单差额索引：运单列表要用来提示「这条改动影响了哪张账单」
function driftIndex(data) {
  const index = {};
  data.bills.forEach((bill) => {
    const drift = detectDrift(data, bill);
    if (!drift || !drift.hasDrift) return;
    drift.lineDrifts.forEach((line) => {
      index[line.waybillId] = {
        billId: bill.id,
        billCode: bill.code,
        billStatus: bill.status,
        diffYuan: line.diffYuan,
        direction: line.direction,
      };
    });
  });
  return index;
}

function formatChangedFields(changed) {
  return (changed || []).map((item) => item.label || item.field).join('、');
}

function summarizeBill(bill, data, driftCache) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  const drift = driftCache && Object.prototype.hasOwnProperty.call(driftCache, bill.id)
    ? driftCache[bill.id]
    : detectDrift(data, bill);
  const driftById = {};
  (drift && drift.lineDrifts || []).forEach((line) => { driftById[line.waybillId] = line; });
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    lines: lines.map((line) => {
      const lineDrift = driftById[line.waybillId] || null;
      return Object.assign({}, line, {
        amountText: Number(line.amountYuan || 0).toFixed(2),
        billableText: Number(line.billableKg).toFixed(2) + ' kg',
        snapshot: undefined,
        drift: lineDrift ? {
          changedFields: lineDrift.changedFields,
          changedFieldsText: formatChangedFields(lineDrift.changedFields),
          billableThenText: lineDrift.billableThenKg.toFixed(2) + ' kg',
          billableNowText: lineDrift.billableNowKg.toFixed(2) + ' kg',
          amountThenText: lineDrift.amountThenYuan.toFixed(2),
          amountNowText: lineDrift.amountNowYuan.toFixed(2),
          diffText: (lineDrift.diffYuan > 0 ? '+' : '') + lineDrift.diffYuan.toFixed(2),
          diffYuan: lineDrift.diffYuan,
          direction: lineDrift.direction,
        } : null,
      });
    }),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
    drift: drift ? {
      checkedAt: drift.checkedAt,
      lineCount: drift.lineCount,
      hasDrift: drift.hasDrift,
      adjustmentYuan: drift.adjustmentYuan,
      adjustmentText: (drift.adjustmentYuan > 0 ? '+' : '') + drift.adjustmentYuan.toFixed(2),
      adjustmentDirection: drift.adjustmentDirection,
      expectedNowYuan: drift.expectedNowYuan,
      expectedNowText: drift.expectedNowYuan.toFixed(2),
      billedText: pricing.roundFen(Number(bill.amountYuan || 0)).toFixed(2),
    } : null,
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  const driftCache = {};
  data.bills.forEach((bill) => { driftCache[bill.id] = detectDrift(data, bill); });
  let bills = data.bills.map((bill) => summarizeBill(bill, data, driftCache));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  const issued = bills.filter((bill) => bill.status === '已出账');
  const drifted = issued.filter((bill) => bill.drift && bill.drift.hasDrift);
  return {
    bills,
    total: bills.length,
    issued: issued.length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
    driftedCount: drifted.length,
    adjustmentTotalYuan: pricing.roundFen(drifted.reduce((sum, bill) => sum + bill.drift.adjustmentYuan, 0)),
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const priced = priceBill(data, customer, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  save(data);
  return summarizeBill(bill, load());
}

function listPeriods() {
  const data = load();
  const periods = new Set();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (period) periods.add(period);
  });
  data.bills.forEach((bill) => periods.add(bill.period));
  return { periods: Array.from(periods).sort() };
}

module.exports = {
  listBills,
  getBill,
  generateBill,
  voidBill,
  listPeriods,
  periodOf,
  zoneOf,
  detectDrift,
  driftIndex,
  summarizeBill,
  SNAPSHOT_FIELDS,
};
