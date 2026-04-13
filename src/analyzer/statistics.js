// src/analytics/statistics.js
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class Statistics {
    constructor() {
        this.signals = {
            total: 0,
            active: new Map(),     // key: symbol -> активный сигнал
            history: []            // закрытые сигналы
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

        logger.info('📊 Модуль статистики инициализирован');
    }

    // ==================== ЗАГРУЗКА ====================

    loadSignals() {
        try {
            if (fs.existsSync(this.files.signals)) {
                const data = fs.readFileSync(this.files.signals, 'utf8');
                this.allSignals = JSON.parse(data);

                // Восстанавливаем активные сигналы
                const openSignals = this.allSignals.filter(s => s.type === 'open' && !s.closed);
                for (const signal of openSignals) {
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
                            execution: signal.execution || null
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

    // ==================== СЛУШАТЕЛИ ====================

    setupListeners() {
        // От Analyzer
        eventEmitter.on('signal:new', this.addSignal.bind(this));
        eventEmitter.on('signal:close', this.closeSignal.bind(this));
        eventEmitter.on('price:update', this.updatePriceHistory.bind(this));
        
        // От Executor
        eventEmitter.on('execution:report', this.onExecutionReport.bind(this));
    }

    // ==================== ДОБАВЛЕНИЕ СИГНАЛА ====================

    addSignal(signalData) {
        const signal = {
            id: signalData.id,
            symbol: signalData.symbol,
            direction: signalData.direction,
            type: 'open',
            timestamp: signalData.timestamp,
            date: new Date(signalData.timestamp).toISOString(),
            entrySpread: signalData.entrySpread,
            entryNetProfit: signalData.entryNetProfit,
            entryDexPrice: signalData.entryDexPrice,
            entryCexPrice: signalData.entryCexPrice,
            execution: {
                status: 'pending',           // pending, filled, cancelled, failed
                entryOrderId: null,
                entryFilledPrice: null,
                entryFilledAt: null,
                exitOrderId: null,
                exitPrice: null,
                exitReason: null,
                profitPercent: null
            },
            closed: false
        };

        this.allSignals.push(signal);
        this.signals.active.set(signalData.symbol, signalData);
        this.signals.total++;
        this.updateTokenStats(signalData.symbol, signalData.entrySpread);
        this.scheduleSave();

        logger.info(`📊 Сигнал добавлен: ${signalData.symbol} (${signalData.direction}) спред ${signalData.entrySpread.toFixed(2)}%`);
    }

    // ==================== ОБРАБОТКА ОТЧЕТОВ ОТ EXECUTOR ====================

    onExecutionReport({ symbol, event, data, timestamp }) {
        // Находим активный сигнал
        const activeSignal = this.signals.active.get(symbol);
        if (!activeSignal) {
            logger.debug(`Отчет по ${symbol} получен, но активный сигнал не найден`);
            return;
        }

        // Находим запись в allSignals
        const signalRecord = this.allSignals.find(s => s.id === activeSignal.id && s.type === 'open');
        if (!signalRecord) return;

        switch (event) {
            case 'entry_filled':
                signalRecord.execution.status = 'filled';
                signalRecord.execution.entryOrderId = data.orderId;
                signalRecord.execution.entryFilledPrice = data.filledPrice;
                signalRecord.execution.entryFilledAt = timestamp;
                logger.info(`📊 ${symbol}: вход исполнен по ${data.filledPrice}`);
                break;

            case 'entry_cancelled':
                signalRecord.execution.status = 'cancelled';
                signalRecord.execution.exitReason = 'cancelled';
                signalRecord.closed = true;
                this.signals.active.delete(symbol);
                logger.info(`📊 ${symbol}: вход отменен`);
                break;

            case 'entry_cancelled_by_stop':
                signalRecord.execution.status = 'cancelled';
                signalRecord.execution.exitReason = 'stop_signal';
                signalRecord.closed = true;
                this.signals.active.delete(symbol);
                logger.info(`📊 ${symbol}: вход отменен по стоп-сигналу`);
                break;

            case 'entry_failed':
                signalRecord.execution.status = 'failed';
                signalRecord.execution.exitReason = 'order_failed';
                signalRecord.closed = true;
                this.signals.active.delete(symbol);
                logger.warn(`📊 ${symbol}: не удалось выставить ордер`);
                break;

            case 'take_profit':
                signalRecord.execution.status = 'closed';
                signalRecord.execution.exitOrderId = data.orderId;
                signalRecord.execution.exitPrice = data.exitPrice;
                signalRecord.execution.exitReason = 'take_profit';
                signalRecord.execution.profitPercent = data.profitPercent;
                signalRecord.closed = true;
                this.signals.active.delete(symbol);
                this.updateProfitStats(symbol, data.profitPercent, true);
                logger.info(`📊 ${symbol}: закрыт по тейку, прибыль ${data.profitPercent.toFixed(2)}%`);
                break;

            case 'stop_loss':
                signalRecord.execution.status = 'closed';
                signalRecord.execution.exitOrderId = data.orderId;
                signalRecord.execution.exitPrice = data.exitPrice;
                signalRecord.execution.exitReason = 'stop_loss';
                signalRecord.execution.profitPercent = data.profitPercent;
                signalRecord.closed = true;
                this.signals.active.delete(symbol);
                this.updateProfitStats(symbol, data.profitPercent, false);
                logger.info(`📊 ${symbol}: закрыт по стопу, убыток ${data.profitPercent.toFixed(2)}%`);
                break;
        }

        this.scheduleSave();
    }

    // ==================== ЗАКРЫТИЕ СИГНАЛА (от Analyzer) ====================

    closeSignal(closeData) {
        const signal = this.signals.active.get(closeData.symbol);
        if (!signal) return;

        const signalRecord = this.allSignals.find(s => s.id === signal.id && s.type === 'open');
        if (!signalRecord) return;

        // Если сигнал закрыт до исполнения (таймаут и т.д.)
        if (signalRecord.execution.status === 'pending') {
            signalRecord.execution.status = 'closed_by_analyzer';
            signalRecord.execution.exitReason = closeData.reason;
            signalRecord.closed = true;
            this.signals.active.delete(closeData.symbol);
            logger.info(`📊 ${closeData.symbol}: сигнал закрыт анализатором (${closeData.reason})`);
        }

        this.scheduleSave();
    }

    // ==================== ИСТОРИЯ ЦЕН ====================

    updatePriceHistory({ symbol, dexPrice, cexPrice, timestamp }) {
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

    // ==================== СТАТИСТИКА ТОКЕНОВ ====================

    updateTokenStats(symbol, spread) {
        if (!this.tokenStats.has(symbol)) {
            this.tokenStats.set(symbol, {
                signals: 0,
                totalSpread: 0,
                maxSpread: 0,
                totalProfit: 0,
                wins: 0,
                losses: 0
            });
        }

        const stats = this.tokenStats.get(symbol);
        stats.signals++;
        stats.totalSpread += spread;
        stats.maxSpread = Math.max(stats.maxSpread, spread);
    }

    updateProfitStats(symbol, profit, isWin) {
        const stats = this.tokenStats.get(symbol);
        if (!stats) return;

        if (isWin) stats.wins++;
        else stats.losses++;
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
            closedSignals,
            wins,
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

        logger.info('\n🎯 СТАТИСТИКА ТОКЕНОВ:');
        for (const [symbol, s] of this.tokenStats.entries()) {
            if (s.signals > 0) {
                const winRate = (s.wins / (s.wins + s.losses)) * 100;
                const quality = winRate > 60 ? '✅' : (winRate > 40 ? '⚠️' : '❌');
                logger.info(`   ${quality} ${symbol}: винрейт ${winRate.toFixed(0)}% | сигналов ${s.signals} | профит ${s.totalProfit.toFixed(2)}%`);
            }
        }
        logger.info('===================================\n');
    }

    // ==================== СОХРАНЕНИЕ ====================

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

    async shutdown() {
        logger.info('💾 Сохранение данных...');
        if (this.saveDebounce) clearTimeout(this.saveDebounce);
        await this.saveAllData();
        await Promise.all([this.writeQueues.signals, this.writeQueues.summary]);
        logger.info('✅ Данные сохранены');
    }
}

module.exports = new Statistics();