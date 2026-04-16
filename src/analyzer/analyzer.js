// src/analytics/analyzer.js
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class Analyzer {
    constructor() {
        this.activeTraps = new Map();     // symbol -> данные активной ловушки
        this.priceHistory = new Map();    // symbol -> история цен
        this.lastProcessedPrices = new Map();

        this.config = {
            // Ловушка (выставляется сразу)
            trapOffsetPercent: 10,           // отступ от DEX (%)
            
            // Тейк
            takeProfitRecoveryPercent: 70,   // восстановление (%)
            
            // Таймаут
            maxActiveTimeMs: 3 * 60 * 60 * 1000,
            
            // Размер позиции
            positionSize: 5,                 // USDT
        };

        this.setupListeners();
        logger.info('🔍 Анализатор (ловля прострелов) инициализирован');
        logger.info(`   Ловушка выставляется сразу с отступом ${this.config.trapOffsetPercent}% от DEX`);
    }

    setupListeners() {
        eventEmitter.on('data:ready', this.processData.bind(this));
        eventEmitter.on('position:opened', this.onPositionOpened.bind(this));
        eventEmitter.on('position:closed', this.onPositionClosed.bind(this));
    }

    updatePriceHistory(symbol, dexPrice, cexPrice, timestamp) {
        if (!this.priceHistory.has(symbol)) {
            this.priceHistory.set(symbol, { dex: [], cex: [] });
        }

        const history = this.priceHistory.get(symbol);
        history.dex.push({ price: dexPrice, timestamp });
        history.cex.push({ price: cexPrice, timestamp });

        const cutoff = timestamp - (60 * 60 * 1000);
        history.dex = history.dex.filter(h => h.timestamp > cutoff);
        history.cex = history.cex.filter(h => h.timestamp > cutoff);
    }

    getLatestCexPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        if (!history || history.cex.length === 0) return null;
        return history.cex[history.cex.length - 1].price;
    }

    getLatestDexPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        if (!history || history.dex.length === 0) return null;
        return history.dex[history.dex.length - 1].price;
    }

    calculateTakeProfitPrice(entryPrice, currentDexPrice, currentCexPrice) {
        // Если DEX ниже CEX — тейк по текущей цене CEX
        if (currentDexPrice < currentCexPrice) {
            return currentCexPrice;
        }
        // Иначе тейк от DEX (70% восстановления)
        const fullGap = currentDexPrice - entryPrice;
        const recoveryAmount = fullGap * (this.config.takeProfitRecoveryPercent / 100);
        return entryPrice + recoveryAmount;
    }

    processData({ symbol, dexPrice, cexPrice, timestamp }) {
        if (!dexPrice || !cexPrice) return;

        this.updatePriceHistory(symbol, dexPrice, cexPrice, timestamp);

        const activeTrap = this.activeTraps.get(symbol);
        const lastPrices = this.lastProcessedPrices.get(symbol);

        this.lastProcessedPrices.set(symbol, { dexPrice, cexPrice, timestamp });

        if (activeTrap) {
            // Обновляем существующую ловушку по матрице сценариев
            this.updateActiveTrap(symbol, activeTrap, dexPrice, cexPrice, timestamp, lastPrices);
        } else {
            // ВЫСТАВЛЯЕМ ЛОВУШКУ СРАЗУ
            this.createTrap(symbol, dexPrice, cexPrice, timestamp);
        }
    }

    /**
     * Создание ловушки (ВЫСТАВЛЯЕТСЯ СРАЗУ)
     */
    createTrap(symbol, dexPrice, cexPrice, timestamp) {
        // Расчет цены ловушки с отступом от DEX
        const trapPrice = dexPrice * (1 - this.config.trapOffsetPercent / 100);
        const takeProfitPrice = this.calculateTakeProfitPrice(trapPrice, dexPrice, cexPrice);

        const trap = {
            id: `${symbol}_${timestamp}`,
            symbol,
            createdAt: timestamp,
            dexPrice: dexPrice,
            cexPrice: cexPrice,
            originalDexPrice: dexPrice,
            originalCexPrice: cexPrice,
            trapPrice: trapPrice,
            takeProfitPrice: takeProfitPrice,
            lastDexPrice: dexPrice,
            lastCexPrice: cexPrice,
            status: 'pending',        // pending → active (после исполнения)
            remainingSize: this.config.positionSize,
            totalSize: this.config.positionSize,
            isDecoupling: false
        };

        this.activeTraps.set(symbol, trap);

        logger.info(`📌 ЛОВУШКА ВЫСТАВЛЕНА ${symbol}`, {
            dexPrice: `$${dexPrice.toFixed(6)}`,
            cexPrice: `$${cexPrice.toFixed(6)}`,
            trapOffset: `${this.config.trapOffsetPercent}%`,
            trapPrice: `$${trapPrice.toFixed(6)}`,
            takeProfit: `$${takeProfitPrice.toFixed(6)}`,
            size: `${this.config.positionSize} USDT`
        });

        eventEmitter.emit('signal:create_trap', {
            symbol,
            dexPrice,
            trapPrice,
            size: this.config.positionSize
        });
    }

    /**
     * Обновление активной ловушки по матрице сценариев
     */
    updateActiveTrap(symbol, trap, dexPrice, cexPrice, timestamp, lastPrices) {
        // Определяем направление движения
        const dexRising = dexPrice > trap.lastDexPrice;
        const dexFalling = dexPrice < trap.lastDexPrice;
        const cexRising = cexPrice > trap.lastCexPrice;
        const cexFalling = cexPrice < trap.lastCexPrice;
        const cexStable = Math.abs(cexPrice - trap.lastCexPrice) < 0.00001;
        
        const isNotExecuted = trap.status === 'pending';
        const isExecuted = trap.status === 'active' || trap.remainingSize < trap.totalSize;

        // ==================== DEX РАСТЕТ ====================
        if (dexRising) {
            // DEX ↑ + CEX → + НЕ ИСПОЛНЕН
            if (cexStable && isNotExecuted) {
                logger.info(`📈 DEX ↑ CEX → | НЕ ИСПОЛНЕН | ВХОД ПО CEX (раскорелляция)`);
                this.decouplingEntry(symbol, trap, dexPrice, cexPrice);
                return;
            }
            
            // DEX ↑ + CEX ↑ + НЕ ИСПОЛНЕН
            if (cexRising && isNotExecuted) {
                logger.info(`🔄 DEX ↑ CEX ↑ | НЕ ИСПОЛНЕН | КОРРЕКТИРОВКА ЛОВУШКИ (поднимаем)`);
                this.adjustTrap(symbol, trap, dexPrice, cexPrice);
                return;
            }
            
            // DEX ↑ + ЛЮБОЙ CEX + ИСПОЛНЕН (частично/полностью)
            if (isExecuted) {
                logger.info(`🔄 DEX ↑ | ИСПОЛНЕН | КОРРЕКТИРОВКА ТЕЙКА + ПЕРЕСТАНОВКА ЛОВУШКИ`);
                this.adjustTakeProfit(symbol, trap, dexPrice, cexPrice);
                if (trap.remainingSize > 0) {
                    this.adjustTrap(symbol, trap, dexPrice, cexPrice);
                }
                return;
            }
        }
        
        // ==================== DEX ПАДАЕТ ====================
        if (dexFalling) {
            // DEX ↓ + ЛЮБОЙ CEX + НЕ ИСПОЛНЕН
            if (isNotExecuted) {
                logger.info(`📉 DEX ↓ | НЕ ИСПОЛНЕН | УБИРАЕМ ЛОВУШКУ`);
                this.cancelTrap(symbol, trap);
                return;
            }
            
            // DEX ↓ + ЛЮБОЙ CEX + ИСПОЛНЕН
            if (isExecuted) {
                logger.info(`📉 DEX ↓ | ИСПОЛНЕН | УБИРАЕМ ЛОВУШКУ + КОРРЕКТИРОВКА ТЕЙКА`);
                if (trap.remainingSize > 0) {
                    this.cancelTrap(symbol, trap);
                }
                this.adjustTakeProfit(symbol, trap, dexPrice, cexPrice);
                return;
            }
        }
        
        // Обновляем последние цены
        trap.lastDexPrice = dexPrice;
        trap.lastCexPrice = cexPrice;
    }

    /**
     * Вход по раскорелляции (DEX растет, CEX стоит)
     */
    decouplingEntry(symbol, trap, dexPrice, cexPrice) {
        const decoupling = ((dexPrice - cexPrice) / cexPrice) * 100;
        
        logger.info(`📈 РАСКОРЕЛЛЯЦИЯ ${symbol}: ${decoupling.toFixed(2)}%`);
        
        // Отменяем старую ловушку
        eventEmitter.emit('signal:cancel_trap', { symbol });
        
        // Входим лимитом по CEX
        eventEmitter.emit('signal:decoupling_entry', {
            symbol,
            dexPrice,
            cexPrice,
            size: trap.totalSize
        });
        
        this.activeTraps.delete(symbol);
    }

    /**
     * Корректировка ловушки (поднимаем/переставляем)
     */
    adjustTrap(symbol, trap, dexPrice, cexPrice) {
        const newTrapPrice = dexPrice * (1 - this.config.trapOffsetPercent / 100);
        
        logger.info(`🔄 КОРРЕКТИРОВКА ЛОВУШКИ ${symbol}: ${trap.trapPrice} → ${newTrapPrice}`);
        
        trap.trapPrice = newTrapPrice;
        trap.dexPrice = dexPrice;
        
        eventEmitter.emit('signal:update_trap', {
            symbol,
            newTrapPrice,
            newDexPrice: dexPrice
        });
    }

    /**
     * Корректировка тейк-профита
     */
    adjustTakeProfit(symbol, trap, dexPrice, cexPrice) {
        const entryPrice = trap.actualEntryPrice || trap.trapPrice;
        const newTakeProfit = this.calculateTakeProfitPrice(entryPrice, dexPrice, cexPrice);
        
        logger.info(`🎯 КОРРЕКТИРОВКА ТЕЙКА ${symbol}: ${trap.takeProfitPrice} → ${newTakeProfit}`);
        
        trap.takeProfitPrice = newTakeProfit;
        
        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit,
            dexPrice,
            size: trap.totalSize - (trap.remainingSize || 0)
        });
    }

    /**
     * Отмена ловушки
     */
    cancelTrap(symbol, trap) {
        logger.info(`❌ ОТМЕНА ЛОВУШКИ ${symbol}`);
        
        eventEmitter.emit('signal:cancel_trap', { symbol });
        this.activeTraps.delete(symbol);
    }

    /**
     * Обработка открытия позиции (ловушка сработала)
     */
    onPositionOpened({ symbol, entryPrice, dexPrice }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap || trap.status !== 'pending') return;

        trap.status = 'active';
        trap.actualEntryPrice = entryPrice;
        trap.activatedAt = Date.now();
        trap.remainingSize = trap.totalSize;
        
        const currentCexPrice = this.getLatestCexPrice(symbol);
        const currentTakeProfit = this.calculateTakeProfitPrice(entryPrice, dexPrice, currentCexPrice);
        trap.takeProfitPrice = currentTakeProfit;

        logger.info(`🎯 ЛОВУШКА СРАБОТАЛА ${symbol}`, {
            entryPrice: `$${entryPrice.toFixed(6)}`,
            dexPrice: `$${dexPrice.toFixed(6)}`,
            takeProfit: `$${currentTakeProfit.toFixed(6)}`,
            size: `${trap.totalSize} USDT`
        });

        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit: currentTakeProfit,
            size: trap.totalSize
        });

        setTimeout(() => {
            this.checkActiveTimeout(symbol);
        }, this.config.maxActiveTimeMs);
    }

    /**
     * Проверка таймаута активной позиции
     */
    checkActiveTimeout(symbol) {
        const trap = this.activeTraps.get(symbol);
        if (!trap || trap.status !== 'active') return;

        const currentCexPrice = this.getLatestCexPrice(symbol);
        
        if (currentCexPrice === null) return;

        const profitPercent = ((currentCexPrice - trap.actualEntryPrice) / trap.actualEntryPrice) * 100;

        logger.warn(`⏰ ТАЙМАУТ ${symbol} (3 часа)`, {
            entryPrice: `$${trap.actualEntryPrice.toFixed(6)}`,
            currentPrice: `$${currentCexPrice.toFixed(6)}`,
            profitPercent: `${profitPercent.toFixed(2)}%`
        });

        eventEmitter.emit('signal:close_position', {
            symbol,
            size: trap.totalSize,
            price: currentCexPrice,
            reason: 'timeout'
        });

        this.activeTraps.delete(symbol);
    }

    onPositionClosed({ symbol, reason, profitPercent }) {
        const trap = this.activeTraps.get(symbol);
        if (trap) {
            logger.info(`🔒 ПОЗИЦИЯ ЗАКРЫТА ${symbol}: ${reason} (${profitPercent > 0 ? '+' : ''}${profitPercent?.toFixed(2)}%)`);
            this.activeTraps.delete(symbol);
        }
    }
}

module.exports = new Analyzer();