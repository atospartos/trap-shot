const logger = require('../core/logger');

class CexState {
    constructor() {
        // Храним последние данные по каждому символу на каждой бирже
        this.lastTickers = new Map(); // key: exchange:symbol -> ticker
        this.lastOrderBooks = new Map(); // key: exchange:symbol -> orderbook
        this.lastAnalyses = new Map(); // key: exchange:symbol -> analysis
        this.history = new Map(); // key: exchange:symbol -> array of historical ticks
        
        // Конфигурация
        this.maxHistoryLength = 100; // храним последние 100 записей
        this.maxOrderBookHistory = 20; // храним последние 20 анализов стакана
    }

    // ========== ТИКЕРЫ ==========

    /**
     * Обновление тикера
     * @returns {Object} предыдущее состояние
     */
    updateTicker(exchange, symbol, ticker) {
        const key = `${exchange}:${symbol}`;
        const previous = this.lastTickers.get(key);
        
        // Сохраняем текущий
        this.lastTickers.set(key, {
            ...ticker,
            timestamp: Date.now()
        });
        
        // Сохраняем в историю
        if (!this.history.has(key)) {
            this.history.set(key, []);
        }
        
        const history = this.history.get(key);
        history.push({
            price: ticker.price,
            volume: ticker.volume,
            bid: ticker.bid,
            ask: ticker.ask,
            timestamp: Date.now()
        });
        
        // Ограничиваем длину истории
        if (history.length > this.maxHistoryLength) {
            history.shift();
        }
        
        return previous;
    }

    /**
     * Получить последний тикер
     */
    getTicker(exchange, symbol) {
        const key = `${exchange}:${symbol}`;
        return this.lastTickers.get(key);
    }

    /**
     * Получить предыдущий тикер (для сравнения)
     */
    getPreviousTicker(exchange, symbol) {
        const key = `${exchange}:${symbol}`;
        const history = this.history.get(key);
        if (!history || history.length < 2) return null;
        return history[history.length - 2];
    }

    // ========== ОРДЕРБУКИ ==========

    /**
     * Обновление ордербука
     */
    updateOrderBook(exchange, symbol, orderbook) {
        const key = `${exchange}:${symbol}`;
        
        // Сохраняем с временной меткой
        this.lastOrderBooks.set(key, {
            ...orderbook,
            cachedAt: Date.now()
        });
    }

    /**
     * Получить последний ордербук
     */
    getOrderBook(exchange, symbol) {
        const key = `${exchange}:${symbol}`;
        return this.lastOrderBooks.get(key);
    }

    // ========== АНАЛИТИКА ==========

    /**
     * Сохранить результат анализа
     */
    saveAnalysis(exchange, symbol, analysis) {
        const key = `${exchange}:${symbol}`;
        
        if (!this.lastAnalyses.has(key)) {
            this.lastAnalyses.set(key, []);
        }
        
        const analyses = this.lastAnalyses.get(key);
        analyses.push({
            ...analysis,
            savedAt: Date.now()
        });
        
        // Ограничиваем историю анализов
        if (analyses.length > this.maxOrderBookHistory) {
            analyses.shift();
        }
    }

    /**
     * Получить последний анализ
     */
    getLatestAnalysis(exchange, symbol) {
        const key = `${exchange}:${symbol}`;
        const analyses = this.lastAnalyses.get(key);
        if (!analyses || analyses.length === 0) return null;
        return analyses[analyses.length - 1];
    }

    /**
     * Получить историю анализов
     */
    getAnalysisHistory(exchange, symbol, limit = 10) {
        const key = `${exchange}:${symbol}`;
        const analyses = this.lastAnalyses.get(key);
        if (!analyses) return [];
        return analyses.slice(-limit);
    }

    // ========== ИСТОРИЯ ЦЕН ==========

    /**
     * Получить историю цен за последние N минут
     */
    getPriceHistory(exchange, symbol, minutes = 60) {
        const key = `${exchange}:${symbol}`;
        const history = this.history.get(key) || [];
        const cutoff = Date.now() - minutes * 60 * 1000;
        
        return history.filter(h => h.timestamp >= cutoff);
    }

    /**
     * Рассчитать изменение цены за период
     */
    getPriceChange(exchange, symbol, minutes = 5) {
        const history = this.getPriceHistory(exchange, symbol, minutes);
        if (history.length < 2) return null;
        
        const first = history[0].price;
        const last = history[history.length - 1].price;
        
        return {
            changePercent: ((last - first) / first) * 100,
            firstPrice: first,
            lastPrice: last,
            period: minutes,
            direction: last > first ? 'up' : 'down',
            volatility: this.calculateVolatility(history)
        };
    }

    /**
     * Расчет волатильности
     */
    calculateVolatility(history) {
        if (history.length < 5) return null;
        
        const prices = history.map(h => h.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length;
        
        return {
            stdDev: Math.sqrt(variance),
            stdDevPercent: (Math.sqrt(variance) / mean) * 100
        };
    }

    // ========== СТАТИСТИКА ==========

    /**
     * Получить статистику по всем отслеживаемым символам
     */
    getAllStats() {
        const stats = {};
        
        // Собираем по всем биржам и символам
        for (const [key, ticker] of this.lastTickers) {
            const [exchange, symbol] = key.split(':');
            
            if (!stats[symbol]) stats[symbol] = {};
            if (!stats[symbol][exchange]) stats[symbol][exchange] = {};
            
            stats[symbol][exchange].lastPrice = ticker.price;
            stats[symbol][exchange].lastUpdate = ticker.timestamp;
            stats[symbol][exchange].volume = ticker.volume;
        }
        
        // Добавляем информацию из анализов
        for (const [key, analyses] of this.lastAnalyses) {
            const [exchange, symbol] = key.split(':');
            const latest = analyses[analyses.length - 1];
            
            if (latest && latest.pressure) {
                if (!stats[symbol]) stats[symbol] = {};
                if (!stats[symbol][exchange]) stats[symbol][exchange] = {};
                
                stats[symbol][exchange].pressure = latest.pressure.ratio;
                stats[symbol][exchange].liquidityGrade = latest.metrics?.liquidityGrade;
                stats[symbol][exchange].walls = latest.walls?.length || 0;
            }
        }
        
        return stats;
    }

    /**
     * Очистка старых данных
     */
    cleanup(maxAgeHours = 24) {
        const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
        let cleanedCount = 0;
        
        // Очищаем историю тикеров
        for (const [key, history] of this.history) {
            const filtered = history.filter(h => h.timestamp >= cutoff);
            if (filtered.length !== history.length) {
                this.history.set(key, filtered);
                cleanedCount++;
            }
        }
        
        // Очищаем старые анализы
        for (const [key, analyses] of this.lastAnalyses) {
            const filtered = analyses.filter(a => a.savedAt >= cutoff);
            if (filtered.length !== analyses.length) {
                this.lastAnalyses.set(key, filtered);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            logger.debug(`🧹 Очистка CEX state: удалено старых записей из ${cleanedCount} ключей`);
        }
    }
}

module.exports = new CexState();