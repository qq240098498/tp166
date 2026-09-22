const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');

const SERVICES = ['保价', '签收', '上门'];

function decorate(waybill, data) {
  const customer = findCustomer(data, waybill.customerId);
  const zone = zones.zoneOfCity(data, waybill.toCity);
  const index = zones.cityIndex(data);
  const known = index.has(zones.cleanCity(waybill.toCity));
  const bill = data.bills.find((item) => item.id === waybill.billId) || null;
  return Object.assign({}, waybill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    settle: customer ? customer.settle : '',
    zoneId: zone ? zone.id : '',
    zoneName: zone ? zone.name : '未归属',
    zoneKnown: known,
    billCode: bill ? bill.code : '',
    billStatus: bill ? bill.status : '',
    locked: Boolean(waybill.billId),
    weightText: Number(waybill.weightKg).toFixed(2) + ' kg',
    volumeText: Number(waybill.volumeM3).toFixed(3) + ' m³',
    createdAtText: String(waybill.createdAt || '').replace('T', ' ').slice(0, 16),
  });
}

function listWaybills(query) {
  const data = load();
  const keyword = String((query && query.keyword) || '').trim();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  const unzoned = String((query && query.unzoned) || '').trim() === '1';
  let items = data.waybills.map((waybill) => decorate(waybill, data));
  if (customerId) items = items.filter((item) => item.customerId === customerId);
  if (status) items = items.filter((item) => item.status === status);
  if (unzoned) items = items.filter((item) => !item.zoneKnown);
  if (keyword) {
    const needle = keyword.toLowerCase();
    items = items.filter((item) => [item.code, item.fromCity, item.toCity, item.customerName].join(' ').toLowerCase().includes(needle));
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    waybills: items,
    total: items.length,
    lockedCount: items.filter((item) => item.locked).length,
    unzonedCount: items.filter((item) => !item.zoneKnown).length,
  };
}

function findWaybill(data, id) {
  return data.waybills.find((waybill) => waybill.id === id) || null;
}

function validateWaybillPayload(payload, current) {
  const next = Object.assign({}, current || {}, payload || {});
  const code = String(next.code || '').trim();
  const customerId = String(next.customerId || '').trim();
  const fromCity = String(next.fromCity || '').trim();
  const toCity = String(next.toCity || '').trim();
  const status = String(next.status || (current ? current.status : '待发')).trim();
  if (!code) throw badRequest('WAYBILL_CODE_REQUIRED', '运单号必填', { field: 'code' });
  if (!/^YD[0-9]{8,14}$/.test(code)) throw badRequest('WAYBILL_CODE_INVALID', '运单号要用 YD 加数字，例如 YD20260901001', { field: 'code' });
  if (!customerId) throw badRequest('WAYBILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  if (!fromCity) throw badRequest('WAYBILL_FROM_REQUIRED', '寄件城市必填', { field: 'fromCity' });
  if (!toCity) throw badRequest('WAYBILL_TO_REQUIRED', '收件城市必填', { field: 'toCity' });
  if (!['待发', '在途', '已签收', '退回'].includes(status)) {
    throw badRequest('WAYBILL_STATUS_INVALID', '运单状态只能是待发、在途、已签收或退回', { field: 'status' });
  }
  const weightKg = Number(next.weightKg);
  const volumeM3 = Number(next.volumeM3);
  const pieces = Number(next.pieces === undefined ? 1 : next.pieces);
  const insuredAmountYuan = Number(next.insuredAmountYuan === undefined ? 0 : next.insuredAmountYuan);
  if (!(weightKg > 0)) throw badRequest('WAYBILL_WEIGHT_INVALID', '实际重量必须是大于 0 的数字', { field: 'weightKg' });
  if (!(volumeM3 > 0)) throw badRequest('WAYBILL_VOLUME_INVALID', '体积必须是大于 0 的数字', { field: 'volumeM3' });
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 99) throw badRequest('WAYBILL_PIECES_INVALID', '件数填 1 到 99 之间的整数', { field: 'pieces' });
  if (!(insuredAmountYuan >= 0)) throw badRequest('WAYBILL_INSURED_INVALID', '保价金额必须是不小于 0 的数字', { field: 'insuredAmountYuan' });
  const services = Array.isArray(next.services) ? next.services.map((item) => String(item).trim()).filter(Boolean) : [];
  services.forEach((item) => {
    if (!SERVICES.includes(item)) throw badRequest('WAYBILL_SERVICE_INVALID', '附加服务只能是：' + SERVICES.join('、'), { field: 'services' });
  });
  if (services.includes('保价') && !(insuredAmountYuan > 0)) {
    throw badRequest('WAYBILL_INSURED_REQUIRED', '选了保价就要填保价金额', { field: 'insuredAmountYuan' });
  }
  const createdAt = String(next.createdAt || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(createdAt)) {
    throw badRequest('WAYBILL_CREATED_INVALID', '创建时刻要形如 2026-09-01 10:30', { field: 'createdAt' });
  }
  return { code, customerId, fromCity, toCity, status, weightKg, volumeM3, pieces, insuredAmountYuan, services, createdAt };
}

function createWaybill(payload) {
  const data = load();
  const clean = validateWaybillPayload(payload, null);
  if (!findCustomer(data, clean.customerId)) throw badRequest('WAYBILL_CUSTOMER_NOT_FOUND', '选的客户不存在', { field: 'customerId' });
  if (data.waybills.some((waybill) => waybill.code === clean.code)) {
    throw badRequest('WAYBILL_CODE_DUPLICATE', '运单号 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  const waybill = Object.assign({ id: nextId('wb', data.waybills) }, clean, { billId: null, quoteCacheYuan: null });
  data.waybills.push(waybill);
  save(data);
  return decorate(waybill, load());
}

function updateWaybill(id, payload) {
  const data = load();
  const current = findWaybill(data, id);
  if (!current) throw notFound('WAYBILL_NOT_FOUND', '运单不存在');
  const clean = validateWaybillPayload(payload, current);
  if (data.waybills.some((waybill) => waybill.id !== id && waybill.code === clean.code)) {
    throw badRequest('WAYBILL_CODE_DUPLICATE', '运单号 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  if (!findCustomer(data, clean.customerId)) throw badRequest('WAYBILL_CUSTOMER_NOT_FOUND', '选的客户不存在', { field: 'customerId' });
  Object.assign(current, clean);
  save(data);
  return decorate(current, load());
}

function removeWaybill(id) {
  const data = load();
  const current = findWaybill(data, id);
  if (!current) throw notFound('WAYBILL_NOT_FOUND', '运单不存在');
  if (current.billId) throw badRequest('WAYBILL_LOCKED', '这条运单已经进账单，不能直接删', { field: 'billId' });
  data.waybills = data.waybills.filter((waybill) => waybill.id !== id);
  save(data);
  return { removed: id };
}

// 单条计费：算完之后把结果记在运单上，页面上再次打开可以直接看到上次算出来的数
function quote(id) {
  const data = load();
  const waybill = findWaybill(data, id);
  if (!waybill) throw notFound('WAYBILL_NOT_FOUND', '运单不存在');
  const settings = pricing.settingsOf(data);
  const zone = zones.zoneOfCity(data, waybill.toCity);
  if (!zone) throw badRequest('WAYBILL_ZONE_UNKNOWN', '收件城市 ' + waybill.toCity + ' 还没有归属到任何分区');
  const customer = findCustomer(data, waybill.customerId);
  const result = pricing.quoteWaybill(waybill, zone, customer, settings);
  waybill.quoteCacheYuan = result.totalYuan;
  waybill.quoteCachedAt = new Date().toISOString();
  save(data);
  return Object.assign({ waybill: decorate(waybill, load()) }, result);
}

module.exports = {
  listWaybills,
  findWaybill,
  createWaybill,
  updateWaybill,
  removeWaybill,
  quote,
  decorate,
  SERVICES,
};
