// src/analytics/statistics.js
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class Statistics {
    constructor() {
        this.signals = {
            total: 0,
            active: new Map(), // key: symbol -> signal data
            history: []
        };

        this.tokenStats = new Map();
        this.allSignals = [];
        this.priceHistory = new Map();

        this.writeQueues = {
            signals: Promise.resolve(),
            summary: Promise.resolve()
        };

        this.isSaving = {
            signals: false,
            summary: false
        };

        this.config = {
            // Входные условия
            minSpreadPercent: 0.7,
            feePercent: 0.4,

            // Триггеры (от entrySpread)
            takeProfitReduction: 60,     // №2: схлоп 60% → тейк
            stopLossFalseReduction: 30,  // №3: ложное схлоп 30% → стоп
            stopLossIncrease: 30,        // №4: рост спреда 30% → стоп
            marketMoveThreshold: 1.0,    // №5: движение >1% → стоп
            spreadStableThreshold: 0.5,  // №5: спред изменился <0.5%

            // Таймаут
            signalTimeoutMs: 90 * 60 * 1000,

            // Данные
            dataDir: path.join(process.cwd(), 'data'),
            maxRecords: 1000,
            lookbackSeconds: 60
        };

        this.files = {
            signals: path.join(this.config.dataDir, 'signals.json'),
            summary: path.join(this.config.dataDir, 'summary.json')
        };

        if (!fs.existsSync(this.config.dataDir)) {
            fs.mkdirSync(this.config.dataDir, { recursive: true });
        }

        this.loadSignals();
        this.setupListeners();

        setInterval(() => this.saveAllData(), 30000);
        setInterval(() => this.logSummary(), 60000);

        this.saveDebounce = null;

        logger.info('📊 Модуль аналитики инициализирован');
        logger.info(`   Пороги: тейк -${this.config.takeProfitReduction}% | стоп (ложное схождение) -${this.config.stopLossFalseReduction}% | стоп (ложное расширение) +${this.config.stopLossIncrease}% | стоп (рынок) >${this.config.marketMoveThreshold}%`);
    }

    loadSignals() {
        try {
            if (fs.existsSync(this.files.signals)) {
                const data = fs.readFileSync(this.files.signals, 'utf8');
                this.allSignals = JSON.parse(data);

                // Восстанавливаем активные сигналы
                const openSignals = this.allSignals.filter(s => s.type === 'open' && !s.closed);
                for (const signal of openSignals) {
                    // Проверяем, не закрыт ли уже
                    const closed = this.allSignals.some(s => s.type === 'close' && s.id === signal.id);
                    if (!closed) {
                        this.signals.active.set(signal.symbol, {
                            id: signal.id,
                            symbol: signal.symbol,
                            direction: signal.direction,
                            entryTime: signal.timestamp,
                            entrySpread: signal.entrySpread,
                            entryNetProfit: signal.entryNetProfit,
                            entryDexPrice: signal.entryDexPrice,
                            entryCexPrice: signal.entryCexPrice,
                            status: 'active',
                            currentSpread: signal.entrySpread,
                            currentDexPrice: signal.entryDexPrice,
                            currentCexPrice: signal.entryCexPrice,
                            maxSpread: signal.entrySpread,
                            expansions: signal.expansions || []
                        });
                        this.signals.total++;
                    }
                }

                const closedSignals = this.allSignals.filter(s => s.type === 'close');
                this.signals.history = closedSignals.slice(-100);

                logger.info(`📂 Загружено ${this.allSignals.length} сигналов, активных: ${this.signals.active.size}`);
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки: ${error.message}`);
            this.allSignals = [];
        }
    }

    scheduleSave() {
        if (this.saveDebounce) clearTimeout(this.saveDebounce);
        this.saveDebounce = setTimeout(() => this.saveAllData(), 3000);
    }

    async writeToFile(filePath, data, queueName) {
        this.writeQueues[queueName] = this.writeQueues[queueName]
            .then(async () => {
                try {
                    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
                } catch (error) {
                    logger.error(`Ошибка записи ${queueName}: ${error.message}`);
                }
            });
        return this.writeQueues[queueName];
    }

    async saveAllData() {
        if (this.isSaving.signals) return;
        this.isSaving.signals = true;

        try {
            await this.writeToFile(this.files.signals, this.allSignals, 'signals');
            await this.saveSummary();
        } catch (error) {
            logger.error(`Ошибка сохранения: ${error.message}`);
        } finally {
            this.isSaving.signals = false;
        }
    }

    async saveSummary() {
        if (this.isSaving.summary) return;
        this.isSaving.summary = true;

        try {
            const stats = this.getStats();
            const summary = {
                ...stats,
                totalRecords: this.allSignals.length,
                lastUpdated: Date.now(),
                lastUpdatedDate: new Date().toISOString(),
                uptime: process.uptime()
            };
            await this.writeToFile(this.files.summary, summary, 'summary');
        } catch (error) {
            logger.error(`Ошибка сводки: ${error.message}`);
        } finally {
            this.isSaving.summary = false;
        }
    }

    updatePriceHistory(symbol, dexPrice, cexPrice, timestamp) {
        if (!this.priceHistory.has(symbol)) {
            this.priceHistory.set(symbol, { dex: [], cex: [] });
        }

        const history = this.priceHistory.get(symbol);
        history.dex.push({ price: dexPrice, timestamp });
        history.cex.push({ price: cexPrice, timestamp });

        const cutoff = timestamp - (this.config.lookbackSeconds * 1000);
        history.dex = history.dex.filter(h => h.timestamp > cutoff);
        history.cex = history.cex.filter(h => h.timestamp > cutoff);
    }

    getPriceMove(symbol, entryTime, currentPrice, type) {
        const history = this.priceHistory.get(symbol);
        if (!history) return null;

        const prices = type === 'dex' ? history.dex : history.cex;
        const entryPrice = prices.find(h => h.timestamp >= entryTime)?.price;

        if (!entryPrice) return null;

        return ((currentPrice - entryPrice) / entryPrice) * 100;
    }

    setupListeners() {
        eventEmitter.on('data:ready', this.processData.bind(this));
    }

    processData({ symbol, dexPrice, cexPrice, timestamp }) {
        if (!dexPrice || !cexPrice) return;

        const spread = ((dexPrice - cexPrice) / cexPrice) * 100;
        const absSpread = Math.abs(spread);
        const netProfit = absSpread - this.config.feePercent;

        this.updatePriceHistory(symbol, dexPrice, cexPrice, timestamp);
        this.updateTokenStats(symbol, absSpread);

        const direction = spread > 0 ? '📈 LONG (DEX > CEX)' : '📉 SHORT (CEX > DEX)';
        logger.debug(`💹 ${symbol}: ${direction} | спред: ${absSpread.toFixed(2)}% (net ${netProfit.toFixed(2)}%)`);

        const activeSignal = this.signals.active.get(symbol);

        if (activeSignal) {
            // 🔥 ЕСТЬ АКТИВНЫЙ СИГНАЛ — ОБНОВЛЯЕМ ЕГО
            this.updateActiveSignal(symbol, activeSignal, absSpread, dexPrice, cexPrice, timestamp, spread);
        } else {
            // НЕТ АКТИВНОГО СИГНАЛА — ПРОВЕРЯЕМ УСЛОВИЯ ВХОДА
            if (absSpread >= this.config.minSpreadPercent && netProfit > 0) {
                this.createSignal(symbol, spread, absSpread, dexPrice, cexPrice, timestamp);
            }
        }
    }

    createSignal(symbol, spread, absSpread, dexPrice, cexPrice, timestamp) {
        // Проверяем, нет ли уже активного сигнала
        if (this.signals.active.has(symbol)) {
            logger.debug(`${symbol}: уже есть активный сигнал, пропускаем создание нового`);
            return;
        }
        const direction = spread > 0 ? 'LONG' : 'SHORT';

        const signal = {
            id: `${symbol}_${timestamp}`,
            symbol,
            direction,
            // Исходная точка входа (НЕ МЕНЯЕТСЯ)
            entryTime: timestamp,
            entrySpread: absSpread,
            entryNetProfit: absSpread - this.config.feePercent,
            entryDexPrice: dexPrice,
            entryCexPrice: cexPrice,
            // Динамические данные
            status: 'active',
            currentSpread: absSpread,
            currentDexPrice: dexPrice,
            currentCexPrice: cexPrice,
            maxSpread: absSpread,
            maxSpreadTime: timestamp,
            expansions: []  // история расширений
        };

        this.signals.active.set(symbol, signal);
        this.signals.total++;

        const stats = this.tokenStats.get(symbol);
        if (stats) stats.signals++;

        this.allSignals.push({
            id: signal.id,
            symbol,
            direction,
            type: 'open',
            timestamp,
            date: new Date(timestamp).toISOString(),
            entrySpread: absSpread,
            entryNetProfit: absSpread - this.config.feePercent,
            entryDexPrice: dexPrice,
            entryCexPrice: cexPrice,
            closed: false
        });

        this.scheduleSave();

        const emoji = direction === 'LONG' ? '📈' : '📉';
        logger.signal(`${emoji} СИГНАЛ ${direction} ${symbol}`, {
            spread: `${absSpread.toFixed(2)}%`,
            netProfit: `${(absSpread - this.config.feePercent).toFixed(2)}%`
        });

        eventEmitter.emit('signal:new', {
            symbol,
            direction,
            spread: absSpread,
            netProfit: absSpread - this.config.feePercent,
            dexPrice,
            cexPrice
        });

        setTimeout(() => {
            const current = this.signals.active.get(symbol);
            if (current && current.id === signal.id) {
                this.closeSignal(symbol, current.currentSpread, 'timeout', null, null);
            }
        }, this.config.signalTimeoutMs);
    }

    updateActiveSignal(symbol, signal, currentSpread, dexPrice, cexPrice, timestamp, rawSpread) {
        const prevSpread = signal.currentSpread;
        signal.currentSpread = currentSpread;
        signal.currentDexPrice = dexPrice;
        signal.currentCexPrice = cexPrice;

        if (currentSpread > signal.maxSpread) {
            signal.maxSpread = currentSpread;
            signal.maxSpreadTime = timestamp;
        }

        // Расчеты от исходной точки входа
        const spreadChange = ((currentSpread - signal.entrySpread) / signal.entrySpread) * 100;
        const cexMove = this.getPriceMove(symbol, signal.entryTime, cexPrice, 'cex');
        const dexMove = this.getPriceMove(symbol, signal.entryTime, dexPrice, 'dex');

        // №1: Расширение правильное (DEX движется ОТ CEX) → ЖДЕМ + ЗАПИСЬ
        if (signal.direction === 'LONG') {
            if (spreadChange > 0 && dexMove > 0 && Math.abs(dexMove) > Math.abs(cexMove || 0)) {
                if (currentSpread > prevSpread) {
                    signal.expansions.push({
                        time: timestamp,
                        spread: currentSpread,
                        dexPrice,
                        cexPrice,
                        dexMove,
                        cexMove
                    });
                    logger.debug(`📈 ${symbol}: расширение правильное (DEX растет), запись ${currentSpread.toFixed(2)}%`);
                }
                return; // Ждем
            }
        } else {
            if (spreadChange > 0 && dexMove < 0 && Math.abs(dexMove) > Math.abs(cexMove || 0)) {
                if (currentSpread > prevSpread) {
                    signal.expansions.push({
                        time: timestamp,
                        spread: currentSpread,
                        dexPrice,
                        cexPrice,
                        dexMove,
                        cexMove
                    });
                    logger.debug(`📈 ${symbol}: расширение правильное (DEX падает), запись ${currentSpread.toFixed(2)}%`);
                }
                return; // Ждем
            }
        }

        // №2: Истинное схождение → ТЕЙК
        if (currentSpread <= signal.entrySpread * (1 - this.config.takeProfitReduction / 100)) {
            if (signal.direction === 'LONG') {
                if (cexMove > 0.1) {
                    this.closeSignal(symbol, currentSpread, 'take_profit_true', cexMove, dexMove);
                    return;
                } else {
                    this.closeSignal(symbol, currentSpread, 'stop_loss_false_collapse', cexMove, dexMove);
                    return;
                }
            }
            if (signal.direction === 'SHORT') {
                if (cexMove < -0.1) {
                    this.closeSignal(symbol, currentSpread, 'take_profit_true', cexMove, dexMove);
                    return;
                } else {
                    this.closeSignal(symbol, currentSpread, 'stop_loss_false_collapse', cexMove, dexMove);
                    return;
                }
            }
        }

        // №3: Ложное схождение → СТОП
        if (currentSpread <= signal.entrySpread * (1 - this.config.stopLossFalseReduction / 100)) {
            if (signal.direction === 'LONG' && dexMove < 0) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_collapse', cexMove, dexMove);
                return;
            }
            if (signal.direction === 'SHORT' && dexMove > 0) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_collapse', cexMove, dexMove);
                return;
            }
        }

        // №4: Расширение ложное → СТОП
        if (currentSpread >= signal.entrySpread * (1 + this.config.stopLossIncrease / 100)) {
            if (signal.direction === 'LONG' && dexMove > 0 && cexMove <= dexMove) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_expansion', cexMove, dexMove);
                return;
            }
            if (signal.direction === 'SHORT' && dexMove < 0 && cexMove >= dexMove) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_expansion', cexMove, dexMove);
                return;
            }
        }

        // №5: Рынок против нас → СТОП
        const spreadStable = Math.abs(spreadChange) < this.config.spreadStableThreshold;

        if (signal.direction === 'LONG') {
            if (cexMove < -this.config.marketMoveThreshold &&
                dexMove < -this.config.marketMoveThreshold &&
                spreadStable) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_market_drop', cexMove, dexMove);
                return;
            }
        } else {
            if (cexMove > this.config.marketMoveThreshold &&
                dexMove > this.config.marketMoveThreshold &&
                spreadStable) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_market_rise', cexMove, dexMove);
                return;
            }
        }

        // Продолжаем ждать
        logger.debug(`📊 ${symbol}: ждем, спред ${currentSpread.toFixed(2)}% (изм ${spreadChange.toFixed(1)}%)`);
    }

    closeSignal(symbol, exitSpread, reason, cexMove, dexMove) {
        const signal = this.signals.active.get(symbol);
        if (!signal || signal.status !== 'active') return;

        const exitTime = Date.now();
        const duration = (exitTime - signal.entryTime) / 1000;

        // Расчет реальной прибыли на CEX
        let profitPercent = 0;
        if (signal.direction === 'LONG') {
            profitPercent = ((signal.currentCexPrice - signal.entryCexPrice) / signal.entryCexPrice) * 100 - this.config.feePercent;
        } else {
            profitPercent = ((signal.entryCexPrice - signal.currentCexPrice) / signal.entryCexPrice) * 100 - this.config.feePercent;
        }

        const isWin = profitPercent > 0;

        // Определяем тип схождения
        let collapseType = 'unknown';
        if (reason === 'take_profit_true') collapseType = 'true';
        else if (reason === 'stop_loss_false_collapse') collapseType = 'false_collapse';
        else if (reason === 'stop_loss_false_expansion') collapseType = 'false_expansion';
        else if (reason === 'stop_loss_market_drop' || reason === 'stop_loss_market_rise') collapseType = 'market';
        else if (reason === 'timeout') collapseType = 'timeout';

        const closedSignal = {
            id: signal.id,
            symbol: signal.symbol,
            direction: signal.direction,
            type: 'close',
            timestamp: exitTime,
            date: new Date(exitTime).toISOString(),
            // Исходные данные
            entrySpread: signal.entrySpread,
            entryNetProfit: signal.entryNetProfit,
            entryCexPrice: signal.entryCexPrice,
            entryDexPrice: signal.entryDexPrice,
            // Выходные данные
            exitSpread: exitSpread,
            exitCexPrice: signal.currentCexPrice,
            exitDexPrice: signal.currentDexPrice,
            exitProfit: profitPercent,
            // Максимальный спред
            maxSpread: signal.maxSpread,
            maxSpreadTime: signal.maxSpreadTime,
            expansions: signal.expansions,
            // Результат
            reason: reason,
            collapseType: collapseType,
            duration: duration,
            isWin: isWin,
            cexMove: cexMove || 0,
            dexMove: dexMove || 0
        };

        // Обновляем запись открытия
        const openIndex = this.allSignals.findIndex(s => s.id === signal.id && s.type === 'open');
        if (openIndex !== -1) {
            this.allSignals[openIndex].closed = true;
            this.allSignals[openIndex].maxSpread = signal.maxSpread;
            this.allSignals[openIndex].expansions = signal.expansions;
        }

        this.allSignals.push(closedSignal);
        this.signals.history.unshift(closedSignal);
        if (this.signals.history.length > 100) this.signals.history.pop();
        this.signals.active.delete(symbol);

        this.updateTruthStats(symbol, collapseType, isWin, profitPercent);
        this.scheduleSave();

        const emoji = isWin ? '✅' : '❌';
        let typeEmoji = '📊';
        if (collapseType === 'true') typeEmoji = '🎯';
        else if (collapseType === 'false_collapse') typeEmoji = '⚠️';
        else if (collapseType === 'false_expansion') typeEmoji = '💀';
        else if (collapseType === 'market') typeEmoji = '🌊';

        logger.signal(`${emoji} ${typeEmoji} ЗАКРЫТ ${signal.direction} ${symbol}`, {
            profit: `${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%`,
            duration: `${duration.toFixed(1)}с`,
            reason: reason,
            exitSpread: `${exitSpread.toFixed(2)}%`,
            entrySpread: `${signal.entrySpread.toFixed(2)}%`,
            cexMove: `${cexMove > 0 ? '+' : ''}${cexMove?.toFixed(2) || 0}%`,
            dexMove: `${dexMove > 0 ? '+' : ''}${dexMove?.toFixed(2) || 0}%`
        });

        eventEmitter.emit('signal:close', {
            symbol: signal.symbol,
            direction: signal.direction,
            isWin,
            profit: profitPercent,
            duration,
            reason,
            exitSpread,
            collapseType,
            entrySpread: signal.entrySpread,
            maxSpread: signal.maxSpread,
            expansionsCount: signal.expansions.length
        });

        if (this.allSignals.length > this.config.maxRecords) {
            this.allSignals = this.allSignals.slice(-this.config.maxRecords);
        }
    }

    updateTokenStats(symbol, spread) {
        if (!this.tokenStats.has(symbol)) {
            this.tokenStats.set(symbol, {
                signals: 0,
                totalSpread: 0,
                maxSpread: 0,
                totalProfit: 0,
                wins: 0,
                losses: 0,
                truthStats: {
                    trueCollapses: 0,
                    falseCollapses: 0,
                    falseExpansions: 0,
                    marketStops: 0,
                    timeouts: 0
                }
            });
        }

        const stats = this.tokenStats.get(symbol);
        stats.totalSpread += spread;
        stats.maxSpread = Math.max(stats.maxSpread, spread);
    }

    updateTruthStats(symbol, collapseType, isWin, profit) {
        const stats = this.tokenStats.get(symbol);
        if (!stats) return;

        if (collapseType === 'true') stats.truthStats.trueCollapses++;
        else if (collapseType === 'false_collapse') stats.truthStats.falseCollapses++;
        else if (collapseType === 'false_expansion') stats.truthStats.falseExpansions++;
        else if (collapseType === 'market') stats.truthStats.marketStops++;
        else if (collapseType === 'timeout') stats.truthStats.timeouts++;

        if (isWin) {
            stats.wins++;
        } else {
            stats.losses++;
        }
        stats.totalProfit += profit;
    }

    getStats() {
        const closedSignals = this.signals.history.length;
        const wins = this.signals.history.filter(s => s.isWin).length;
        const winRate = closedSignals > 0 ? (wins / closedSignals) * 100 : 0;
        const totalProfit = this.signals.history.reduce((sum, s) => sum + (s.exitProfit || 0), 0);

        return {
            totalSignals: this.signals.total,
            activeSignals: this.signals.active.size,
            closedSignals: closedSignals,
            wins: wins,
            losses: closedSignals - wins,
            winRate: `${winRate.toFixed(1)}%`,
            totalProfit: `${totalProfit.toFixed(2)}%`,
            avgProfit: closedSignals > 0 ? `${(totalProfit / closedSignals).toFixed(2)}%` : '0%'
        };
    }

    logSummary() {
        const stats = this.getStats();

        logger.info('\n📊 ========== СТАТИСТИКА ==========');
        logger.info(`🎯 Сигналов: ${stats.totalSignals} | 🟢 Активных: ${stats.activeSignals} | ✅ Закрытых: ${stats.closedSignals}`);
        logger.info(`🏆 Винрейт: ${stats.winRate} (${stats.wins}/${stats.closedSignals}) | 💰 Прибыль: ${stats.totalProfit}`);

        logger.info('\n🎯 ТИПЫ ЗАКРЫТИЙ:');
        for (const [symbol, s] of this.tokenStats.entries()) {
            if (s.signals > 0) {
                const total = s.truthStats.trueCollapses + s.truthStats.falseCollapses + s.truthStats.falseExpansions + s.truthStats.marketStops + s.truthStats.timeouts;
                if (total > 0) {
                    const trueRate = (s.truthStats.trueCollapses / total) * 100;
                    const winRate = (s.wins / (s.wins + s.losses)) * 100;
                    const quality = winRate > 60 ? '✅' : (winRate > 40 ? '⚠️' : '❌');
                    logger.info(`   ${quality} ${symbol}: винрейт ${winRate.toFixed(0)}% | истинных схождений ${trueRate.toFixed(0)}% (${s.truthStats.trueCollapses}/${total}) | профит ${s.totalProfit.toFixed(2)}%`);
                }
            }
        }

        logger.info('===================================\n');
    }

    async shutdown() {
        logger.info('💾 Сохранение данных...');
        if (this.saveDebounce) clearTimeout(this.saveDebounce);
        await this.saveAllData();
        await Promise.all([this.writeQueues.signals, this.writeQueues.summary]);
        logger.info('✅ Данные сохранены');
    }
}

module.exports = new Statistics();