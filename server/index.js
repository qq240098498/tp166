const path = require('path');
const express = require('express');
const { createRouter, errorHandler } = require('./api');
const store = require('./store');

const app = express();
const port = Number(process.env.PORT || 5150);

app.use(express.json());
app.use('/api', createRouter());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.use(errorHandler);

const data = store.load();
app.listen(port, () => {
  console.log('运单计费与账单核对台已启动：http://localhost:' + port);
  console.log('现有数据：分区 ' + data.zones.length + ' 个、客户 ' + data.customers.length + ' 个、运单 ' + data.waybills.length + ' 条、账单 ' + data.bills.length + ' 张');
});
