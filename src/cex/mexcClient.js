const ccxt = require('ccxt');
const logger = require('../core/logger');

class MexcClient {
    constructor() {
        this.exchange = null;
        this.initialize();
    }

    initialize() {
        try {
            this.exchange = new ccxt.mexc({
                enableRateLimit: true,
                timeout: 15000,
                options: { defaultType: 'spot' }
            });
            logger.info('MEXC клиент инициализирован');
        } catch (error) {
            logger.error('Ошибка инициализации MEXC:', error.message);
        }
    }

    async getTicker(symbol) {
        if (!this.exchange) return null;
        try {
            const ticker = await this.exchange.fetchTicker(symbol);
            return {
                exchange: 'mexc',
                symbol,
                price: ticker.last,
                bid: ticker.bid,
                ask: ticker.ask,
                volume: ticker.quoteVolume,
                timestamp: ticker.timestamp
            };
        } catch (error) {
            //logger.error(`MEXC ticker error for ${symbol}:`, error.message);
            return null;
        }
    }

    async getOrderBook(symbol, limit = 100) {
        if (!this.exchange) return null;
        try {
            return await this.exchange.fetchOrderBook(symbol, limit);
        } catch (error) {
            //logger.error(`MEXC orderbook error for ${symbol}:`, error.message);
            return null;
        }
    }
}

module.exports = new MexcClient();