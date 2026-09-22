// 计费口径（本项目现有实现）
// 1. 计费重量 = max(实际重量, 体积重量)，体积重量 = 体积(m³) × 1000000 ÷ 体积系数，结果向上取到 0.5kg
// 2. 首重以内收首重价，超出部分按续重单位向上进位，每个单位收续重价
// 3. 运费不低于最低收费
// 4. 附加费 = 偏远附加（按分区）+ 超规附加（计费重量超限或件数超限）+ 保价费（保价金额 × 费率）
// 5. 月结客户按折扣作用于运费与附加费合计，现结客户不打折；费用以元为单位，保留两位
const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
};

function settingsOf(data) {
  return Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
}

function roundFen(yuan) {
  return Math.round(Number(yuan) * 100) / 100;
}

function roundUpToUnit(value, unit) {
  if (!(unit > 0)) return Number(value);
  return Math.ceil(Number(value) / unit) * unit;
}

function volumeWeightKg(volumeM3, divisor) {
  const volume = Number(volumeM3) || 0;
  const base = Number(divisor) > 0 ? Number(divisor) : DEFAULT_SETTINGS.volumetricDivisor;
  return (volume * 1000000) / base;
}

function billableWeightKg(waybill, settings) {
  const actual = Number(waybill.weightKg) || 0;
  const volume = volumeWeightKg(waybill.volumeM3, settings.volumetricDivisor);
  return roundUpToUnit(Math.max(actual, volume), 0.5);
}

function freightYuan(zone, billableKg, settings) {
  const firstWeightKg = Number(zone.firstWeightKg) || 1;
  const firstPriceYuan = Number(zone.firstPriceYuan) || 0;
  const addUnitKg = Number(zone.addUnitKg) || 0.5;
  const addPriceYuan = Number(zone.addPriceYuan) || 0;
  const over = Math.max(0, Number(billableKg) - firstWeightKg);
  const units = Math.ceil(over / addUnitKg);
  const raw = firstPriceYuan + units * addPriceYuan;
  const floor = Number(settings.minChargeYuan) || 0;
  return raw < floor ? floor : raw;
}

function surchargeYuan(zone, waybill, billableKg, settings) {
  let fee = Number(zone.remoteFeeYuan) || 0;
  const oversizeWeight = Number(billableKg) > Number(settings.oversizeWeightKg);
  const oversizePieces = Number(waybill.pieces || 1) >= Number(settings.oversizePieces);
  if (oversizeWeight || oversizePieces) fee += Number(settings.oversizeFeeYuan) || 0;
  const insured = Number(waybill.insuredAmountYuan) || 0;
  const services = Array.isArray(waybill.services) ? waybill.services : [];
  if (services.includes('保价') && insured > 0) {
    fee += insured * (Number(settings.insurancePermille) || 0) / 1000;
  }
  return fee;
}

function discountPermilleOf(customer) {
  if (!customer) return 1000;
  if (customer.settle !== '月结') return 1000;
  const value = Number(customer.discountPermille);
  return Number.isFinite(value) && value > 0 ? value : 1000;
}

// 单条运单计费
function quoteWaybill(waybill, zone, customer, settings) {
  const billableKg = billableWeightKg(waybill, settings);
  const freight = freightYuan(zone, billableKg, settings);
  const surcharge = surchargeYuan(zone, waybill, billableKg, settings);
  const permille = discountPermilleOf(customer);
  const gross = freight + surcharge;
  const total = roundFen(gross * permille / 1000);
  return {
    waybillId: waybill.id,
    zoneId: zone ? zone.id : null,
    zoneName: zone ? zone.name : '',
    billableKg,
    freightYuan: roundFen(freight),
    surchargeYuan: roundFen(surcharge),
    grossYuan: roundFen(gross),
    discountPermille: permille,
    totalYuan: total,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  settingsOf,
  roundFen,
  roundUpToUnit,
  volumeWeightKg,
  billableWeightKg,
  freightYuan,
  surchargeYuan,
  discountPermilleOf,
  quoteWaybill,
};
