const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'db.json');

const DEFAULT_SETTINGS = {
  volumetricDivisor: 6000,
  minChargeYuan: 8,
  oversizeWeightKg: 30,
  oversizePieces: 3,
  oversizeFeeYuan: 20,
  insurancePermille: 20,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyData() {
  return {
    meta: { name: '运单计费与账单核对台', currency: 'CNY', updatedAt: null },
    settings: clone(DEFAULT_SETTINGS),
    zones: [],
    customers: [],
    waybills: [],
    bills: [],
  };
}

function normalize(raw) {
  const base = emptyData();
  const data = raw && typeof raw === 'object' ? raw : {};
  const out = {
    meta: Object.assign({}, base.meta, data.meta || {}),
    settings: Object.assign({}, base.settings, data.settings || {}),
    zones: Array.isArray(data.zones) ? data.zones.filter((item) => item && item.id) : [],
    customers: Array.isArray(data.customers) ? data.customers.filter((item) => item && item.id) : [],
    waybills: Array.isArray(data.waybills) ? data.waybills.filter((item) => item && item.id) : [],
    bills: Array.isArray(data.bills) ? data.bills.filter((item) => item && item.id) : [],
  };
  out.zones.forEach((zone) => {
    if (!Array.isArray(zone.cities)) zone.cities = [];
    if (!zone.aliases || typeof zone.aliases !== 'object') zone.aliases = {};
  });
  out.waybills.forEach((waybill) => {
    if (!Array.isArray(waybill.services)) waybill.services = [];
  });
  out.bills.forEach((bill) => {
    if (!Array.isArray(bill.waybillIds)) bill.waybillIds = [];
  });
  return out;
}

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(dataFile)) {
    const seeded = normalize(null);
    save(seeded);
    return seeded;
  }
  const text = fs.readFileSync(dataFile, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 的内容是否完整');
  }
  return normalize(parsed);
}

function save(data) {
  ensureDir();
  const next = normalize(data);
  next.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(dataFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function nextId(prefix, list) {
  let max = 0;
  list.forEach((item) => {
    const match = String(item.id || '').match(/(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

module.exports = { load, save, normalize, nextId, dataFile, DEFAULT_SETTINGS };
