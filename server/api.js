const express = require('express');
const { AppError } = require('./errors');
const store = require('./store');
const zones = require('./zones');
const customers = require('./customers');
const waybills = require('./waybills');
const bills = require('./bills');
const pricing = require('./pricing');

function buildSummary() {
  const data = store.load();
  const settings = pricing.settingsOf(data);
  const decorated = data.waybills.map((waybill) => waybills.decorate(waybill, data));
  const unzoned = decorated.filter((item) => !item.zoneKnown);
  const cached = data.waybills.filter((waybill) => Number(waybill.quoteCacheYuan) > 0);
  const issued = data.bills.filter((bill) => bill.status === '已出账');
  const voided = data.bills.filter((bill) => bill.status === '已作废');
  const issuedAmount = issued.reduce((sum, bill) => sum + Number(bill.amountYuan || 0), 0);
  return {
    zoneCount: data.zones.length,
    customerCount: data.customers.length,
    waybillCount: data.waybills.length,
    billCount: data.bills.length,
    issuedCount: issued.length,
    voidedCount: voided.length,
    issuedAmountYuan: pricing.roundFen(issuedAmount),
    lockedCount: decorated.filter((item) => item.locked).length,
    unzonedCount: unzoned.length,
    unzonedCities: Array.from(new Set(unzoned.map((item) => item.toCity))),
    cachedCount: cached.length,
    statusCounts: ['待发', '在途', '已签收', '退回'].map((status) => ({
      status,
      count: decorated.filter((item) => item.status === status).length,
    })),
    periods: Array.from(new Set(data.waybills.map((waybill) => bills.periodOf(waybill)).filter(Boolean))).sort(),
    settings,
    updatedAt: data.meta.updatedAt,
  };
}

function createRouter() {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, service: '运单计费与账单核对台' });
  });

  router.get('/summary', (req, res) => {
    res.json(buildSummary());
  });

  router.get('/settings', (req, res) => {
    const data = store.load();
    res.json({ settings: pricing.settingsOf(data) });
  });

  router.patch('/settings', (req, res) => {
    const data = store.load();
    const payload = req.body || {};
    Object.keys(payload).forEach((key) => {
      if (!(key in store.DEFAULT_SETTINGS)) return;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(400, 'SETTINGS_VALUE_INVALID', '设置项 ' + key + ' 必须是不小于 0 的数字', { field: key });
      }
      data.settings[key] = value;
    });
    store.save(data);
    res.json({ settings: pricing.settingsOf(store.load()) });
  });

  router.get('/zones', (req, res) => res.json(zones.listZones()));
  router.post('/zones', (req, res) => res.status(201).json(zones.createZone(req.body || {})));
  router.patch('/zones/:id', (req, res) => res.json(zones.updateZone(req.params.id, req.body || {})));
  router.delete('/zones/:id', (req, res) => res.json(zones.removeZone(req.params.id)));

  router.get('/customers', (req, res) => res.json(customers.listCustomers()));
  router.post('/customers', (req, res) => res.status(201).json(customers.createCustomer(req.body || {})));
  router.patch('/customers/:id', (req, res) => res.json(customers.updateCustomer(req.params.id, req.body || {})));
  router.delete('/customers/:id', (req, res) => res.json(customers.removeCustomer(req.params.id)));

  router.get('/waybills', (req, res) => res.json(waybills.listWaybills(req.query || {})));
  router.post('/waybills', (req, res) => res.status(201).json(waybills.createWaybill(req.body || {})));
  router.patch('/waybills/:id', (req, res) => res.json(waybills.updateWaybill(req.params.id, req.body || {})));
  router.delete('/waybills/:id', (req, res) => res.json(waybills.removeWaybill(req.params.id)));
  router.post('/waybills/:id/quote', (req, res) => res.json(waybills.quote(req.params.id)));

  router.get('/bills', (req, res) => res.json(bills.listBills(req.query || {})));
  router.get('/periods', (req, res) => res.json(bills.listPeriods()));
  router.post('/bills/generate', (req, res) => res.status(201).json(bills.generateBill(req.body || {})));
  router.get('/bills/:id', (req, res) => res.json(bills.getBill(req.params.id)));
  router.post('/bills/:id/void', (req, res) => res.json(bills.voidBill(req.params.id)));

  router.use((req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: '没有这个接口：' + req.method + ' ' + req.path } });
  });

  return router;
}

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: String(err && err.message ? err.message : err) } });
}

module.exports = { createRouter, errorHandler, buildSummary };
