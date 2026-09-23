const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
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
    const surcharge = pricing.surchargeYuan(zone, waybill, weight, settings);
    const raw = (freightAll * share + surcharge) * permille / 1000;
    const cached = Number(waybill.quoteCacheYuan);
    const amount = cached > 0 ? cached : pricing.roundFen(raw);
    // 快照分区按这条运单自己的收件城市取（与运单页单条计费同口径）；
    // 上面的 zone 只用于合单总价，同一账单里的运单本就可能跨分区
    const lineZone = zoneOf(data, waybill.toCity);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneName: zone ? zone.name : '',
      billableKg: weight,
      amountYuan: amount,
      fromCache: cached > 0,
      // 出账时刻快照：出账后运单/分区/参数/折扣再被改动，靠它按「当时数据」重算并逐条比对
      snapshot: {
        actualWeightKg: Number(waybill.weightKg) || 0,
        volumeM3: Number(waybill.volumeM3) || 0,
        pieces: Number(waybill.pieces) || 1,
        insuredAmountYuan: Number(waybill.insuredAmountYuan || 0),
        services: Array.isArray(waybill.services) ? waybill.services.slice() : [],
        zone: lineZone ? {
          id: lineZone.id, name: lineZone.name,
          firstWeightKg: Number(lineZone.firstWeightKg) || 0,
          firstPriceYuan: Number(lineZone.firstPriceYuan) || 0,
          addUnitKg: Number(lineZone.addUnitKg) || 0,
          addPriceYuan: Number(lineZone.addPriceYuan) || 0,
          remoteFeeYuan: Number(lineZone.remoteFeeYuan) || 0,
        } : null,
        settings: {
          volumetricDivisor: Number(settings.volumetricDivisor) || 0,
          minChargeYuan: Number(settings.minChargeYuan) || 0,
          oversizeWeightKg: Number(settings.oversizeWeightKg) || 0,
          oversizePieces: Number(settings.oversizePieces) || 0,
          oversizeFeeYuan: Number(settings.oversizeFeeYuan) || 0,
          insurancePermille: Number(settings.insurancePermille) || 0,
        },
        permille,
      },
    };
  });
  return { lines, amountYuan, permille };
}

// 差额方向：正差是现在要多收（账单少收了），负差是要退（账单多收了）
function deltaDirection(deltaYuan) {
  const value = pricing.roundFen(deltaYuan);
  if (value > 0.009) return '少收';
  if (value < -0.009) return '多收';
  return '无差额';
}

function servicesEqual(a, b) {
  const x = (Array.isArray(a) ? a : []).slice().sort();
  const y = (Array.isArray(b) ? b : []).slice().sort();
  return x.length === y.length && x.every((item, index) => item === y[index]);
}

// 按「某一时刻」的运单/分区/参数/折扣，用运单页同款单条计费口径算一条运单该收多少
function quoteAt(zone, waybillLike, billableKg, settings, permille) {
  if (!zone) return null;
  const freight = pricing.freightYuan(zone, billableKg, settings);
  const surcharge = pricing.surchargeYuan(zone, waybillLike, billableKg, settings);
  return pricing.roundFen((freight + surcharge) * (Number(permille) || 1000) / 1000);
}

function zonePriceChanged(thenZone, nowZone) {
  if (!thenZone || !nowZone || thenZone.id !== nowZone.id) return false;
  return ['firstWeightKg', 'firstPriceYuan', 'addUnitKg', 'addPriceYuan', 'remoteFeeYuan'].some((key) => {
    return Number(thenZone[key] || 0) !== Number(nowZone[key] || 0);
  });
}

const SETTING_LABELS = {
  volumetricDivisor: '体积系数',
  minChargeYuan: '最低收费',
  oversizeWeightKg: '超规重量线',
  oversizePieces: '超规件数线',
  oversizeFeeYuan: '超规附加',
  insurancePermille: '保价费率',
};

// 出账后改动核对：拿每行的出账快照跟运单/分区/参数/折扣的当前值逐条比对。
// 「按当时数据」与「按现在数据」都走单条计费口径，差额单独汇总成一笔调整，绝不回写账单金额。
function buildAdjustment(data, bill) {
  const permilleThen0 = Number(bill.discountPermille) || 1000;
  const empty = {
    hasDiff: false,
    affectedCount: 0,
    direction: '无差额',
    deltaYuan: 0,
    thenSumYuan: 0,
    nowSumYuan: 0,
    lines: [],
    discountChanged: false,
    permilleThen: permilleThen0,
    permilleNow: permilleThen0,
  };
  if (bill.status !== '已出账') return empty;
  const customer = findCustomer(data, bill.customerId);
  const settingsNow = pricing.settingsOf(data);
  const permilleNow = pricing.discountPermilleOf(customer);
  const discountChanged = permilleThen0 !== permilleNow;
  Object.assign(empty, { discountChanged, permilleNow });
  const settingsNowChangedKeys = (snapSettings) => Object.keys(snapSettings || {}).filter(
    (key) => Number(snapSettings[key] || 0) !== Number(settingsNow[key] || 0)
  );

  const affected = [];
  (bill.lines || []).forEach((line) => {
    const waybill = data.waybills.find((item) => item.id === line.waybillId);
    if (!waybill) return;
    const snap = line.snapshot || null;

    // —— 按当时数据（出账快照；老账单缺快照时退回用冻结的计费重量＋当前未变字段）——
    const settingsThen = snap ? snap.settings : settingsNow;
    const permilleThen = snap && snap.permille != null ? snap.permille : permilleThen0;
    const zoneThen = snap && snap.zone ? snap.zone : zoneOf(data, line.toCity);
    const thenLike = {
      pieces: snap ? snap.pieces : Number(waybill.pieces) || 1,
      insuredAmountYuan: snap ? snap.insuredAmountYuan : Number(waybill.insuredAmountYuan || 0),
      services: snap ? snap.services : (Array.isArray(waybill.services) ? waybill.services : []),
    };
    const billableThen = Number(line.billableKg) || 0;
    const amountThen = quoteAt(zoneThen, thenLike, billableThen, settingsThen, permilleThen);

    // —— 按现在数据 ——
    const zoneNow = zoneOf(data, waybill.toCity);
    const billableNow = pricing.billableWeightKg(waybill, settingsNow);
    const amountNow = quoteAt(zoneNow, waybill, billableNow, settingsNow, permilleNow);

    const reasons = [];
    // 重量/体积
    if (snap && Math.abs(Number(snap.actualWeightKg || 0) - (Number(waybill.weightKg) || 0)) > 1e-9) {
      reasons.push('实际重量 ' + Number(snap.actualWeightKg).toFixed(2) + 'kg → ' + (Number(waybill.weightKg) || 0).toFixed(2) + 'kg');
    }
    if (snap && Math.abs(Number(snap.volumeM3 || 0) - (Number(waybill.volumeM3) || 0)) > 1e-9) {
      reasons.push('体积 ' + Number(snap.volumeM3).toFixed(3) + 'm³ → ' + (Number(waybill.volumeM3) || 0).toFixed(3) + 'm³');
    }
    if (Math.abs(billableNow - billableThen) > 1e-9) {
      reasons.push('计费重量 ' + billableThen.toFixed(2) + 'kg → ' + billableNow.toFixed(2) + 'kg');
    }
    // 城市 / 分区
    const cityChanged = cleanCity(line.toCity) !== cleanCity(waybill.toCity);
    if (cityChanged) reasons.push('收件城市 ' + (line.toCity || '—') + ' → ' + waybill.toCity);
    if (zoneThen && zoneNow && zoneThen.name !== zoneNow.name) {
      reasons.push('分区 ' + zoneThen.name + ' → ' + zoneNow.name);
    } else if (zonePriceChanged(zoneThen, zoneNow)) {
      reasons.push('分区「' + zoneThen.name + '」单价已调整');
    }
    // 件数 / 保价 / 附加服务
    if (snap && Number(snap.pieces) !== Number(waybill.pieces)) {
      reasons.push('件数 ' + Number(snap.pieces) + ' 件 → ' + Number(waybill.pieces) + ' 件');
    }
    if (snap && Math.abs(Number(snap.insuredAmountYuan || 0) - Number(waybill.insuredAmountYuan || 0)) > 1e-9) {
      reasons.push('保价金额 ' + pricing.roundFen(snap.insuredAmountYuan).toFixed(2) + ' 元 → ' + pricing.roundFen(waybill.insuredAmountYuan || 0).toFixed(2) + ' 元');
    }
    if (snap && !servicesEqual(snap.services, waybill.services)) {
      reasons.push('附加服务 ' + (snap.services.length ? snap.services.join('、') : '无') + ' → ' + ((waybill.services || []).length ? waybill.services.join('、') : '无'));
    }
    // 计费参数 / 折扣（账单级变化，每行都点出来）
    const changedKeys = snap ? settingsNowChangedKeys(snap.settings) : [];
    if (changedKeys.length) {
      reasons.push('计费参数已调整（' + changedKeys.map((key) => SETTING_LABELS[key] || key).join('、') + '）');
    }
    if (discountChanged) reasons.push('客户折扣 ' + permilleThen0 + '‰ → ' + permilleNow + '‰');

    const amountChanged = amountThen !== null && amountNow !== null && Math.abs(amountNow - amountThen) > 0.009;
    if (!reasons.length && !amountChanged) return;

    affected.push({
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneNameThen: zoneThen ? zoneThen.name : '',
      zoneNameNow: zoneNow ? zoneNow.name : '',
      billableKgThen: billableThen,
      billableKgNow: billableNow,
      amountThenYuan: amountThen === null ? 0 : amountThen,
      amountNowYuan: amountNow === null ? 0 : amountNow,
      unbillable: amountThen === null || amountNow === null,
      deltaYuan: amountThen === null || amountNow === null ? 0 : pricing.roundFen(amountNow - amountThen),
      reasons,
    });
  });

  const thenSum = pricing.roundFen(affected.reduce((sum, item) => sum + item.amountThenYuan, 0));
  const nowSum = pricing.roundFen(affected.reduce((sum, item) => sum + item.amountNowYuan, 0));
  const delta = pricing.roundFen(nowSum - thenSum);
  return {
    hasDiff: affected.length > 0,
    affectedCount: affected.length,
    direction: deltaDirection(delta),
    deltaYuan: delta,
    thenSumYuan: thenSum,
    nowSumYuan: nowSum,
    lines: affected,
    discountChanged,
    permilleThen: permilleThen0,
    permilleNow,
  };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  // 出账后改动核对：差额走单独一笔调整，账单金额本身不动
  const adjustment = buildAdjustment(data, bill);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
    })),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
    adjustment,
    adjustmentText: formatAdjustmentText(adjustment),
    payableYuan: pricing.roundFen(Number(bill.amountYuan || 0) + adjustment.deltaYuan),
  });
}

// 清单卡片上用的一句话提示，例如「少收 15.68 元 · 1 条运单出账后改动」
function formatAdjustmentText(adjustment) {
  if (!adjustment || !adjustment.hasDiff) return '';
  const bits = [];
  const priced = adjustment.lines.filter((line) => !line.unbillable);
  if (priced.length) {
    bits.push(adjustment.direction + ' ' + Math.abs(adjustment.deltaYuan).toFixed(2) + ' 元');
  }
  const unbillableCount = adjustment.lines.filter((line) => line.unbillable).length;
  if (unbillableCount) bits.push(unbillableCount + ' 条当前算不出价');
  bits.push(adjustment.affectedCount + ' 条运单出账后有改动');
  return bits.join(' · ');
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

// 给运单侧用：这条运单所属的已出账账单，是否因出账后改动产生了差额
function waybillAdjustment(data, waybill) {
  if (!waybill || !waybill.billId) return null;
  const bill = data.bills.find((item) => item.id === waybill.billId);
  if (!bill || bill.status !== '已出账') return null;
  const adj = buildAdjustment(data, bill);
  const line = adj.lines.find((item) => item.waybillId === waybill.id) || null;
  if (!line) return null;
  return {
    billId: bill.id,
    billCode: bill.code,
    billHasDiff: adj.hasDiff,
    billAffectedCount: adj.affectedCount,
    billDeltaYuan: adj.deltaYuan,
    direction: adj.direction,
    deltaYuan: line.deltaYuan,
    amountThenYuan: line.amountThenYuan,
    amountNowYuan: line.amountNowYuan,
    billableKgThen: line.billableKgThen,
    billableKgNow: line.billableKgNow,
    unbillable: line.unbillable,
    reasons: line.reasons,
  };
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

module.exports = { listBills, getBill, generateBill, voidBill, listPeriods, periodOf, zoneOf, waybillAdjustment, buildAdjustment };
