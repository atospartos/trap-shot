// src/cex/gateClient.js - небольшая оптимизация
const axios = require('axios');
const logger = require('../core/logger');

class GateClient {
    constructor() {
        this.baseUrl = 'https://api.gateio.ws/api/v4';
    }

    async getTicker(symbol) {
        try {
            // Проверяем, что символ передан
            if (!symbol) {
                logger.warn('GateClient: символ не указан');
                return null;
            }
            
            // Gate.io ожидает формат BTC_USDT, а не BTC/USDT
            const gateSymbol = symbol.replace('/', '_');
            
            logger.debug(`Gate.io запрос тикера для ${gateSymbol}`);
            
            const response = await axios.get(
                `${this.baseUrl}/spot/tickers`,
                { 
                    params: { currency_pair: gateSymbol }, 
                    timeout: 2000 
                }
            );
            
            if (response.data && response.data[0]) {
                const ticker = response.data[0];
                return {
                    exchange: 'gateio',
                    symbol,
                    price: parseFloat(ticker.last),
                    bid: parseFloat(ticker.highest_bid),
                    ask: parseFloat(ticker.lowest_ask),
                    volume: parseFloat(ticker.quote_volume),
                    timestamp: Date.now()
                };
            }
            
            logger.debug(`Gate.io: нет данных для ${gateSymbol}`);
            return null;
            
        } catch (error) {
            if (error.response) {
                logger.debug(`Gate.io ошибка ${error.response.status} для ${symbol}`);
            } else {
                logger.debug(`Gate.io ошибка: ${error.message}`);
            }
            return null;
        }
    }

    async getOrderBook(symbol, limit = 100) {
        try {
            const gateSymbol = symbol.replace('/', '_');
            const response = await axios.get(
                `${this.baseUrl}/spot/order_book`,
                { params: { currency_pair: gateSymbol, limit }, timeout: 5000 }
            );
            return response.data;
        } catch (error) {
            logger.debug(`Gate.io orderbook error: ${error.message}`);
            return null;
        }
    }
}

module.exports = new GateClient();