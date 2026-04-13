// src/cex/mexcPrivate.js
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../core/logger');

class MexcPrivate {
    constructor() {
        this.baseURL = 'https://api.mexc.com/api/v3';
        this.apiKey = process.env.MEXC_API_KEY;
        this.apiSecret = process.env.MEXC_API_SECRET;
        this.testMode = process.env.TEST_MODE === 'true';

        if (!this.apiKey || !this.apiSecret) {
            logger.error('❌ MEXC API ключи не найдены в .env');
        }

        logger.info(`🔐 MEXC Private клиент инициализирован ${this.testMode ? '(ТЕСТОВЫЙ РЕЖИМ)' : '(РЕАЛЬНЫЙ РЕЖИМ)'}`);
    }

    /**
     * Генерация подписи по стандарту MEXC
     * @param {string} method - HTTP метод
     * @param {string} endpoint - эндпоинт
     * @param {Object} queryParams - параметры в строке запроса
     * @param {Object} bodyParams - параметры в теле запроса
     * @returns {string} подпись (строчные буквы)
     */
    generateSignature(method, endpoint, queryParams = {}, bodyParams = {}) {
        // Объединяем параметры (query string + body)
        const allParams = { ...queryParams, ...bodyParams };

        // Сортируем ключи
        const sortedKeys = Object.keys(allParams).sort();

        // Формируем строку для подписи: param1=value1&param2=value2...
        const signatureString = sortedKeys
            .map(key => `${key}=${allParams[key]}`)
            .join('&');

        logger.debug(`Строка для подписи: ${signatureString}`);

        // Генерируем HMAC SHA256 подпись (строчные буквы)
        const signature = crypto
            .createHmac('sha256', this.apiSecret)
            .update(signatureString)
            .digest('hex')
            .toLowerCase();

        logger.debug(`Подпись: ${signature}`);

        return signature;
    }

    /**
     * Выполнение запроса к API
     */
    async request(method, endpoint, queryParams = {}, bodyParams = null) {
        const timestamp = Date.now();
        const recvWindow = 5000;

        // Базовые параметры (всегда в query string для подписи)
        const baseParams = {
            timestamp: timestamp,
            recvWindow: recvWindow
        };

        // Объединяем параметры для подписи
        const allQueryParams = { ...queryParams, ...baseParams };

        // Определяем фактический эндпоинт для тестового режима
        let actualEndpoint = endpoint;
        if (this.testMode && endpoint === '/order') {
            actualEndpoint = '/order/test';
        }

        // Генерируем подпись
        const signature = this.generateSignature(method, actualEndpoint, allQueryParams, bodyParams || {});

        // Добавляем подпись в query параметры
        const finalQueryParams = { ...allQueryParams, signature };

        // Формируем URL
        const queryString = Object.keys(finalQueryParams)
            .sort()
            .map(key => `${key}=${finalQueryParams[key]}`)
            .join('&');

        const url = `${this.baseURL}${actualEndpoint}?${queryString}`;

        // Заголовки
        const headers = {
            'X-MEXC-APIKEY': this.apiKey,
            'Content-Type': 'application/json'
        };

        logger.debug(`${method} ${url}`);

        try {
            let response;
            switch (method.toUpperCase()) {
                case 'GET':
                    response = await axios.get(url, { headers });
                    break;
                case 'POST':
                    response = await axios.post(url, bodyParams, { headers });
                    break;
                case 'DELETE':
                    response = await axios.delete(url, { headers });
                    break;
                default:
                    throw new Error(`Unsupported method: ${method}`);
            }

            return response.data;
        } catch (error) {
            const errorMsg = error.response?.data?.msg || error.message;
            const errorCode = error.response?.data?.code;
            logger.error(`❌ API ошибка (${errorCode}): ${errorMsg}`);
            return { error: true, code: errorCode, msg: errorMsg };
        }
    }

    /**
     * Создание ордера
     */
    async placeOrder(symbol, side, type, quantity, price = null) {
        const queryParams = {
            symbol: `${symbol}USDT`,
            side: side.toUpperCase(),
            type: type.toUpperCase(),
            quantity: quantity.toString()
        };

        const bodyParams = {};

        if (price && type.toUpperCase() === 'LIMIT') {
            queryParams.price = price.toString();
            queryParams.timeInForce = 'GTC';
        }

        const result = await this.request('POST', '/order', queryParams, bodyParams);

        if (result.error) {
            return null;
        }

        if (this.testMode) {
            logger.info(`🧪 [TEST] Ордер валиден: ${side} ${quantity} ${symbol} ${price ? `по ${price}` : 'рынок'}`);
            return { orderId: `test_${Date.now()}`, testMode: true };
        }

        logger.info(`✅ Ордер выставлен: ${side} ${quantity} ${symbol} ${price ? `по ${price}` : 'рынок'} (ID: ${result.orderId})`);
        return result;
    }

    /**
     * Отмена ордера
     */
    async cancelOrder(symbol, orderId) {
        const queryParams = {
            symbol: `${symbol}USDT`,
            orderId: orderId
        };

        const result = await this.request('DELETE', '/order', queryParams);

        if (result.error) {
            return null;
        }

        logger.info(`✅ Ордер ${orderId} отменен`);
        return result;
    }

    /**
     * Получение информации об ордере
     */
    async getOrder(symbol, orderId) {
        const queryParams = {
            symbol: `${symbol}USDT`,
            orderId: orderId
        };

        const result = await this.request('GET', '/order', queryParams);

        if (result.error) {
            return null;
        }

        return result;
    }

    /**
     * Получение открытых ордеров
     */
    async getOpenOrders(symbol = null) {
        const queryParams = {};
        if (symbol) {
            queryParams.symbol = `${symbol}USDT`;
        }

        const result = await this.request('GET', '/openOrders', queryParams);

        if (result.error) {
            return [];
        }

        return result;
    }

    /**
     * Получение информации об аккаунте
     */
    async getAccountInfo() {
        const result = await this.request('GET', '/account', {});

        if (result.error) {
            return null;
        }

        return result;
    }

    /**
     * Получение баланса USDT
     */
    async getUSDTBalance() {
        const account = await this.getAccountInfo();
        if (!account || !account.balances) return 0;

        const balance = account.balances.find(b => b.asset === 'USDT');
        return balance ? parseFloat(balance.free) : 0;
    }
    
    async hasSufficientFunds(symbol, quantity, price) {
        const usdtBalance = await this.getUSDTBalance();
        const requiredAmount = parseFloat(quantity) * parseFloat(price);
        return usdtBalance >= requiredAmount;
    }
}

module.exports = new MexcPrivate();