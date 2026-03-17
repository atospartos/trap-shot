require('dotenv').config();

const orchestrator = require('./src/core/orchestrator');
const logger = require('./src/core/logger');

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