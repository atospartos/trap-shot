const logger = require('../core/logger');
const fs = require('fs');
const path = require('path');

class StatisticalModel {
    constructor() {
        // Хранилище исторических данных
        this.history = new Map(); // symbol -> array of spread records

        // Статистические метрики для каждого токена
        this.metrics = new Map(); // symbol -> { mean, stdDev, percentiles }

        // Путь для сохранения данных (опционально)
        this.dataPath = path.join(__dirname, '../../data/spread_history.json');

        // Загружаем сохраненную историю
        this.loadHistory();
    }

    /**
     * Запись нового значения спреда
     * @param {string} symbol - Символ токена
     * @param {number} spreadPercent - Разница цен DEX/CEX в процентах
     * @param {Object} context - Дополнительный контекст (ликвидность, объем и т.д.)
     */
    recordSpread(symbol, spreadPercent, context = {}) {
        if (!this.history.has(symbol)) {
            this.history.set(symbol, []);
        }

        const record = {
            timestamp: Date.now(),
            spread: spreadPercent,
            absSpread: Math.abs(spreadPercent),
            direction: spreadPercent > 0 ? 'dex_higher' : 'cex_higher',
            ...context
        };

        const history = this.history.get(symbol);
        history.push(record);

        // Ограничиваем историю последними 1000 записей (около 3 дней при проверке раз в 5 минут)
        if (history.length > 1000) {
            history.shift();
        }

        // Пересчитываем статистику если накопилось достаточно данных
        if (history.length >= 30) {
            this.calculateMetrics(symbol);
        }

        return record;
    }

    /**
     * Расчет статистических метрик для токена
     */
    calculateMetrics(symbol) {
        const history = this.history.get(symbol);
        if (!history || history.length < 10) return null;

        // Берем только абсолютные значения спреда
        const spreads = history.map(r => r.absSpread);

        // Среднее арифметическое
        const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;

        // Стандартное отклонение
        const variance = spreads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / spreads.length;
        const stdDev = Math.sqrt(variance);

        // Медиана и процентили
        const sorted = [...spreads].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const percentile90 = sorted[Math.floor(sorted.length * 0.9)];
        const percentile95 = sorted[Math.floor(sorted.length * 0.95)];
        const percentile99 = sorted[Math.floor(sorted.length * 0.99)];

        // Минимальное и максимальное значения
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        // Анализ схлопывания спреда (как быстро возвращается к среднему)
        const meanReversion = this.analyzeMeanReversion(symbol, history);

        const metrics = {
            symbol,
            sampleSize: history.length,

            // Основные статистики
            mean,
            median,
            stdDev,

            // Процентили
            percentiles: {
                p90: percentile90,
                p95: percentile95,
                p99: percentile99
            },

            // Экстремумы
            min,
            max,
            range: max - min,

            // Коэффициент вариации (относительное отклонение)
            coefficientOfVariation: mean > 0 ? stdDev / mean : 0,

            // Метрики для стратегии
            strategy: {
                // Для входа: ждем когда спред > p90
                entryThreshold: percentile90,

                // Для тейк-профита: возврат к среднему или медиане
                takeProfit: mean * 0.8, // 80% от среднего (консервативно)

                // Для стоп-лосса: расширение спреда до p99 + запас
                stopLoss: percentile99 * 1.2, // +20% к 99-му процентилю

                // Ожидаемое схлопывание
                expectedCollapse: mean * 0.5, // обычно схлопывается на 50%

                // Максимальное наблюдаемое схлопывание
                maxCollapse: this.calculateMaxCollapse(symbol)
            },

            meanReversion,

            lastUpdated: Date.now()
        };

        this.metrics.set(symbol, metrics);

        // Сохраняем в файл
        this.saveHistory();

        return metrics;
    }

    /**
     * Анализ схлопывания спреда (как быстро возвращается к норме)
     */
    analyzeMeanReversion(symbol, history) {
        if (history.length < 20) return null;

        const reversionEvents = [];

        // Ищем моменты, когда спред был большим (> p80) и смотрит как быстро вернулся
        const spreads = history.map(r => r.absSpread);
        const sorted = [...spreads].sort((a, b) => a - b);
        const p80 = sorted[Math.floor(sorted.length * 0.8)];

        for (let i = 0; i < history.length - 5; i++) {
            if (history[i].absSpread > p80) {
                // Нашли большой спред, смотрим следующие 5 записей
                let returnTime = null;
                let returnValue = null;

                for (let j = i + 1; j < Math.min(i + 10, history.length); j++) {
                    if (history[j].absSpread <= history[i].absSpread * 0.5) {
                        // Вернулся к половине от пика
                        returnTime = (history[j].timestamp - history[i].timestamp) / 1000 / 60; // в минутах
                        returnValue = history[j].absSpread;
                        break;
                    }
                }

                if (returnTime) {
                    reversionEvents.push({
                        peakSpread: history[i].absSpread,
                        peakTime: history[i].timestamp,
                        returnSpread: returnValue,
                        returnTimeMinutes: returnTime,
                        collapsePercent: ((history[i].absSpread - returnValue) / history[i].absSpread) * 100
                    });
                }
            }
        }

        if (reversionEvents.length === 0) return null;

        // Усредняем показатели
        const avgReturnTime = reversionEvents.reduce((sum, e) => sum + e.returnTimeMinutes, 0) / reversionEvents.length;
        const avgCollapsePercent = reversionEvents.reduce((sum, e) => sum + e.collapsePercent, 0) / reversionEvents.length;

        return {
            events: reversionEvents.length,
            avgReturnTimeMinutes: avgReturnTime,
            avgCollapsePercent: avgCollapsePercent,
            typicalPattern: `Спред схлопывается на ${avgCollapsePercent.toFixed(1)}% за ${avgReturnTime.toFixed(0)} мин`
        };
    }

    /**
     * Расчет максимального схлопывания спреда
     */
    calculateMaxCollapse(symbol) {
        const history = this.history.get(symbol);
        if (!history || history.length < 10) return null;

        let maxCollapse = 0;

        for (let i = 0; i < history.length - 1; i++) {
            for (let j = i + 1; j < Math.min(i + 20, history.length); j++) {
                const collapse = history[i].absSpread - history[j].absSpread;
                if (collapse > maxCollapse) {
                    maxCollapse = collapse;
                }
            }
        }

        return maxCollapse;
    }

    /**
     * Получить рекомендации по стоп-лоссу и тейк-профиту
     */
    getRiskParameters(symbol, currentSpread) {
        const metrics = this.metrics.get(symbol);
        if (!metrics) {
            return {
                hasEnoughData: false,
                recommendedStopLoss: 5, // дефолт 5%
                recommendedTakeProfit: 2, // дефолт 2%
                confidence: 'low'
            };
        }

        const absSpread = Math.abs(currentSpread);
        const direction = currentSpread > 0 ? 'dex_higher' : 'cex_higher';

        // Динамические рекомендации на основе текущего спреда
        let recommendedStopLoss, recommendedTakeProfit, action;

        if (absSpread > metrics.percentiles.p95) {
            // Очень большой спред - можно войти с широкими стопами
            recommendedStopLoss = metrics.strategy.stopLoss;
            recommendedTakeProfit = metrics.strategy.expectedCollapse;
            action = 'aggressive_entry';
        } else if (absSpread > metrics.percentiles.p90) {
            // Большой спред - хорошая возможность
            recommendedStopLoss = metrics.percentiles.p99;
            recommendedTakeProfit = metrics.mean * 0.7;
            action = 'normal_entry';
        } else if (absSpread > metrics.mean) {
            // Выше среднего - можно рассмотреть
            recommendedStopLoss = metrics.percentiles.p95;
            recommendedTakeProfit = metrics.mean * 0.5;
            action = 'cautious_entry';
        } else {
            // Ниже среднего - ждем
            recommendedStopLoss = metrics.percentiles.p90;
            recommendedTakeProfit = metrics.mean * 0.3;
            action = 'wait';
        }

        // Рассчитываем риск/прибыль
        const riskRewardRatio = recommendedStopLoss / recommendedTakeProfit;

        return {
            hasEnoughData: true,
            symbol,
            currentSpread: absSpread,
            direction,

            // Рекомендации
            action,
            recommendedStopLoss: recommendedStopLoss.toFixed(2) + '%',
            recommendedTakeProfit: recommendedTakeProfit.toFixed(2) + '%',
            riskRewardRatio: riskRewardRatio.toFixed(2),

            // Обоснование
            reasoning: {
                entryThreshold: `Спред ${absSpread.toFixed(2)}% ${absSpread > metrics.percentiles.p90 ? '>p90' : '<p90'}`,
                expectedMove: `Ожидаем схлопывание на ${metrics.strategy.expectedCollapse.toFixed(2)}%`,
                maxRisk: `Макс. риск ${metrics.strategy.stopLoss.toFixed(2)}%`,
                confidence: metrics.sampleSize > 100 ? 'high' : metrics.sampleSize > 50 ? 'medium' : 'low'
            },

            // Полная статистика для информации
            statistics: {
                mean: metrics.mean.toFixed(2) + '%',
                median: metrics.median.toFixed(2) + '%',
                p90: metrics.percentiles.p90.toFixed(2) + '%',
                p95: metrics.percentiles.p95.toFixed(2) + '%',
                p99: metrics.percentiles.p99.toFixed(2) + '%',
                sampleSize: metrics.sampleSize
            }
        };
    }

    /**
     * Сохранение истории в файл
     */
    saveHistory() {
        try {
            const data = {
                history: Array.from(this.history.entries()),
                metrics: Array.from(this.metrics.entries()),
                lastSaved: Date.now()
            };

            fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error('Ошибка сохранения истории спредов', { error: error.message });
        }
    }

    /**
     * Загрузка истории из файла
     */
    loadHistory() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));

                this.history = new Map(data.history);
                this.metrics = new Map(data.metrics);

                logger.info(`Загружена история спредов: ${this.history.size} токенов`);
            }
        } catch (error) {
            logger.error('Ошибка загрузки истории спредов', { error: error.message });
        }
    }
    /**
 * Запись расхождения в статистику
 */
    recordDivergence(symbol, data) {
        if (!this.history) {
            this.history = new Map();
        }

        if (!this.history.has(symbol)) {
            this.history.set(symbol, []);
        }

        const history = this.history.get(symbol);
        history.push({
            timestamp: Date.now(),
            ...data
        });

        // Храним последние 1000 записей
        if (history.length > 1000) {
            history.shift();
        }

        logger.debug(`Статистика обновлена для ${symbol}: +1 запись (всего ${history.length})`);
    }

    /**
    * Получение статистики по направлению расхождений
    * @param {string} symbol - символ токена
    * @param {string} direction - направление ('DEX_HIGHER' или 'CEX_HIGHER')
    */
    getDirectionalStats(symbol, direction) {
        try {
            const history = this.history?.get(symbol) || [];

            if (history.length < 5) {
                return {
                    sampleSize: 0,
                    avgDurationMinutes: 0,
                    avgCollapsePercent: 0,
                    meanReversionRate: 0,
                    typicalPattern: 'недостаточно данных'
                };
            }

            // Фильтруем записи по направлению
            const directionalHistory = history.filter(h => {
                const hDirection = h.percent > 0 ? 'DEX_HIGHER' : 'CEX_HIGHER';
                return hDirection === direction;
            });

            if (directionalHistory.length < 3) {
                return {
                    sampleSize: directionalHistory.length,
                    avgDurationMinutes: 0,
                    avgCollapsePercent: 0,
                    meanReversionRate: 0,
                    typicalPattern: 'недостаточно данных по направлению'
                };
            }

            // Анализируем схлопывание для этого направления
            let totalCollapse = 0;
            let totalDuration = 0;
            let reversionCount = 0;

            for (let i = 0; i < directionalHistory.length - 1; i++) {
                const current = directionalHistory[i];
                const next = directionalHistory[i + 1];

                // Если был большой спред и потом уменьшился
                if (current.absSpread > 0.5 && next.absSpread < current.absSpread * 0.7) {
                    const collapse = ((current.absSpread - next.absSpread) / current.absSpread) * 100;
                    const duration = (next.timestamp - current.timestamp) / 1000 / 60; // в минутах

                    totalCollapse += collapse;
                    totalDuration += duration;
                    reversionCount++;
                }
            }

            const avgCollapse = reversionCount > 0 ? totalCollapse / reversionCount : 0;
            const avgDuration = reversionCount > 0 ? totalDuration / reversionCount : 0;
            const meanReversionRate = directionalHistory.length > 0 ?
                (reversionCount / directionalHistory.length) * 100 : 0;

            return {
                sampleSize: directionalHistory.length,
                avgDurationMinutes: avgDuration,
                avgCollapsePercent: avgCollapse,
                meanReversionRate: meanReversionRate,
                typicalPattern: avgDuration > 0 ?
                    `Обычно схлопывается на ${avgCollapse.toFixed(1)}% за ${avgDuration.toFixed(1)} мин` :
                    'нет данных о схлопывании'
            };

        } catch (error) {
            logger.error(`Ошибка в getDirectionalStats для ${symbol}:`, { error: error.message });
            return {
                sampleSize: 0,
                avgDurationMinutes: 0,
                avgCollapsePercent: 0,
                meanReversionRate: 0,
                typicalPattern: 'ошибка анализа'
            };
        }
    }

    /**
 * Получение статистики по расхождениям
 * @param {string} symbol - символ токена
 * @param {number} currentPercent - текущее расхождение (опционально)
 */
    getDivergenceStats(symbol, currentPercent = 0) {
        try {
            const history = this.history?.get(symbol) || [];

            if (history.length < 2) {
                return {
                    sampleSize: history.length,
                    mean: 0,
                    percentiles: { p90: 0, p95: 0 },
                    hasEnoughData: false,
                    percentileLabel: 'недостаточно данных'
                };
            }

            // Извлекаем значения спреда из истории
            const spreads = history
                .map(h => {
                    // Пробуем разные возможные поля
                    if (h.percent !== undefined) return Math.abs(h.percent);
                    if (h.absPercent !== undefined) return h.absPercent;
                    if (h.spread !== undefined) return Math.abs(h.spread);
                    return null;
                })
                .filter(v => v !== null && v > 0);

            if (spreads.length < 2) {
                return {
                    sampleSize: history.length,
                    mean: 0,
                    percentiles: { p90: 0, p95: 0 },
                    hasEnoughData: false,
                    percentileLabel: 'нет валидных спредов'
                };
            }

            spreads.sort((a, b) => a - b);

            const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
            const p90 = spreads[Math.floor(spreads.length * 0.9)] || spreads[spreads.length - 1] || 0;
            const p95 = spreads[Math.floor(spreads.length * 0.95)] || spreads[spreads.length - 1] || 0;

            return {
                sampleSize: history.length,
                mean,
                percentiles: { p90, p95 },
                hasEnoughData: history.length >= 30,
                percentileLabel: this._getPercentileLabel(spreads, currentPercent)
            };

        } catch (error) {
            logger.error(`Ошибка в getDivergenceStats для ${symbol}:`, {
                error: error.message,
                stack: error.stack
            });

            // Возвращаем объект по умолчанию в случае ошибки
            return {
                sampleSize: 0,
                mean: 0,
                percentiles: { p90: 0, p95: 0 },
                hasEnoughData: false,
                percentileLabel: 'ошибка'
            };
        }
    }

    _getPercentileLabel(spreads, value) {
        if (spreads.length === 0) return 'unknown';

        const percentile = (spreads.filter(s => s < value).length / spreads.length) * 100;

        if (percentile > 95) return '>95%';
        if (percentile > 90) return '>90%';
        if (percentile > 75) return '>75%';
        if (percentile > 50) return '>50%';
        return 'normal';
    }
}

module.exports = new StatisticalModel();