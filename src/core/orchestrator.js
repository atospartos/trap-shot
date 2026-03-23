const logger = require('./logger');
const eventEmitter = require('./eventEmitter');
const dexMonitor = require('../dex/monitor');
const cexMonitor = require('../cex/monitor');
const telegram = require('../notifier/telegram');
const divergenceTracker = require('../notifier/divergenceTracker');
const statistics = require('../analyzer/statistics');

class Orchestrator {
    constructor() {
        this.isRunning = false;
        this.tokens = require('../config/tokens'); // Список отслеживаемых токенов
        this.activeDivergences = new Map(); // Активные разрывы для отслеживания {key: symbol:exchange -> divergence data}
        this.config = { // Настройки
            delayBetweenTokens: 250, // 250ms между запуском токенов
            cycleInterval: 5000, // 5 секунд между циклами
            timeouts: {
                dex: 2000,
                cex: 2000,
            }
        };
        this.stats = {
            cyclesCompleted: 0,
            tokensProcessed: 0,
            startTime: null,
            cycleStartTime: null
        };
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Оркестратор уже запущен');
            return;
        }

        logger.info('🚀 Запуск Trading Bot MVP (последовательный запуск токенов с паузой 250ms)');
        logger.info(`📊 Настройки: задержка между токенами ${this.config.delayBetweenTokens}ms, интервал между циклами ${this.config.cycleInterval / 1000}с`);

        if (telegram && telegram.sendStartupMessage) {
            telegram.sendStartupMessage();
        }

        this.isRunning = true;
        this.stats.startTime = Date.now();
        this.runCycles(); // Запускаем бесконечные циклы

        logger.info(`✅ Оркестратор запущен, токенов в списке: ${this.tokens.length}`);
    }

    async runCycles() {
        while (this.isRunning) {
            await this.runSingleCycle();

            if (this.isRunning) {
                logger.info(`⏳ Ожидание ${this.config.cycleInterval / 1000}с до следующего цикла...`);
                await this.delay(this.config.cycleInterval);
            }
        }
    }

    async runSingleCycle() {
        this.stats.cycleStartTime = Date.now();

        logger.info(`\n🔄 === НАЧАЛО ЦИКЛА ${this.stats.cyclesCompleted + 1} ===`);
        logger.info(`📊 Запускаем ${this.tokens.length} токенов с интервалом ${this.config.delayBetweenTokens}ms...`);

        const tokenPromises = []; // Создаем промисы для всех токенов с задержкой между запусками

        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];

            if (i > 0) {
                await this.delay(this.config.delayBetweenTokens); // Задержка перед запуском каждого токена (кроме первого)
            }
            // Запускаем обработку токена
            const promise = this.processToken(token).catch(error => {
                logger.error(`❌ [${token.symbol}] Ошибка: ${error.message}`);
                return null;
            });

            tokenPromises.push(promise);
        }

        const results = await Promise.allSettled(tokenPromises); // Ждем завершения всех токенов

        let successCount = 0;
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                successCount++; // Подсчитываем успешные
            }
        }

        const cycleDuration = Date.now() - this.stats.cycleStartTime;
        this.stats.cyclesCompleted++;
        this.stats.tokensProcessed += successCount;
        eventEmitter.emit('cycle:completed', cycleDuration);
        logger.info(`📊 Успешно: ${successCount}/${this.tokens.length} токенов`);
        logger.info(`⏱️  Длительность: ${cycleDuration}ms (${(cycleDuration / 1000).toFixed(1)}с)`);
    }

    async processToken(token) {

        const tokenStartTime = Date.now();

        try {

            const dexPromise = this.getDexData(token);// Получаем DEX данные
            const cexPromises = []; // Получаем CEX данные с разных бирж (все параллельно)

            if (token.cex?.mexc) {
                cexPromises.push(this.getCexData(token, 'mexc'));
            }
            if (token.cex?.gateio) {
                cexPromises.push(this.getCexData(token, 'gateio'));
            }
            if (token.cex?.binance) {
                cexPromises.push(this.getCexData(token, 'binance'));
            }

            const [dexResult, ...cexResults] = await Promise.allSettled([
                dexPromise,
                ...cexPromises // Ждем все запросы параллельно
            ]);

            const dexData = dexResult.status === 'fulfilled' ? dexResult.value : null;
            const cexData = cexResults
                .filter(r => r.status === 'fulfilled' && r.value)
                .map(r => r.value);

            if (dexData && cexData.length > 0) {
                this.analyzeTokenData(token.symbol, dexData, cexData); // Анализируем если есть данные

                const duration = Date.now() - tokenStartTime;
                logger.debug(`✅ [${token.symbol}] Обработан за ${duration}ms`);
                return true;
            } else {
                logger.info(`⏩ [${token.symbol}] Недостаточно данных (DEX: ${!!dexData}, CEX: ${cexData.length})`);
                return false;
            }

        } catch (error) {
            logger.error(`❌ [${token.symbol}] Ошибка: ${error.message}`);
            throw error;
        }
    }

    async getDexData(token) {
        const [dexChain, dexAddress] = Object.entries(token.dex || {})[0] || [];
        if (!dexChain || !dexAddress) return null;

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`DEX timeout after ${this.config.timeouts.dex}ms`)), this.config.timeouts.dex)
        );

        const dexPromise = dexMonitor.fetchTokenData(token.symbol, dexChain, dexAddress);

        const data = await Promise.race([dexPromise, timeoutPromise]);
        return data?.[0] || null;
    }

    async getCexData(token, exchange) {
        const symbol = token.cex?.[exchange];
        if (!symbol) return null;

        const timeout = this.config.timeouts.cex;

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${exchange} timeout after ${timeout}ms`)), timeout)
        );

        const cexPromise = cexMonitor.fetchPrice(token.symbol, exchange, symbol);

        return await Promise.race([cexPromise, timeoutPromise]);
    }

    analyzeTokenData(symbol, dexData, cexData) {
        try {
            // Защита от undefined
            if (!dexData || dexData.priceUsd === undefined || dexData.priceUsd === null) {
                logger.debug(`⏩ ${symbol}: нет DEX цены`);
                return;
            }

            const dexPrice = parseFloat(dexData.priceUsd);
            if (isNaN(dexPrice)) {
                logger.debug(`⏩ ${symbol}: невалидная DEX цена: ${dexData.priceUsd}`);
                return;
            }

            const divergences = [];

            for (const cex of cexData) {
                if (!cex || cex.price === undefined || cex.price === null) {
                    logger.debug(`⏩ ${symbol}: нет CEX цены для ${cex?.exchange}`);
                    continue;
                }

                const cexPrice = parseFloat(cex.price);
                if (isNaN(cexPrice)) {
                    logger.debug(`⏩ ${symbol}: невалидная CEX цена для ${cex.exchange}: ${cex.price}`);
                    continue;
                }

                const diffPercent = ((dexPrice - cexPrice) / cexPrice) * 100;
                const absDiff = Math.abs(diffPercent);
                const netProfit = absDiff - 0.4;

                divergences.push({
                    dexPrice,
                    cexPrice,
                    exchange: cex.exchange,
                    diffPercent,
                    absDiff,
                    netProfit
                });

                this.trackDivergence(
                    symbol,
                    cex.exchange.toUpperCase(),
                    diffPercent,
                    dexPrice,
                    cexPrice
                );
            }

            if (divergences.length === 0) {
                return;
            }

            divergences.sort((a, b) => b.absDiff - a.absDiff);

            // БЕЗОПАСНОЕ ФОРМАТИРОВАНИЕ — проверяем каждое значение
            const divergenceStrings = divergences
                .map(d => {
                    // Защита от undefined/null/NaN
                    if (d.diffPercent === undefined || isNaN(d.diffPercent)) {
                        return `${d.exchange}: цена невалидна`;
                    }
                    if (d.netProfit === undefined || isNaN(d.netProfit)) {
                        return `${d.exchange}: прибыль невалидна`;
                    }
                    if (d.dexPrice === undefined || isNaN(d.dexPrice)) {
                        return `${d.exchange}: DEX цена невалидна`;
                    }
                    if (d.cexPrice === undefined || isNaN(d.cexPrice)) {
                        return `${d.exchange}: CEX цена невалидна`;
                    }

                    const emoji = d.diffPercent > 0 ? '📈' : '📉';
                    const profitEmoji = d.netProfit > 0 ? '🟢' : '🔴';
                    const profitStr = d.netProfit > 0 ? `+${d.netProfit.toFixed(2)}` : d.netProfit.toFixed(2);
                    const diffStr = d.diffPercent > 0 ? `+${d.diffPercent.toFixed(2)}` : d.diffPercent.toFixed(2);

                    // Используем toFixed с защитой от слишком маленьких/больших чисел
                    const dexStr = d.dexPrice < 0.000001 ? d.dexPrice.toExponential(6) : d.dexPrice.toFixed(10);
                    const cexStr = d.cexPrice < 0.000001 ? d.cexPrice.toExponential(6) : d.cexPrice.toFixed(10);

                    return `${d.exchange}: ${emoji} ${diffStr}% (${profitEmoji} net ${profitStr}%) | dex: ${dexStr} cex:${cexStr}`;
                })
                .join(' | ');

            logger.info(`💹 ${symbol}: ${divergenceStrings}`);

            const significantSignals = divergences.filter(d => d.absDiff >= 1.5);
            if (significantSignals.length > 0) {
                logger.signal(`🔥 СИГНАЛ ${symbol}:`, significantSignals.map(s => ({
                    exchange: s.exchange,
                    diffPercent: s.diffPercent.toFixed(2) + '%',
                    netProfit: s.netProfit.toFixed(2) + '%'
                })));

                for (const signal of significantSignals) {
                    eventEmitter.emit('signal:arbitrage', {
                        symbol,
                        exchange: signal.exchange,
                        direction: signal.diffPercent > 0 ? 'DEX_HIGHER' : 'CEX_HIGHER',
                        diffPercent: signal.diffPercent,
                        netProfit: signal.netProfit,
                        dexPrice: signal.dexPrice,
                        cexPrice: signal.cexPrice,
                        confidence: this.calculateConfidence(symbol, signal.exchange, signal.absDiff),
                        timestamp: Date.now()
                    });
                }
            }

        } catch (error) {
            logger.error(`❌ Ошибка анализа ${symbol}:`, { error: error.message, stack: error.stack });
        }
    }

    /**
     * Отслеживание разрывов с полными данными
     */
    trackDivergence(symbol, exchange, diffPercent, dexPrice, cexPrice) {
        const absDiff = Math.abs(diffPercent);
        const key = `${symbol}:${exchange}`;
        const direction = diffPercent > 0 ? 'DEX_HIGHER' : 'CEX_HIGHER';
        const timestamp = Date.now();

        let divergence = this.activeDivergences?.get(key);
        const minTrackSpread = 1.5;

        if (!divergence && absDiff >= minTrackSpread) {
            // НАЧАЛО разрыва
            divergence = {
                symbol,
                exchange,
                direction,
                startTime: timestamp,
                startDexPrice: dexPrice,
                startCexPrice: cexPrice,
                startSpread: absDiff,
                lastSpread: absDiff,
                lastDexPrice: dexPrice,
                lastCexPrice: cexPrice,
                currentSpread: absDiff,
                currentDexPrice: dexPrice,
                currentCexPrice: cexPrice,
                dexMovePercent: 0,
                cexMovePercent: 0,
                lastNotified: { start: true }
            };

            this.activeDivergences.set(key, divergence);

            eventEmitter.emit('divergence:start', {
                symbol,
                exchange,
                direction,
                spread: absDiff,
                dexPrice,
                cexPrice,
                timestamp
            });

            logger.info(`🔴 НАЧАЛО РАЗРЫВА ${symbol} ${exchange}`, {
                spread: `${absDiff.toFixed(2)}%`,
                dex: `$${dexPrice}`,
                cex: `$${cexPrice}`,
                direction
            });

        } else if (divergence) {
            // Обновляем текущие значения
            divergence.lastSpread = absDiff;
            divergence.lastDexPrice = dexPrice;
            divergence.lastCexPrice = cexPrice;
            divergence.currentSpread = absDiff;
            divergence.currentDexPrice = dexPrice;
            divergence.currentCexPrice = cexPrice;

            const dexMovePercent = ((dexPrice - divergence.startDexPrice) / divergence.startDexPrice) * 100;
            const cexMovePercent = ((cexPrice - divergence.startCexPrice) / divergence.startCexPrice) * 100;
            const collapsePercent = ((divergence.startSpread - absDiff) / divergence.startSpread) * 100;

            divergence.dexMovePercent = dexMovePercent;
            divergence.cexMovePercent = cexMovePercent;

            eventEmitter.emit('divergence:update', {
                symbol,
                exchange,
                direction: divergence.direction,
                spread: absDiff,
                dexPrice,
                cexPrice,
                dexMovePercent,
                cexMovePercent,
                collapsePercent,
                timestamp
            });

            // Логируем только значительные изменения
            // if (collapsePercent > 5 && !divergence.causeNotified) {
            //     const isTrueCollapse = (divergence.direction === 'DEX_HIGHER' && cexMovePercent > 0) ||
            //                            (divergence.direction === 'CEX_HIGHER' && cexMovePercent < 0);

            //     const causeText = isTrueCollapse 
            //         ? `✅ ИСТИННОЕ: CEX движется к DEX`
            //         : `⚠️ ЛОЖНОЕ: DEX движется к CEX (${dexMovePercent > 0 ? 'dex_moving_up' : 'dex_moving_down'})`;

            //     logger.info(`📊 ${symbol} ${exchange}: ${causeText}`, {
            //         dexMove: `${dexMovePercent > 0 ? '+' : ''}${dexMovePercent.toFixed(2)}%`,
            //         cexMove: `${cexMovePercent > 0 ? '+' : ''}${cexMovePercent.toFixed(2)}%`,
            //         collapse: `${collapsePercent.toFixed(1)}%`
            //     });

            divergence.causeNotified = true;

            // Проверяем, не пора ли закрыть разрыв
            // При закрытии разрыва:
            if (absDiff <= 1.5 && divergence.endTime === undefined) {
                const now = Date.now();
                divergence.endTime = now;
                divergence.endSpread = absDiff;
                divergence.currentSpread = absDiff;  // ← ДОБАВИТЬ!

                const duration = (now - divergence.startTime) / 1000;
                const finalCollapse = ((divergence.startSpread - absDiff) / divergence.startSpread) * 100;

                // Логируем перед отправкой
                logger.debug(`📊 Закрытие разрыва ${symbol} ${exchange}:`, {

                    endSpread: absDiff,
                    finalCollapse,
                    duration
                });

                eventEmitter.emit('divergence:end', {
                    symbol,
                    exchange,
                    direction: divergence.direction,
                    duration,
                    endSpread: absDiff,
                    finalCollapse,
                    dexMove: dexMovePercent,
                    cexMove: cexMovePercent,
                    endTime: now
                });
                this.activeDivergences.delete(key);
            }
        }
    }

    /**
     * Расчет уверенности в сигнале
     */
    calculateConfidence(symbol, exchange, spread) {
        // Базовая уверенность от размера спреда
        let confidence = spread > 20 ? 'high' : spread > 10 ? 'medium' : 'low';

        // Проверяем статистику по токену (если есть)
        const suitability = divergenceTracker.getTokenSuitability(symbol);
        if (suitability.hasEnoughData) {
            // Если токен часто дает ложные разрывы, понижаем уверенность
            if (suitability.falseCollapseRate > 50) {
                if (confidence === 'high') confidence = 'medium';
                else if (confidence === 'medium') confidence = 'low';
                else confidence = 'very_low';
            }
            // Если токен часто дает быстрые истинные разрывы, повышаем
            else if (suitability.trueCollapseRate > 70 && suitability.fastCollapseRate > 30) {
                if (confidence === 'medium') confidence = 'high';
                else if (confidence === 'low') confidence = 'medium';
            }
        }

        return confidence;
    }

    logStats() {
        const now = Date.now();
        const uptime = ((now - this.stats.startTime) / 1000 / 60).toFixed(1);

        logger.info(`⏱️  Uptime: ${uptime} минут`);
        logger.info(`🔄 Циклов выполнено: ${this.stats.cyclesCompleted}`);
        logger.info(`📈 Токенов обработано: ${this.stats.tokensProcessed}\n`);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        this.isRunning = false;
        this.logStats();
        logger.info('🛑 Оркестратор остановлен');
    }
}

module.exports = new Orchestrator();