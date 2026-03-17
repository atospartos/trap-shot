require('dotenv').config();

module.exports = {
    // Общие настройки
    env: process.env.NODE_ENV || 'development',
    checkInterval: 0.1, // минут
    
    // Telegram
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    },
    
    // Биржи
    exchanges: {
        mexc: {
            apiKey: process.env.MEXC_API_KEY,
            secret: process.env.MEXC_SECRET_KEY,
            enable: process.env.MEXC_ENABLE === 'true'
        },
        gateio: {
            apiKey: process.env.GATEIO_API_KEY,
            secret: process.env.GATEIO_SECRET_KEY,
            enable: process.env.GATEIO_ENABLE === 'true'
        }
    },
    
    // Параметры стратегии
    strategy: {
        minPriceDiffPercent: parseFloat(process.env.MIN_PRICE_DIFF_PERCENT) || 2,
        minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD) || 50000,
        minVolume24hUsd: parseFloat(process.env.MIN_VOLUME_24H_USD) || 10000
    }
};