// src/notifier/telegram.js
const TelegramBot = require('node-telegram-bot-api');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class TelegramNotifier {
    constructor() {
        
        this.bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
        this.chatId = process.env.TG_CHAT_ID;
        
        eventEmitter.on('signal:open', this.sendSignal.bind(this));
        eventEmitter.on('signal:close', this.sendResult.bind(this));
        
        logger.info('Telegram нотификатор запущен');
    }
    
    sendSignal(data) {
        const emoji = data.direction === 'DEX_HIGHER' ? '📈' : '📉';
        const message = 
`${emoji} <b>СИГНАЛ ${data.symbol}</b>

DEX: $${data.dexPrice.toFixed(10)}
CEX: $${data.cexPrice.toFixed(10)}
Спред: <b>${data.spread.toFixed(2)}%</b>
Net: ${data.netProfit.toFixed(2)}%

Действуйте! 🚀`;
        
        this.send(message);
    }
    
    sendResult(data) {
        const emoji = data.isWin ? '✅' : '❌';
        const message = 
`${emoji} <b>РЕЗУЛЬТАТ ${data.symbol}</b>

Прибыль: <b>${data.profit > 0 ? '+' : ''}${data.profit.toFixed(2)}%</b>
Длительность: ${data.duration.toFixed(0)}с
Причина: ${data.reason}`;
        
        this.send(message);
    }
    
    send(message) {
        if (!this.bot || !this.chatId) return;
        this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' })
            .catch(err => logger.error('Telegram error', err));
    }
}

module.exports = new TelegramNotifier();