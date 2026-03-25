// src/cex/monitor.js - исправленная версия
const cexClient = require('./cexClient');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class CexMonitor {
    async fetchPrice(tokenSymbol, cexSymbol) {
        try {
            logger.debug(`📥 CEX запрос для ${tokenSymbol} (${cexSymbol})`);
            
            // 🔥 Исправление: передаем cexSymbol (например, "BARD/USDT") в cexClient
            const ticker = await cexClient.getTicker(cexSymbol);
            
            if (ticker && ticker.price) {
                logger.debug(`✅ ${tokenSymbol} цена $${ticker.price}`);
                
                // Отправляем событие для обратной совместимости
                eventEmitter.emit('cex:price', {
                    symbol: tokenSymbol,
                    price: ticker.price,
                    volume: ticker.volume,
                    timestamp: Date.now()
                });
                
                return {
                    price: ticker.price,
                    volume: ticker.volume,
                    exchange: 'gateio',
                    symbol: cexSymbol
                };
            }
            
            logger.warn(`⚠️ Нет данных для ${tokenSymbol} (${cexSymbol})`);
            return null;
            
        } catch (error) {
            logger.error(`❌ Ошибка CEX для ${tokenSymbol}: ${error.message}`);
            return null;  // возвращаем null вместо throw, чтобы не прерывать цикл
        }
    }
    
    // Добавляем метод для проверки доступности (опционально)
    async testConnection() {
        try {
            const ticker = await cexClient.getTicker('USDT/USDT');
            return ticker !== null;
        } catch (error) {
            return false;
        }
    }
}

module.exports = new CexMonitor();