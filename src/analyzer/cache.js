class DataCache {
    constructor() {
        this.dexPrices = {};      // symbol -> { chain -> price }
        this.cexPrices = {};      // symbol -> { exchange -> price }
        this.pools = {};          // symbol -> { chain -> pools[] }
        this.cexStats = {};       // symbol -> { exchange -> stats }
        this.orderBooks = {};     // symbol -> { exchange -> orderbook }
    }

    updateDexPrice(symbol, chain, price, poolData) {
        if (poolData.quoteToken?.symbol !== 'USDT') return;
        if (!this.dexPrices[symbol]) this.dexPrices[symbol] = {};
        this.dexPrices[symbol][chain] = {
            price,
            timestamp: Date.now(),
            pool: poolData
        };

        // Сохраняем статистику
        if (!this.pools[symbol]) this.pools[symbol] = {};
        this.pools[symbol][chain] = poolData;
    }

    updateCexPrice(symbol, exchange, price, volume, bid, ask) {
        if (!this.cexPrices[symbol]) this.cexPrices[symbol] = {};
        this.cexPrices[symbol][exchange] = {
            price,
            volume,
            bid,
            ask,
            timestamp: Date.now()
        };

        // Сохраняем статистику
        if (!this.cexStats[symbol]) this.cexStats[symbol] = {};
        this.cexStats[symbol][exchange] = {
            price,
            volume,
            bid,
            ask,
            spread: ask && bid ? ((ask - bid) / bid) * 100 : null,
            timestamp: Date.now()
        };
    }

    updateOrderBook(symbol, exchange, orderbook) {
        if (!this.orderBooks[symbol]) this.orderBooks[symbol] = {};
        this.orderBooks[symbol][exchange] = {
            ...orderbook,
            timestamp: Date.now()
        };
    }

    getBestDexPrice(symbol) {
        const chains = this.dexPrices[symbol];
        if (!chains) return null;

        let best = { price: 0, chain: null, data: null };
        for (const [chain, data] of Object.entries(chains)) {
            if (data.price > best.price) {
                best = { price: data.price, chain, data };
            }
        }
        return best.price > 0 ? best : null;
    }

    getBestCexPrice(symbol) {
        const exchanges = this.cexPrices[symbol];
        if (!exchanges) return null;

        let best = { price: 0, exchange: null, data: null };
        for (const [exchange, data] of Object.entries(exchanges)) {
            if (data.price > best.price) {
                best = { price: data.price, exchange, data };
            }
        }
        return best.price > 0 ? best : null;
    }

    getCexStats(symbol) {
        const stats = this.cexStats[symbol];
        if (!stats) return null;

        // Усредняем или берем лучшие значения
        const exchanges = Object.keys(stats);
        if (exchanges.length === 0) return null;

        // Берем первую биржу для простоты
        const firstExchange = exchanges[0];
        return stats[firstExchange];
    }

    getDexStats(symbol) {
        const chains = this.pools[symbol];
        if (!chains) return null;

        // Суммируем ликвидность по всем пулам
        let totalLiquidity = 0;
        let totalVolume = 0;
        let bestPool = null;

        for (const [chain, pools] of Object.entries(chains)) {
            if (Array.isArray(pools)) {
                pools.forEach(pool => {
                    totalLiquidity += pool.liquidityUsd || 0;
                    totalVolume += pool.volume24h || 0;

                    if (!bestPool || (pool.liquidityUsd || 0) > (bestPool.liquidityUsd || 0)) {
                        bestPool = pool;
                    }
                });
            }
        }

        return {
            totalLiquidity,
            totalVolume,
            poolsCount: Object.keys(chains).length,
            bestPool
        };
    }
}

module.exports = new DataCache();