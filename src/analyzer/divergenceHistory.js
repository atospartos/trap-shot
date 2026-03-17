const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class DivergenceHistory {
    constructor() {
        // Храним историю для каждого токена
        this.history = new Map(); // symbol -> массив записей
        
        // Активные разрывы (которые еще не закрылись)
        this.activeDivergences = new Map(); // symbol -> { startTime, startSpread, ... }
        
        // Настройки
        this.windowMinutes = 5; // анализируем за последние 5 минут
        this.significantThreshold = 1.0; // считаем разрыв значимым если >1%
    }

    /**
     * Запись нового измерения
     */
    recordMeasurement(symbol, spreadPercent, direction, metadata = {}) {
        const now = Date.now();
        const absSpread = Math.abs(spreadPercent);
        
        // Сохраняем в историю
        if (!this.history.has(symbol)) {
            this.history.set(symbol, []);
        }
        
        const history = this.history.get(symbol);
        history.push({
            timestamp: now,
            spread: spreadPercent,
            absSpread,
            direction,
            ...metadata
        });
        
        // Оставляем только последние N записей (примерно за 5 минут при проверке раз в 30 сек)
        const maxRecords = 100;
        if (history.length > maxRecords) {
            history.shift();
        }

        // Проверяем начало/конец разрыва
        this._trackDivergence(symbol, spreadPercent, direction, now, metadata);
        
        // Очищаем старые записи (старше 10 минут)
        this._cleanup(symbol);
    }

    /**
     * Отслеживание начала и конца разрыва
     */
    _trackDivergence(symbol, spreadPercent, direction, timestamp, metadata) {
        const absSpread = Math.abs(spreadPercent);
        const key = `${symbol}:${direction}`;
        
        // Если разрыв значительный
        if (absSpread >= this.significantThreshold) {
            // Если еще не было активного разрыва в этом направлении
            if (!this.activeDivergences.has(key)) {
                // НАЧАЛО разрыва
                this.activeDivergences.set(key, {
                    symbol,
                    direction,
                    startTime: timestamp,
                    startSpread: absSpread,
                    maxSpread: absSpread,
                    endTime: null,
                    endSpread: null,
                    measurements: [{
                        time: timestamp,
                        spread: absSpread,
                        ...metadata
                    }]
                });
                
                logger.info(`🔴 НАЧАЛО разрыва ${symbol} ${direction}`, {
                    spread: `${absSpread.toFixed(2)}%`,
                    time: new Date(timestamp).toLocaleTimeString()
                });
                
                eventEmitter.emit('divergence:started', {
                    symbol,
                    direction,
                    spread: absSpread,
                    startTime: timestamp
                });
            } else {
                // Обновляем существующий разрыв
                const divergence = this.activeDivergences.get(key);
                divergence.maxSpread = Math.max(divergence.maxSpread, absSpread);
                divergence.measurements.push({
                    time: timestamp,
                    spread: absSpread,
                    ...metadata
                });
                
                // Храним последние 10 измерений для этого разрыва
                if (divergence.measurements.length > 10) {
                    divergence.measurements.shift();
                }
            }
        } else {
            // Разрыв закончился (если был активным)
            if (this.activeDivergences.has(key)) {
                const divergence = this.activeDivergences.get(key);
                divergence.endTime = timestamp;
                divergence.endSpread = absSpread;
                
                const duration = (timestamp - divergence.startTime) / 1000; // в секундах
                
                // Сохраняем в историю закрытых разрывов
                this._saveClosedDivergence({
                    ...divergence,
                    duration,
                    collapsed: absSpread < this.significantThreshold / 2
                });
                
                logger.info(`🟢 КОНЕЦ разрыва ${symbol} ${direction}`, {
                    duration: `${duration.toFixed(0)}с`,
                    maxSpread: `${divergence.maxSpread.toFixed(2)}%`,
                    endSpread: `${absSpread.toFixed(2)}%`
                });
                
                eventEmitter.emit('divergence:ended', {
                    symbol,
                    direction,
                    duration,
                    maxSpread: divergence.maxSpread,
                    startTime: divergence.startTime,
                    endTime: timestamp
                });
                
                this.activeDivergences.delete(key);
            }
        }
    }

    /**
     * Сохраняем закрытый разрыв в историю
     */
    _saveClosedDivergence(divergence) {
        const key = `closed:${divergence.symbol}`;
        if (!this.history.has(key)) {
            this.history.set(key, []);
        }
        
        const closed = this.history.get(key);
        closed.push({
            ...divergence,
            closedAt: Date.now()
        });
        
        // Храним последние 50 закрытых разрывов
        if (closed.length > 50) {
            closed.shift();
        }
    }

    /**
     * Очистка старых записей
     */
    _cleanup(symbol) {
        const cutoff = Date.now() - 10 * 60 * 1000; // 10 минут
        const history = this.history.get(symbol);
        
        if (history) {
            const filtered = history.filter(h => h.timestamp >= cutoff);
            this.history.set(symbol, filtered);
        }
    }

    /**
     * Получить статистику за последние N минут
     */
    getStats(symbol, minutes = 5) {
        const history = this.history.get(symbol) || [];
        const cutoff = Date.now() - minutes * 60 * 1000;
        
        const recent = history.filter(h => h.timestamp >= cutoff);
        
        if (recent.length === 0) {
            return {
                hasData: false,
                message: `Нет данных за последние ${minutes} минут`
            };
        }

        // Анализируем записи
        const spreads = recent.map(h => h.absSpread);
        const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
        const maxSpread = Math.max(...spreads);
        
        // Считаем сколько раз был значительный разрыв
        const significantCount = spreads.filter(s => s >= this.significantThreshold).length;
        
        // Анализируем направления
        const directions = recent.reduce((acc, h) => {
            acc[h.direction] = (acc[h.direction] || 0) + 1;
            return acc;
        }, {});
        
        // Получаем активные разрывы
        const active = [];
        for (const [key, div] of this.activeDivergences.entries()) {
            if (div.symbol === symbol) {
                const duration = (Date.now() - div.startTime) / 1000;
                active.push({
                    direction: div.direction,
                    durationSeconds: duration,
                    currentSpread: div.measurements[div.measurements.length - 1]?.spread,
                    maxSpread: div.maxSpread
                });
            }
        }

        return {
            hasData: true,
            periodMinutes: minutes,
            measurements: recent.length,
            
            // Статистика по спреду
            stats: {
                avgSpread: avgSpread.toFixed(2) + '%',
                maxSpread: maxSpread.toFixed(2) + '%',
                significantCount,
                frequency: ((significantCount / recent.length) * 100).toFixed(0) + '%'
            },
            
            // Направления
            directions: Object.entries(directions).map(([dir, count]) => ({
                direction: dir,
                count,
                percent: ((count / recent.length) * 100).toFixed(0) + '%'
            })),
            
            // Активные разрывы сейчас
            activeDivergences: active,
            
            // Тренд (растет или падает разрыв)
            trend: this._calculateTrend(recent),
            
            // Прогноз
            prediction: this._predictDivergence(recent)
        };
    }

    /**
     * Расчет тренда
     */
    _calculateTrend(recent) {
        if (recent.length < 5) return 'недостаточно данных';
        
        const last5 = recent.slice(-5).map(r => r.absSpread);
        const first = last5[0];
        const last = last5[last5.length - 1];
        
        if (last > first * 1.2) return '📈 растет';
        if (last < first * 0.8) return '📉 падает';
        return '➡️ стабилен';
    }

    /**
     * Простой прогноз (будет ли схлопывание)
     */
    _predictDivergence(recent) {
        if (recent.length < 10) return null;
        
        // Смотрим историю: как часто разрывы схлопывались
        const closedKey = `closed:${recent[0]?.symbol}`;
        const closed = this.history.get(closedKey) || [];
        
        if (closed.length < 5) return null;
        
        const avgDuration = closed.reduce((sum, d) => sum + d.duration, 0) / closed.length;
        const collapseRate = closed.filter(d => d.collapsed).length / closed.length;
        
        // Смотрим текущий активный разрыв
        const active = Array.from(this.activeDivergences.values())
            .find(d => d.symbol === recent[0]?.symbol);
        
        if (active) {
            const currentDuration = (Date.now() - active.startTime) / 1000;
            const remaining = Math.max(0, avgDuration - currentDuration);
            
            return {
                willCollapse: collapseRate > 0.7 ? 'вероятно' : 'может быть',
                averageLifetime: `${(avgDuration / 60).toFixed(1)} мин`,
                estimatedEnd: remaining > 0 
                    ? `через ${(remaining / 60).toFixed(1)} мин`
                    : 'скоро',
                confidence: collapseRate > 0.8 ? 'высокая' : 'средняя'
            };
        }
        
        return null;
    }

    /**
     * Получить сводку по всем токенам
     */
    getAllStats() {
        const tokens = require('../config/tokens');
        const summary = [];
        
        for (const token of tokens) {
            const stats = this.getStats(token.symbol);
            if (stats.hasData) {
                summary.push({
                    symbol: token.symbol,
                    ...stats
                });
            }
        }
        
        return summary;
    }

    /**
     * Проверка, был ли разрыв в последние X минут
     */
    hadDivergence(symbol, minutes = 5, threshold = this.significantThreshold) {
        const stats = this.getStats(symbol, minutes);
        return stats.hasData && stats.stats.significantCount > 0;
    }

    /**
     * Сколько длится текущий разрыв
     */
    getCurrentDivergenceDuration(symbol) {
        for (const [key, div] of this.activeDivergences.entries()) {
            if (div.symbol === symbol) {
                return (Date.now() - div.startTime) / 1000; // секунды
            }
        }
        return 0;
    }
}

module.exports = new DivergenceHistory();