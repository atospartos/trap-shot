const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class WhaleMonitor {
    constructor() {
        // Пороги для "китов"
        this.thresholds = {
            solana: 100000,  // $100k на Solana
            ethereum: 500000, // $500k на Ethereum
            bsc: 200000,      // $200k на BSC
            polygon: 100000,  // $100k на Polygon
            avalanche: 100000, // $100k на Avalanche
            default: 50000    // $50k по умолчанию
        };
        
        // Отслеживаем недавних китов
        this.recentWhales = new Map(); // symbol -> [{txn, timestamp}]
        
        // Настройки окна анализа
        this.analysisWindowMinutes = 30; // анализируем активность за 30 минут
    }

    /**
     * Анализ транзакций в пуле на наличие китов
     */
    analyzeTransactions(symbol, chainId, pool, transactions) {
        if (!transactions || !Array.isArray(transactions)) return [];
        
        const threshold = this.thresholds[chainId] || this.thresholds.default;
        const whales = [];
        
        for (const txn of transactions) {
            // Проверяем размер транзакции
            const valueUsd = parseFloat(txn.valueUsd) || 0;
            
            if (valueUsd >= threshold) {
                const whale = {
                    symbol,
                    chainId,
                    pool: pool.dexId,
                    txHash: txn.txHash,
                    valueUsd,
                    type: txn.type, // 'buy' или 'sell'
                    price: txn.price,
                    timestamp: txn.timestamp || Date.now(),
                    // Важно для стратегии: направление движения
                    impact: txn.type === 'buy' ? 'bullish' : 'bearish'
                };
                
                whales.push(whale);
                
                // Логируем
                logger.signal(`🐋 КИТ на ${symbol} (${chainId})`, {
                    value: `$${valueUsd.toLocaleString()}`,
                    type: whale.type,
                    pool: pool.dexId,
                    impact: whale.impact
                });
                
                // Сохраняем в историю
                this._addToHistory(symbol, chainId, whale);
                
                // Генерируем событие для стратегии
                eventEmitter.emit('dex:whale', {
                    ...whale,
                    recentActivity: this.getRecentWhaleActivity(symbol, chainId)
                });
            }
        }
        
        return whales;
    }

    /**
     * Добавление кита в историю
     */
    _addToHistory(symbol, chainId, whale) {
        const key = `${symbol}:${chainId}`;
        if (!this.recentWhales.has(key)) {
            this.recentWhales.set(key, []);
        }
        
        const history = this.recentWhales.get(key);
        history.push({
            ...whale,
            detectedAt: Date.now()
        });
        
        // Храним только последние 100
        if (history.length > 100) {
            history.shift();
        }
    }

    /**
     * Получить активность китов за последние N минут
     */
    getRecentWhaleActivity(symbol, chainId, minutes = null) {
        const windowMinutes = minutes || this.analysisWindowMinutes;
        const key = `${symbol}:${chainId}`;
        const history = this.recentWhales.get(key) || [];
        const cutoff = Date.now() - windowMinutes * 60 * 1000;
        
        const recent = history.filter(w => w.detectedAt >= cutoff);
        
        if (recent.length === 0) return null;
        
        // Анализируем направление
        const buys = recent.filter(w => w.type === 'buy').length;
        const sells = recent.filter(w => w.type === 'sell').length;
        const totalVolume = recent.reduce((sum, w) => sum + w.valueUsd, 0);
        
        // Определяем сентимент
        let sentiment = 'neutral';
        let signal = null;
        
        if (buys > sells * 2) {
            sentiment = 'strong_bullish';
            signal = 'bullish';
        } else if (buys > sells) {
            sentiment = 'bullish';
            signal = 'bullish';
        } else if (sells > buys * 2) {
            sentiment = 'strong_bearish';
            signal = 'bearish';
        } else if (sells > buys) {
            sentiment = 'bearish';
            signal = 'bearish';
        }
        
        return {
            total: recent.length,
            buys,
            sells,
            net: buys - sells,
            totalVolume,
            avgVolume: totalVolume / recent.length,
            sentiment,
            signal,
            confidence: recent.length > 5 ? 'high' : recent.length > 2 ? 'medium' : 'low',
            recent: recent.slice(0, 5) // последние 5
        };
    }

    /**
     * Получить рекомендацию на основе активности китов
     */
    getWhaleSignal(symbol, chainId) {
        const activity = this.getRecentWhaleActivity(symbol, chainId);
        
        if (!activity || activity.total < 2) return null;
        
        if (activity.signal === 'bullish') {
            return {
                signal: 'bullish',
                confidence: activity.confidence,
                reason: `Киты активно покупают: ${activity.buys} покупок против ${activity.sells} продаж`,
                volume: `$${(activity.totalVolume / 1e6).toFixed(1)}M`,
                details: {
                    buys: activity.buys,
                    sells: activity.sells,
                    totalVolume: activity.totalVolume
                }
            };
        } else if (activity.signal === 'bearish') {
            return {
                signal: 'bearish',
                confidence: activity.confidence,
                reason: `Киты активно продают: ${activity.sells} продаж против ${activity.buys} покупок`,
                volume: `$${(activity.totalVolume / 1e6).toFixed(1)}M`,
                details: {
                    buys: activity.buys,
                    sells: activity.sells,
                    totalVolume: activity.totalVolume
                }
            };
        }
        
        return null;
    }

    /**
     * Проверка, был ли недавно кит по токену
     */
    hasRecentWhale(symbol, chainId, minutes = 15) {
        const activity = this.getRecentWhaleActivity(symbol, chainId, minutes);
        return activity && activity.total > 0;
    }

    /**
     * Получить статистику по всем наблюдаемым китам
     */
    getGlobalStats() {
        const stats = {};
        
        for (const [key, history] of this.recentWhales.entries()) {
            const [symbol, chainId] = key.split(':');
            
            if (!stats[symbol]) {
                stats[symbol] = {};
            }
            
            const recent = this.getRecentWhaleActivity(symbol, chainId);
            if (recent) {
                stats[symbol][chainId] = {
                    lastHour: recent.total,
                    sentiment: recent.sentiment,
                    volume: recent.totalVolume
                };
            }
        }
        
        return stats;
    }

    /**
     * Очистка старых записей
     */
    cleanup() {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 часа
        
        for (const [key, history] of this.recentWhales.entries()) {
            const filtered = history.filter(w => w.detectedAt >= cutoff);
            if (filtered.length > 0) {
                this.recentWhales.set(key, filtered);
            } else {
                this.recentWhales.delete(key);
            }
        }
        
        logger.info(`🧹 Очистка истории китов: осталось ${this.recentWhales.size} записей`);
    }
}

module.exports = new WhaleMonitor();;