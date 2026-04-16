// src/cex/mexcExecutor.js
const fs = require('fs');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const mexcPrivate = require('./mexcPrivate');

class MexcExecutor {
    constructor() {
        // Активные объекты
        this.activeTraps = new Map();           // symbol -> данные ловушки
        this.activeTakeProfits = new Map();     // symbol -> данные тейка
        this.remainderTimers = new Map();       // symbol -> таймер остатка
        
        // Риск-менеджмент
        this.riskManager = {
            tokenStats: new Map(),
            dailyStats: {
                date: new Date().toISOString().split('T')[0],
                totalLoss: 0,
                totalProfit: 0,
                tradesCount: 0
            },
            config: {
                maxConsecutiveLosses: 3,
                positionSize: 5,
                totalDeposit: 25,
                dailyLossLimit: 5,
                dailyResetHour: 0,
                cooldownAfterLossMs: 3600000
            }
        };
        
        this.isHalted = false;
        this.haltedReason = null;
        
        // Базовая конфигурация
        this.config = {
            // Ловушка (фиксированный отступ)
            trapOffsetPercent: 10,               // фиксированный отступ от DEX (%)
            
            // Тейк
            takeProfitRecoveryPercent: 70,       // восстановление (%)
            
            // Раскорелляция
            decouplingThreshold: 5,              // порог раскорелляции для входа (%)
            
            // Частичное исполнение
            partialFill: {
                remainderTimeoutMs: 30000,
                cancelOnDexDrop: true,
                dexDropThreshold: 2,
                returnOnTakeProfit: true,
            },
            
            // Таймаут позиции
            positionTimeoutMs: 3 * 60 * 60 * 1000,
            
            // Файлы
            trapsFile: './data/traps.json',
            positionsFile: './data/positions.json',
            statsFile: './data/risk_stats.json',
            monitorIntervalMs: 2000
        };
        
        this.setupListeners();
        this.loadTraps();
        this.loadTakeProfits();
        this.loadRiskStats();
        this.startMonitor();
        this.startDailyReset();
        
        logger.info('🚀 MEXC Executor (ловля прострелов) запущен');
        logger.info(`   Отступ ловушки: ${this.config.trapOffsetPercent}% от DEX`);
        logger.info(`   Тейк: ${this.config.takeProfitRecoveryPercent}% восстановления`);
        logger.info(`   Раскорелляция: вход при ≥${this.config.decouplingThreshold}%`);
        logger.info(`   Размер позиции: $${this.riskManager.config.positionSize}`);
        logger.info(`   Дневной лимит: $${this.riskManager.config.dailyLossLimit}`);
    }

    setupListeners() {
        eventEmitter.on('signal:create_trap', this.onCreateTrap.bind(this));
        eventEmitter.on('signal:update_trap', this.onUpdateTrap.bind(this));
        eventEmitter.on('signal:cancel_trap', this.onCancelTrap.bind(this));
        eventEmitter.on('signal:update_take_profit', this.onUpdateTakeProfit.bind(this));
        eventEmitter.on('signal:close_position', this.onClosePosition.bind(this));
        eventEmitter.on('signal:decoupling_entry', this.onDecouplingEntry.bind(this));
    }

    // ==================== РИСК-МЕНЕДЖМЕНТ ====================

    startDailyReset() {
        const now = new Date();
        const nextReset = new Date();
        nextReset.setDate(now.getDate() + 1);
        nextReset.setHours(this.riskManager.config.dailyResetHour, 0, 0, 0);
        
        const msUntilReset = nextReset - now;
        
        setTimeout(() => {
            this.resetDailyStats();
            setInterval(() => this.resetDailyStats(), 24 * 60 * 60 * 1000);
        }, msUntilReset);
    }

    resetDailyStats() {
        const today = new Date().toISOString().split('T')[0];
        
        this.riskManager.dailyStats = {
            date: today,
            totalLoss: 0,
            totalProfit: 0,
            tradesCount: 0
        };
        
        this.saveRiskStats();
        logger.info(`📅 Дневная статистика сброшена (${today})`);
        
        if (this.isHalted && this.haltedReason === 'daily_loss_limit') {
            this.isHalted = false;
            this.haltedReason = null;
            logger.info(`✅ Дневной лимит сброшен, торговля возобновлена`);
        }
    }

    async checkDailyLossLimit() {
        const dailyLoss = this.riskManager.dailyStats.totalLoss;
        
        if (dailyLoss >= this.riskManager.config.dailyLossLimit) {
            logger.error(`🛑 ДНЕВНОЙ ЛИМИТ УБЫТКА: $${dailyLoss} / $${this.riskManager.config.dailyLossLimit}`);
            this.isHalted = true;
            this.haltedReason = 'daily_loss_limit';
            
            for (const [symbol, trap] of this.activeTraps) {
                await this.onCancelTrap({ symbol });
            }
            for (const [symbol, tp] of this.activeTakeProfits) {
                await this.onClosePosition({ symbol, size: tp.size, price: 0, reason: 'daily_stop_loss' });
            }
            
            return false;
        }
        return true;
    }

    async checkTokenLossLimit(symbol) {
        const stats = this.riskManager.tokenStats.get(symbol);
        if (!stats) return true;
        
        if (stats.consecutiveLosses >= this.riskManager.config.maxConsecutiveLosses) {
            const cooldownRemaining = (stats.lastTradeTime + this.riskManager.config.cooldownAfterLossMs) - Date.now();
            
            if (cooldownRemaining > 0) {
                logger.warn(`⏸️ ТОРГОВЛЯ ${symbol} ОСТАНОВЛЕНА: ${stats.consecutiveLosses} убытков подряд, кулдаун ${Math.ceil(cooldownRemaining / 60000)} мин`);
                return false;
            } else {
                stats.consecutiveLosses = 0;
                this.saveRiskStats();
                logger.info(`✅ ТОРГОВЛЯ ${symbol} ВОЗОБНОВЛЕНА`);
                return true;
            }
        }
        return true;
    }

    updateTokenStats(symbol, isWin, profit) {
        let stats = this.riskManager.tokenStats.get(symbol);
        
        if (!stats) {
            stats = {
                losses: 0,
                wins: 0,
                consecutiveLosses: 0,
                totalProfit: 0,
                lastTradeTime: 0
            };
            this.riskManager.tokenStats.set(symbol, stats);
        }
        
        if (isWin) {
            stats.wins++;
            stats.consecutiveLosses = 0;
        } else {
            stats.losses++;
            stats.consecutiveLosses++;
        }
        
        stats.totalProfit += profit;
        stats.lastTradeTime = Date.now();
        
        this.saveRiskStats();
        
        if (stats.consecutiveLosses >= this.riskManager.config.maxConsecutiveLosses - 1) {
            logger.warn(`⚠️ ${symbol}: ${stats.consecutiveLosses + 1} убытков подряд!`);
        }
    }

    updateDailyStats(profit, isWin) {
        if (profit < 0) {
            this.riskManager.dailyStats.totalLoss += Math.abs(profit);
        } else {
            this.riskManager.dailyStats.totalProfit += profit;
        }
        this.riskManager.dailyStats.tradesCount++;
        
        this.saveRiskStats();
        this.checkDailyLossLimit();
    }

    canOpenPosition(symbol, size) {
        if (this.isHalted) {
            logger.warn(`⚠️ Торговля остановлена: ${this.haltedReason}`);
            return false;
        }
        
        if (!this.checkTokenLossLimit(symbol)) {
            return false;
        }
        
        if (this.riskManager.dailyStats.totalLoss >= this.riskManager.config.dailyLossLimit) {
            logger.warn(`⚠️ Дневной лимит убытка достигнут`);
            return false;
        }
        
        const totalExposure = this.getTotalExposure();
        if (totalExposure + size > this.riskManager.config.totalDeposit) {
            logger.warn(`⚠️ Превышение депозита: $${totalExposure + size} > $${this.riskManager.config.totalDeposit}`);
            return false;
        }
        
        return true;
    }

    getTotalExposure() {
        let total = 0;
        for (const trap of this.activeTraps.values()) {
            total += trap.totalSize;
        }
        for (const tp of this.activeTakeProfits.values()) {
            total += tp.size;
        }
        return total;
    }

    // ==================== РАСЧЕТ ТЕЙКА ====================

    calculateTakeProfitPrice(dexPrice, cexPrice) {
        // Если DEX ниже CEX — тейк по текущей цене CEX
        if (dexPrice < cexPrice) {
            return cexPrice;
        }
        // Иначе тейк от DEX (70% восстановления)
        return dexPrice * (1 - this.config.takeProfitRecoveryPercent / 100);
    }

    // ==================== ЛОВУШКА ====================

    async onCreateTrap({ symbol, dexPrice, trapPrice, size }) {
        if (!this.canOpenPosition(symbol, size)) {
            logger.warn(`${symbol}: отклонено (risk management)`);
            return;
        }
        
        if (this.activeTraps.has(symbol)) {
            logger.warn(`${symbol}: ловушка уже существует`);
            return;
        }
        
        logger.info(`📌 ЛОВУШКА ${symbol}: BUY LIMIT ${trapPrice}, size ${size} (отступ ${this.config.trapOffsetPercent}% от DEX ${dexPrice})`);
        
        const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', size, trapPrice);
        
        if (order && order.orderId) {
            const trap = {
                symbol,
                dexPrice,
                trapPrice,
                remainingSize: size,
                totalSize: size,
                orderId: order.orderId,
                originalDexPrice: dexPrice,
                status: 'active',
                createdAt: Date.now()
            };
            
            this.activeTraps.set(symbol, trap);
            this.saveTraps();
            logger.info(`✅ ЛОВУШКА ${symbol} выставлена (ID: ${order.orderId})`);
            this.startRemainderTimer(symbol);
        }
    }

    async onUpdateTrap({ symbol, newTrapPrice, newDexPrice }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;
        
        logger.info(`🔄 ОБНОВЛЕНИЕ ЛОВУШКИ ${symbol}: ${trap.trapPrice} → ${newTrapPrice}`);
        
        await mexcPrivate.cancelOrder(symbol, trap.orderId);
        
        const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', trap.remainingSize, newTrapPrice);
        
        if (order && order.orderId) {
            trap.trapPrice = newTrapPrice;
            trap.dexPrice = newDexPrice;
            trap.orderId = order.orderId;
            this.saveTraps();
            logger.info(`✅ ЛОВУШКА ${symbol} обновлена`);
        }
    }

    async onCancelTrap({ symbol }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;
        
        await mexcPrivate.cancelOrder(symbol, trap.orderId);
        this.activeTraps.delete(symbol);
        this.saveTraps();
        this.clearRemainderTimer(symbol);
        logger.info(`❌ ЛОВУШКА ${symbol} отменена`);
    }

    // ==================== ТЕЙК ====================

    async onUpdateTakeProfit({ symbol, takeProfitPrice, size, reason = 'standard' }) {
        const existing = this.activeTakeProfits.get(symbol);
        
        if (existing && existing.orderId) {
            await mexcPrivate.cancelOrder(symbol, existing.orderId);
        }
        
        const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', size, takeProfitPrice);
        
        if (order && order.orderId) {
            const tp = {
                symbol,
                takeProfitPrice,
                size,
                orderId: order.orderId,
                status: 'active',
                createdAt: Date.now(),
                reason
            };
            
            this.activeTakeProfits.set(symbol, tp);
            this.saveTakeProfits();
            logger.info(`🎯 ТЕЙК ${symbol}: SELL LIMIT ${takeProfitPrice}, size ${size} (${reason})`);
        }
    }

    // ==================== РАСКОРЕЛЛЯЦИЯ ====================

    async onDecouplingEntry({ symbol, dexPrice, cexPrice, size }) {
        if (!this.canOpenPosition(symbol, size)) {
            logger.warn(`${symbol}: отклонено (risk management)`);
            return;
        }
        
        if (this.activeTraps.has(symbol) || this.activeTakeProfits.has(symbol)) {
            logger.warn(`${symbol}: уже есть активная позиция, пропускаем вход по раскорелляции`);
            return;
        }
        
        const decoupling = ((dexPrice - cexPrice) / cexPrice) * 100;
        
        logger.info(`📈 РАСКОРЕЛЛЯЦИЯ ${symbol}: DEX $${dexPrice} | CEX $${cexPrice} | разрыв ${decoupling.toFixed(2)}%`);
        logger.info(`   Вход по лимиту: BUY LIMIT ${size} USDT @ $${cexPrice}`);
        
        const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', size, cexPrice);
        
        if (order && order.orderId) {
            const trap = {
                symbol,
                dexPrice,
                trapPrice: cexPrice,
                remainingSize: size,
                totalSize: size,
                orderId: order.orderId,
                originalDexPrice: dexPrice,
                status: 'active',
                createdAt: Date.now(),
                isDecoupling: true
            };
            
            this.activeTraps.set(symbol, trap);
            this.saveTraps();
            
            const takeProfitPrice = dexPrice;
            await this.onUpdateTakeProfit({ symbol, takeProfitPrice, size, reason: 'decoupling' });
            
            logger.info(`✅ Вход по раскорелляции ${symbol} выполнен, тейк ${takeProfitPrice}`);
        }
    }

    // ==================== ЧАСТИЧНОЕ ИСПОЛНЕНИЕ ====================

    async handlePartialFill(symbol, filledSize, filledPrice, remainingSize) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;
        
        trap.remainingSize = remainingSize;
        this.saveTraps();
        
        const currentDexPrice = trap.dexPrice;
        const currentCexPrice = await this.getCurrentCexPrice(symbol);
        const takeProfitPrice = this.calculateTakeProfitPrice(currentDexPrice, currentCexPrice);
        
        await this.onUpdateTakeProfit({
            symbol,
            takeProfitPrice,
            size: filledSize,
            reason: `partial_${filledSize}`
        });
        
        logger.info(`⚠️ ЧАСТИЧНОЕ ИСПОЛНЕНИЕ ${symbol}: +${filledSize} USDT (всего ${trap.totalSize - remainingSize}/${trap.totalSize})`);
        logger.info(`   Тейк: ${takeProfitPrice} (DEX=${currentDexPrice}, CEX=${currentCexPrice})`);
        
        this.resetRemainderTimer(symbol);
    }

    async handleTakeProfitFilled(symbol, filledSize, filledPrice) {
        const trap = this.activeTraps.get(symbol);
        const tp = this.activeTakeProfits.get(symbol);
        
        if (!trap || !tp) return;
        
        // Расчет прибыли
        const profit = (filledPrice - trap.trapPrice) * filledSize;
        const profitPercent = ((filledPrice - trap.trapPrice) / trap.trapPrice) * 100;
        const isWin = profit > 0;
        
        this.updateTokenStats(symbol, isWin, profit);
        this.updateDailyStats(profit, isWin);
        
        logger.info(`💰 РЕЗУЛЬТАТ ${symbol}: ${isWin ? 'ПРИБЫЛЬ' : 'УБЫТОК'} $${profit.toFixed(4)} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
        
        this.activeTakeProfits.delete(symbol);
        this.saveTakeProfits();
        
        if (this.config.partialFill.returnOnTakeProfit && trap.remainingSize > 0) {
            const newSize = trap.remainingSize + filledSize;
            const currentDexPrice = trap.dexPrice;
            const newTrapPrice = currentDexPrice * (1 - this.config.trapOffsetPercent / 100);
            
            await mexcPrivate.cancelOrder(symbol, trap.orderId);
            
            const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', newSize, newTrapPrice);
            
            if (order && order.orderId) {
                trap.remainingSize = newSize;
                trap.totalSize = newSize;
                trap.trapPrice = newTrapPrice;
                trap.orderId = order.orderId;
                this.saveTraps();
                
                const newTakeProfitPrice = this.calculateTakeProfitPrice(currentDexPrice, currentDexPrice);
                await this.onUpdateTakeProfit({ symbol, takeProfitPrice: newTakeProfitPrice, size: newSize, reason: 'return' });
                
                logger.info(`🔄 ВОЗВРАТ ${symbol}: ${filledSize} USDT в ловушку, новая ловушка ${newSize} USDT`);
            }
        } else {
            this.activeTraps.delete(symbol);
            this.saveTraps();
            logger.info(`✅ ТЕЙК ИСПОЛНЕН ${symbol}: ${filledSize} USDT по ${filledPrice}`);
        }
        
        this.clearRemainderTimer(symbol);
    }

    // ==================== СТРАХОВКА ЛОВУШКИ ====================

    async checkDexDrop(symbol, trap, currentDexPrice, currentCexPrice) {
        const dexDrop = ((trap.originalDexPrice - currentDexPrice) / trap.originalDexPrice) * 100;
        
        if (dexDrop >= this.config.partialFill.dexDropThreshold) {
            logger.warn(`🛡️ DEX ПАДАЕТ ${symbol}: на ${dexDrop.toFixed(2)}% (порог ${this.config.partialFill.dexDropThreshold}%)`);
            
            const tp = this.activeTakeProfits.get(symbol);
            
            if (tp) {
                const newTakeProfitPrice = this.calculateTakeProfitPrice(currentDexPrice, currentCexPrice);
                await this.onUpdateTakeProfit({ symbol, takeProfitPrice: newTakeProfitPrice, size: tp.size, reason: 'dex_drop_adjust' });
                logger.info(`   Тейк скорректирован: ${tp.takeProfitPrice} → ${newTakeProfitPrice}`);
            }
            
            if (trap.remainingSize === trap.totalSize) {
                await this.onCancelTrap({ symbol });
                logger.info(`   Ловушка отменена (не исполнена)`);
            }
            
            return true;
        }
        return false;
    }

    // ==================== ТАЙМЕР ОСТАТКА ====================

    startRemainderTimer(symbol) {
        this.clearRemainderTimer(symbol);
        
        const timer = setTimeout(() => {
            this.onRemainderTimeout(symbol);
        }, this.config.partialFill.remainderTimeoutMs);
        
        this.remainderTimers.set(symbol, timer);
    }

    resetRemainderTimer(symbol) {
        this.clearRemainderTimer(symbol);
        this.startRemainderTimer(symbol);
    }

    clearRemainderTimer(symbol) {
        const timer = this.remainderTimers.get(symbol);
        if (timer) {
            clearTimeout(timer);
            this.remainderTimers.delete(symbol);
        }
    }

    async onRemainderTimeout(symbol) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;
        
        logger.warn(`⏰ ТАЙМАУТ ОСТАТКА ${symbol}: отмена ловушки ${trap.remainingSize} USDT`);
        
        await mexcPrivate.cancelOrder(symbol, trap.orderId);
        this.activeTraps.delete(symbol);
        this.saveTraps();
        this.clearRemainderTimer(symbol);
    }

    // ==================== ВСПОМОГАТЕЛЬНЫЕ ====================

    async getCurrentCexPrice(symbol) {
        try {
            const orderBook = await mexcPrivate.getOrderBook(symbol);
            return orderBook?.bids[0]?.[0] || 0;
        } catch (error) {
            return 0;
        }
    }

    async checkOrders() {
        for (const [symbol, trap] of this.activeTraps) {
            const order = await mexcPrivate.getOrder(symbol, trap.orderId);
            
            if (order && order.status === 'FILLED') {
                await this.handlePartialFill(symbol, trap.totalSize, order.price, 0);
                this.activeTraps.delete(symbol);
                this.saveTraps();
                this.clearRemainderTimer(symbol);
            }
            else if (order && order.status === 'PARTIALLY_FILLED') {
                const filledSize = parseFloat(order.executedQty);
                const remainingSize = trap.totalSize - filledSize;
                await this.handlePartialFill(symbol, filledSize, order.price, remainingSize);
            }
            else if (order && order.status === 'CANCELED') {
                this.activeTraps.delete(symbol);
                this.saveTraps();
                this.clearRemainderTimer(symbol);
            }
        }
        
        for (const [symbol, tp] of this.activeTakeProfits) {
            const order = await mexcPrivate.getOrder(symbol, tp.orderId);
            
            if (order && order.status === 'FILLED') {
                await this.handleTakeProfitFilled(symbol, tp.size, order.price);
                this.activeTakeProfits.delete(symbol);
                this.saveTakeProfits();
            }
            else if (order && order.status === 'PARTIALLY_FILLED') {
                const filledSize = parseFloat(order.executedQty);
                await this.handleTakeProfitFilled(symbol, filledSize, order.price);
            }
        }
    }

    async onClosePosition({ symbol, size, price, reason }) {
        logger.info(`🔒 ЗАКРЫТИЕ ПОЗИЦИИ ${symbol}: ${size} USDT, причина: ${reason}`);
        
        if (reason === 'timeout') {
            const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'MARKET', size);
            if (order && order.orderId) {
                logger.info(`✅ ПОЗИЦИЯ ЗАКРЫТА ${symbol}: по рынку`);
            }
        } else {
            const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', size, price);
            if (order && order.orderId) {
                logger.info(`✅ ПОЗИЦИЯ ЗАКРЫТА ${symbol}: лимитом ${price}`);
            }
        }
    }

    // ==================== ЗАГРУЗКА/СОХРАНЕНИЕ ====================

    startMonitor() {
        setInterval(() => this.checkOrders(), this.config.monitorIntervalMs);
    }

    loadTraps() {
        try {
            if (fs.existsSync(this.config.trapsFile)) {
                const data = JSON.parse(fs.readFileSync(this.config.trapsFile));
                for (const trap of data.traps || []) {
                    this.activeTraps.set(trap.symbol, trap);
                }
                logger.info(`📂 Загружено ${this.activeTraps.size} ловушек`);
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки ловушек: ${error.message}`);
        }
    }

    saveTraps() {
        const data = { traps: Array.from(this.activeTraps.values()), updated: Date.now() };
        fs.writeFileSync(this.config.trapsFile, JSON.stringify(data, null, 2));
    }

    loadTakeProfits() {
        try {
            if (fs.existsSync(this.config.positionsFile)) {
                const data = JSON.parse(fs.readFileSync(this.config.positionsFile));
                for (const tp of data.takeProfits || []) {
                    this.activeTakeProfits.set(tp.symbol, tp);
                }
                logger.info(`📂 Загружено ${this.activeTakeProfits.size} тейков`);
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки тейков: ${error.message}`);
        }
    }

    saveTakeProfits() {
        const data = { takeProfits: Array.from(this.activeTakeProfits.values()), updated: Date.now() };
        fs.writeFileSync(this.config.positionsFile, JSON.stringify(data, null, 2));
    }

    loadRiskStats() {
        try {
            if (fs.existsSync(this.config.statsFile)) {
                const data = JSON.parse(fs.readFileSync(this.config.statsFile));
                
                if (data.tokenStats) {
                    for (const [symbol, stats] of Object.entries(data.tokenStats)) {
                        this.riskManager.tokenStats.set(symbol, stats);
                    }
                }
                
                if (data.dailyStats) {
                    this.riskManager.dailyStats = data.dailyStats;
                    
                    const today = new Date().toISOString().split('T')[0];
                    if (this.riskManager.dailyStats.date !== today) {
                        this.resetDailyStats();
                    }
                }
                
                logger.info(`📊 Загружена статистика: ${this.riskManager.tokenStats.size} токенов`);
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки статистики: ${error.message}`);
        }
    }

    saveRiskStats() {
        try {
            const data = {
                tokenStats: Object.fromEntries(this.riskManager.tokenStats),
                dailyStats: this.riskManager.dailyStats,
                updated: Date.now()
            };
            fs.writeFileSync(this.config.statsFile, JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error(`Ошибка сохранения статистики: ${error.message}`);
        }
    }

    async shutdown() {
        for (const [symbol, trap] of this.activeTraps) {
            await mexcPrivate.cancelOrder(symbol, trap.orderId);
        }
        for (const [symbol, tp] of this.activeTakeProfits) {
            await mexcPrivate.cancelOrder(symbol, tp.orderId);
        }
        this.saveTraps();
        this.saveTakeProfits();
        this.saveRiskStats();
        logger.info('🛑 MEXC Executor остановлен');
    }
}

module.exports = new MexcExecutor();