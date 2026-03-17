const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class TelegramNotifier {
    constructor() {
        if (!config.telegram.token) {
            logger.warn('Telegram токен не указан, уведомления отключены');
            return;
        }

        this.bot = new TelegramBot(config.telegram.token, { polling: false });
        this.chatId = config.telegram.chatId;

        // Подписываемся на события
        eventEmitter.on('signal:priceDiff', this.sendSignal.bind(this));
        eventEmitter.on('dex:significantChanges', this.sendChanges.bind(this));
        eventEmitter.on('analysis:poolSummary', this.sendSummary.bind(this));

        logger.info('Telegram нотификатор инициализирован');
    }

    sendMessage(message, options = {}) {
        if (!this.bot || !this.chatId) return;

        this.bot.sendMessage(this.chatId, message, {
            parse_mode: 'HTML',
            ...options
        }).catch(err => {
            logger.error('Ошибка отправки Telegram', { error: err.message });
        });
    }

    sendSignal(data) {
        const emoji = data.diffPercent > 0 ? '📈' : '📉';
        const message =
            `${emoji} <b>Сигнал по ${data.symbol}</b>

DEX (${data.dex.chain}): $${data.dex.price.toFixed(6)}
CEX (${data.cex.exchange}): $${data.cex.price.toFixed(6)}
Разница: <b>${data.diffPercent.toFixed(2)}%</b>

DEX ликвидность: $${data.dex.data?.pool?.liquidityUsd?.toFixed(0) || 'N/A'}
CEX объем: $${data.cex.data?.volume?.toFixed(0) || 'N/A'}`;

        this.sendMessage(message);
    }

    sendStartupMessage() {
        const message =
            `🤖 <b>Trading Bot MVP запущен</b>

Отслеживаемые токены: ${require('../config/tokens').map(t => t.symbol).join(', ')}
Интервал проверки: ${config.checkInterval} мин
Порог сигнала: ${config.strategy.minPriceDiffPercent}%

Бот начал работу!`;

        this.sendMessage(message);
    }

    // Новый метод для отправки изменений
    sendChanges(data) {
        const message =
            `🔄 <b>Изменения по ${data.symbol}</b>

${data.changes.map(change => {
                switch (change.type) {
                    case 'new_pool':
                        return `🆕 Новый пул на ${change.pool.dexId}
   Ликвидность: $${change.pool.liquidityUsd.toFixed(0)}
   Цена: $${change.pool.priceUsd}`;
                    case 'price_change':
                        return `${change.change > 0 ? '📈' : '📉'} Цена ${Math.abs(change.change).toFixed(2)}%
   ${change.oldPrice} → ${change.newPrice}`;
                    case 'liquidity_change':
                        return `${change.change > 0 ? '➕' : '➖'} Ликвидность ${Math.abs(change.change).toFixed(0)}%
   $${change.oldLiquidity.toFixed(0)} → $${change.newLiquidity.toFixed(0)}`;
                    case 'high_activity':
                        return `🔥 Высокая активность
   Новых транзакций: ${change.newTransactions}
   Покупок: ${change.buys}, Продаж: ${change.sells}`;
                    default:
                        return '';
                }
            }).join('\n\n')}`;

        this.sendMessage(message);
    }

    // Новый метод для сводки по токену
    sendSummary(data) {
        const emoji = data.summary.hasEnoughLiquidity ? '✅' : '⚠️';
        const message =
            `${emoji} <b>Сводка по ${data.symbol}</b>

📊 <b>Пулы:</b> ${data.summary.poolsCount}
💰 <b>Общая ликвидность:</b> $${data.totalLiquidity.toFixed(0)} (${data.summary.liquidityGrade})
📈 <b>Объем 24ч:</b> $${data.totalVolume24h.toFixed(0)} (${data.summary.volumeGrade})
🔄 <b>Транзакций 24ч:</b> ${data.totalTxns24h}

🏆 <b>Лучший пул:</b>
   DEX: ${data.bestLiquidityPool?.dexId}
   Ликвидность: $${data.bestLiquidityPool?.liquidityUsd.toFixed(0)}
   Статус: ${data.bestLiquidityPool?.metrics.health}`;

        this.sendMessage(message);
    }
}

module.exports = new TelegramNotifier();