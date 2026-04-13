require('dotenv').config();
const logger = require('./src/core/logger');
const orchestrator = require('./src/orchestrator');

// Обработка сигналов остановки
process.on('SIGINT', () => {
    logger.info('Получен сигнал SIGINT, останавливаемся...');
    orchestrator.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Получен сигнал SIGTERM, останавливаемся...');
    orchestrator.stop();
    process.exit(0);
});

// Запуск
orchestrator.start().catch(error => {
    logger.error('Критическая ошибка при запуске', { error: error.message });
    process.exit(1);
});