// src/execution/executionManager.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');

class ExecutionManager {
    constructor() {
        this.ws = null;
        this.positions = new Map();

        // Только базовые настройки
        this.config = {
            wsUrl: 'wss://fx-ws-testnet.gateio.ws/v4/ws/usdt', // реаальный счет: wss://fx-ws.gateio.ws/v4/ws/usdt
            apiKey: process.env.GATE_TEST_KEY,
            apiSecret: process.env.GATE_TEST_SECRET,
            userId: process.env.GATE_TEST_ID,
            positionsFile: path.join(process.cwd(), 'data', 'positions.json')
        };

        this.connect();
        this.setupListeners();
        this.loadPositions();

        logger.info('🚀 Execution Manager запущен');
    }

    // ==================== WEBSOCKET ====================

    connect() {
        const WebSocket = require('ws');

        this.ws = new WebSocket(this.config.wsUrl, {
            headers: { 'X-Gate-Size-Decimal': '1' }
        });

        this.ws.on('open', () => {
            logger.info('WebSocket подключен');
            this.subscribeTickers();
            this.authenticate();
        });

        this.ws.on('message', (data) => this.handleMessage(data));
        this.ws.on('error', (err) => logger.error(`WS ошибка: ${err.message}`));
        this.ws.on('close', () => {
            logger.warn('WS закрыт, переподключение через 5с');
            setTimeout(() => this.connect(), 5000);
        });
    }

    subscribeTickers() {
        const symbols = this.getAllSymbols();
        this.send({
            time: Math.floor(Date.now() / 1000),
            channel: 'futures.tickers',
            event: 'subscribe',
            payload: symbols
        });
    }

    authenticate() {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = this.sign('futures.orders', 'subscribe', timestamp);

        // Подписка на ордера
        this.send({
            id: Date.now(),
            time: timestamp,
            channel: 'futures.orders',
            event: 'subscribe',
            payload: [this.config.userId, '!all'],
            auth: { method: 'api_key', KEY: this.config.apiKey, SIGN: sign }
        });

        // Подписка на позиции
        this.send({
            id: Date.now() + 1,
            time: timestamp,
            channel: 'futures.positions',
            event: 'subscribe',
            payload: [this.config.userId, '!all'],
            auth: { method: 'api_key', KEY: this.config.apiKey, SIGN: sign }
        });
    }

    // ==================== ОСНОВНЫЕ МЕТОДЫ ====================

    async openPosition(symbol, direction, entryPrice, targetPrice, entrySpread, size) {
        const side = direction === 'LONG' ? 'buy' : 'sell';

        const levels = this.calculateLevels(
            entryPrice,
            targetPrice,
            direction,
            entrySpread
        );

        // Выставляем лимитный ордер на вход
        const order = await this.placeOrder(symbol, side, entryPrice, size);

        if (order && order.id) {
            const position = {
                id: `${symbol}_${Date.now()}`,
                symbol,
                direction,
                entryPrice,
                takeProfit: levels.takeProfit,
                stopLoss: levels.stopLoss,
                size,
                status: 'pending',
                orderId: order.id,
                createdAt: Date.now()
            };

            this.positions.set(symbol, position);
            this.savePositions();
            logger.info(`📈 Открыта позиция ${direction} ${symbol} по ${entryPrice}`);

            // Выставляем тейк и стоп
            await this.placeOrder(symbol, side === 'buy' ? 'sell' : 'buy', levels.takeProfit, size);
            await this.placeOrder(symbol, side === 'buy' ? 'sell' : 'buy', levels.stopLoss, size);
        }
    }

    async closePosition(symbol) {
        const position = this.positions.get(symbol);
        if (!position) return;

        const side = position.direction === 'LONG' ? 'sell' : 'buy';
        await this.placeOrder(symbol, side, null, position.size, true);

        this.positions.delete(symbol);
        this.savePositions();
        logger.info(`🔒 Закрыта позиция ${symbol}`);
    }

    async placeOrder(symbol, side, price, size, isMarket = false) {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = this.sign('futures.order_place', 'api', timestamp);

        const order = {
            text: `bot_${Date.now()}`,
            contract: `${symbol}_USDT`,
            size: size.toString(),
            price: isMarket ? '0' : price.toString(),
            tif: isMarket ? 'ioc' : 'gtc'
        };

        const response = await this.request('futures.order_place', order, sign, timestamp);

        if (response && response.id) {
            logger.info(`✅ Ордер выставлен: ${side} ${size} ${symbol} ${isMarket ? 'рыночный' : `по ${price}`}`);
            return { id: response.id };
        }
        return null;
    }

    // ==================== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ====================

    calculateLevels(entryPrice, targetPrice, direction) {
        // Расстояние до цели
        const distance = Math.abs(targetPrice - entryPrice);

        // Пороги из логики Statistics:
        // - Тейк при 60% движения к цели
        // - Стоп при 25% движения против

        const takeProfitDistance = distance * 0.6;   // 60% к цели
        const stopLossDistance = distance * 0.25;    // 25% против

        if (direction === 'LONG') {
            return {
                takeProfit: entryPrice + takeProfitDistance,
                stopLoss: entryPrice - stopLossDistance,
                takeProfitPercent: (takeProfitDistance / entryPrice) * 100,
                stopLossPercent: (stopLossDistance / entryPrice) * 100
            };
        } else {
            return {
                takeProfit: entryPrice - takeProfitDistance,
                stopLoss: entryPrice + stopLossDistance,
                takeProfitPercent: (takeProfitDistance / entryPrice) * 100,
                stopLossPercent: (stopLossDistance / entryPrice) * 100
            };
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(data));
        }
    }

    request(channel, payload, sign, timestamp) {
        return new Promise((resolve) => {
            const id = Date.now();
            const request = {
                id, time: timestamp, channel, event: 'api',
                auth: { method: 'api_key', KEY: this.config.apiKey, SIGN: sign },
                payload: [payload]
            };

            const handler = (data) => {
                const parsed = JSON.parse(data);
                if (parsed.id === id) {
                    this.ws.removeListener('message', handler);
                    resolve(parsed.result || null);
                }
            };

            this.ws.on('message', handler);
            this.send(request);

            setTimeout(() => {
                this.ws.removeListener('message', handler);
                resolve(null);
            }, 5000);
        });
    }

    sign(channel, event, timestamp) {
        const message = `channel=${channel}&event=${event}&time=${timestamp}`;
        return crypto.createHmac('sha512', this.config.apiSecret)
            .update(message)
            .digest('hex');
    }

    handleMessage(data) {
        const parsed = JSON.parse(data);

        // Обработка тикеров (цена CEX)
        if (parsed.channel === 'futures.tickers' && parsed.event === 'update') {
            for (const ticker of parsed.result) {
                const symbol = ticker.contract.replace('_USDT', '');
                const price = parseFloat(ticker.last);
                eventEmitter.emit('cex:price', { symbol, price, timestamp: Date.now() });
            }
        }

        // Обработка исполнения ордеров
        if (parsed.channel === 'futures.orders' && parsed.event === 'update') {
            for (const order of parsed.result) {
                if (order.status === 'finished') {
                    const position = Array.from(this.positions.values()).find(p => p.orderId === order.id);
                    if (position && position.status === 'pending') {
                        position.status = 'active';
                        position.filledAt = order.fill_price;
                        this.savePositions();
                        eventEmitter.emit('position:opened', position);
                    }
                }
            }
        }
    }

    getAllSymbols() {
        try {
            const tokens = require('../data/tokens');
            return tokens.map(t => `${t.symbol}_USDT`);
        } catch (error) {
            return [];
        }
    }

    setupListeners() {
        eventEmitter.on('signal:open', (signal) => {
            this.openPosition(
                signal.symbol, signal.direction,
                signal.cexPrice, signal.dexPrice, signal.spread,
                signal.size || 100
            );
        });

        eventEmitter.on('signal:close', (signal) => {
            this.closePosition(signal.symbol);
        });
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
            logger.warn(`Ошибка загрузки: ${error.message}`);
        }
    }

    savePositions() {
        const data = { positions: Array.from(this.positions.values()), updated: Date.now() };
        fs.writeFileSync(this.config.positionsFile, JSON.stringify(data, null, 2));
    }
}

module.exports = new ExecutionManager();