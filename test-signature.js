// test-signature.js
require('dotenv').config();
const crypto = require('crypto');

const apiSecret = process.env.MEXC_API_SECRET;
const timestamp = Date.now();
const recvWindow = 5000;

const params = {
    symbol: 'SOLUSDT',
    side: 'BUY',
    type: 'LIMIT',
    quantity: '0.1',
    price: '85.5',
    timestamp: timestamp,
    recvWindow: recvWindow,
    timeInForce: 'GTC'
};

// Сортируем ключи
const sortedKeys = Object.keys(params).sort();
const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
const signatureBase = `POST\n/api/v3/order/test\n${queryString}`;

console.log('Base string:', signatureBase);

const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureBase)
    .digest('hex');

console.log('Signature:', signature);
console.log('Full params:', { ...params, signature });