const mexcClient = require('./mexcClient');
const gateClient = require('./gateClient');
const logger = require('../core/logger');

class CexClient {
    constructor() {
        this.clients = {
            mexc: mexcClient,
            gateio: gateClient
        };
    }

    async getTicker(exchange, symbol) {
        const client = this.clients[exchange];
        if (!client) {
            logger.warn(`Клиент для биржи ${exchange} не найден`);
            return null;
        }
        return await client.getTicker(symbol);
    }

    async getOrderBook(exchange, symbol, limit = 100) {
        const client = this.clients[exchange];
        if (!client) return null;
        return await client.getOrderBook(symbol, limit);
    }
}

module.exports = new CexClient();