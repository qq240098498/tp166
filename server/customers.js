const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');

function listCustomers() {
  const data = load();
  return {
    customers: data.customers.map((customer) => ({
      id: customer.id,
      code: customer.code,
      name: customer.name,
      settle: customer.settle,
      discountPermille: Number(customer.discountPermille),
      discountText: Number(customer.discountPermille) >= 1000 ? '不打折' : (Number(customer.discountPermille) / 10).toFixed(1) + ' 折',
      periodDay: Number(customer.periodDay || 1),
      status: customer.status,
      waybillCount: data.waybills.filter((waybill) => waybill.customerId === customer.id).length,
    })),
    total: data.customers.length,
  };
}

function findCustomer(data, id) {
  return data.customers.find((customer) => customer.id === id) || null;
}

function validateCustomerPayload(payload, current) {
  const next = Object.assign({}, current || {}, payload || {});
  const code = String(next.code || '').trim().toUpperCase();
  const name = String(next.name || '').trim();
  const settle = String(next.settle || '').trim();
  if (!/^C[0-9]{2,4}$/.test(code)) throw badRequest('CUSTOMER_CODE_INVALID', '客户编码要用 C 加数字，例如 C05', { field: 'code' });
  if (!name) throw badRequest('CUSTOMER_NAME_REQUIRED', '客户名称必填', { field: 'name' });
  if (settle !== '月结' && settle !== '现结') throw badRequest('CUSTOMER_SETTLE_INVALID', '结算方式只能是月结或现结', { field: 'settle' });
  const discountPermille = Number(next.discountPermille);
  if (!Number.isInteger(discountPermille) || discountPermille < 100 || discountPermille > 1000) {
    throw badRequest('CUSTOMER_DISCOUNT_INVALID', '折扣要用千分比表示，范围 100 到 1000', { field: 'discountPermille' });
  }
  if (settle === '现结' && discountPermille !== 1000) {
    throw badRequest('CUSTOMER_DISCOUNT_NOT_ALLOWED', '现结客户不参与折扣，折扣要填 1000', { field: 'discountPermille' });
  }
  const periodDay = Number(next.periodDay === undefined ? 1 : next.periodDay);
  if (!Number.isInteger(periodDay) || periodDay < 1 || periodDay > 28) {
    throw badRequest('CUSTOMER_PERIOD_DAY_INVALID', '账期日填 1 到 28 之间的整数', { field: 'periodDay' });
  }
  const status = String(next.status || (current ? current.status : '启用')).trim();
  if (status !== '启用' && status !== '停用') throw badRequest('CUSTOMER_STATUS_INVALID', '客户状态只能是启用或停用', { field: 'status' });
  return { code, name, settle, discountPermille, periodDay, status };
}

function createCustomer(payload) {
  const data = load();
  const clean = validateCustomerPayload(payload, null);
  if (data.customers.some((customer) => customer.code === clean.code)) {
    throw badRequest('CUSTOMER_CODE_DUPLICATE', '客户编码 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  const customer = Object.assign({ id: nextId('cust', data.customers) }, clean);
  data.customers.push(customer);
  save(data);
  return customer;
}

function updateCustomer(id, payload) {
  const data = load();
  const current = findCustomer(data, id);
  if (!current) throw notFound('CUSTOMER_NOT_FOUND', '客户不存在');
  const clean = validateCustomerPayload(payload, current);
  if (data.customers.some((customer) => customer.id !== id && customer.code === clean.code)) {
    throw badRequest('CUSTOMER_CODE_DUPLICATE', '客户编码 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  Object.assign(current, clean);
  save(data);
  return current;
}

function removeCustomer(id) {
  const data = load();
  const current = findCustomer(data, id);
  if (!current) throw notFound('CUSTOMER_NOT_FOUND', '客户不存在');
  const used = data.waybills.filter((waybill) => waybill.customerId === id);
  if (used.length > 0) {
    throw badRequest('CUSTOMER_IN_USE', '这个客户名下还有 ' + used.length + ' 条运单，先处理完再删', { count: used.length });
  }
  data.customers = data.customers.filter((customer) => customer.id !== id);
  save(data);
  return { removed: id };
}

module.exports = { listCustomers, findCustomer, createCustomer, updateCustomer, removeCustomer };
