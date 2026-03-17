const ccxt = require('ccxt');
const axios = require('axios');
const logger = require('../core/logger');

class CexClient {
    constructor() {
        this.exchanges = {};
        this.initializeExchanges();
    }

    initializeExchanges() {
        // MEXC
        try {
            this.exchanges.mexc = new ccxt.mexc({
                enableRateLimit: true,
                timeout: 4000,
                options: { defaultType: 'spot' }
            });
            logger.info('MEXC инициализирована');
        } catch (error) {
            logger.error('Ошибка MEXC:', error.message);
        }

        // Gate.io
        try {
            this.exchanges.gateio = new ccxt.gateio({
                enableRateLimit: true,
                timeout: 4000,
                options: { defaultType: 'spot' }
            });
            logger.info('Gate.io инициализирована');
        } catch (error) {
            logger.error('Ошибка Gate.io:', error.message);
        }
    }

    async getTicker(exchangeName, symbol) {
        // Для Gate.io сначала пробуем прямой API (быстрее)
        if (exchangeName === 'gateio') {
            const directResult = await this.getGateTickerDirect(symbol);
            if (directResult) {
                return directResult;
            }
        }

        // Если прямой API не сработал, пробуем CCXT
        return this.getTickerCCXT(exchangeName, symbol);
    }

    async getTickerCCXT(exchangeName, symbol) {
        const exchange = this.exchanges[exchangeName];
        if (!exchange) {
            logger.warn(`Биржа ${exchangeName} не найдена`);
            return null;
        }

        try {
            logger.debug(`📤 CCXT запрос к ${exchangeName} для ${symbol}`);
            const startTime = Date.now();
            
            // Пробуем стандартный формат
            let ticker;
            try {
                ticker = await exchange.fetchTicker(symbol);
            } catch (error) {
                // Для Gate.io нужен формат с подчеркиванием
                if (exchangeName === 'gateio') {
                    const altSymbol = symbol.replace('/', '_');
                    logger.debug(`🔄 Gate.io пробуем формат: ${altSymbol}`);
                    ticker = await exchange.fetchTicker(altSymbol);
                } else {
                    throw error;
                }
            }
            
            const duration = Date.now() - startTime;
            logger.debug(`📥 CCXT ответ от ${exchangeName} за ${duration}ms`);
            
            return {
                exchange: exchangeName,
                symbol,
                price: ticker.last,
                bid: ticker.bid,
                ask: ticker.ask,
                volume: ticker.quoteVolume,
                high: ticker.high,
                low: ticker.low,
                change: ticker.percentage,
                timestamp: ticker.timestamp,
                duration
            };
        } catch (error) {
            logger.error(`❌ CCXT ошибка ${exchangeName} ${symbol}:`, error.message);
            return null;
        }
    }

    async getGateTickerDirect(symbol) {
        try {
            const gateSymbol = symbol.replace('/', '_');
            logger.debug(`🌐 Gate.io прямой API для ${gateSymbol}`);
            
            const startTime = Date.now();
            
            const response = await axios.get(
                `https://api.gateio.ws/api/v4/spot/tickers`,
                {
                    params: { currency_pair: gateSymbol },
                    timeout: 4000 // 4 секунды таймаут
                }
            );
            
            const duration = Date.now() - startTime;
            
            if (response.data && response.data[0]) {
                const ticker = response.data[0];
                logger.debug(`📥 Gate.io прямой API ответ за ${duration}ms`);
                
                return {
                    exchange: 'gateio',
                    symbol,
                    price: parseFloat(ticker.last),
                    bid: parseFloat(ticker.highest_bid),
                    ask: parseFloat(ticker.lowest_ask),
                    volume: parseFloat(ticker.quote_volume),
                    high: parseFloat(ticker.high_24h),
                    low: parseFloat(ticker.low_24h),
                    change: parseFloat(ticker.change_percentage),
                    timestamp: Date.now(),
                    duration
                };
            }
            return null;
        } catch (error) {
            logger.debug(`Gate.io прямой API не работает, пробуем CCXT: ${error.message}`);
            return null;
        }
    }

    async getOrderBook(exchangeName, symbol, limit = 100) {
        const exchange = this.exchanges[exchangeName];
        if (!exchange) return null;

        try {
            // Нормализуем символ для Gate.io
            let normalizedSymbol = symbol;
            if (exchangeName === 'gateio') {
                normalizedSymbol = symbol.replace('/', '_');
            }
            
            const orderbook = await exchange.fetchOrderBook(normalizedSymbol, limit);
            return {
                exchange: exchangeName,
                symbol,
                bids: orderbook.bids,
                asks: orderbook.asks,
                timestamp: orderbook.timestamp
            };
        } catch (error) {
            logger.error(`OrderBook error ${exchangeName}:`, error.message);
            return null;
        }
    }

    async getGateOrderBookDirect(symbol, limit = 100) {
        try {
            const gateSymbol = symbol.replace('/', '_');
            
            const response = await axios.get(
                'https://api.gateio.ws/api/v4/spot/order_book',
                {
                    params: {
                        currency_pair: gateSymbol,
                        limit: Math.min(limit, 100)
                    },
                    timeout: 4000
                }
            );

            if (response.data) {
                return {
                    exchange: 'gateio',
                    symbol,
                    bids: response.data.bids.map(b => [parseFloat(b[0]), parseFloat(b[1])]),
                    asks: response.data.asks.map(a => [parseFloat(a[0]), parseFloat(a[1])]),
                    timestamp: Date.now()
                };
            }
            return null;
        } catch (error) {
            logger.error('Gate.io orderbook direct error:', error.message);
            return null;
        }
    }
}

module.exports = new CexClient();