const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class DivergenceTracker {
    constructor() {
        // Настройки уведомлений
        this.notificationLevels = [
            { name: 'collapse_33', threshold: 33 },
            { name: 'collapse_50', threshold: 50 },
            { name: 'collapse_almost', threshold: 90 }
        ];
        
        this.collapseReserve = 2.0; // 2% запас
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Подписываемся на события, которые будет отправлять orchestrator
        eventEmitter.on('divergence:tracker:start', this.onDivergenceStart.bind(this));
        eventEmitter.on('divergence:tracker:update', this.onDivergenceUpdate.bind(this));
        eventEmitter.on('divergence:tracker:end', this.onDivergenceEnd.bind(this));
    }

    onDivergenceStart(data) {
        const { symbol, direction, spread, startTime } = data;
        
        this.sendStartNotification(symbol, direction, spread, startTime);
        
        // Сохраняем для отслеживания прогресса
        if (!this.activeDivergences) this.activeDivergences = new Map();
        const key = `${symbol}:${direction}`;
        this.activeDivergences.set(key, {
            startSpread: spread,
            lastNotified: {}
        });
    }

    onDivergenceUpdate(data) {
        const { symbol, direction, spread, timestamp } = data;
        const key = `${symbol}:${direction}`;
        
        const active = this.activeDivergences?.get(key);
        if (!active) return;
        
        const startSpread = active.startSpread;
        const collapsePercent = ((startSpread - spread) / startSpread) * 100;
        
        // Проверяем уровни схлопывания
        for (const level of this.notificationLevels) {
            if (!active.lastNotified[level.name] && collapsePercent >= level.threshold) {
                active.lastNotified[level.name] = true;
                this.sendCollapseNotification(symbol, direction, startSpread, spread, collapsePercent, level.name, timestamp);
            }
        }
        
        // Почти полностью схлопнулся (осталось < 1%)
        if (spread <= this.collapseReserve && !active.lastNotified.almost_complete) {
            active.lastNotified.almost_complete = true;
            this.sendAlmostCompleteNotification(symbol, direction, startSpread, spread, collapsePercent, timestamp);
        }
    }

    onDivergenceEnd(data) {
        const { symbol, direction, duration, maxSpread, endSpread, endTime } = data;
        
        this.sendEndNotification(symbol, direction, maxSpread, endSpread, duration, endTime);
        
        // Очищаем активный разрыв
        const key = `${symbol}:${direction}`;
        this.activeDivergences?.delete(key);
    }

    sendStartNotification(symbol, direction, spread, startTime) {
        const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';
        const emoji = direction === 'DEX_HIGHER' ? '📈' : '📉';
        
        const message = 
`${emoji} <b>НАЧАЛО РАЗРЫВА</b>

<b>${symbol}</b>
${directionText}: <b>${spread.toFixed(2)}%</b>

⏰ <b>Время:</b> ${new Date(startTime).toLocaleTimeString()}`;

        eventEmitter.emit('telegram:send', { message });
    }

    sendCollapseNotification(symbol, direction, startSpread, currentSpread, collapsePercent, level, timestamp) {
        const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';
        
        let levelText = '';
        let levelEmoji = '';
        
        switch (level) {
            case 'collapse_33':
                levelText = 'СХЛОПНУЛСЯ НА 1/3';
                levelEmoji = '📉';
                break;
            case 'collapse_50':
                levelText = 'СХЛОПНУЛСЯ НА 1/2';
                levelEmoji = '📉';
                break;
            default:
                levelText = 'СХЛОПЫВАНИЕ';
                levelEmoji = '📊';
        }
        
        const message = 
`${levelEmoji} <b>${levelText}</b>

<b>${symbol}</b>
${directionText}
📊 <b>Начальный спред:</b> ${startSpread.toFixed(2)}%
📉 <b>Текущий спред:</b> ${currentSpread.toFixed(2)}%
📉 <b>Схлопнулся на:</b> ${collapsePercent.toFixed(1)}%

⏰ <b>Время:</b> ${new Date(timestamp).toLocaleTimeString()}`;

        eventEmitter.emit('telegram:send', { message });
    }

    sendAlmostCompleteNotification(symbol, direction, startSpread, currentSpread, collapsePercent, timestamp) {
        const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';
        
        const message = 
`✅ <b>ПОЧТИ ПОЛНОСТЬЮ СХЛОПНУЛСЯ</b>

<b>${symbol}</b>
${directionText}
📊 <b>Начальный спред:</b> ${startSpread.toFixed(2)}%
📉 <b>Текущий спред:</b> ${currentSpread.toFixed(2)}%
📉 <b>Схлопнулся на:</b> ${collapsePercent.toFixed(1)}%

⏰ <b>Время:</b> ${new Date(timestamp).toLocaleTimeString()}`;

        eventEmitter.emit('telegram:send', { message });
    }

    sendEndNotification(symbol, direction, maxSpread, endSpread, duration, endTime) {
        const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';
        
        const minutes = Math.floor(duration / 60);
        const seconds = Math.floor(duration % 60);
        const durationText = minutes > 0 
            ? `${minutes} мин ${seconds} сек` 
            : `${seconds} сек`;
        
        const collapsePercent = ((maxSpread - endSpread) / maxSpread) * 100;
        
        const message = 
`✅ <b>РАЗРЫВ ЗАКРЫТ</b>

<b>${symbol}</b>
${directionText}

📊 <b>Максимальный спред:</b> ${maxSpread.toFixed(2)}%
✅ <b>Финальный спред:</b> ${endSpread.toFixed(2)}%
📉 <b>Схлопнулся на:</b> ${collapsePercent.toFixed(1)}%

⏱️ <b>Длительность:</b> ${durationText}
⏰ <b>Время закрытия:</b> ${new Date(endTime).toLocaleTimeString()}`;

        eventEmitter.emit('telegram:send', { message });
    }
}

module.exports = new DivergenceTracker();