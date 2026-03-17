const config = require('../config');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class PoolAnalyzer {
    constructor() {
        // Пороговые значения из конфига
        this.minLiquidity = config.strategy.minLiquidityUsd;
        this.minVolume = config.strategy.minVolume24hUsd;
        
        // Хранилище предыдущих состояний для отслеживания изменений
        this.previousStates = new Map(); // key: pairAddress -> lastState
    }

    /**
     * Анализ пулов токена
     */
    analyzeTokenPools(symbol, pools) {
        if (!pools || pools.length === 0) {
            logger.info(`ℹ️ ${symbol}: нет активных пулов`);
            return null;
        }

        // 1. Фильтруем пулы по минимальной ликвидности
        const validPools = pools.filter(p => p.liquidityUsd >= this.minLiquidity);
        
        // 2. Сортируем по ликвидности
        const sortedPools = validPools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
        
        // 3. Анализируем каждый пул
        const analysis = {
            symbol,
            totalLiquidity: 0,
            totalVolume24h: 0,
            totalTxns24h: 0,
            bestLiquidityPool: null,
            bestVolumePool: null,
            pools: [],
            summary: {}
        };

        for (const pool of sortedPools) {
            analysis.totalLiquidity += pool.liquidityUsd;
            analysis.totalVolume24h += pool.volume24h || 0;
            analysis.totalTxns24h += pool.txns24h?.total || 0;
            
            const poolAnalysis = this.analyzeSinglePool(pool);
            analysis.pools.push(poolAnalysis);
            
            if (!analysis.bestLiquidityPool || pool.liquidityUsd > analysis.bestLiquidityPool.liquidityUsd) {
                analysis.bestLiquidityPool = poolAnalysis;
            }
            
            if (!analysis.bestVolumePool || (pool.volume24h || 0) > analysis.bestVolumePool.volume24h) {
                analysis.bestVolumePool = poolAnalysis;
            }
        }

        // Формируем сводку
        analysis.summary = {
            poolsCount: analysis.pools.length,
            hasEnoughLiquidity: analysis.totalLiquidity >= this.minLiquidity,
            hasEnoughVolume: analysis.totalVolume24h >= this.minVolume,
            isActive: analysis.totalTxns24h > 100,
            liquidityGrade: this.getGrade(analysis.totalLiquidity, this.minLiquidity),
            volumeGrade: this.getGrade(analysis.totalVolume24h, this.minVolume)
        };

        this.logAnalysis(analysis);
        eventEmitter.emit('analysis:poolSummary', analysis);
        
        return analysis;
    }

    /**
     * Детальный анализ одного пула
     */
    analyzeSinglePool(pool) {
        const volumeToLiquidityRatio = pool.liquidityUsd > 0 
            ? (pool.volume24h || 0) / pool.liquidityUsd 
            : 0;
        
        const buySellRatio = pool.txns24h?.sells > 0 
            ? pool.txns24h.buys / pool.txns24h.sells 
            : pool.txns24h?.buys || 0;

        let health = 'unknown';
        if (pool.liquidityUsd >= this.minLiquidity && volumeToLiquidityRatio > 0.1) {
            health = 'healthy';
        } else if (pool.liquidityUsd < this.minLiquidity / 10) {
            health = 'dangerous';
        } else if (volumeToLiquidityRatio < 0.05) {
            health = 'inactive';
        }

        return {
            pairAddress: pool.pairAddress,
            dexId: pool.dexId,
            chainId: pool.chainId,
            priceUsd: pool.priceUsd,
            liquidityUsd: pool.liquidityUsd,
            volume24h: pool.volume24h || 0,
            txns24h: pool.txns24h || { buys: 0, sells: 0, total: 0 },
            metrics: {
                volumeToLiquidityRatio,
                buySellRatio,
                health
            },
            url: pool.url,
            pairCreatedAt: pool.pairCreatedAt
        };
    }

    /**
     * Отслеживание изменений в пулах
     */
    trackChanges(symbol, currentPools) {
        const changes = [];
        
        for (const pool of currentPools) {
            const pairKey = `${pool.chainId}:${pool.pairAddress}`;
            const previous = this.previousStates.get(pairKey);
            
            if (!previous) {
                changes.push({
                    type: 'new_pool',
                    symbol,
                    pool: this.analyzeSinglePool(pool),
                    timestamp: new Date().toISOString()
                });
                
                logger.signal(`🆕 Новый пул для ${symbol} на ${pool.dexId}`, {
                    liquidity: `$${pool.liquidityUsd.toFixed(0)}`,
                    price: `$${pool.priceUsd}`
                });
                
            } else {
                const priceChange = ((pool.priceUsd - previous.priceUsd) / previous.priceUsd) * 100;
                const liquidityChange = ((pool.liquidityUsd - previous.liquidityUsd) / previous.liquidityUsd) * 100;
                
                if (Math.abs(priceChange) > 5) {
                    changes.push({
                        type: 'price_change',
                        symbol,
                        pool: pool.dexId,
                        change: priceChange,
                        oldPrice: previous.priceUsd,
                        newPrice: pool.priceUsd,
                        timestamp: new Date().toISOString()
                    });
                }
                
                if (Math.abs(liquidityChange) > 20) {
                    changes.push({
                        type: 'liquidity_change',
                        symbol,
                        pool: pool.dexId,
                        change: liquidityChange,
                        oldLiquidity: previous.liquidityUsd,
                        newLiquidity: pool.liquidityUsd,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            
            this.previousStates.set(pairKey, {
                priceUsd: pool.priceUsd,
                liquidityUsd: pool.liquidityUsd,
                volume24h: pool.volume24h,
                txns24h: pool.txns24h,
                timestamp: new Date().toISOString()
            });
        }
        
        return changes;
    }

    getGrade(value, threshold) {
        if (value >= threshold * 10) return 'excellent';
        if (value >= threshold * 5) return 'good';
        if (value >= threshold) return 'sufficient';
        if (value >= threshold / 10) return 'low';
        return 'critical';
    }

    logAnalysis(analysis) {
        const emoji = analysis.summary.hasEnoughLiquidity ? '✅' : '⚠️';
        
        logger.info(`${emoji} Анализ ${analysis.symbol}`, {
            pools: analysis.summary.poolsCount,
            totalLiquidity: `$${analysis.totalLiquidity.toFixed(0)}`,
            totalVolume24h: `$${analysis.totalVolume24h.toFixed(0)}`,
            totalTxns24h: analysis.totalTxns24h,
            liquidityGrade: analysis.summary.liquidityGrade,
            volumeGrade: analysis.summary.volumeGrade,
            bestPool: analysis.bestLiquidityPool ? {
                dex: analysis.bestLiquidityPool.dexId,
                liquidity: `$${analysis.bestLiquidityPool.liquidityUsd.toFixed(0)}`,
                health: analysis.bestLiquidityPool.metrics.health
            } : null
        });
    }
}

module.exports = new PoolAnalyzer();