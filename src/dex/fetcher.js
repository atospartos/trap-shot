const client = require('./client');
const logger = require('../core/logger');

class DexFetcher {
    /**
     * ТОЧНЫЙ ПОИСК по АДРЕСУ (как в Тесте 1)
     * Использует search?q=address для наиболее точных результатов
     */
    async fetchPoolsByToken(tokenAddress) {
        try {
            logger.debug(`🔍 Точный поиск по адресу: ${tokenAddress}`);
            
            // Используем search с адресом (Тест 1)
            const endpoint = `/latest/dex/search?q=${tokenAddress}`;
            const data = await client.get(endpoint);
            
            if (!data || !data.pairs || data.pairs.length === 0) {
                logger.debug(`❌ Пулов не найдено для адреса ${tokenAddress}`);
                return [];
            }

            logger.info(`✅ Найдено ${data.pairs.length} пулов по адресу ${tokenAddress}`);
            
            // Фильтруем только USDT пары (как в тесте)
            const usdtPairs = data.pairs.filter(pair => 
                pair.quoteToken?.symbol?.toUpperCase() === 'USDT' || 'USDC'
            );
            
            logger.info(`📊 Из них USD пулов: ${usdtPairs.length}`);
            
            return this._normalizePools(usdtPairs);
            
        } catch (error) {
            logger.error(`Ошибка точного поиска по адресу ${tokenAddress}:`, { error: error.message });
            return [];
        }
    }

    /**
     * Получение данных для всех отслеживаемых токенов
     * Использует точный поиск по адресу как основной метод
     */
    async fetchAllTrackedTokens(tokens) {
        const results = [];
        
        for (const token of tokens) {
            for (const [chainId, tokenAddress] of Object.entries(token.dex)) {
                logger.info(`🔎 Ищем пулы для ${token.symbol} на ${chainId} по адресу ${tokenAddress}`);
                
                // Используем ТОЧНЫЙ поиск по адресу (Тест 1)
                const pools = await this.fetchPoolsByToken(tokenAddress);
                
                if (pools.length > 0) {
                    results.push({
                        symbol: token.symbol,
                        chainId: chainId,
                        tokenAddress: tokenAddress,
                        pools: pools,
                        stats: {
                            totalLiquidity: pools.reduce((sum, p) => sum + p.liquidityUsd, 0),
                            totalVolume: pools.reduce((sum, p) => sum + p.volume24h, 0),
                            bestPool: pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
                        }
                    });
                    
                    logger.info(`✅ ${token.symbol} на ${chainId}: ${pools.length} USD пулов`, {
                        totalLiquidity: `$${results[results.length-1].stats.totalLiquidity.toFixed(0)}`,
                        bestDex: results[results.length-1].stats.bestPool.dexId
                    });
                } else {
                    logger.warn(`⚠️ ${token.symbol} на ${chainId}: нет USD пулов`);
                }
            }
        }
        
        return results;
    }

    /**
     * Нормализация данных пула
     */
    _normalizePools(pools) {
        if (!Array.isArray(pools)) return [];
        
        return pools.map(pool => ({
            pairAddress: pool.pairAddress,
            dexId: pool.dexId,
            chainId: pool.chainId,
            url: pool.url,
            baseToken: {
                address: pool.baseToken?.address,
                name: pool.baseToken?.name,
                symbol: pool.baseToken?.symbol
            },
            quoteToken: {
                address: pool.quoteToken?.address,
                name: pool.quoteToken?.name,
                symbol: pool.quoteToken?.symbol
            },
            priceUsd: parseFloat(pool.priceUsd) || 0,
            liquidityUsd: pool.liquidity?.usd || 0,
            volume24h: pool.volume?.h24 || 0,
            priceChange24h: pool.priceChange?.h24 || 0,
            txns24h: {
                buys: pool.txns?.h24?.buys || 0,
                sells: pool.txns?.h24?.sells || 0,
                total: (pool.txns?.h24?.buys || 0) + (pool.txns?.h24?.sells || 0)
            },
            pairCreatedAt: pool.pairCreatedAt 
                ? new Date(pool.pairCreatedAt * 1000).toISOString() 
                : null
        }));
    }
}

module.exports = new DexFetcher();