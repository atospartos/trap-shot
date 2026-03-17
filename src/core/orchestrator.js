const config = require('../config');
const logger = require('./logger');
const eventEmitter = require('./eventEmitter');

// Модули
const dexMonitor = require('../dex/monitor');
const cexMonitor = require('../cex/monitor');
const comparator = require('../analyzer/comparator');
const telegram = require('../notifier/telegram');
const cache = require('../analyzer/cache');
const statisticalModel = require('../analyzer/statisticalModel');

class Orchestrator {
    constructor() {
        this.interval = null;
        this.isRunning = false;

        // Настраиваем обработчики событий
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        // Когда DEX модуль получает данные
        eventEmitter.on('dex:poolData', (data) => {
            cache.updateDexPrice(data.symbol, data.chain, data.price, data.pool);
            comparator.analyzeSymbol(data.symbol);
        });

        // Когда CEX модуль получает данные
        eventEmitter.on('cex:price', (data) => {
            cache.updateCexPrice(data.symbol, data.exchange, data.price);
            comparator.analyzeSymbol(data.symbol);
        });
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Оркестратор уже запущен');
            return;
        }

        logger.info('🚀 Запуск Trading Bot MVP');

        // Приветственное сообщение в Telegram
        if (telegram && telegram.sendStartupMessage) {
            telegram.sendStartupMessage();
        }

        this.isRunning = true;

        // ВАЖНО: НЕ запускаем cexMonitor.start() здесь, 
        // потому что runCheck() уже вызывает checkAllPrices()
        
        // Запускаем первый цикл проверок
        await this.runCheck();
        
        // Запускаем периодические проверки
        const intervalMs = config.checkInterval * 60 * 1000;
        logger.info(`🕐 Устанавливаем интервал проверок: ${config.checkInterval} минут (${intervalMs}ms)`);
        
        this.interval = setInterval(() => this.runCheck(), intervalMs);

        // Запускаем периодические отчеты
        this.startPeriodicReports();

        logger.info(`✅ Оркестратор запущен, интервал ${config.checkInterval} минут`);
    }

    async runCheck() {
        const startTime = Date.now();
        logger.info('=== Начало цикла проверки ===');

        try {
            // 1. Получаем данные с DEX
            await dexMonitor.checkAllTokens();

            // 2. Получаем данные с CEX (вызываем напрямую)
            await cexMonitor.checkAllPrices();

            // 3. Анализ уже происходит через события

            const duration = Date.now() - startTime;
            logger.info(`✅ Цикл проверки завершен за ${duration}ms`);

        } catch (error) {
            logger.error('❌ Ошибка в цикле проверки', { error: error.message, stack: error.stack });
        }

        logger.info('=== Конец цикла проверки ===');
    }

    startPeriodicReports() {
        // Отчет по статистике раз в час
        setInterval(() => {
            try {
                if (!statisticalModel || !statisticalModel.metrics) return;
                
                const symbols = Array.from(statisticalModel.metrics.keys());

                for (const symbol of symbols) {
                    const metrics = statisticalModel.metrics.get(symbol);
                    if (metrics && metrics.sampleSize > 30) {
                        eventEmitter.emit('telegram:riskReport', {
                            symbol,
                            stats: metrics
                        });
                    }
                }
            } catch (error) {
                logger.error('Ошибка в периодическом отчете', { error: error.message });
            }
        }, 60 * 60 * 1000); // каждый час
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.isRunning = false;
        logger.info('🛑 Оркестратор остановлен');
    }
}

module.exports = new Orchestrator();