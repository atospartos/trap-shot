const logger = require('../core/logger');

class FeeCalculator {
    constructor() {
        // Базовые комиссии для разных бирж
        this.exchangeFees = {
            mexc: {
                maker: 0.002, // 0.2%
                taker: 0.002, // 0.2%
                withdrawal: 0.001
            },
            gateio: {
                maker: 0.002,
                taker: 0.002,
                withdrawal: 0.001
            },
            binance: {
                maker: 0.001,
                taker: 0.001,
                withdrawal: 0.0005
            }
        };
        
        logger.info('✅ FeeCalculator инициализирован');
    }

    /**
     * Проверка, выгодна ли сделка с учетом комиссий
     */
    isProfitable(divergencePercent, exchange, symbol, positionSizeUsd, side, holdHours = 1) {
        try {
            // Получаем комиссии для биржи
            const fees = this.exchangeFees[exchange] || this.exchangeFees.mexc;
            
            // Комиссия за открытие и закрытие позиции
            const openFee = positionSizeUsd * fees.taker;
            const closeFee = positionSizeUsd * fees.taker;
            
            // Общая комиссия в процентах
            const totalFeePercent = ((openFee + closeFee) / positionSizeUsd) * 100;
            
            // Чистая прибыль (разница минус комиссии)
            const netProfit = divergencePercent - totalFeePercent;
            
            // Результат
            return {
                isProfitable: netProfit > 0,
                grossDivergence: divergencePercent,
                totalCosts: totalFeePercent,
                netProfit: netProfit,
                meetsMinimum: divergencePercent >= totalFeePercent + 0.2, // +0.2% запас
                costs: {
                    percentages: {
                        total: totalFeePercent,
                        open: (openFee / positionSizeUsd) * 100,
                        close: (closeFee / positionSizeUsd) * 100
                    },
                    fees: {
                        open: openFee,
                        close: closeFee,
                        total: openFee + closeFee
                    }
                },
                recommendation: netProfit > 0 ? 'profitable' : 'not_profitable'
            };
            
        } catch (error) {
            logger.error('Ошибка расчета прибыльности:', error.message);
            // Возвращаем базовый результат в случае ошибки
            return {
                isProfitable: divergencePercent > 0.5,
                grossDivergence: divergencePercent,
                totalCosts: 0.5,
                netProfit: divergencePercent - 0.5,
                meetsMinimum: divergencePercent > 0.7,
                costs: {
                    percentages: { total: 0.5, open: 0.25, close: 0.25 },
                    fees: { open: 0, close: 0, total: 0 }
                },
                recommendation: divergencePercent > 0.5 ? 'profitable' : 'not_profitable'
            };
        }
    }

    /**
     * Получить комиссии для биржи
     */
    getExchangeFees(exchange) {
        return this.exchangeFees[exchange] || this.exchangeFees.mexc;
    }

    /**
     * Рассчитать минимальную прибыль для входа
     */
    getMinProfitThreshold(exchange) {
        const fees = this.getExchangeFees(exchange);
        return (fees.taker * 2 * 100) + 0.2; // комиссия на вход/выход + запас
    }
}

module.exports = new FeeCalculator();