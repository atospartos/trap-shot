// src/cex/cexMonitor.js
const mexcPublic = require('./mexcPublic');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class CexMonitor {
    async fetchPrice(tokenSymbol, cexSymbol) {
        try {
            const baseSymbol = cexSymbol.split('/')[0];
            logger.debug(`📥 CEX запрос для ${tokenSymbol} (${baseSymbol})`);

            const ticker = await mexcPublic.getTickerPrice(baseSymbol);

            if (ticker && ticker.price) {
                logger.debug(`✅ ${tokenSymbol} цена $${ticker.price}`);

                eventEmitter.emit('cex:price', {
                    symbol: tokenSymbol,
                    price: ticker.price,
                    timestamp: Date.now()
                });

                return {
                    price: ticker.price,
                    exchange: 'mexc',
                    symbol: cexSymbol
                };
            }

            logger.warn(`⚠️ Нет данных для ${tokenSymbol} (${cexSymbol})`);
            return null;

        } catch (error) {
            logger.error(`❌ Ошибка CEX для ${tokenSymbol}: ${error.message}`);
            return null;
        }
    }
}

module.exports = new CexMonitor();