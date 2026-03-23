const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class DivergenceTracker {
    constructor() {
        // Активные разрывы
        this.activeDivergences = new Map(); // key: symbol:exchange -> divergence data

        // Статистика по токенам
        this.tokenStats = new Map(); // symbol -> { totalDivergences, trueCollapses, ... }

        // Настройки
        this.config = {
            minSpreadToTrack: 1.5,           // Минимальный спред для отслеживания (%)
            trueCollapseThreshold: 0.3,      // Считаем схлопывание истинным, если CEX двинулся больше чем DEX на X%
            maxWaitTime: 90 * 60 * 1000,     // Максимальное ожидание схлопывания (1.5 часа)
            fastCollapseTime: 10 * 1000,     // Быстрое схлопывание (10 секунд)
            notificationLevels: [33, 50, 75, 90], // Уровни схлопывания для уведомлений
            collapseReserve: 1.0             // Остаток спреда для уведомления "почти схлопнулся" (%)
        };

        // Подписка на события
        this.setupEventListeners();
    }

    setupEventListeners() {
        // ВАЖНО: методы должны существовать!
        eventEmitter.on('divergence:start', this.onDivergenceStart.bind(this));
        eventEmitter.on('divergence:update', this.onDivergenceUpdate.bind(this));
        eventEmitter.on('divergence:end', this.onDivergenceEnd.bind(this));
    }

    // ========== ОБРАБОТЧИКИ СОБЫТИЙ ==========

    /**
     * Начало разрыва
     */
    onDivergenceStart(data) {
        const { symbol, exchange, direction, spread, dexPrice, cexPrice, timestamp } = data;
        const key = `${symbol}:${exchange}`;

        if (spread < this.config.minSpreadToTrack) {
            logger.debug(`Разрыв ${symbol} ${exchange} (${spread.toFixed(2)}%) ниже порога отслеживания`);
            return;
        }

        // Сохраняем активный разрыв
        const divergence = {
            symbol,
            exchange,
            direction,
            startTime: timestamp,
            startDexPrice: dexPrice,
            startCexPrice: cexPrice,
            startSpread: spread,

            // Текущие значения
            currentDexPrice: dexPrice,
            currentCexPrice: cexPrice,
            currentSpread: spread,

            // Динамика
            dexMovePercent: 0,
            cexMovePercent: 0,

            // Статус
            status: 'active',
            lastNotified: { start: true },
            movements: [],

            // Для статистики
            trueCollapse: null,
            collapseTime: null,
            collapseCause: null
        };

        this.activeDivergences.set(key, divergence);

        // Уведомление о начале
        this.sendStartNotification(symbol, exchange, direction, spread, timestamp);

        logger.info(`🔴 НАЧАЛО РАЗРЫВА ${symbol} ${exchange}`, {
            spread: `${spread.toFixed(2)}%`,
            dex: `$${dexPrice}`,
            cex: `$${cexPrice}`,
            direction
        });
    }

    /**
     * Обновление разрыва
     */
    onDivergenceUpdate(data) {
        // Отладка
        if (data.dexPrice === undefined || data.cexPrice === undefined) {
            logger.error(`❌ divergence:update missing prices`, {
                symbol: data.symbol,
                exchange: data.exchange,
                hasDexPrice: data.dexPrice !== undefined,
                hasCexPrice: data.cexPrice !== undefined,
                receivedKeys: Object.keys(data)
            });
        }
        const {
            symbol,
            exchange,
            direction,
            spread,
            dexPrice,
            cexPrice,
            dexMovePercent,
            cexMovePercent,
            collapsePercent,
            timestamp
        } = data;

        // Проверка на undefined
        if (dexPrice === undefined || cexPrice === undefined) {
            logger.error(`divergence:update missing prices for ${symbol} ${exchange}`, data);
            return;
        }
        const key = `${symbol}:${exchange}`;

        const divergence = this.activeDivergences.get(key);
        if (!divergence) return;

        // Обновляем текущие значения
        divergence.currentDexPrice = dexPrice;
        divergence.currentCexPrice = cexPrice;
        divergence.currentSpread = spread;
        divergence.dexMovePercent = dexMovePercent;
        divergence.cexMovePercent = cexMovePercent;

        // Сохраняем движение
        divergence.movements.push({
            time: timestamp,
            dexPrice,
            cexPrice,
            spread,
            dexMove: dexMovePercent,
            cexMove: cexMovePercent,
            collapsePercent
        });

        // Ограничиваем историю
        if (divergence.movements.length > 100) {
            divergence.movements.shift();
        }

        // Анализ причины схлопывания (если происходит)
        if (collapsePercent > 0) {
            this.analyzeCollapseCause(divergence, collapsePercent);
        }

        // Проверяем уровни схлопывания для уведомлений
        this.checkNotificationLevels(divergence, collapsePercent, timestamp);

        // Проверяем, не пора ли закрывать разрыв
        this.checkDivergenceEnd(divergence, timestamp);
    }

    /**
     * Конец разрыва
     */
    // ========== ОБРАБОТЧИК КОНЦА РАЗРЫВА ==========

    onDivergenceEnd(data) {
        const {
            symbol,
            exchange,
            direction,
            duration,
            endSpread,
            finalCollapse,
            dexMove,
            cexMove,
            endTime
        } = data;

        // Логируем полученные данные для отладки
        logger.debug(`📊 onDivergenceEnd для ${symbol} ${exchange}:`, {
            duration,
            endSpread,
            finalCollapse,
            dexMove,
            cexMove,
            endTime
        });
    

    // Подготовка объекта для уведомления
    const key = `${symbol}:${exchange}`;
    const activeDivergence = this.activeDivergences.get(key);

    const divergenceForNotification = {
        symbol,
        exchange,
        direction,
        currentSpread: endSpread,
        startSpread: activeDivergence?.startSpread,
        trueCollapse: activeDivergence?.trueCollapse,
        dexMovePercent: activeDivergence?.dexMovePercent || dexMove,
        cexMovePercent: activeDivergence?.cexMovePercent || cexMove
    };

        this.sendEndNotification(divergenceForNotification, duration, finalCollapse, endTime);
this.activeDivergences.delete(key);
    }

// ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

/**
 * Анализ причины схлопывания
 */
analyzeCollapseCause(divergence, collapsePercent) {
    const dexMove = divergence.dexMovePercent;
    const cexMove = divergence.cexMovePercent;

    const dexContribution = Math.abs(dexMove);
    const cexContribution = Math.abs(cexMove);
    const total = dexContribution + cexContribution;

    if (total === 0) return;

    const cexRatio = cexContribution / total;

    // Истинное схлопывание — когда CEX двигается в сторону DEX
    let isTrueCollapse = false;
    let cause = 'unknown';

    if (divergence.direction === 'DEX_HIGHER') {
        // CEX должен расти (движение вверх положительное)
        const cexMovingUp = divergence.cexMovePercent > 0;

        if (cexMovingUp && cexRatio > this.config.trueCollapseThreshold) {
            isTrueCollapse = true;
            cause = 'cex_catching_up';
        } else {
            isTrueCollapse = false;
            cause = 'dex_moving_down';
        }
    } else { // CEX_HIGHER
        // CEX должен падать (движение вниз отрицательное)
        const cexMovingDown = divergence.cexMovePercent < 0;

        if (cexMovingDown && cexRatio > this.config.trueCollapseThreshold) {
            isTrueCollapse = true;
            cause = 'cex_catching_down';
        } else {
            isTrueCollapse = false;
            cause = 'dex_moving_up';
        }
    }

    divergence.trueCollapse = isTrueCollapse;
    divergence.collapseCause = cause;

    // Логируем только если есть значительное изменение
    if (collapsePercent > 5 && !divergence.causeNotified) {
        const causeText = isTrueCollapse
            ? `✅ ИСТИННОЕ: CEX движется к DEX (${cause})`
            : `⚠️ ЛОЖНОЕ: DEX движется к CEX (${cause})`;

        logger.info(`📊 ${divergence.symbol} ${divergence.exchange}: ${causeText}`, {
            dexMove: `${divergence.dexMovePercent > 0 ? '+' : ''}${divergence.dexMovePercent.toFixed(2)}%`,
            cexMove: `${divergence.cexMovePercent > 0 ? '+' : ''}${divergence.cexMovePercent.toFixed(2)}%`,
            collapse: `${collapsePercent.toFixed(1)}%`
        });

        divergence.causeNotified = true;

        // Отправляем уведомление о ложном разрыве (только 1 раз)
        if (!isTrueCollapse && !divergence.falseNotified) {
            divergence.falseNotified = true;
            this.sendFalseDivergenceNotification(divergence);
        }
    }
}

/**
 * Проверка уровней схлопывания для уведомлений
 */
checkNotificationLevels(divergence, collapsePercent, timestamp) {
    for (const level of this.config.notificationLevels) {
        const levelKey = `collapse_${level}`;
        if (!divergence.lastNotified[levelKey] && collapsePercent >= level) {
            divergence.lastNotified[levelKey] = true;
            this.sendCollapseNotification(divergence, collapsePercent, level, timestamp);
        }
    }

    // Почти полностью схлопнулся (осталось < 1%)
    if (!divergence.lastNotified.almost_complete &&
        divergence.currentSpread <= this.config.collapseReserve) {
        divergence.lastNotified.almost_complete = true;
        this.sendAlmostCompleteNotification(divergence, collapsePercent, timestamp);
    }
}

/**
 * Проверка, нужно ли закрыть разрыв
 */
checkDivergenceEnd(divergence, timestamp) {
    // 1. Схлопнулся полностью
    if (divergence.currentSpread <= 0.1) {
        this.endDivergence(divergence, timestamp, 'collapsed');
        return;
    }

    // 2. Превышено максимальное время ожидания
    const elapsed = timestamp - divergence.startTime;
    if (elapsed > this.config.maxWaitTime) {
        this.endDivergence(divergence, timestamp, 'timeout');
        return;
    }

    // 3. Движение в противоположную сторону (разрыв увеличился более чем на 50%)
    if (divergence.currentSpread > divergence.startSpread * 1.5) {
        this.endDivergence(divergence, timestamp, 'expanded');
    }
}

/**
 * Завершение разрыва (внутренний метод)
 */
endDivergence(divergence, timestamp, reason) {
    const duration = (timestamp - divergence.startTime) / 1000;
    const finalCollapse = ((divergence.startSpread - divergence.currentSpread) / divergence.startSpread) * 100;

    // Отправляем событие для внешней обработки
    eventEmitter.emit('divergence:end', {
        symbol: divergence.symbol,
        exchange: divergence.exchange,
        direction: divergence.direction,
        duration,
        endSpread: divergence.currentSpread,
        finalCollapse,
        dexMove: divergence.dexMovePercent,
        cexMove: divergence.cexMovePercent,
        reason,
        endTime: timestamp
    });
}

/**
 * Обновление статистики токена
 */
updateTokenStats(divergence, duration, collapsePercent, isFastCollapse) {
    if (!this.tokenStats.has(divergence.symbol)) {
        this.tokenStats.set(divergence.symbol, {
            totalDivergences: 0,
            trueCollapses: 0,
            falseCollapses: 0,
            fastCollapses: 0,
            totalCollapseTime: 0,
            avgCollapseTime: 0,
            avgCollapsePercent: 0,
            lastUpdate: Date.now()
        });
    }

    const stats = this.tokenStats.get(divergence.symbol);
    stats.totalDivergences++;

    if (divergence.trueCollapse === true) {
        stats.trueCollapses++;
        stats.totalCollapseTime += duration;
        stats.avgCollapseTime = stats.totalCollapseTime / stats.trueCollapses;
    } else if (divergence.trueCollapse === false) {
        stats.falseCollapses++;
    }

    if (isFastCollapse) {
        stats.fastCollapses++;
    }

    stats.avgCollapsePercent = (stats.avgCollapsePercent * (stats.totalDivergences - 1) + collapsePercent) / stats.totalDivergences;
    stats.lastUpdate = Date.now();
}

/**
 * Получение пригодности токена для стратегии
 */
getTokenSuitability(symbol) {
    const stats = this.tokenStats.get(symbol);
    if (!stats || stats.totalDivergences < 5) {
        return {
            symbol,
            hasEnoughData: false,
            message: 'Недостаточно данных (нужно минимум 5 разрывов)'
        };
    }

    const trueRate = (stats.trueCollapses / stats.totalDivergences) * 100;
    const fastRate = (stats.fastCollapses / stats.totalDivergences) * 100;

    let grade = 'C';
    let recommendation = 'Средняя пригодность';

    if (trueRate > 70 && fastRate > 30) {
        grade = 'A';
        recommendation = 'Отлично подходит для арбитража';
    } else if (trueRate > 50 && fastRate > 20) {
        grade = 'B';
        recommendation = 'Хорошо подходит';
    } else if (trueRate > 30) {
        grade = 'C';
        recommendation = 'Средняя пригодность, требуется осторожность';
    } else {
        grade = 'D';
        recommendation = 'Низкая пригодность, часто ложные разрывы';
    }

    return {
        symbol,
        hasEnoughData: true,
        totalDivergences: stats.totalDivergences,
        trueCollapseRate: `${trueRate.toFixed(1)}%`,
        falseCollapseRate: `${(100 - trueRate).toFixed(1)}%`,
        fastCollapseRate: `${fastRate.toFixed(1)}%`,
        avgCollapseTime: `${(stats.avgCollapseTime / 60).toFixed(1)} мин`,
        avgCollapsePercent: `${stats.avgCollapsePercent.toFixed(1)}%`,
        grade,
        recommendation
    };
}

// ========== УВЕДОМЛЕНИЯ В TELEGRAM ==========

sendStartNotification(symbol, exchange, direction, spread, timestamp) {
    const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';
    const emoji = direction === 'DEX_HIGHER' ? '📈' : '📉';

    const message =
        `${emoji} <b>НАЧАЛО РАЗРЫВА</b>

<b>${symbol}</b> (${exchange})
${directionText}: <b>${spread.toFixed(2)}%</b>

⏰ <b>Время:</b> ${new Date(timestamp).toLocaleTimeString()}`;

    eventEmitter.emit('telegram:send', { message });
}

sendCollapseNotification(divergence, collapsePercent, level, timestamp) {
    // Защита от undefined
    if (!divergence) {
        logger.error('❌ sendCollapseNotification: divergence is undefined');
        return;
    }

    const symbol = divergence.symbol || 'unknown';
    const exchange = divergence.exchange || 'unknown';
    const direction = divergence.direction || 'unknown';
    const startSpread = divergence.startSpread;
    const currentSpread = divergence.currentSpread;
    const dexMove = divergence.dexMovePercent;
    const cexMove = divergence.cexMovePercent;

    if (startSpread === undefined || currentSpread === undefined) {
        logger.error(`❌ sendCollapseNotification: missing spreads for ${symbol} ${exchange}`, {
            startSpread,
            currentSpread
        });
        return;
    }

    const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';

    const levelText = {
        33: 'СХЛОПНУЛСЯ НА 1/3',
        50: 'СХЛОПНУЛСЯ НА 1/2',
        75: 'СХЛОПНУЛСЯ НА 3/4',
        90: 'ПОЧТИ ПОЛНОСТЬЮ СХЛОПНУЛСЯ'
    }[level] || `СХЛОПНУЛСЯ НА ${level}%`;

    const emoji = level >= 75 ? '✅' : '📉';

    const causeText = divergence.trueCollapse === true
        ? '✅ Истинное схлопывание (CEX догоняет DEX)'
        : divergence.trueCollapse === false
            ? '⚠️ Ложное схлопывание (DEX движется к CEX)'
            : '🔄 Смешанное движение';

    const message =
        `${emoji} <b>${levelText}</b>

<b>${symbol}</b> (${exchange})
${directionText}

📊 <b>Начальный спред:</b> ${startSpread.toFixed(2)}%
📉 <b>Текущий спред:</b> ${currentSpread.toFixed(2)}%
📉 <b>Схлопнулся на:</b> ${collapsePercent.toFixed(1)}%

📈 <b>Движение:</b>
• DEX: ${dexMove !== undefined ? (dexMove > 0 ? '+' : '') + dexMove.toFixed(2) + '%' : 'N/A'}
• CEX: ${cexMove !== undefined ? (cexMove > 0 ? '+' : '') + cexMove.toFixed(2) + '%' : 'N/A'}

🔍 <b>Анализ:</b> ${causeText}

⏰ <b>Время:</b> ${new Date(timestamp).toLocaleTimeString()}`;

    eventEmitter.emit('telegram:send', { message });
}

sendFalseDivergenceNotification(divergence) {
    const message =
        `⚠️ <b>ЛОЖНЫЙ РАЗРЫВ</b>

<b>${divergence.symbol}</b> (${divergence.exchange})
Разрыв схлопывается за счет движения DEX к CEX

📊 <b>Движение:</b>
• DEX: ${divergence.dexMovePercent > 0 ? '+' : ''}${divergence.dexMovePercent.toFixed(2)}%
• CEX: ${divergence.cexMovePercent > 0 ? '+' : ''}${divergence.cexMovePercent.toFixed(2)}%

💡 <b>Рекомендация:</b> Не открывать позицию, дождаться истинного схлопывания`;

    eventEmitter.emit('telegram:send', { message });
}

sendAlmostCompleteNotification(divergence, collapsePercent, timestamp) {
    if (!divergence) {
        logger.error('❌ sendAlmostCompleteNotification: divergence is undefined');
        return;
    }

    const symbol = divergence.symbol || 'unknown';
    const exchange = divergence.exchange || 'unknown';
    const direction = divergence.direction || 'unknown';
    const startSpread = divergence.startSpread;
    const currentSpread = divergence.currentSpread;

    if (startSpread === undefined || currentSpread === undefined) {
        logger.error(`❌ sendAlmostCompleteNotification: missing spreads for ${symbol} ${exchange}`);
        return;
    }

    const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';

    const message =
        `✅ <b>ПОЧТИ ПОЛНОСТЬЮ СХЛОПНУЛСЯ</b>

<b>${symbol}</b> (${exchange})
${directionText}
Осталось менее 1% спреда

📊 <b>Начальный спред:</b> ${startSpread.toFixed(2)}%
📉 <b>Текущий спред:</b> ${currentSpread.toFixed(2)}%
📉 <b>Схлопнулся на:</b> ${collapsePercent.toFixed(1)}%

⏰ <b>Время:</b> ${new Date(timestamp).toLocaleTimeString()}`;

    eventEmitter.emit('telegram:send', { message });
}

sendEndNotification(divergence, duration, collapsePercent, endTime) {
    // Защита от undefined
    if (!divergence) {
        logger.error('❌ sendEndNotification: divergence is undefined');
        return;
    }

    const symbol = divergence.symbol || 'unknown';
    const exchange = divergence.exchange || 'unknown';
    const direction = divergence.direction || 'unknown';

    // Безопасное получение значений — ВСЕГДА ЧИСЛА
    let endSpread = divergence.currentSpread;
    let finalCollapse = collapsePercent;

    // Если endSpread все еще undefined, используем lastSpread
    if (endSpread === undefined && divergence.lastSpread !== undefined) {
        endSpread = divergence.lastSpread;
    }


    // Преобразуем в числа и проверяем
    const endSpreadNum = parseFloat(endSpread);
    const finalCollapseNum = parseFloat(finalCollapse);
    const durationNum = parseFloat(duration);

    // Форматируем с защитой от NaN
    const minutes = Math.floor(durationNum / 60);
    const seconds = Math.floor(durationNum % 60);
    const durationText = minutes > 0
        ? `${minutes} мин ${seconds} сек`
        : `${seconds} сек`;

    const isFast = durationNum <= this.config.fastCollapseTime;
    const fastText = isFast ? '🚀 БЫСТРОЕ ' : '';

    const trueText = divergence.trueCollapse === true
        ? '✅ Истинный разрыв (CEX догнал DEX)'
        : divergence.trueCollapse === false
            ? '❌ Ложный разрыв (DEX двигался к CEX)'
            : '❓ Неопределенный';

    const directionText = direction === 'DEX_HIGHER' ? 'DEX дороже CEX' : 'CEX дороже DEX';
    const emoji = direction === 'DEX_HIGHER' ? '📈' : '📉';

    // ФОРМИРУЕМ СООБЩЕНИЕ — теперь все числа валидны
    const message =
        `${fastText}${emoji} <b>РАЗРЫВ ЗАКРЫТ</b>

<b>${symbol}</b> (${exchange})
${directionText}

✅ <b>Финальный спред:</b> ${endSpreadNum.toFixed(2)}%
📉 <b>Схлопнулся на:</b> ${finalCollapseNum.toFixed(1)}%

⏱️ <b>Длительность:</b> ${durationText}
🔍 <b>Тип:</b> ${trueText}

⏰ <b>Время закрытия:</b> ${new Date(endTime).toLocaleTimeString()}`;

    eventEmitter.emit('telegram:send', { message });
}
}

module.exports = new DivergenceTracker();