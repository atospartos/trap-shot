// src/analytics/analyzer.js
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class Analyzer {
    constructor() {
        this.activeTraps = new Map();     // symbol -> данные активной ловушки
        this.priceHistory = new Map();    // symbol -> история цен

        this.config = {
            // Ловушка
            trapOffsetPercent: 10,           // отступ от DEX (%)
            dexAdjustmentThreshold: 2,       // падение DEX для перестановки ловушки (%)
            
            // Тейк-профит (динамический)
            recoveryTargetPercent: 70,       // процент восстановления разрыва (%)
            takeProfitUpdateThreshold: 2,    // изменение DEX для обновления тейка (%)
            
            // Таймаут
            maxActiveTimeMs: 3 * 60 * 60 * 1000, // 3 часа от активации
            
            // Размер позиции
            positionSize: 20,                // USDT
            
            // Вспомогательные
            historyMinutes: 240,
            minHistoryPoints: 10
        };

        this.setupListeners();
        logger.info('🔍 Анализатор (ловля прострелов) инициализирован');
        logger.info(`   Ловушка: -${this.config.trapOffsetPercent}% от DEX`);
        logger.info(`   Корректировка ловушки: при падении DEX >${this.config.dexAdjustmentThreshold}%`);
        logger.info(`   Тейк: ${this.config.recoveryTargetPercent}% восстановления разрыва`);
        logger.info(`   Обновление тейка: при изменении DEX >${this.config.takeProfitUpdateThreshold}%`);
        logger.info(`   Таймаут: ${this.config.maxActiveTimeMs / 3600000}ч от активации`);
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

        const cutoff = timestamp - (this.config.historyMinutes * 60 * 1000);
        history.dex = history.dex.filter(h => h.timestamp > cutoff);
        history.cex = history.cex.filter(h => h.timestamp > cutoff);
    }

    /**
     * Расчет динамической цены тейк-профита
     * @param {number} entryPrice - цена входа
     * @param {number} currentDexPrice - текущая цена DEX
     * @returns {number} цена тейк-профита
     */
    calculateTakeProfit(entryPrice, currentDexPrice) {
        const fullGap = currentDexPrice - entryPrice;
        const recoveryAmount = fullGap * (this.config.recoveryTargetPercent / 100);
        return entryPrice + recoveryAmount;
    }

    /**
     * Проверка, нужно ли обновить тейк-профит
     */
    shouldUpdateTakeProfit(oldDexPrice, newDexPrice, entryPrice) {
        const dexChangePercent = Math.abs((newDexPrice - oldDexPrice) / oldDexPrice) * 100;
        return dexChangePercent >= this.config.takeProfitUpdateThreshold;
    }

    processData({ symbol, dexPrice, cexPrice, timestamp }) {
        if (!dexPrice || !cexPrice) return;

        this.updatePriceHistory(symbol, dexPrice, cexPrice, timestamp);

        const activeTrap = this.activeTraps.get(symbol);

        if (activeTrap) {
            this.updateActiveTrap(symbol, activeTrap, dexPrice, cexPrice, timestamp);
        } else {
            this.createTrap(symbol, dexPrice, cexPrice, timestamp);
        }
    }

    /**
     * Создание ловушки
     */
    createTrap(symbol, dexPrice, cexPrice, timestamp) {
        const trapPrice = dexPrice * (1 - this.config.trapOffsetPercent / 100);
        const initialTakeProfit = this.calculateTakeProfit(trapPrice, dexPrice);

        const trap = {
            id: `${symbol}_${timestamp}`,
            symbol,
            createdAt: timestamp,
            dexPrice: dexPrice,
            cexPrice: cexPrice,
            trapPrice: trapPrice,
            takeProfitPrice: initialTakeProfit,
            lastDexPrice: dexPrice,      // для отслеживания изменений DEX
            status: 'pending',
            size: this.config.positionSize
        };

        this.activeTraps.set(symbol, trap);

        logger.info(`📌 ЛОВУШКА ${symbol}`, {
            dexPrice: `$${dexPrice.toFixed(6)}`,
            cexPrice: `$${cexPrice.toFixed(6)}`,
            trapOffset: `${this.config.trapOffsetPercent}%`,
            trapPrice: `$${trapPrice.toFixed(6)}`,
            takeProfit: `$${initialTakeProfit.toFixed(6)}`
        });

        eventEmitter.emit('signal:enter', {
            symbol,
            dexPrice,
            entryPrice: trapPrice,
            takeProfit: initialTakeProfit,
            size: trap.size
        });
    }

    /**
     * Обновление активной ловушки
     */
    updateActiveTrap(symbol, trap, dexPrice, cexPrice, timestamp) {
        const dexDropPercent = ((trap.dexPrice - dexPrice) / trap.dexPrice) * 100;

        // 1. Корректировка ловушки при падении DEX (только для pending)
        if (dexDropPercent >= this.config.dexAdjustmentThreshold && trap.status === 'pending') {
            const newTrapPrice = dexPrice * (1 - this.config.trapOffsetPercent / 100);
            const newTakeProfit = this.calculateTakeProfit(newTrapPrice, dexPrice);

            logger.info(`🔄 КОРРЕКТИРОВКА ЛОВУШКИ ${symbol}`, {
                oldPrice: `$${trap.trapPrice.toFixed(6)}`,
                newPrice: `$${newTrapPrice.toFixed(6)}`,
                dexDrop: `${dexDropPercent.toFixed(2)}%`,
                oldTakeProfit: `$${trap.takeProfitPrice.toFixed(6)}`,
                newTakeProfit: `$${newTakeProfit.toFixed(6)}`
            });

            trap.trapPrice = newTrapPrice;
            trap.takeProfitPrice = newTakeProfit;
            trap.dexPrice = dexPrice;
            trap.lastDexPrice = dexPrice;

            eventEmitter.emit('signal:adjust', {
                symbol,
                dexPrice,
                newEntryPrice: newTrapPrice,
                newTakeProfit: newTakeProfit,
                dexDropPercent
            });
        }

        // 2. Обновление тейк-профита для активной позиции
        if (trap.status === 'active') {
            const dexChangePercent = Math.abs((dexPrice - trap.lastDexPrice) / trap.lastDexPrice) * 100;
            
            if (dexChangePercent >= this.config.takeProfitUpdateThreshold) {
                const newTakeProfit = this.calculateTakeProfit(trap.actualEntryPrice, dexPrice);
                
                logger.info(`🎯 ОБНОВЛЕНИЕ ТЕЙКА ${symbol}`, {
                    oldDex: `$${trap.lastDexPrice.toFixed(6)}`,
                    newDex: `$${dexPrice.toFixed(6)}`,
                    dexChange: `${dexChangePercent.toFixed(2)}%`,
                    oldTakeProfit: `$${trap.takeProfitPrice.toFixed(6)}`,
                    newTakeProfit: `$${newTakeProfit.toFixed(6)}`
                });

                trap.takeProfitPrice = newTakeProfit;
                trap.lastDexPrice = dexPrice;

                eventEmitter.emit('signal:update_take_profit', {
                    symbol,
                    newTakeProfit: newTakeProfit,
                    dexPrice: dexPrice,
                    dexChangePercent
                });
            }
        }
    }

    /**
     * Обработка открытия позиции
     */
    onPositionOpened({ symbol, entryPrice, dexPrice }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap || trap.status !== 'pending') return;

        trap.status = 'active';
        trap.actualEntryPrice = entryPrice;
        trap.activatedAt = Date.now();
        trap.lastDexPrice = dexPrice;
        
        // Расчет тейк-профита на момент активации
        const currentTakeProfit = this.calculateTakeProfit(entryPrice, dexPrice);
        trap.takeProfitPrice = currentTakeProfit;

        logger.info(`🎯 ЛОВУШКА СРАБОТАЛА ${symbol}`, {
            entryPrice: `$${entryPrice.toFixed(6)}`,
            dexPrice: `$${dexPrice.toFixed(6)}`,
            takeProfit: `$${currentTakeProfit.toFixed(6)}`,
            recoveryTarget: `${this.config.recoveryTargetPercent}%`
        });

        eventEmitter.emit('signal:update_take_profit', {
            symbol,
            newTakeProfit: currentTakeProfit
        });

        // Таймаут 3 часа от активации
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
        
        if (currentCexPrice === null) {
            logger.warn(`${symbol}: нет текущей цены CEX для проверки таймаута`);
            return;
        }

        const profitPercent = ((currentCexPrice - trap.actualEntryPrice) / trap.actualEntryPrice) * 100;

        logger.warn(`⏰ ТАЙМАУТ ${symbol} (3 часа)`, {
            entryPrice: `$${trap.actualEntryPrice.toFixed(6)}`,
            currentPrice: `$${currentCexPrice.toFixed(6)}`,
            profitPercent: `${profitPercent.toFixed(2)}%`
        });

        // Всегда закрываем лимитным ордером по текущей цене
        this.exitSignal(symbol, 'timeout', profitPercent, currentCexPrice);
    }

    getLatestCexPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        if (!history || history.cex.length === 0) return null;
        return history.cex[history.cex.length - 1].price;
    }

    exitSignal(symbol, reason, profitPercent, exitPrice) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) return;

        logger.info(`🔒 ВЫХОД ${symbol}: ${reason}`, {
            profitPercent: `${profitPercent?.toFixed(2) || '0'}%`,
            exitPrice: `$${exitPrice?.toFixed(6)}`
        });

        eventEmitter.emit('signal:exit', {
            symbol,
            reason,
            profitPercent: profitPercent || 0,
            exitPrice: exitPrice,
            timestamp: Date.now()
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