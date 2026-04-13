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
            positionsFile: './data/positions.json'
        };
        
        this.setupListeners();
        this.loadPositions();
        this.startMonitor();
        
        logger.info('🚀 MEXC Executor (LONG only) запущен');
    }

    // ==================== ПУБЛИЧНЫЕ МЕТОДЫ ДЛЯ ВНЕШНЕГО ИСПОЛЬЗОВАНИЯ ====================

    async placeBuyLimitOrder(symbol, price, quantity) {
        return await mexcPrivate.placeOrder(symbol, 'BUY', 'LIMIT', quantity, price);
    }

    async placeSellLimitOrder(symbol, price, quantity) {
        return await mexcPrivate.placeOrder(symbol, 'SELL', 'LIMIT', quantity, price);
    }

    async cancelOrder(symbol, orderId) {
        return await mexcPrivate.cancelOrder(symbol, orderId);
    }

    async getOrder(symbol, orderId) {
        return await mexcPrivate.getOrder(symbol, orderId);
    }

    // ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================

    setupListeners() {
        eventEmitter.on('signal:open', this.onOpen.bind(this));
        eventEmitter.on('signal:cancel_entry', this.onCancel.bind(this));
        eventEmitter.on('signal:stop', this.onStop.bind(this));
    }

    async onOpen({ symbol, entryPrice, takeProfit, size }) {
        if (this.positions.has(symbol)) {
            logger.warn(`${symbol}: позиция уже существует`);
            return;
        }

        logger.info(`📈 OPEN ${symbol}: BUY LIMIT ${entryPrice}, TP ${takeProfit}, size ${size}`);

        const order = await this.placeBuyLimitOrder(symbol, entryPrice, size);

        if (order && order.orderId) {
            this.positions.set(symbol, {
                symbol, entryPrice, takeProfit, size,
                status: 'pending', buyOrderId: order.orderId, sellOrderId: null,
                createdAt: Date.now()
            });
            this.savePositions();
            logger.info(`✅ BUY LIMIT ${symbol} выставлен (ID: ${order.orderId})`);
        } else {
            this.report('entry_failed', symbol, { entryPrice, takeProfit, size });
        }
    }

    async onCancel({ symbol }) {
        const pos = this.positions.get(symbol);
        if (!pos || pos.status !== 'pending') return;

        await this.cancelOrder(symbol, pos.buyOrderId);
        this.positions.delete(symbol);
        this.savePositions();
        this.report('entry_cancelled', symbol, { orderId: pos.buyOrderId });
        logger.info(`❌ BUY LIMIT ${symbol} отменен`);
    }

    async onStop({ symbol, stopPrice }) {
        const pos = this.positions.get(symbol);
        if (!pos) return;

        if (pos.status === 'pending') {
            await this.cancelOrder(symbol, pos.buyOrderId);
            this.positions.delete(symbol);
            this.savePositions();
            this.report('entry_cancelled_by_stop', symbol, { stopPrice });
            logger.info(`🛑 STOP ${symbol}: отмена BUY LIMIT (не исполнен)`);
        } 
        else if (pos.status === 'active') {
            const order = await this.placeSellLimitOrder(symbol, stopPrice, pos.size);
            if (order?.orderId) {
                pos.sellOrderId = order.orderId;
                pos.status = 'closing';
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
            if (pos.status === 'pending' && pos.buyOrderId) {
                const order = await this.getOrder(symbol, pos.buyOrderId);
                if (order?.status === 'FILLED') {
                    await this.onBuyFilled(symbol, pos, order);
                }
                if (order?.status === 'CANCELED') {
                    this.onBuyCancelled(symbol);
                }
            }
            if (pos.status === 'closing' && pos.sellOrderId) {
                const order = await this.getOrder(symbol, pos.sellOrderId);
                if (order?.status === 'FILLED') {
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

        const sellOrder = await this.placeSellLimitOrder(symbol, pos.takeProfit, pos.size);
        if (sellOrder?.orderId) {
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
        const profit = ((exitPrice - pos.filledPrice) / pos.filledPrice) * 100;

        logger.info(`🔒 SELL FILLED ${symbol}: ${exitPrice} (${isTakeProfit ? 'TP' : 'SL'}), P&L: ${profit > 0 ? '+' : ''}${profit.toFixed(2)}%`);

        this.positions.delete(symbol);
        this.savePositions();
        this.report(isTakeProfit ? 'take_profit' : 'stop_loss', symbol, { exitPrice, profit });
        
        eventEmitter.emit('position:closed', {
            symbol,
            reason: isTakeProfit ? 'take_profit' : 'stop_loss',
            exitPrice,
            profit
        });
    }

    onBuyCancelled(symbol) {
        this.positions.delete(symbol);
        this.savePositions();
        this.report('entry_cancelled', symbol, {});
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
        this.savePositions();
        logger.info('🛑 MEXC Executor остановлен');
    }
}

module.exports = new MexcExecutor();