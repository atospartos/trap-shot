// src/cex/mexcExecutor.js
const fs = require('fs');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const mexcPrivate = require('./mexcPrivate');

class MexcExecutor {
    constructor() {
        this.activeTraps = new Map();     // symbol -> данные активной ловушки (pending)
        this.positions = new Map();        // symbol -> данные открытой позиции (active)
        this.monitorInterval = null;
        
        this.config = {
            monitorIntervalMs: 2000,
            trapsFile: './data/traps.json',
            positionsFile: './data/positions.json'
        };
        
        this.setupListeners();
        this.loadTraps();
        this.loadPositions();
        this.startMonitor();
        
        logger.info('🚀 MEXC Executor (ловля прострелов) запущен');
    }

    setupListeners() {
        eventEmitter.on('signal:enter', this.onEnter.bind(this));
        eventEmitter.on('signal:adjust', this.onAdjust.bind(this));
        eventEmitter.on('signal:update_take_profit', this.onUpdateTakeProfit.bind(this));
        eventEmitter.on('signal:exit', this.onExit.bind(this));
    }

    // ==================== ЛОВУШКА (PENDING) ====================

    async onEnter({ symbol, entryPrice, takeProfit, size }) {
        if (this.activeTraps.has(symbol) || this.positions.has(symbol)) {
            logger.warn(`${symbol}: уже есть активная ловушка или позиция`);
            return;
        }
        
        logger.info(`📌 ЛОВУШКА ${symbol}: BUY LIMIT ${entryPrice}, TP ${takeProfit}, size ${size}`);
        
        const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', size, entryPrice);
        
        if (order && order.orderId) {
            const trap = {
                symbol,
                entryPrice,
                takeProfit,
                size,
                orderId: order.orderId,
                createdAt: Date.now()
            };
            
            this.activeTraps.set(symbol, trap);
            this.saveTraps();
            logger.info(`✅ ЛОВУШКА ${symbol} выставлена (ID: ${order.orderId})`);
        } else {
            logger.error(`❌ Не удалось выставить ловушку ${symbol}`);
        }
    }

    async onAdjust({ symbol, newEntryPrice, newTakeProfit }) {
        const trap = this.activeTraps.get(symbol);
        if (!trap) {
            logger.warn(`${symbol}: ловушка не найдена для корректировки`);
            return;
        }
        
        logger.info(`🔄 КОРРЕКТИРОВКА ЛОВУШКИ ${symbol}: новая цена ${newEntryPrice}`);
        
        // Отменяем старый ордер
        await mexcPrivate.cancelOrder(symbol, trap.orderId);
        
        // Выставляем новый
        const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', trap.size, newEntryPrice);
        
        if (order && order.orderId) {
            trap.entryPrice = newEntryPrice;
            trap.takeProfit = newTakeProfit;
            trap.orderId = order.orderId;
            this.saveTraps();
            logger.info(`✅ ЛОВУШКА ${symbol} скорректирована (ID: ${order.orderId})`);
        } else {
            logger.error(`❌ Не удалось скорректировать ловушку ${symbol}`);
        }
    }

    // ==================== ПОЗИЦИЯ (ACTIVE) ====================

    async onUpdateTakeProfit({ symbol, newTakeProfit }) {
        const position = this.positions.get(symbol);
        if (!position) {
            logger.warn(`${symbol}: позиция не найдена для обновления тейка`);
            return;
        }
        
        // Отменяем старый ордер на продажу
        if (position.sellOrderId) {
            await mexcPrivate.cancelOrder(symbol, position.sellOrderId);
            logger.debug(`🗑️ Отменен старый тейк-ордер ${symbol}`);
        }
        
        // Выставляем новый
        const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', position.size, newTakeProfit);
        
        if (order && order.orderId) {
            position.takeProfit = newTakeProfit;
            position.sellOrderId = order.orderId;
            this.savePositions();
            logger.info(`🎯 ОБНОВЛЕН ТЕЙК ${symbol}: SELL LIMIT ${newTakeProfit}`);
        }
    }

    async onExit({ symbol, reason, exitPrice }) {
        const position = this.positions.get(symbol);
        if (!position) {
            logger.warn(`${symbol}: позиция не найдена для выхода`);
            return;
        }
        
        logger.info(`🔒 ВЫХОД ${symbol}: ${reason}, цена ${exitPrice}`);
        
        // Отменяем тейк-ордер, если есть
        if (position.sellOrderId) {
            await mexcPrivate.cancelOrder(symbol, position.sellOrderId);
        }
        
        // Закрываем позицию лимитным ордером по указанной цене
        const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', position.size, exitPrice);
        
        if (order && order.orderId) {
            logger.info(`✅ ПОЗИЦИЯ ${symbol} закрыта (ID: ${order.orderId})`);
            this.positions.delete(symbol);
            this.savePositions();
            
            eventEmitter.emit('position:closed', {
                symbol,
                reason,
                profitPercent: ((exitPrice - position.entryPrice) / position.entryPrice) * 100
            });
        } else {
            logger.error(`❌ Не удалось закрыть позицию ${symbol}`);
        }
    }

    // ==================== МОНИТОРИНГ ====================

    startMonitor() {
        this.monitorInterval = setInterval(() => this.checkOrders(), this.config.monitorIntervalMs);
    }

    async checkOrders() {
        // Проверяем ловушки (pending)
        for (const [symbol, trap] of this.activeTraps) {
            const order = await mexcPrivate.getOrder(symbol, trap.orderId);
            
            if (order?.status === 'FILLED') {
                await this.onTrapFilled(symbol, trap, order);
            }
            if (order?.status === 'CANCELED') {
                this.activeTraps.delete(symbol);
                this.saveTraps();
                logger.info(`❌ Ловушка ${symbol} отменена`);
            }
        }
        
        // Проверяем позиции (active) — только для информации
        for (const [symbol, position] of this.positions) {
            if (position.sellOrderId) {
                const order = await mexcPrivate.getOrder(symbol, position.sellOrderId);
                if (order?.status === 'FILLED') {
                    const profitPercent = ((order.price - position.entryPrice) / position.entryPrice) * 100;
                    logger.info(`💰 ПОЗИЦИЯ ЗАКРЫТА ${symbol}: прибыль ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%`);
                    this.positions.delete(symbol);
                    this.savePositions();
                }
            }
        }
    }

    async onTrapFilled(symbol, trap, order) {
        const filledPrice = parseFloat(order.price);
        
        const position = {
            symbol,
            entryPrice: filledPrice,
            takeProfit: trap.takeProfit,
            size: trap.size,
            buyOrderId: trap.orderId,
            sellOrderId: null,
            createdAt: Date.now()
        };
        
        // Выставляем тейк-профит
        const sellOrder = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', position.size, position.takeProfit);
        
        if (sellOrder && sellOrder.orderId) {
            position.sellOrderId = sellOrder.orderId;
        }
        
        this.positions.set(symbol, position);
        this.activeTraps.delete(symbol);
        this.savePositions();
        this.saveTraps();
        
        logger.info(`🎯 ЛОВУШКА СРАБОТАЛА ${symbol}: вход по ${filledPrice}, тейк ${position.takeProfit}`);
        
        eventEmitter.emit('position:opened', {
            symbol,
            entryPrice: filledPrice,
            dexPrice: trap.entryPrice,
            takeProfit: position.takeProfit,
            size: position.size
        });
    }

    // ==================== ЗАГРУЗКА/СОХРАНЕНИЕ ====================

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

    loadPositions() {
        try {
            if (fs.existsSync(this.config.positionsFile)) {
                const data = JSON.parse(fs.readFileSync(this.config.positionsFile));
                for (const pos of data.positions || []) {
                    this.positions.set(pos.symbol, pos);
                }
                logger.info(`📂 Загружено ${this.positions.size} позиций`);
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки позиций: ${error.message}`);
        }
    }

    savePositions() {
        const data = { positions: Array.from(this.positions.values()), updated: Date.now() };
        fs.writeFileSync(this.config.positionsFile, JSON.stringify(data, null, 2));
    }

    // ==================== ОСТАНОВКА ====================

    async shutdown() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        
        // Отменяем все активные ловушки
        for (const [symbol, trap] of this.activeTraps) {
            await mexcPrivate.cancelOrder(symbol, trap.orderId);
            logger.info(`🗑️ Ловушка ${symbol} отменена при остановке`);
        }
        
        this.saveTraps();
        this.savePositions();
        logger.info('🛑 MEXC Executor остановлен');
    }
}

module.exports = new MexcExecutor();