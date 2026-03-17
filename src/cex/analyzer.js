const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const config = require('../config');
const cexState = require('./models');

class CexAnalyzer {
    constructor() {
        this.minVolume = config.strategy.minVolume24hUsd;
        this.significantPriceChange = 2; // % для сигнала
        this.significantSpread = 0.5; // % для широкого спреда
        
        // Параметры для анализа глубины
        this.depthPercentLevels = [0.5, 1, 2, 5]; // проценты от текущей цены
        this.depthValueLevels = [10000, 25000, 50000, 100000, 250000]; // уровни в USD
    }

    // ========== АНАЛИЗ ТИКЕРА ==========
    
    analyzeTicker(exchange, symbol, ticker) {
        const previous = cexState.getPreviousTicker(exchange, symbol);
        
        // Базовая статистика
        const analysis = {
            exchange,
            symbol,
            price: ticker.price,
            bid: ticker.bid,
            ask: ticker.ask,
            volume: ticker.volume,
            timestamp: ticker.timestamp,
            
            // Рассчитываем спред
            spread: ticker.ask && ticker.bid 
                ? ((ticker.ask - ticker.bid) / ticker.bid) * 100 
                : null,
            
            metrics: {
                hasEnoughVolume: ticker.volume >= this.minVolume,
                volumeGrade: this.getVolumeGrade(ticker.volume)
            }
        };

        // Если есть предыдущие данные, считаем изменения
        if (previous) {
            const priceChange = ((ticker.price - previous.price) / previous.price) * 100;
            
            analysis.changes = {
                priceChangePercent: priceChange,
                timeSinceLast: ticker.timestamp - previous.timestamp
            };

            // Сигнал при значительном изменении цены
            if (Math.abs(priceChange) >= this.significantPriceChange) {
                this.emitPriceChangeSignal(exchange, symbol, priceChange, previous, ticker);
            }
        }

        // Сигнал при широком спреде
        if (analysis.spread && analysis.spread > this.significantSpread) {
            this.emitWideSpreadSignal(exchange, symbol, analysis.spread, ticker);
        }

        // Логируем (только для отладки)
        logger.debug(`${exchange}: ${symbol}`, {
            price: `$${ticker.price}`,
            spread: analysis.spread?.toFixed(2) + '%',
            volume: `$${ticker.volume?.toFixed(0)}`
        });
        
        // Обновляем состояние
        cexState.updateTicker(exchange, symbol, ticker);
        
        // ВОЗВРАЩАЕМ структурированные данные
        return {
            type: 'ticker',
            ...analysis
        };
    }

    // ========== АНАЛИЗ ОРДЕРБУКА ==========

    /**
     * Анализ ордербука с кумулятивной глубиной
     * @returns {Object} структурированные данные для других модулей
     */
    analyzeOrderBook(exchange, symbol, orderbook) {
        if (!orderbook || !orderbook.bids || !orderbook.asks) {
            return {
                type: 'orderbook',
                error: 'Нет данных',
                exchange,
                symbol
            };
        }

        const currentPrice = (orderbook.bids[0][0] + orderbook.asks[0][0]) / 2;

        // 1. Анализ глубины по процентным уровням
        const percentDepth = this.analyzePercentDepth(orderbook, currentPrice);
        
        // 2. Анализ глубины по фиксированным суммам
        const valueDepth = this.analyzeValueDepth(orderbook, currentPrice);
        
        // 3. Находим крупные ордера
        const largeBids = this.findLargeOrders(orderbook.bids, 10000);
        const largeAsks = this.findLargeOrders(orderbook.asks, 10000);
        
        // 4. Рассчитываем давление
        const pressure = this.calculatePressure(orderbook);
        
        // 5. Анализ "стенок"
        const walls = this.findWalls(orderbook);
        
        // 6. Спред
        const spread = ((orderbook.asks[0][0] - orderbook.bids[0][0]) / orderbook.bids[0][0]) * 100;

        // Формируем структурированный результат
        const analysis = {
            type: 'orderbook',
            exchange,
            symbol,
            currentPrice,
            timestamp: orderbook.timestamp || Date.now(),
            
            // Основные метрики
            spread,
            
            // Детальный анализ глубины (для execution модуля)
            depth: {
                byPercent: percentDepth,
                byValue: valueDepth
            },
            
            // Крупные ордера
            largeOrders: {
                bids: largeBids.map(o => ({ price: o.price, value: o.value })),
                asks: largeAsks.map(o => ({ price: o.price, value: o.value }))
            },
            
            // Давление рынка
            pressure: {
                bidVolume: pressure.bidVolume,
                askVolume: pressure.askVolume,
                ratio: pressure.ratio,
                totalDepth: pressure.totalDepth
            },
            
            // Стенки (уровни поддержки/сопротивления)
            walls: walls.map(w => ({
                side: w.side,
                price: w.price,
                value: w.value,
                type: w.type
            })),
            
            // Метаданные
            metrics: {
                liquidityGrade: this.getLiquidityGrade(pressure.totalDepth),
                hasLargeBids: largeBids.length > 0,
                hasLargeAsks: largeAsks.length > 0,
                hasWalls: walls.length > 0,
                isBullish: pressure.ratio > 1.2,
                isBearish: pressure.ratio < 0.8
            }
        };

        // Генерируем события при важных сигналах
        this.emitOrderBookSignals(analysis);
        
        // Логируем краткую информацию
        logger.info(`📚 ${exchange}: Анализ глубины ${symbol}`, {
            spread: `${spread.toFixed(2)}%`,
            pressure: pressure.ratio.toFixed(2),
            walls: walls.length,
            depth1p: `Up: $${percentDepth['1%']?.toMoveUp.cumulativeValue?.toFixed(0) || 0}`
        });

        // Сохраняем в состояние
        cexState.updateOrderBook(exchange, symbol, {
            ...analysis,
            raw: orderbook // сохраняем сырые данные если нужно
        });

        return analysis;
    }

    /**
     * Анализ глубины по процентным уровням
     */
    analyzePercentDepth(orderbook, currentPrice) {
        const result = {};
        
        for (const percent of this.depthPercentLevels) {
            // Для покупателей (ask side) - цена растет
            const askTargetPrice = currentPrice * (1 + percent / 100);
            const askDepth = this.calculateCumulativeDepth(
                orderbook.asks,
                currentPrice,
                askTargetPrice,
                'ask'
            );
            
            // Для продавцов (bid side) - цена падает
            const bidTargetPrice = currentPrice * (1 - percent / 100);
            const bidDepth = this.calculateCumulativeDepth(
                orderbook.bids,
                currentPrice,
                bidTargetPrice,
                'bid'
            );
            
            result[`${percent}%`] = {
                toMoveUp: {
                    targetPrice: askTargetPrice,
                    amount: askDepth.cumulativeAmount,
                    value: askDepth.cumulativeValue,
                    reached: askDepth.reachedTarget
                },
                toMoveDown: {
                    targetPrice: bidTargetPrice,
                    amount: bidDepth.cumulativeAmount,
                    value: bidDepth.cumulativeValue,
                    reached: bidDepth.reachedTarget
                }
            };
        }
        
        return result;
    }

    /**
     * Анализ глубины по фиксированным суммам
     */
    analyzeValueDepth(orderbook, currentPrice) {
        const result = {};
        
        for (const targetValue of this.depthValueLevels) {
            // Для покупки
            const buyImpact = this.calculateImpactForValue(
                orderbook.asks,
                currentPrice,
                targetValue,
                'buy'
            );
            
            // Для продажи
            const sellImpact = this.calculateImpactForValue(
                orderbook.bids,
                currentPrice,
                targetValue,
                'sell'
            );
            
            result[`$${(targetValue/1000).toFixed(0)}k`] = {
                buy: {
                    canFill: buyImpact.canFill,
                    fillPercent: buyImpact.fillPercent,
                    averagePrice: buyImpact.averagePrice,
                    priceImpact: buyImpact.priceImpact,
                    lastPrice: buyImpact.lastPrice
                },
                sell: {
                    canFill: sellImpact.canFill,
                    fillPercent: sellImpact.fillPercent,
                    averagePrice: sellImpact.averagePrice,
                    priceImpact: sellImpact.priceImpact,
                    lastPrice: sellImpact.lastPrice
                }
            };
        }
        
        return result;
    }

    /**
     * Расчет кумулятивной глубины от текущей цены до целевой
     */
    calculateCumulativeDepth(orders, currentPrice, targetPrice, side) {
        const sortedOrders = side === 'ask' 
            ? [...orders].sort((a, b) => a[0] - b[0])
            : [...orders].sort((a, b) => b[0] - a[0]);

        let cumulativeAmount = 0;
        let cumulativeValue = 0;
        let lastPrice = currentPrice;

        for (const [price, amount] of sortedOrders) {
            if (side === 'ask' && price > targetPrice) break;
            if (side === 'bid' && price < targetPrice) break;
            
            cumulativeAmount += amount;
            cumulativeValue += price * amount;
            lastPrice = price;
        }

        return {
            cumulativeAmount,
            cumulativeValue,
            reachedTarget: side === 'ask' 
                ? lastPrice >= targetPrice 
                : lastPrice <= targetPrice,
            finalPrice: lastPrice
        };
    }

    /**
     * Расчет влияния покупки/продажи на определенную сумму
     */
    calculateImpactForValue(orders, currentPrice, targetValue, side) {
        const sortedOrders = side === 'buy'
            ? [...orders].sort((a, b) => a[0] - b[0])
            : [...orders].sort((a, b) => b[0] - a[0]);

        let remainingValue = targetValue;
        let cumulativeAmount = 0;
        let weightedSum = 0;
        let lastPrice = currentPrice;

        for (const [price, amount] of sortedOrders) {
            const value = price * amount;
            
            if (value >= remainingValue) {
                const partialAmount = remainingValue / price;
                cumulativeAmount += partialAmount;
                weightedSum += price * partialAmount;
                lastPrice = price;
                remainingValue = 0;
                break;
            } else {
                cumulativeAmount += amount;
                weightedSum += value;
                lastPrice = price;
                remainingValue -= value;
            }
        }

        const avgPrice = weightedSum / cumulativeAmount;
        const priceImpact = ((avgPrice - currentPrice) / currentPrice) * 100 * (side === 'buy' ? 1 : -1);

        return {
            canFill: remainingValue === 0,
            fillPercent: ((targetValue - remainingValue) / targetValue) * 100,
            averagePrice: avgPrice,
            priceImpact,
            lastPrice,
            remainingValue
        };
    }

    /**
     * Поиск крупных ордеров
     */
    findLargeOrders(orders, minValue) {
        return orders
            .map(([price, amount]) => ({
                price,
                amount,
                value: price * amount
            }))
            .filter(order => order.value >= minValue)
            .sort((a, b) => b.value - a.value);
    }

    /**
     * Поиск "стенок" (аномально крупных заявок)
     */
    findWalls(orderbook) {
        const walls = [];
        
        const avgAskValue = this.calculateAverageOrderValue(orderbook.asks);
        orderbook.asks.forEach(([price, amount]) => {
            const value = price * amount;
            if (value > avgAskValue * 5) {
                walls.push({
                    side: 'ask',
                    price,
                    amount,
                    value,
                    type: 'resistance'
                });
            }
        });
        
        const avgBidValue = this.calculateAverageOrderValue(orderbook.bids);
        orderbook.bids.forEach(([price, amount]) => {
            const value = price * amount;
            if (value > avgBidValue * 5) {
                walls.push({
                    side: 'bid',
                    price,
                    amount,
                    value,
                    type: 'support'
                });
            }
        });
        
        return walls;
    }

    /**
     * Расчет давления
     */
    calculatePressure(orderbook) {
        const totalBidVolume = orderbook.bids.reduce((sum, [price, amount]) => sum + (price * amount), 0);
        const totalAskVolume = orderbook.asks.reduce((sum, [price, amount]) => sum + (price * amount), 0);
        
        return {
            bidVolume: totalBidVolume,
            askVolume: totalAskVolume,
            ratio: totalBidVolume / totalAskVolume,
            totalDepth: totalBidVolume + totalAskVolume
        };
    }

    /**
     * Расчет среднего размера ордера
     */
    calculateAverageOrderValue(orders) {
        if (orders.length === 0) return 0;
        const total = orders.reduce((sum, [price, amount]) => sum + (price * amount), 0);
        return total / orders.length;
    }

    // ========== ГЕНЕРАЦИЯ СОБЫТИЙ ==========

    emitPriceChangeSignal(exchange, symbol, priceChange, previous, ticker) {
        const direction = priceChange > 0 ? '📈' : '📉';
        
        logger.signal(`${direction} ${exchange}: ${symbol} изменилась на ${priceChange.toFixed(2)}%`);
        
        eventEmitter.emit('cex:priceChange', {
            exchange,
            symbol,
            changePercent: priceChange,
            oldPrice: previous.price,
            newPrice: ticker.price,
            volume: ticker.volume,
            timestamp: Date.now()
        });
    }

    emitWideSpreadSignal(exchange, symbol, spread, ticker) {
        logger.warn(`⚠️ ${exchange}: Широкий спред ${symbol} ${spread.toFixed(2)}%`);
        
        eventEmitter.emit('cex:wideSpread', {
            exchange,
            symbol,
            spread,
            bid: ticker.bid,
            ask: ticker.ask,
            timestamp: Date.now()
        });
    }

    emitOrderBookSignals(analysis) {
        // Сильный дисбаланс
        if (analysis.pressure.ratio > 2) {
            eventEmitter.emit('cex:strongBuyPressure', {
                exchange: analysis.exchange,
                symbol: analysis.symbol,
                ratio: analysis.pressure.ratio,
                timestamp: Date.now()
            });
        } else if (analysis.pressure.ratio < 0.5) {
            eventEmitter.emit('cex:strongSellPressure', {
                exchange: analysis.exchange,
                symbol: analysis.symbol,
                ratio: analysis.pressure.ratio,
                timestamp: Date.now()
            });
        }
        
        // Обнаружение стенок
        if (analysis.walls.length > 0) {
            eventEmitter.emit('cex:walls', {
                exchange: analysis.exchange,
                symbol: analysis.symbol,
                walls: analysis.walls,
                timestamp: Date.now()
            });
        }
    }

    // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

    getVolumeGrade(volume) {
        if (!volume) return 'unknown';
        if (volume >= this.minVolume * 10) return 'excellent';
        if (volume >= this.minVolume * 5) return 'good';
        if (volume >= this.minVolume) return 'sufficient';
        if (volume >= this.minVolume / 10) return 'low';
        return 'critical';
    }

    getLiquidityGrade(depth) {
        if (depth >= 1000000) return 'excellent';
        if (depth >= 500000) return 'good';
        if (depth >= 100000) return 'sufficient';
        if (depth >= 50000) return 'low';
        return 'critical';
    }

    /**
     * Получить последний анализ для символа
     */
    getLatestAnalysis(symbol) {
        return cexState.getLatestAnalysis(symbol);
    }
}

module.exports = new CexAnalyzer();