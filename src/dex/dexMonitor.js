const dexClient = require('./dexClient');
const logger = require('../core/logger');
// const eventEmitter = require('../core/eventEmitter');

class DexMonitor {
    async fetchTokenData(symbol, chainId, tokenAddress) {
        try {
            logger.debug(`🔍 DEX запрос для ${symbol} на ${chainId}`);
            
            const allPools = await dexClient.searchByExactAddress(tokenAddress);
            
            if (!allPools || allPools.length === 0) {
                logger.debug(`ℹ️ Нет пулов для ${symbol} на ${chainId}`);
                return null;
            }
            
            // Берем пул с максимальной ликвидностью
            const bestPool = allPools.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
            
            logger.debug(`✅ DEX данные для ${symbol}: ${bestPool.baseToken}/${bestPool.quoteToken} $${bestPool.priceUsd} (ликв. $${bestPool.liquidityUsd})`);
            
            
            return [bestPool];
            
        } catch (error) {
            logger.error(`❌ Ошибка DEX для ${symbol}:`, { error: error.message });
            throw error;
        }
    }
}

module.exports = new DexMonitor();