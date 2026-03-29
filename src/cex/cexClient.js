// src/cex/gateClient.js
const axios = require('axios');
const logger = require('../core/logger');

class GateClient {
    constructor(options = {}) {
        this.baseURL = options.baseURL || 'https://api.gateio.ws/api/v4';
        this.timeout = options.timeout || 2000;
        this.maxRequestsPerClient = 6;     // Пересоздаем после 6 запросов
        this.requestCount = 0;
        this.client = null;
        
        this.createClient();
    }

    // Создание нового клиента
    createClient() {
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: {
                'Accept': '*/*',
                'Connection': 'close'
            },
            httpAgent: false,
            httpsAgent: false
        });
        this.requestCount = 0;
        logger.debug(`🔄 Создан новый Gate.io клиент`);
    }

    // Проверка и пересоздание клиента при необходимости
    checkAndRotateClient() {
        if (this.requestCount >= this.maxRequestsPerClient) {
            logger.debug(`🔄 Пересоздание Gate.io клиента (${this.requestCount} запросов)`);
            this.createClient();
        }
    }

    async getTicker(symbol) {
        if (!symbol) {
            logger.warn('GateClient: символ не указан');
            return null;
        }

        this.checkAndRotateClient();
        
        const gateSymbol = symbol.replace('/', '_');

        try {
            const response = await this.client.get(`/spot/tickers`, {
                params: { currency_pair: gateSymbol }
            });
            
            this.requestCount++;

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
            return null;

        } catch (error) {
            if (error.response?.status === 429) {
                logger.warn(`⚠️ Rate limit, принудительное пересоздание клиента`);
                this.createClient();
            }
            return null;
        }
    }

    async getOrderBook(symbol, limit = 100) {
        this.checkAndRotateClient();
        
        const gateSymbol = symbol.replace('/', '_');
        
        try {
            const response = await this.client.get(`/spot/order_book`, {
                params: { currency_pair: gateSymbol, limit }
            });
            this.requestCount++;
            return response.data;
        } catch (error) {
            if (error.response?.status === 429) {
                logger.warn(`⚠️ Rate limit, принудительное пересоздание клиента`);
                this.createClient();
            }
            return null;
        }
    }
}

module.exports = new GateClient();

// src/cex/gateClient.js - небольшая оптимизация
// const axios = require('axios');
// const logger = require('../core/logger');

// class GateClient {
//     constructor() {
//         this.baseUrl = 'https://api.gateio.ws/api/v4';
//     }

//     async getTicker(symbol) {
//         try {
//             // Проверяем, что символ передан
//             if (!symbol) {
//                 logger.warn('GateClient: символ не указан');
//                 return null;
//             }

//             // Gate.io ожидает формат BTC_USDT, а не BTC/USDT
//             const gateSymbol = symbol.replace('/', '_');

//             logger.debug(`Gate.io запрос тикера для ${gateSymbol}`);
//             this.requestCount++;
//             const response = await axios.get(
//                 `${this.baseUrl}/spot/tickers`,
//                 {
//                     params: { currency_pair: gateSymbol },
//                     timeout: 3000
//                 }
//             );

//             if (response.data && response.data[0]) {
//                 const ticker = response.data[0];
//                 return {
//                     exchange: 'gateio',
//                     symbol,
//                     price: parseFloat(ticker.last),
//                     bid: parseFloat(ticker.highest_bid),
//                     ask: parseFloat(ticker.lowest_ask),
//                     volume: parseFloat(ticker.quote_volume),
//                     timestamp: Date.now()
//                 };
//             }

//             logger.debug(`Gate.io: нет данных для ${gateSymbol}`);
//             return null;

//         } catch (error) {
//             if (error.response) {
//                 logger.debug(`Gate.io ошибка ${error.response.status} для ${symbol}`);
//             } else {
//                 logger.debug(`Gate.io ошибка: ${error.message}`);
//             }
//             return null;
//         }
//     }

//     async getOrderBook(symbol, limit = 100) {
//         try {
//             const gateSymbol = symbol.replace('/', '_');
//             const response = await axios.get(
//                 `${this.baseUrl}/spot/order_book`,
//                 { params: { currency_pair: gateSymbol, limit }, timeout: 5000 }
//             );
//             return response.data;
//         } catch (error) {
//             logger.debug(`Gate.io orderbook error: ${error.message}`);
//             return null;
//         }
//     }
// }

// module.exports = new GateClient();