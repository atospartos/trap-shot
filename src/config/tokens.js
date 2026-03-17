// Список отслеживаемых токенов с маппингом между DEX и CEX
module.exports = [
    // {
    //     symbol: 'USDC',
        
    //     // DEX данные (DexScreener)
    //     dex: {
    //         solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    //         ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    //         bsc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
    //     },
        
    //     // CEX данные (CCXT)
    //     cex: {
    //         mexc: 'USDC/USDT',
    //         gateio: 'USDC/USDT'
    //     }
    // },
    {
        symbol: 'GF',
        dex: {
            bsc: '0x6Db461da03b8Ad06319fF2aF985E1C8dFcC004e0'
        },
        cex: {
            mexc: 'GF/USDT',
            gateio: 'GF/USDT'
        }
    }

];