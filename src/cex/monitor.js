const client = require('./client');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const tokens = require('../config/tokens');

class CexMonitor {
    constructor() {
        this.stats = {
            mexc: { success: 0, failed: 0, totalTime: 0 },
            gateio: { success: 0, failed: 0, totalTime: 0 }
        };
        logger.info('📊 CEX монитор инициализирован');
    }

    // Убрали start() метод - теперь только checkAllPrices()

    async checkAllPrices() {
        logger.info('📊 Начинаем анализ CEX...');
        
        // Собираем уникальные пары
        const pairs = [];
        const seen = new Set();
        
        for (const token of tokens) {
            for (const [exchangeName, symbol] of Object.entries(token.cex)) {
                const key = `${exchangeName}:${symbol}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    pairs.push({
                        tokenSymbol: token.symbol,
                        exchange: exchangeName,
                        symbol: symbol
                    });
                }
            }
        }
        
        logger.debug(`📊 Уникальных пар для анализа: ${pairs.length}`);
        
        // Запускаем все запросы параллельно
        const promises = pairs.map(p => 
            this.fetchPrice(p.tokenSymbol, p.exchange, p.symbol)
        );
        
        // Ждем все запросы
        await Promise.all(promises);
        
        // Логируем статистику
        this.logStats();
    }

    async fetchPrice(tokenSymbol, exchangeName, symbol) {
        try {
            logger.debug(`📤 Запрос к ${exchangeName} для ${symbol}`);
            const startTime = Date.now();
            
            const ticker = await client.getTicker(exchangeName, symbol);
            const duration = Date.now() - startTime;
            
            if (ticker) {
                // Обновляем статистику
                if (this.stats[exchangeName]) {
                    this.stats[exchangeName].success++;
                    this.stats[exchangeName].totalTime += duration;
                }
                
                logger.info(`✅ ${exchangeName}: ${symbol} цена $${ticker.price} (${duration}ms)`);
                
                // Отправляем событие для компаратора
                eventEmitter.emit('cex:price', {
                    symbol: tokenSymbol,
                    exchange: exchangeName,
                    price: ticker.price,
                    bid: ticker.bid,
                    ask: ticker.ask,
                    volume: ticker.volume,
                    timestamp: Date.now()
                });
                
                return ticker;
            } else {
                if (this.stats[exchangeName]) {
                    this.stats[exchangeName].failed++;
                }
                logger.warn(`⚠️ Нет данных от ${exchangeName} для ${symbol}`);
                return null;
            }

        } catch (error) {
            if (this.stats[exchangeName]) {
                this.stats[exchangeName].failed++;
            }
            logger.error(`❌ Ошибка ${exchangeName} ${symbol}:`, error.message);
            return null;
        }
    }

    logStats() {
        for (const [exchange, stat] of Object.entries(this.stats)) {
            if (stat.success > 0 || stat.failed > 0) {
                const avgTime = stat.success > 0 ? (stat.totalTime / stat.success).toFixed(0) : 0;
                logger.info(`📊 ${exchange}: ✅ ${stat.success} ❌ ${stat.failed} ⏱️ ${avgTime}ms`);
            }
        }
    }
}

module.exports = new CexMonitor();