const cache = require('./cache');
const config = require('../config');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const statisticalModel = require('./statisticalModel');
const feeCalculator = require('../cex/fees');
const whaleMonitor = require('../dex/whaleMonitor');
const divergenceHistory = require('./divergenceHistory');

class Comparator {
    analyzeSymbol(symbol) {
        const bestDex = cache.getBestDexPrice(symbol);
        const bestCex = cache.getBestCexPrice(symbol);

        if (!bestDex || !bestCex) {
            logger.info(`Нет данных для сравнения ${symbol}`, {
                dex: !!bestDex,
                cex: !!bestCex
            });
            return null;
        }

        const dexPrice = bestDex.price;
        const cexPrice = bestCex.price;
        const diffPercent = ((dexPrice - cexPrice) / cexPrice) * 100;
        const absDiffPercent = Math.abs(diffPercent);
        const direction = diffPercent > 0 ? 'DEX_HIGHER' : 'CEX_HIGHER';

        // Получаем дополнительную статистику
        const dexStats = cache.getDexStats(symbol);
        
        // Убираем console.log, оставляем только через logger
        logger.debug(`Анализ ${symbol}: DEX $${dexPrice} CEX $${cexPrice} разница ${diffPercent?.toFixed(2)}%`);

        // Создаем result
        const result = {
            symbol,
            timestamp: Date.now(),

            // Ключевое - расхождение цен
            divergence: {
                percent: diffPercent,
                absPercent: absDiffPercent,
                direction: direction,
                description: diffPercent > 0
                    ? `DEX дороже CEX на ${absDiffPercent.toFixed(2)}%`
                    : `CEX дороже DEX на ${absDiffPercent.toFixed(2)}%`
            },

            // Данные DEX
            dex: {
                price: dexPrice,
                chain: bestDex.chain,
                pool: bestDex.data?.pool || bestDex.data,
                liquidity: bestDex.data?.pool?.liquidityUsd || 0,
                stats: dexStats
            },

            // Данные CEX
            cex: {
                price: cexPrice,
                exchange: bestCex.exchange,
                volume: bestCex.data?.volume || 0
            },

            // Метрики для принятия решений
            metrics: {
                hasEnoughLiquidity: (bestDex.data?.pool?.liquidityUsd || 0) >= config.strategy.minLiquidityUsd,
                hasEnoughVolume: (bestCex.data?.volume || 0) >= config.strategy.minVolume24hUsd,
                profitPotential: absDiffPercent - 0.5,
                liquidityToVolumeRatio: bestDex.data?.pool?.liquidityUsd > 0
                    ? (bestCex.data?.volume || 0) / bestDex.data.pool.liquidityUsd
                    : 0
            }
        };

        // ========== ЧАСТЬ 1: ЗАПИСЬ В ИСТОРИЮ РАЗРЫВОВ ==========
        divergenceHistory.recordMeasurement(
            symbol,
            diffPercent,
            direction,
            {
                dexLiquidity: result.dex.liquidity,
                cexVolume: result.cex.volume,
                dexChain: bestDex.chain,
                cexExchange: bestCex.exchange
            }
        );

        // Получаем статистику за последние 5 минут
        const historyStats = divergenceHistory.getStats(symbol, 5);
        result.divergenceHistory = historyStats;

        // Если есть активный разрыв, добавляем информацию о длительности
        const currentDuration = divergenceHistory.getCurrentDivergenceDuration(symbol);
        if (currentDuration > 0) {
            result.divergence.durationSeconds = currentDuration;
            result.divergence.durationMinutes = (currentDuration / 60).toFixed(1);
        }

        // ========== ЧАСТЬ 2: ЗАПИСЬ В СТАТИСТИЧЕСКУЮ МОДЕЛЬ ==========
        statisticalModel.recordDivergence(symbol, {
            percent: diffPercent,
            absPercent: absDiffPercent,
            direction: direction,
            dexLiquidity: result.dex.liquidity,
            cexVolume: result.cex.volume,
            dexChain: bestDex.chain,
            cexExchange: bestCex.exchange
        });

        // ========== ЧАСТЬ 3: ПОЛУЧЕНИЕ СТАТИСТИКИ ПО РАСХОЖДЕНИЮ ==========
        const divergenceStats = statisticalModel.getDivergenceStats(symbol, absDiffPercent);
        result.stats = divergenceStats;

        // ========== ЧАСТЬ 4: АНАЛИЗ КИТОВ ==========
        const whaleSignal = whaleMonitor.getWhaleSignal(symbol, bestDex.chain);
        if (whaleSignal) {
            result.whaleActivity = whaleSignal;
        }

        // ========== ЧАСТЬ 5: РАСЧЕТ КОМИССИЙ ==========
        const defaultPositionSize = config.trading?.defaultPositionSize || 1000;
        const holdHours = config.trading?.defaultHoldHours || 2;

        const profitability = feeCalculator.isProfitable(
            absDiffPercent,
            bestCex.exchange,
            symbol,
            defaultPositionSize,
            diffPercent > 0 ? 'buy' : 'sell',
            holdHours
        );

        result.profitability = profitability;

        // ========== ЧАСТЬ 6: АНАЛИЗ ТЕКУЩЕГО РАСХОЖДЕНИЯ ==========
        const hasEnoughData = divergenceStats && divergenceStats.sampleSize >= 30;

        if (hasEnoughData) {
            const currentAbs = absDiffPercent;
            const p90 = divergenceStats.percentiles.p90;
            const p95 = divergenceStats.percentiles.p95;
            const mean = divergenceStats.mean;

            if (currentAbs > p95) {
                result.divergence.significance = 'EXTREME';
                result.divergence.percentile = '>95%';
            } else if (currentAbs > p90) {
                result.divergence.significance = 'HIGH';
                result.divergence.percentile = '>90%';
            } else if (currentAbs > mean) {
                result.divergence.significance = 'ABOVE_AVERAGE';
                result.divergence.percentile = '>среднего';
            } else {
                result.divergence.significance = 'NORMAL';
                result.divergence.percentile = 'в норме';
            }

            result.divergence.typicalBehavior = this.analyzeTypicalBehavior(
                symbol,
                direction,
                currentAbs
            );
        }

        // ========== ЧАСТЬ 7: ПРОВЕРКА УСЛОВИЙ ДЛЯ СИГНАЛА ==========
        const minDivergence = config.strategy.minPriceDiffPercent || 2;
        const isSignificant = absDiffPercent >= minDivergence;
        const isLiquid = result.metrics.hasEnoughLiquidity;
        const isProfitableAfterFees = profitability?.isProfitable || false;
        const hasWhaleConfirmation = whaleSignal ?
            (whaleSignal.signal === (diffPercent > 0 ? 'bullish' : 'bearish')) :
            true;

        // Формируем рекомендацию
        result.recommendation = this.generateRecommendation(
            symbol,
            absDiffPercent,
            direction,
            isSignificant,
            isLiquid,
            isProfitableAfterFees,
            hasWhaleConfirmation,
            divergenceStats,
            profitability,
            whaleSignal,
            result
        );

        // ========== ЧАСТЬ 8: ЛОГИРОВАНИЕ И СОБЫТИЯ ==========
        logger.info(`📊 ${symbol}: ${result.divergence.description}`, {
            dexPrice: `$${dexPrice.toFixed(6)}`,
            cexPrice: `$${cexPrice.toFixed(6)}`,
            divergence: `${absDiffPercent.toFixed(2)}%`,
            significance: result.divergence.significance || 'N/A',
            liquidity: `$${result.dex.liquidity.toFixed(0)}`,
            volume: `$${result.cex.volume.toFixed(0)}`,
            netProfit: profitability ? `${profitability.netProfit.toFixed(2)}%` : 'N/A'
        });

        // Сигнал
        if (isSignificant && isLiquid && isProfitableAfterFees) {
            let signalStrength = 'medium';
            let reason = [];

            if (hasWhaleConfirmation) {
                signalStrength = 'high';
                reason.push('подтверждено китами');
            }

            if (profitability && profitability.netProfit > 2) {
                signalStrength = signalStrength === 'high' ? 'critical' : 'high';
                reason.push('высокая прибыль');
            }

            if (result.divergence.significance === 'EXTREME') {
                signalStrength = 'critical';
                reason.push('экстремальное расхождение');
            }

            // Формируем сообщение
            const message = this.formatEnhancedSignal(result, signalStrength, reason);

            logger.signal(message, {
                ...result,
                signalStrength,
                reasons: reason,
                fees: profitability?.costs,
                whales: whaleSignal
            });

            eventEmitter.emit('signal:arbitrage', {
                ...result,
                type: 'enhanced_signal',
                strength: signalStrength
            });

        } else if (isSignificant && !isLiquid) {
            logger.warn(`⚠️ Расхождение ${absDiffPercent.toFixed(2)}% по ${symbol}, но нет ликвидности на DEX`, {
                needed: `$${config.strategy.minLiquidityUsd}`,
                actual: `$${result.dex.liquidity.toFixed(0)}`
            });

            eventEmitter.emit('signal:divergence', {
                ...result,
                type: 'low_liquidity'
            });

        } else if (isSignificant && profitability && !profitability.isProfitable) {
            logger.info(`ℹ️ Расхождение ${absDiffPercent.toFixed(2)}% по ${symbol} не покрывает комиссии`, {
                gross: `${absDiffPercent.toFixed(2)}%`,
                costs: `${profitability.costs.percentages.total.toFixed(2)}%`,
                net: `${profitability.netProfit.toFixed(2)}%`
            });
        }

        // Отправляем событие для Telegram
        eventEmitter.emit('analysis:divergence', result);

        // Отчет по статистике
        if (hasEnoughData && divergenceStats && divergenceStats.sampleSize % 10 === 0) {
            eventEmitter.emit('telegram:riskReport', {
                symbol,
                stats: divergenceStats
            });
        }

        return result;
    }

    // ... остальные методы без изменений ...
    analyzeTypicalBehavior(symbol, direction, currentAbs) {
        const stats = statisticalModel.getDirectionalStats(symbol, direction);
        if (!stats || stats.sampleSize < 5) {
            return {
                pattern: 'недостаточно данных',
                averageDuration: null,
                averageCollapse: null
            };
        }
        return {
            pattern: stats.typicalPattern,
            averageDuration: stats.avgDurationMinutes,
            averageCollapse: stats.avgCollapsePercent,
            usuallyReturnsToMean: stats.meanReversionRate > 0.7 ? 'да' : 'не всегда',
            sampleSize: stats.sampleSize
        };
    }

    generateRecommendation(symbol, absDiff, direction, isSignificant, isLiquid,
        isProfitableAfterFees, hasWhaleConfirmation, stats, profitability, whaleSignal, result) {

        if (!isSignificant) {
            return {
                action: 'WAIT',
                reason: `Расхождение ${absDiff.toFixed(2)}% ниже порога ${config.strategy.minPriceDiffPercent}%`,
                priority: 'low'
            };
        }

        if (!isLiquid) {
            return {
                action: 'WAIT',
                reason: `Недостаточно ликвидности на DEX`,
                priority: 'medium',
                details: `Нужно $${config.strategy.minLiquidityUsd}, есть $${result?.dex?.liquidity?.toFixed(0) || 'N/A'}`
            };
        }

        if (!isProfitableAfterFees) {
            return {
                action: 'SKIP',
                reason: `Расхождение не покрывает комиссии`,
                priority: 'low',
                details: profitability ?
                    `${absDiff.toFixed(2)}% < ${profitability.costs.percentages.total.toFixed(2)}%` :
                    'невыгодно'
            };
        }

        if (stats && stats.sampleSize >= 30) {
            const priority = absDiff > stats.percentiles.p95 ? 'high' :
                absDiff > stats.percentiles.p90 ? 'medium' : 'low';

            const direction_text = direction === 'DEX_HIGHER'
                ? 'Купить на CEX (лонг)'
                : 'Продать на CEX (шорт)';

            let confidence = 'low';
            if (stats.sampleSize > 100) confidence = 'high';
            else if (stats.sampleSize > 50) confidence = 'medium';

            const finalPriority = hasWhaleConfirmation && whaleSignal ?
                (priority === 'high' ? 'critical' :
                    priority === 'medium' ? 'high' : 'medium') : priority;

            return {
                action: 'ENTER',
                direction: direction,
                trade: direction_text,
                entryPrice: `по рынку CEX`,
                expectedGrossProfit: `${absDiff.toFixed(2)}%`,
                expectedNetProfit: profitability ? `${profitability.netProfit.toFixed(2)}%` : 'N/A',
                priority: finalPriority,
                confidence: confidence,
                reason: `Расхождение ${absDiff.toFixed(2)}%`,
                whaleConfirmed: hasWhaleConfirmation,
                stats: {
                    mean: stats.mean.toFixed(2) + '%',
                    p90: stats.percentiles.p90.toFixed(2) + '%',
                    p95: stats.percentiles.p95.toFixed(2) + '%',
                    sampleSize: stats.sampleSize
                }
            };
        }

        return {
            action: 'ENTER',
            direction: direction,
            trade: direction === 'DEX_HIGHER' ? 'Купить на CEX (лонг)' : 'Продать на CEX (шорт)',
            expectedGrossProfit: `${absDiff.toFixed(2)}%`,
            expectedNetProfit: profitability ? `${profitability.netProfit.toFixed(2)}%` : 'N/A',
            priority: hasWhaleConfirmation ? 'medium' : 'low',
            confidence: 'low',
            reason: `Расхождение ${absDiff.toFixed(2)}% (без исторических данных)`,
            whaleConfirmed: hasWhaleConfirmation
        };
    }

    formatEnhancedSignal(result, strength, reasons) {
        const emoji = result.divergence.direction === 'DEX_HIGHER' ? '📈' : '📉';
        const strengthEmoji = strength === 'critical' ? '🔥' :
            strength === 'high' ? '⚡' : '📊';

        let message = `${strengthEmoji} <b>${result.symbol}: ${result.divergence.description}</b>\n\n`;

        message += `💰 DEX: $${result.dex.price.toFixed(6)} (${result.dex.chain})\n`;
        message += `💵 CEX: $${result.cex.price.toFixed(6)} (${result.cex.exchange})\n\n`;

        if (result.profitability) {
            message += `📊 <b>Финансы (позиция $${result.profitability.positionSize || 1000}):</b>\n`;
            message += `• Валовая разница: ${result.divergence.absPercent.toFixed(2)}%\n`;
            message += `• Комиссии: ${result.profitability.costs.percentages.total.toFixed(2)}%\n`;
            message += `• Чистая прибыль: <b>${result.profitability.netProfit.toFixed(2)}%</b>\n\n`;
        }

        if (result.divergenceHistory?.hasData) {
            message += `📊 <b>История за 5 мин:</b>\n`;
            message += `• Средний спред: ${result.divergenceHistory.stats.avgSpread}\n`;
            message += `• Макс. спред: ${result.divergenceHistory.stats.maxSpread}\n`;
            message += `• Частота: ${result.divergenceHistory.stats.frequency}\n`;

            if (result.divergence.durationSeconds) {
                message += `• Длится: ${result.divergence.durationMinutes} мин\n`;
            }

            if (result.divergenceHistory.prediction) {
                message += `• Прогноз: ${result.divergenceHistory.prediction.willCollapse} `;
                message += `${result.divergenceHistory.prediction.estimatedEnd}\n`;
            }
            message += `\n`;
        }

        if (result.stats) {
            message += `📈 <b>Статистика расхождений:</b>\n`;
            message += `• Среднее: ${result.stats.mean.toFixed(2)}%\n`;
            message += `• 90% случаев: < ${result.stats.percentiles.p90.toFixed(2)}%\n`;
            message += `• Текущее: ${result.divergence.absPercent.toFixed(2)}% (${result.divergence.significance})\n\n`;
        }

        if (result.whaleActivity) {
            message += `🐋 <b>Активность китов:</b>\n`;
            message += `• ${result.whaleActivity.reason}\n`;
            message += `• Объем: ${result.whaleActivity.volume}\n\n`;
        }

        if (reasons && reasons.length > 0) {
            message += `✅ <b>Сигнал усилен:</b> ${reasons.join(', ')}\n\n`;
        }

        if (result.recommendation && result.recommendation.action === 'ENTER') {
            message += `💡 <b>Рекомендация:</b> ${result.recommendation.trade}\n`;
            message += `🎯 Ожидаемая чистая прибыль: ${result.recommendation.expectedNetProfit}\n`;
            message += `📊 Приоритет: ${result.recommendation.priority}`;

            if (result.recommendation.whaleConfirmed) {
                message += ` (подтверждено китами)`;
            }
        }

        return message;
    }

    analyzeAllSymbols() {
        const tokens = require('../config/tokens');
        const results = [];

        for (const token of tokens) {
            const result = this.analyzeSymbol(token.symbol);
            if (result) {
                results.push(result);
            }
        }

        const bestOpportunity = results
            .filter(r => r.recommendation?.action === 'ENTER')
            .sort((a, b) => {
                const priorityScore = { critical: 4, high: 3, medium: 2, low: 1 };
                const scoreA = priorityScore[a.recommendation.priority] * a.divergence.absPercent;
                const scoreB = priorityScore[b.recommendation.priority] * b.divergence.absPercent;
                return scoreB - scoreA;
            })[0];

        if (bestOpportunity) {
            eventEmitter.emit('analysis:bestOpportunity', bestOpportunity);
        }

        return results;
    }
}

module.exports = new Comparator();