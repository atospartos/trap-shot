const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class StatisticsCollector {
    constructor() {
        // Статистика по разрывам
        this.divergenceStats = {
            total: 0,
            trueCollapses: 0,
            falseCollapses: 0,
            byToken: new Map(),
            byExchange: new Map(),
            hourly: new Array(24).fill(0),
            daily: new Map()
        };
        
        // Статистика по сигналам
        this.signalStats = {
            total: 0,
            executed: 0,
            skipped: 0,
            byToken: new Map(),
            byExchange: new Map()
        };
        
        // Статистика по циклам
        this.cycleStats = {
            count: 0,
            totalDuration: 0,
            minDuration: Infinity,
            maxDuration: 0,
            lastCycleTime: null
        };
        
        // Активный разрыв для восстановления данных
        this.activeDivergence = null;
        
        // Путь для сохранения
        this.dataPath = path.join(__dirname, '/home/mvp-trading-bot/src/analyzer/statistics.json');
        
        // Загружаем сохраненную статистику
        this.loadStats();
        
        // Подписываемся на события
        this.setupEventListeners();
        
        // Автосохранение каждые 5 минут
        setInterval(() => this.saveStats(), 5 * 60 * 1000);
    }

    setupEventListeners() {
        // Начало разрыва
        eventEmitter.on('divergence:start', this.onDivergenceStart.bind(this));
        
        // Конец разрыва
        eventEmitter.on('divergence:end', this.onDivergenceEnd.bind(this));
        
        // Сигнал
        eventEmitter.on('signal:arbitrage', this.onSignal.bind(this));
        
        // Обновление из оркестратора (длительность цикла)
        eventEmitter.on('cycle:completed', this.onCycleComplete.bind(this));
    }

    /**
     * Начало разрыва
     */
    onDivergenceStart(data) {
        const { symbol, exchange, spread, timestamp } = data;
        const hour = new Date(timestamp).getHours();
        
        // Общая статистика
        this.divergenceStats.total++;
        this.divergenceStats.hourly[hour]++;
        
        // По токену
        if (!this.divergenceStats.byToken.has(symbol)) {
            this.divergenceStats.byToken.set(symbol, {
                total: 0,
                trueCollapses: 0,
                falseCollapses: 0,
                maxSpread: 0,
                avgSpread: 0,
                spreads: []
            });
        }
        
        const tokenStat = this.divergenceStats.byToken.get(symbol);
        tokenStat.total++;
        tokenStat.spreads.push(spread);
        tokenStat.maxSpread = Math.max(tokenStat.maxSpread, spread);
        tokenStat.avgSpread = tokenStat.spreads.reduce((a, b) => a + b, 0) / tokenStat.spreads.length;
        
        // По бирже
        if (!this.divergenceStats.byExchange.has(exchange)) {
            this.divergenceStats.byExchange.set(exchange, {
                total: 0,
                trueCollapses: 0,
                falseCollapses: 0
            });
        }
        this.divergenceStats.byExchange.get(exchange).total++;
        
        // Сохраняем активный разрыв
        this.activeDivergence = {
            symbol,
            exchange,
            spread,
            startTime: timestamp,
            startSpread: spread
        };
    }

    /**
     * Конец разрыва
     */
    onDivergenceEnd(data) {
        const { symbol, exchange, duration, maxSpread, endSpread, finalCollapse, isTrue } = data;
        
        // Защита от undefined
        if (symbol === undefined || exchange === undefined) {
            logger.debug('⚠️ onDivergenceEnd: пропущены symbol или exchange');
            return;
        }
        
        // Обновляем статистику по токену
        const tokenStat = this.divergenceStats.byToken.get(symbol);
        if (tokenStat) {
            if (isTrue === true) {
                tokenStat.trueCollapses++;
                this.divergenceStats.trueCollapses++;
            } else if (isTrue === false) {
                tokenStat.falseCollapses++;
                this.divergenceStats.falseCollapses++;
            }
        }
        
        // Обновляем статистику по бирже
        const exchangeStat = this.divergenceStats.byExchange.get(exchange);
        if (exchangeStat) {
            if (isTrue === true) {
                exchangeStat.trueCollapses++;
            } else if (isTrue === false) {
                exchangeStat.falseCollapses++;
            }
        }
        
        // Обновляем дневную статистику
        const day = new Date().toISOString().split('T')[0];
        if (!this.divergenceStats.daily.has(day)) {
            this.divergenceStats.daily.set(day, {
                total: 0,
                trueCollapses: 0,
                falseCollapses: 0
            });
        }
        const dailyStat = this.divergenceStats.daily.get(day);
        dailyStat.total++;
        if (isTrue === true) dailyStat.trueCollapses++;
        if (isTrue === false) dailyStat.falseCollapses++;
        
        // Логируем статистику (с защитой от undefined)
        logger.debug(`📊 Статистика разрыва ${symbol} ${exchange}:`, {
            duration: duration !== undefined ? `${duration.toFixed(1)}с` : 'N/A',
            maxSpread: maxSpread !== undefined ? `${maxSpread.toFixed(2)}%` : 'N/A',
            collapse: finalCollapse !== undefined ? `${finalCollapse.toFixed(1)}%` : 'N/A',
            isTrue: isTrue === true ? 'истинный' : isTrue === false ? 'ложный' : 'неопределенный'
        });
    }

    /**
     * Сигнал
     */
    onSignal(data) {
        const { symbol, exchange, diffPercent, netProfit, confidence } = data;
        
        if (!symbol || !exchange) return;
        
        this.signalStats.total++;
        
        // По токену
        if (!this.signalStats.byToken.has(symbol)) {
            this.signalStats.byToken.set(symbol, {
                total: 0,
                avgProfit: 0,
                maxProfit: 0,
                profits: []
            });
        }
        
        const tokenStat = this.signalStats.byToken.get(symbol);
        tokenStat.total++;
        tokenStat.profits.push(netProfit);
        tokenStat.maxProfit = Math.max(tokenStat.maxProfit, netProfit);
        tokenStat.avgProfit = tokenStat.profits.reduce((a, b) => a + b, 0) / tokenStat.profits.length;
        
        // По бирже
        if (!this.signalStats.byExchange.has(exchange)) {
            this.signalStats.byExchange.set(exchange, {
                total: 0,
                avgProfit: 0,
                maxProfit: 0,
                profits: []
            });
        }
        
        const exchangeStat = this.signalStats.byExchange.get(exchange);
        exchangeStat.total++;
        exchangeStat.profits.push(netProfit);
        exchangeStat.maxProfit = Math.max(exchangeStat.maxProfit, netProfit);
        exchangeStat.avgProfit = exchangeStat.profits.reduce((a, b) => a + b, 0) / exchangeStat.profits.length;
        
        logger.debug(`📈 Сигнал ${symbol} ${exchange}: ${diffPercent.toFixed(2)}% (net ${netProfit.toFixed(2)}%), уверенность: ${confidence}`);
    }

    /**
     * Завершение цикла
     */
    onCycleComplete(duration) {
        if (duration === undefined || isNaN(duration)) return;
        
        this.cycleStats.count++;
        this.cycleStats.totalDuration += duration;
        this.cycleStats.minDuration = Math.min(this.cycleStats.minDuration, duration);
        this.cycleStats.maxDuration = Math.max(this.cycleStats.maxDuration, duration);
        this.cycleStats.lastCycleTime = Date.now();
        
        // Каждые 10 циклов логируем сводку
        if (this.cycleStats.count % 10 === 0) {
            this.logSummary();
        }
    }

    /**
     * Получение статистики по токену
     */
    getTokenStats(symbol) {
        const tokenDivergence = this.divergenceStats.byToken.get(symbol);
        const tokenSignals = this.signalStats.byToken.get(symbol);
        
        if (!tokenDivergence) {
            return {
                symbol,
                hasData: false,
                message: 'Нет данных по этому токену'
            };
        }
        
        const trueRate = tokenDivergence.total > 0 
            ? (tokenDivergence.trueCollapses / tokenDivergence.total) * 100 
            : 0;
        
        const avgSignalProfit = tokenSignals?.avgProfit || 0;
        
        return {
            symbol,
            hasData: true,
            divergences: {
                total: tokenDivergence.total,
                trueCollapses: tokenDivergence.trueCollapses,
                falseCollapses: tokenDivergence.falseCollapses,
                trueRate: `${trueRate.toFixed(1)}%`,
                maxSpread: `${tokenDivergence.maxSpread.toFixed(2)}%`,
                avgSpread: `${tokenDivergence.avgSpread.toFixed(2)}%`
            },
            signals: {
                total: tokenSignals?.total || 0,
                avgProfit: `${avgSignalProfit.toFixed(2)}%`,
                maxProfit: `${tokenSignals?.maxProfit?.toFixed(2) || 0}%`
            },
            grade: this.calculateGrade(trueRate, avgSignalProfit)
        };
    }

    /**
     * Расчет оценки токена
     */
    calculateGrade(trueRate, avgProfit) {
        if (trueRate > 70 && avgProfit > 1) return 'A+';
        if (trueRate > 60 && avgProfit > 0.5) return 'A';
        if (trueRate > 50 && avgProfit > 0) return 'B';
        if (trueRate > 40) return 'C';
        return 'D';
    }

    /**
     * Получение общей сводки
     */
    getSummary() {
        const now = Date.now();
        const uptime = this.cycleStats.lastCycleTime && this.cycleStats.totalDuration > 0
            ? ((now - (this.cycleStats.lastCycleTime - this.cycleStats.totalDuration)) / 1000 / 60).toFixed(1)
            : 0;
        
        const totalDivergences = this.divergenceStats.total;
        const trueRate = totalDivergences > 0 
            ? (this.divergenceStats.trueCollapses / totalDivergences) * 100 
            : 0;
        
        const avgCycleTime = this.cycleStats.count > 0 
            ? (this.cycleStats.totalDuration / this.cycleStats.count).toFixed(0)
            : 0;
        
        return {
            uptime: `${uptime} мин`,
            cycles: {
                completed: this.cycleStats.count,
                avgTime: `${avgCycleTime}ms`,
                minTime: `${this.cycleStats.minDuration === Infinity ? 0 : this.cycleStats.minDuration}ms`,
                maxTime: `${this.cycleStats.maxDuration}ms`
            },
            divergences: {
                total: totalDivergences,
                trueCollapses: this.divergenceStats.trueCollapses,
                falseCollapses: this.divergenceStats.falseCollapses,
                trueRate: `${trueRate.toFixed(1)}%`
            },
            signals: {
                total: this.signalStats.total,
                avgProfit: this.calculateAvgSignalProfit()
            },
            topTokens: this.getTopTokens(5),
            hourlyDistribution: this.getHourlyDistribution()
        };
    }

    /**
     * Расчет средней прибыли по сигналам
     */
    calculateAvgSignalProfit() {
        let totalProfit = 0;
        let count = 0;
        
        for (const [_, stats] of this.signalStats.byToken) {
            totalProfit += stats.avgProfit * stats.total;
            count += stats.total;
        }
        
        return count > 0 ? `${(totalProfit / count).toFixed(2)}%` : '0%';
    }

    /**
     * Получение топ токенов по успешности
     */
    getTopTokens(limit = 5) {
        const tokens = [];
        
        for (const [symbol, stats] of this.divergenceStats.byToken) {
            const trueRate = stats.total > 0 ? (stats.trueCollapses / stats.total) * 100 : 0;
            tokens.push({
                symbol,
                trueRate: `${trueRate.toFixed(1)}%`,
                total: stats.total
            });
        }
        
        return tokens.sort((a, b) => parseFloat(b.trueRate) - parseFloat(a.trueRate)).slice(0, limit);
    }

    /**
     * Получение распределения по часам
     */
    getHourlyDistribution() {
        const max = Math.max(...this.divergenceStats.hourly);
        return this.divergenceStats.hourly.map((count, hour) => ({
            hour,
            count,
            percent: max > 0 ? (count / max) * 100 : 0
        }));
    }

    /**
     * Логирование сводки
     */
    logSummary() {
        const summary = this.getSummary();
        
        logger.info('\n📊 ========== СТАТИСТИКА РАБОТЫ ==========');
        logger.info(`⏱️  Время работы: ${summary.uptime}`);
        logger.info(`🔄 Циклов: ${summary.cycles.completed} (среднее ${summary.cycles.avgTime})`);
        logger.info(`📈 Разрывов: ${summary.divergences.total} (истинных ${summary.divergences.trueRate})`);
        logger.info(`🎯 Сигналов: ${summary.signals.total} (средняя прибыль ${summary.signals.avgProfit})`);
        logger.info('🏆 Топ токенов:');
        
        for (const token of summary.topTokens) {
            logger.info(`   • ${token.symbol}: ${token.trueRate} (${token.total} разрывов)`);
        }
        
        logger.info('========================================\n');
    }

    /**
     * Сохранение статистики в файл
     */
    saveStats() {
        try {
            const data = {
                divergenceStats: {
                    total: this.divergenceStats.total,
                    trueCollapses: this.divergenceStats.trueCollapses,
                    falseCollapses: this.divergenceStats.falseCollapses,
                    byToken: Array.from(this.divergenceStats.byToken.entries()),
                    byExchange: Array.from(this.divergenceStats.byExchange.entries()),
                    hourly: this.divergenceStats.hourly,
                    daily: Array.from(this.divergenceStats.daily.entries())
                },
                signalStats: {
                    total: this.signalStats.total,
                    byToken: Array.from(this.signalStats.byToken.entries()),
                    byExchange: Array.from(this.signalStats.byExchange.entries())
                },
                cycleStats: this.cycleStats,
                lastSaved: Date.now()
            };
            
            const dir = path.dirname(this.dataPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
            logger.debug('📊 Статистика сохранена');
        } catch (error) {
            logger.error('❌ Ошибка сохранения статистики:', { error: error.message });
        }
    }

    /**
     * Загрузка статистики из файла
     */
    loadStats() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
                
                this.divergenceStats.total = data.divergenceStats?.total || 0;
                this.divergenceStats.trueCollapses = data.divergenceStats?.trueCollapses || 0;
                this.divergenceStats.falseCollapses = data.divergenceStats?.falseCollapses || 0;
                this.divergenceStats.byToken = new Map(data.divergenceStats?.byToken || []);
                this.divergenceStats.byExchange = new Map(data.divergenceStats?.byExchange || []);
                this.divergenceStats.hourly = data.divergenceStats?.hourly || new Array(24).fill(0);
                this.divergenceStats.daily = new Map(data.divergenceStats?.daily || []);
                
                this.signalStats.total = data.signalStats?.total || 0;
                this.signalStats.byToken = new Map(data.signalStats?.byToken || []);
                this.signalStats.byExchange = new Map(data.signalStats?.byExchange || []);
                
                this.cycleStats = data.cycleStats || this.cycleStats;
                
                logger.info(`📊 Загружена статистика: ${this.divergenceStats.total} разрывов, ${this.signalStats.total} сигналов`);
            }
        } catch (error) {
            logger.error('❌ Ошибка загрузки статистики:', { error: error.message });
        }
    }

    /**
     * Сброс статистики
     */
    reset() {
        this.divergenceStats = {
            total: 0,
            trueCollapses: 0,
            falseCollapses: 0,
            byToken: new Map(),
            byExchange: new Map(),
            hourly: new Array(24).fill(0),
            daily: new Map()
        };
        
        this.signalStats = {
            total: 0,
            executed: 0,
            skipped: 0,
            byToken: new Map(),
            byExchange: new Map()
        };
        
        this.cycleStats = {
            count: 0,
            totalDuration: 0,
            minDuration: Infinity,
            maxDuration: 0,
            lastCycleTime: null
        };
        
        logger.info('📊 Статистика сброшена');
        this.saveStats();
    }
}

module.exports = new StatisticsCollector();