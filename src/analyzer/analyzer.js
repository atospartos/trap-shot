// src/analytics/analyzer.js
const logger = require('../core/logger');
const eventEmitter = require('../core/eventEmitter');
const statistics = require('./statistics');

class Analyzer {
    constructor() {
        this.activeSignals = new Map(); // symbol -> signal data
        
        this.config = {
            minSpreadPercent: 0.8,
            feePercent: 0.4,
            takeProfitReduction: 60,
            stopLossFalseReduction: 30,
            stopLossIncrease: 30,
            marketMoveThreshold: 1.0,
            spreadStableThreshold: 0.5,
            signalTimeoutMs: 90 * 60 * 1000
        };

        this.setupListeners();
        logger.info('🔍 Модуль анализа сигналов инициализирован');
        logger.info(`   Пороги: тейк -${this.config.takeProfitReduction}% | стоп (ложное схождение) -${this.config.stopLossFalseReduction}% | стоп (ложное расширение) +${this.config.stopLossIncrease}% | стоп (рынок) >${this.config.marketMoveThreshold}%`);
    }

    setupListeners() {
        eventEmitter.on('data:ready', this.processData.bind(this));
    }

    processData({ symbol, dexPrice, cexPrice, timestamp }) {
        if (!dexPrice || !cexPrice) return;

        const spread = ((dexPrice - cexPrice) / cexPrice) * 100;
        const absSpread = Math.abs(spread);
        const netProfit = absSpread - this.config.feePercent;

        // Сохраняем историю цен
        eventEmitter.emit('price:update', { symbol, dexPrice, cexPrice, timestamp });

        const direction = spread > 0 ? '📈 LONG (DEX > CEX)' : '📉 SHORT (CEX > DEX)';
        logger.debug(`💹 ${symbol}: ${direction} | спред: ${absSpread.toFixed(2)}% (net ${netProfit.toFixed(2)}%)`);

        const activeSignal = this.activeSignals.get(symbol);

        if (activeSignal) {
            this.updateActiveSignal(symbol, activeSignal, absSpread, dexPrice, cexPrice, timestamp);
        } else {
            if (absSpread >= this.config.minSpreadPercent && netProfit > 0) {
                this.createSignal(symbol, spread, absSpread, dexPrice, cexPrice, timestamp);
            }
        }
    }

    createSignal(symbol, spread, absSpread, dexPrice, cexPrice, timestamp) {
        if (this.activeSignals.has(symbol)) {
            logger.debug(`${symbol}: уже есть активный сигнал`);
            return;
        }

        const direction = spread > 0 ? 'LONG' : 'SHORT';

        const signal = {
            id: `${symbol}_${timestamp}`,
            symbol,
            direction,
            entryTime: timestamp,
            entrySpread: absSpread,
            entryNetProfit: absSpread - this.config.feePercent,
            entryDexPrice: dexPrice,
            entryCexPrice: cexPrice,
            status: 'active',
            currentSpread: absSpread,
            currentDexPrice: dexPrice,
            currentCexPrice: cexPrice,
            maxSpread: absSpread,
            maxSpreadTime: timestamp,
            expansions: []
        };

        this.activeSignals.set(symbol, signal);

        const emoji = direction === 'LONG' ? '📈' : '📉';
        logger.signal(`${emoji} СИГНАЛ ${direction} ${symbol}`, {
            spread: `${absSpread.toFixed(2)}%`,
            netProfit: `${(absSpread - this.config.feePercent).toFixed(2)}%`
        });

        // Отправляем в статистику
        eventEmitter.emit('signal:new', signal);

        eventEmitter.emit('signal:open', {
            symbol,
            direction,
            spread: absSpread,
            netProfit: absSpread - this.config.feePercent,
            dexPrice,
            cexPrice
        });

        setTimeout(() => {
            const current = this.activeSignals.get(symbol);
            if (current && current.id === signal.id) {
                this.closeSignal(symbol, current.currentSpread, 'timeout', null, null);
            }
        }, this.config.signalTimeoutMs);
    }

    updateActiveSignal(symbol, signal, currentSpread, dexPrice, cexPrice, timestamp) {
        const prevSpread = signal.currentSpread;
        signal.currentSpread = currentSpread;
        signal.currentDexPrice = dexPrice;
        signal.currentCexPrice = cexPrice;

        if (currentSpread > signal.maxSpread) {
            signal.maxSpread = currentSpread;
            signal.maxSpreadTime = timestamp;
        }

        const spreadChange = ((currentSpread - signal.entrySpread) / signal.entrySpread) * 100;
        const cexMove = statistics.getPriceMove(symbol, signal.entryTime, cexPrice, 'cex');
        const dexMove = statistics.getPriceMove(symbol, signal.entryTime, dexPrice, 'dex');

        // №1: Расширение правильное → ЖДЕМ + ЗАПИСЬ
        if (signal.direction === 'LONG') {
            if (spreadChange > 0 && dexMove > 0 && Math.abs(dexMove) > Math.abs(cexMove || 0)) {
                if (currentSpread > prevSpread) {
                    signal.expansions.push({
                        time: timestamp,
                        spread: currentSpread,
                        dexPrice,
                        cexPrice,
                        dexMove,
                        cexMove
                    });
                }
                return;
            }
        } else {
            if (spreadChange > 0 && dexMove < 0 && Math.abs(dexMove) > Math.abs(cexMove || 0)) {
                if (currentSpread > prevSpread) {
                    signal.expansions.push({
                        time: timestamp,
                        spread: currentSpread,
                        dexPrice,
                        cexPrice,
                        dexMove,
                        cexMove
                    });
                }
                return;
            }
        }

        // №2: Истинное схождение → ТЕЙК
        if (currentSpread <= signal.entrySpread * (1 - this.config.takeProfitReduction / 100)) {
            if (signal.direction === 'LONG' && cexMove > 0.1) {
                this.closeSignal(symbol, currentSpread, 'take_profit_true', cexMove, dexMove);
                return;
            }
            if (signal.direction === 'SHORT' && cexMove < -0.1) {
                this.closeSignal(symbol, currentSpread, 'take_profit_true', cexMove, dexMove);
                return;
            }
        }

        // №3: Ложное схождение → СТОП
        if (currentSpread <= signal.entrySpread * (1 - this.config.stopLossFalseReduction / 100)) {
            if (signal.direction === 'LONG' && dexMove < 0) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_collapse', cexMove, dexMove);
                return;
            }
            if (signal.direction === 'SHORT' && dexMove > 0) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_collapse', cexMove, dexMove);
                return;
            }
        }

        // №4: Расширение ложное → СТОП
        if (currentSpread >= signal.entrySpread * (1 + this.config.stopLossIncrease / 100)) {
            if (signal.direction === 'LONG' && dexMove > 0 && cexMove <= dexMove) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_expansion', cexMove, dexMove);
                return;
            }
            if (signal.direction === 'SHORT' && dexMove < 0 && cexMove >= dexMove) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_false_expansion', cexMove, dexMove);
                return;
            }
        }

        // №5: Рынок против нас → СТОП
        const spreadStable = Math.abs(spreadChange) < this.config.spreadStableThreshold;

        if (signal.direction === 'LONG') {
            if (cexMove < -this.config.marketMoveThreshold &&
                dexMove < -this.config.marketMoveThreshold &&
                spreadStable) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_market_drop', cexMove, dexMove);
                return;
            }
        } else {
            if (cexMove > this.config.marketMoveThreshold &&
                dexMove > this.config.marketMoveThreshold &&
                spreadStable) {
                this.closeSignal(symbol, currentSpread, 'stop_loss_market_rise', cexMove, dexMove);
                return;
            }
        }
    }

    closeSignal(symbol, exitSpread, reason, cexMove, dexMove) {
        const signal = this.activeSignals.get(symbol);
        if (!signal || signal.status !== 'active') return;

        const exitTime = Date.now();
        const duration = (exitTime - signal.entryTime) / 1000;

        let profitPercent = 0;
        if (signal.direction === 'LONG') {
            profitPercent = ((signal.currentCexPrice - signal.entryCexPrice) / signal.entryCexPrice) * 100 - this.config.feePercent;
        } else {
            profitPercent = ((signal.entryCexPrice - signal.currentCexPrice) / signal.entryCexPrice) * 100 - this.config.feePercent;
        }

        const isWin = profitPercent > 0;

        // Отправляем в статистику
        eventEmitter.emit('signal:close', {
            symbol: signal.symbol,
            direction: signal.direction,
            exitTime,
            exitSpread,
            exitCexPrice: signal.currentCexPrice,
            exitDexPrice: signal.currentDexPrice,
            exitProfit: profitPercent,
            reason,
            duration,
            isWin,
            cexMove: cexMove || 0,
            dexMove: dexMove || 0
        });

        const emoji = isWin ? '✅' : '❌';
        logger.signal(`${emoji} ЗАКРЫТ ${signal.direction} ${symbol}`, {
            profit: `${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%`,
            duration: `${duration.toFixed(1)}с`,
            reason: reason
        });

        eventEmitter.emit('signal:close', {
            symbol: signal.symbol,
            direction: signal.direction,
            isWin,
            profit: profitPercent,
            duration,
            reason
        });

        this.activeSignals.delete(symbol);
    }
}

module.exports = new Analyzer();