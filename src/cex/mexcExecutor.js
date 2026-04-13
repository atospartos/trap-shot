// src/cex/mexcExecutor.js
const fs = require('fs');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const mexcPrivate = require('./mexcPrivate');

class MexcExecutor {
    constructor() {
        this.positions = new Map();
        this.monitorInterval = null;
        
        this.config = {
            monitorIntervalMs: 2000,
            positionsFile: './data/positions.json',
            defaultSize: 0.1,      // минимальное количество SOL
            maxSize: 100,          // максимальное количество
            minProfitPercent: 0.5, // минимальная прибыль для тейка
            maxLossPercent: 0.5    // максимальный убыток для стопа
        };
        
        this.setupListeners();
        this.loadPositions();
        this.startMonitor();
        
        logger.info('🚀 MEXC Executor (LONG only) запущен');
    }

    // ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================

    setupListeners() {
        eventEmitter.on('signal:open', this.onOpen.bind(this));
        eventEmitter.on('signal:cancel_entry', this.onCancel.bind(this));
        eventEmitter.on('signal:stop', this.onStop.bind(this));
    }

    /**
     * Открытие LONG позиции
     */
    async onOpen({ symbol, entryPrice, takeProfit, size }) {
        if (this.positions.has(symbol)) {
            logger.warn(`${symbol}: позиция уже существует`);
            return;
        }
        
        // Проверка баланса
        const hasFunds = await mexcPrivate.hasSufficientFunds(symbol, size, entryPrice);
        if (!hasFunds) {
            logger.error(`${symbol}: недостаточно средств для открытия позиции`);
            this.report('entry_failed', symbol, { reason: 'insufficient_funds' });
            return;
        }
        
        logger.info(`📈 OPEN ${symbol}: BUY LIMIT ${entryPrice}, TP ${takeProfit}, size ${size}`);
        
        const order = await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', size, entryPrice);
        
        if (order && order.orderId) {
            const position = {
                symbol,
                entryPrice,
                takeProfit,
                size,
                status: 'pending',
                buyOrderId: order.orderId,
                sellOrderId: null,
                createdAt: Date.now()
            };
            
            this.positions.set(symbol, position);
            this.savePositions();
            logger.info(`✅ BUY LIMIT ${symbol} выставлен (ID: ${order.orderId})`);
            
            // Таймаут на вход (90 минут)
            setTimeout(() => this.checkEntryTimeout(symbol), 90 * 60 * 1000);
        } else {
            this.report('entry_failed', symbol, { entryPrice, takeProfit, size });
        }
    }

    /**
     * Отмена ордера на вход
     */
    async onCancel({ symbol }) {
        const pos = this.positions.get(symbol);
        if (!pos || pos.status !== 'pending') {
            logger.warn(`${symbol}: нет активного ордера на вход`);
            return;
        }
        
        const result = await mexcPrivate.cancelOrder(symbol, pos.buyOrderId);
        
        if (result) {
            this.positions.delete(symbol);
            this.savePositions();
            this.report('entry_cancelled', symbol, { orderId: pos.buyOrderId });
            logger.info(`❌ BUY LIMIT ${symbol} отменен`);
        }
    }

    /**
     * Стоп-лосс
     */
    async onStop({ symbol, stopPrice }) {
        const pos = this.positions.get(symbol);
        if (!pos) {
            logger.warn(`${symbol}: позиция не найдена`);
            return;
        }
        
        // Если ордер на вход еще не исполнен — отменяем
        if (pos.status === 'pending') {
            await mexcPrivate.cancelOrder(symbol, pos.buyOrderId);
            this.positions.delete(symbol);
            this.savePositions();
            this.report('entry_cancelled_by_stop', symbol, { stopPrice });
            logger.info(`🛑 STOP ${symbol}: отмена BUY LIMIT (не исполнен)`);
            return;
        }
        
        // Если позиция активна — выставляем SELL LIMIT
        if (pos.status === 'active') {
            const order = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', pos.size, stopPrice);
            
            if (order && order.orderId) {
                pos.sellOrderId = order.orderId;
                pos.status = 'closing';
                pos.stopPrice = stopPrice;
                this.savePositions();
                logger.info(`🛑 STOP ${symbol}: SELL LIMIT ${stopPrice} выставлен (ID: ${order.orderId})`);
            }
        }
    }

    // ==================== МОНИТОРИНГ ====================

    startMonitor() {
        this.monitorInterval = setInterval(() => this.checkOrders(), this.config.monitorIntervalMs);
    }

    async checkOrders() {
        for (const [symbol, pos] of this.positions) {
            // Проверяем BUY ордер (вход)
            if (pos.status === 'pending' && pos.buyOrderId) {
                const order = await mexcPrivate.getOrder(symbol, pos.buyOrderId);
                
                if (order && order.status === 'FILLED') {
                    await this.onBuyFilled(symbol, pos, order);
                }
                if (order && order.status === 'CANCELED') {
                    this.onBuyCancelled(symbol);
                }
            }
            
            // Проверяем SELL ордер (выход)
            if (pos.status === 'closing' && pos.sellOrderId) {
                const order = await mexcPrivate.getOrder(symbol, pos.sellOrderId);
                
                if (order && order.status === 'FILLED') {
                    await this.onSellFilled(symbol, pos, order);
                }
            }
        }
    }

    async onBuyFilled(symbol, pos, order) {
        pos.status = 'active';
        pos.filledPrice = parseFloat(order.price);
        pos.filledAt = Date.now();
        this.savePositions();
        
        logger.info(`✅ BUY FILLED ${symbol}: ${pos.filledPrice}`);
        
        // Выставляем SELL LIMIT на тейк-профит
        const sellOrder = await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', pos.size, pos.takeProfit);
        
        if (sellOrder && sellOrder.orderId) {
            pos.sellOrderId = sellOrder.orderId;
            this.savePositions();
            logger.info(`🎯 SELL LIMIT (тейк) ${symbol} выставлен (ID: ${sellOrder.orderId})`);
        }
        
        this.report('entry_filled', symbol, {
            filledPrice: pos.filledPrice,
            takeProfit: pos.takeProfit,
            size: pos.size
        });
    }

    async onSellFilled(symbol, pos, order) {
        const exitPrice = parseFloat(order.price);
        const isTakeProfit = (exitPrice === pos.takeProfit);
        const profitPercent = ((exitPrice - pos.filledPrice) / pos.filledPrice) * 100;
        
        logger.info(`🔒 SELL FILLED ${symbol}: ${exitPrice} (${isTakeProfit ? 'TP' : 'SL'}), P&L: ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%`);
        
        this.positions.delete(symbol);
        this.savePositions();
        
        this.report(isTakeProfit ? 'take_profit' : 'stop_loss', symbol, {
            exitPrice,
            profitPercent,
            filledPrice: pos.filledPrice,
            takeProfit: pos.takeProfit
        });
        
        eventEmitter.emit('position:closed', {
            symbol,
            reason: isTakeProfit ? 'take_profit' : 'stop_loss',
            exitPrice,
            profitPercent
        });
    }

    onBuyCancelled(symbol) {
        this.positions.delete(symbol);
        this.savePositions();
        this.report('entry_cancelled', symbol, {});
    }

    checkEntryTimeout(symbol) {
        const pos = this.positions.get(symbol);
        if (pos && pos.status === 'pending') {
            logger.warn(`⏰ Таймаут входа ${symbol}, отмена ордера`);
            this.onCancel({ symbol });
        }
    }

    // ==================== ОТЧЕТЫ ====================

    report(event, symbol, data) {
        eventEmitter.emit('execution:report', { symbol, event, data, timestamp: Date.now() });
    }

    // ==================== УПРАВЛЕНИЕ ФАЙЛАМИ ====================

    loadPositions() {
        try {
            if (fs.existsSync(this.config.positionsFile)) {
                const data = JSON.parse(fs.readFileSync(this.config.positionsFile));
                for (const pos of data.positions || []) {
                    if (['pending', 'active', 'closing'].includes(pos.status)) {
                        this.positions.set(pos.symbol, pos);
                    }
                }
                logger.info(`📂 Загружено ${this.positions.size} позиций`);
            }
        } catch (error) {
            logger.warn(`Ошибка загрузки: ${error.message}`);
        }
    }

    savePositions() {
        const data = {
            positions: Array.from(this.positions.values()),
            updated: Date.now()
        };
        fs.writeFileSync(this.config.positionsFile, JSON.stringify(data, null, 2));
    }

    // ==================== ОСТАНОВКА ====================

    async shutdown() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        
        // Закрываем все активные позиции
        for (const [symbol, pos] of this.positions) {
            if (pos.status === 'pending') {
                await mexcPrivate.cancelOrder(symbol, pos.buyOrderId);
            }
            if (pos.status === 'active') {
                await mexcPrivate.placeOrder(symbol, 'SELL', 'MARKET', pos.size);
            }
        }
        
        this.savePositions();
        logger.info('🛑 MEXC Executor остановлен');
    }
}

module.exports = new MexcExecutor();