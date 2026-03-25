// src/core/orchestrator.js
const logger = require('./logger');
const eventEmitter = require('./eventEmitter');
const dexMonitor = require('../dex/monitor');
const cexMonitor = require('../cex/monitor');
const statistics = require('../analyzer/statistics');

class Orchestrator {
    constructor() {
        this.isRunning = false;
        this.tokens = require('../../data/tokens');
        this.config = {
            delayBetweenTokens: 250,      // 250ms между запуском токенов
            cycleInterval: 5000,         // 5 секунд между циклами
            timeout: 2000                 // 2 секунд таймаут на запрос
        };
        this.stats = {
            cycles: 0,
            processed: 0,
            errors: 0,
            totalTime: 0
        };
    }

    async start() {
        if (this.isRunning) return;

        logger.info(`📊 Токенов в списке: ${this.tokens.length}`);

        this.tokens.forEach(token => {
            logger.info(`   - ${token.symbol}: DEX=${Object.keys(token.dex)[0]}, CEX=${token.cex}`);
        });

        this.isRunning = true;

        while (this.isRunning) {
            const cycleStart = Date.now();
            await this.runCycle();
            const cycleDuration = Date.now() - cycleStart;
            this.stats.totalTime += cycleDuration;

            if (this.isRunning) {
                logger.info(`⏳ Цикл завершен за ${(cycleDuration / 1000).toFixed(1)}с, ожидание ${this.config.cycleInterval / 1000}с...`);
                await this.delay(this.config.cycleInterval);
            }
        }
    }

    async runCycle() {
        this.stats.cycles++;
        logger.info(`\n🔄 ЦИКЛ ${this.stats.cycles}`);

        // 🔥 Параллельная обработка всех токенов
        const promises = this.tokens.map(token => this.processToken(token));
        const results = await Promise.allSettled(promises);

        const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

        logger.info(`✅ Цикл ${this.stats.cycles} завершен: ${successCount}/${this.tokens.length} токенов обработано`);
        this.stats.processed += successCount;

        // Показываем статистику каждые 10 циклов
        if (this.stats.cycles % 20 === 0) {
            const stats = statistics.getStats();
            logger.info(`📊 Статистика: ${stats.totalSignals} сигналов, винрейт ${stats.winRate}`);
        }
    }

    async processToken(token) {
        const startTime = Date.now();

        try {
            // Проверяем DEX конфигурацию
            const dexChain = Object.keys(token.dex)[0];
            const dexAddress = token.dex[dexChain];
            // 🔥 ПАРАЛЛЕЛЬНЫЕ ЗАПРОСЫ к DEX и CEX
            const dexPromise = this.withTimeout(
                dexMonitor.fetchTokenData(token.symbol, dexChain, dexAddress),
                this.config.timeout
            );

            const cexPromise = this.withTimeout(
                cexMonitor.fetchPrice(token.symbol, token.cex),
                this.config.timeout
            );

            // Ждем оба запроса параллельно
            const [dexResponse, cexResponse] = await Promise.allSettled([dexPromise, cexPromise]);

            // Обрабатываем DEX данные
            let dexData = null;
            if (dexResponse.status === 'fulfilled' && dexResponse.value) {
                const response = dexResponse.value;
                if (Array.isArray(response) && response.length > 0) {
                    dexData = response[0];
                    logger.debug(`   ✅ DEX: цена $${dexData.priceUsd}`);
                }
            }
            // Обрабатываем CEX данные
            let cexData = null;
            if (cexResponse.status === 'fulfilled' && cexResponse.value && cexResponse.value.price) {
                cexData = cexResponse.value;
                logger.debug(`   ✅ CEX: цена $${cexData.price}`);
            }
            // Проверяем наличие обоих данных
            if (!dexData || !dexData.priceUsd) {
                logger.debug(`${token.symbol}: нет DEX данных`);
                return false;
            }

            if (!cexData || !cexData.price) {
                logger.debug(`${token.symbol}: нет CEX данных`);
                return false;
            }
            // Анализируем спред для логов
            const spread = ((dexData.priceUsd - cexData.price) / cexData.price) * 100;
            const duration = Date.now() - startTime;

            logger.info(`📊 ${token.symbol}: DEX $${dexData.priceUsd} | CEX $${cexData.price} | спред ${spread.toFixed(4)}% (${duration}ms)`);

            // Отправляем данные в аналитику
            eventEmitter.emit('data:ready', {
                symbol: token.symbol,
                dexPrice: dexData.priceUsd,
                cexPrice: cexData.price,
                dexData: {
                    dexId: dexData.dexId,
                    liquidity: dexData.liquidityUsd,
                    volume: dexData.volume24h
                },
                cexData: {
                    exchange: cexData.exchange,
                    volume: cexData.volume
                },
                timestamp: Date.now()
            });

            return true;

        } catch (error) {
            this.stats.errors++;
            logger.error(`${token.symbol}: ошибка - ${error.message}`);
            return false;
        }
    }

    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
            )
        ]);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        this.isRunning = false;
        const avgTime = this.stats.cycles > 0 ? (this.stats.totalTime / this.stats.cycles / 1000).toFixed(1) : 0;
        logger.info(`🛑 Оркестратор остановлен.`);
        logger.info(`   Циклов: ${this.stats.cycles}, обработано: ${this.stats.processed}, ошибок: ${this.stats.errors}`);
        logger.info(`   Среднее время цикла: ${avgTime}с`);
    }
}

module.exports = new Orchestrator();