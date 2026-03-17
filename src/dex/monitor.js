const fetcher = require('./fetcher');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const poolAnalyzer = require('../analyzer/poolAnalyzer');
const whaleMonitor = require('./whaleMonitor');

class DexMonitor {
    constructor() {
        // Кэш для уже обработанных пулов
        this.processedPools = new Set();
    }

    /**
     * Основной метод проверки всех токенов
     * Использует точный поиск по адресу токена
     */
    async checkAllTokens() {
        logger.info('🔍 Начинаем ТОЧНЫЙ поиск пулов по адресам токенов...');
        
        try {
            // Получаем конфигурацию токенов
            const tokens = require('../config/tokens');
            
            // Результаты для всех токенов
            const allResults = [];
            
            // Обрабатываем каждый токен
            for (const token of tokens) {
                const tokenResults = await this.processToken(token);
                allResults.push(...tokenResults);
            }
            
            logger.info(`✅ Точный поиск завершен. Обработано токенов: ${tokens.length}, найдено пулов: ${allResults.length}`);
            
            return allResults;
            
        } catch (error) {
            logger.error('❌ Критическая ошибка в checkAllTokens:', { error: error.message });
            return [];
        }
    }

    /**
     * Обработка одного токена по всем его адресам
     */
    async processToken(token) {
        const results = [];
        
        // Перебираем все сети, где есть адреса токена
        for (const [chainId, tokenAddress] of Object.entries(token.dex)) {
            try {
                logger.info(`🔎 Ищем пулы для ${token.symbol} на ${chainId} по адресу ${tokenAddress}`);
                
                // ТОЧНЫЙ ПОИСК по адресу токена (как в Тесте 1)
                const pools = await fetcher.fetchPoolsByToken(tokenAddress);
                
                if (pools && pools.length > 0) {
                    // Фильтруем только пулы с USDT
                    const usdtPools = pools.filter(pool => 
                        pool.quoteToken?.symbol?.toUpperCase() === 'USDT' || 'USDC'
                    );
                    
                    if (usdtPools.length > 0) {
                        logger.info(`✅ ${token.symbol} на ${chainId}: найдено ${usdtPools.length} USD пулов`);
                        
                        // Обрабатываем найденные пулы
                        const processed = await this.processTokenPools(
                            token.symbol,
                            chainId,
                            tokenAddress,
                            usdtPools
                        );
                        
                        results.push({
                            symbol: token.symbol,
                            chainId,
                            tokenAddress,
                            pools: processed,
                            stats: {
                                totalLiquidity: processed.reduce((sum, p) => sum + p.liquidityUsd, 0),
                                totalVolume: processed.reduce((sum, p) => sum + p.volume24h, 0),
                                poolCount: processed.length,
                                bestPool: processed.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
                            }
                        });
                    } else {
                        logger.warn(`⚠️ ${token.symbol} на ${chainId}: найдены пулы, но нет USD пар`, {
                            availableQuotes: [...new Set(pools.map(p => p.quoteToken?.symbol))]
                        });
                    }
                } else {
                    logger.debug(`ℹ️ ${token.symbol} на ${chainId}: пулов не найдено`);
                }
                
            } catch (error) {
                logger.error(`❌ Ошибка при обработке ${token.symbol} на ${chainId}:`, { error: error.message });
            }
            
            // Небольшая задержка между запросами
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        return results;
    }

    /**
     * Обработка найденных пулов токена
     */
    async processTokenPools(symbol, chainId, tokenAddress, pools) {
        const processedPools = [];
        
        for (const pool of pools) {
            try {
                // Проверяем, не обрабатывали ли уже этот пул
                const poolKey = `${chainId}:${pool.pairAddress}`;
                
                if (this.processedPools.has(poolKey)) {
                    logger.debug(`Пул ${pool.dexId} для ${symbol} уже обработан`);
                    continue;
                }
                
                // Добавляем в кэш обработанных
                this.processedPools.add(poolKey);
                
                // Ограничиваем размер кэша (последние 1000)
                if (this.processedPools.size > 1000) {
                    const toDelete = Array.from(this.processedPools).slice(0, 200);
                    toDelete.forEach(item => this.processedPools.delete(item));
                }
                
                // Обогащаем данные пула
                const enrichedPool = {
                    ...pool,
                    symbol,
                    chainId,
                    tokenAddress,
                    detectedAt: new Date().toISOString()
                };
                
                // 1. Анализ пула через poolAnalyzer
                const analysis = poolAnalyzer.analyzeSinglePool(enrichedPool);
                
                // 2. Поиск крупных транзакций (если есть данные)
                if (pool.txns24h && pool.txns24h.total > 0) {
                    const whales = whaleMonitor.analyzeTransactions(
                        symbol,
                        chainId,
                        enrichedPool,
                        this.mockTransactions(pool) // В реальном API здесь будут реальные транзакции
                    );
                    
                    if (whales.length > 0) {
                        eventEmitter.emit('dex:whales', {
                            symbol,
                            chain: chainId,
                            pool: pool.dexId,
                            whales,
                            count: whales.length
                        });
                    }
                }
                
                // 3. Генерируем события
                eventEmitter.emit('dex:poolData', {
                    symbol,
                    chain: chainId,
                    price: pool.priceUsd,
                    pool: enrichedPool,
                    analysis
                });
                
                // 4. Проверяем, является ли пул новым (по времени создания)
                if (pool.pairCreatedAt) {
                    const hoursSinceCreation = (Date.now() - new Date(pool.pairCreatedAt).getTime()) / (1000 * 60 * 60);
                    if (hoursSinceCreation < 24) {
                        eventEmitter.emit('dex:newPool', {
                            symbol,
                            chain: chainId,
                            pool: enrichedPool,
                            hoursSinceCreation: hoursSinceCreation.toFixed(1)
                        });
                    }
                }
                
                processedPools.push(enrichedPool);
                
                // Логируем информацию о пуле
                logger.debug(`📊 Пул ${pool.dexId} для ${symbol}:`, {
                    price: `$${pool.priceUsd}`,
                    liquidity: `$${pool.liquidityUsd}`,
                    volume24h: `$${pool.volume24h}`,
                    txns: pool.txns24h?.total || 0
                });
                
            } catch (error) {
                logger.error(`Ошибка обработки пула для ${symbol}:`, { error: error.message });
            }
        }
        
        return processedPools;
    }

    /**
     * Мониторинг конкретного токена по символу
     */
    async monitorToken(symbol) {
        const tokens = require('../config/tokens');
        const token = tokens.find(t => t.symbol === symbol);
        
        if (!token) {
            logger.error(`❌ Токен ${symbol} не найден в конфиге`);
            return null;
        }
        
        logger.info(`🎯 Мониторинг конкретного токена: ${symbol}`);
        const results = await this.processToken(token);
        
        return results;
    }

    /**
     * Получение статистики по всем токенам
     */
    getStats() {
        const tokens = require('../config/tokens');
        const stats = {};
        
        tokens.forEach(token => {
            stats[token.symbol] = {
                chains: Object.keys(token.dex),
                addresses: token.dex,
                tracked: true,
                lastCheck: new Date().toISOString()
            };
        });
        
        return stats;
    }

    /**
     * Временная функция для моковых транзакций
     * В реальном проекте здесь будет запрос к API DexScreener
     */
    mockTransactions(pool) {
        // Возвращаем null, так как у нас нет реальных транзакций
        // В будущем можно добавить запрос к /transactions/v1/{chainId}/{pairAddress}
        return null;
        
        /* Пример реального запроса:
        try {
            const response = await fetch(
                `https://api.dexscreener.com/transactions/v1/${chainId}/${pairAddress}`
            );
            return await response.json();
        } catch (error) {
            return null;
        }
        */
    }

    /**
     * Очистка кэша обработанных пулов
     */
    clearCache() {
        this.processedPools.clear();
        logger.info('🧹 Кэш обработанных пулов очищен');
    }
}

module.exports = new DexMonitor();