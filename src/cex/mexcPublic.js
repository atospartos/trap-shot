// src/cex/mexcPublic.js
const axios = require('axios');
const logger = require('../core/logger');

class MexcPublic {
    constructor() {
        this.baseURL = 'https://api.mexc.com';
    }

    async getTickerPrice(symbol) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/ticker/price`, {
                params: { symbol: `${symbol}USDT` },
                timeout: 5000
            });
            
            if (response.data && response.data.price) {
                return {
                    symbol,
                    price: parseFloat(response.data.price),
                    timestamp: Date.now()
                };
            }
            return null;
        } catch (error) {
            logger.debug(`Ошибка получения цены ${symbol}: ${error.message}`);
            return null;
        }
    }

    async getTicker24hr(symbol) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/ticker/24hr`, {
                params: { symbol: `${symbol}USDT` },
                timeout: 5000
            });
            return response.data;
        } catch (error) {
            logger.debug(`Ошибка 24hr статистики ${symbol}: ${error.message}`);
            return null;
        }
    }

    async getOrderBook(symbol, limit = 100) {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/depth`, {
                params: { symbol: `${symbol}USDT`, limit },
                timeout: 5000
            });
            return response.data;
        } catch (error) {
            logger.debug(`Ошибка книги ордеров ${symbol}: ${error.message}`);
            return null;
        }
    }

    async ping() {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/ping`);
            return response.status === 200;
        } catch (error) {
            return false;
        }
    }

    async getServerTime() {
        try {
            const response = await axios.get(`${this.baseURL}/api/v3/time`);
            return response.data?.serverTime;
        } catch (error) {
            return null;
        }
    }
}

module.exports = new MexcPublic();