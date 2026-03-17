const fs = require('fs');
const path = require('path');

// Создаем папку для логов, если её нет
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'bot.log');
const errorFile = path.join(logsDir, 'error.log');

class Logger {
    constructor() {
        this.levels = {
            DEBUG: 0,
            INFO: 1,
            WARN: 2,
            ERROR: 3,
            SIGNAL: 4
        };
        
        // Текущий уровень логирования (можно менять через .env)
        this.currentLevel = process.env.LOG_LEVEL || 'INFO';
    }

    /**
     * Основной метод логирования
     */
    log(level, message, data = null) {
        // Проверяем, нужно ли логировать этот уровень
        if (this.levels[level] < this.levels[this.currentLevel]) {
            return;
        }

        const timestamp = new Date().toISOString();
        let logEntry = `[${timestamp}] [${level}] ${message}`;
        
        if (data) {
            // Красивое форматирование объекта
            const dataStr = typeof data === 'object' 
                ? JSON.stringify(data, null, 2)
                : data;
            logEntry += `\n${dataStr}`;
        }
        
        // В консоль с цветом
        this._consoleLog(level, logEntry);
        
        // В файл
        try {
            fs.appendFileSync(logFile, logEntry + '\n');
            
            // Ошибки дублируем в отдельный файл
            if (level === 'ERROR') {
                fs.appendFileSync(errorFile, logEntry + '\n');
            }
        } catch (err) {
            console.error('Не удалось записать в лог-файл:', err.message);
        }
    }

    /**
     * Цветной вывод в консоль
     */
    _consoleLog(level, message) {
        const colors = {
            DEBUG: '\x1b[36m', // Cyan
            INFO: '\x1b[32m',  // Green
            WARN: '\x1b[33m',  // Yellow
            ERROR: '\x1b[31m', // Red
            SIGNAL: '\x1b[35m' // Magenta
        };
        
        const reset = '\x1b[0m';
        const color = colors[level] || '\x1b[0m';
        
        console.log(color + message + reset);
    }

    // ========== Удобные методы для разных уровней ==========

    debug(message, data) {
        this.log('DEBUG', message, data);
    }

    info(message, data) {
        this.log('INFO', message, data);
    }

    warn(message, data) {
        this.log('WARN', message, data);
    }

    error(message, data) {
        this.log('ERROR', message, data);
    }

    signal(message, data) {
        this.log('SIGNAL', `🚨 ${message}`, data);
        // Звуковой сигнал для важных уведомлений
        console.log('\x07');
    }

    // ========== Специализированные методы ==========

    /**
     * Логирование начала операции
     */
    start(operation, data) {
        this.info(`▶️ Начинаем: ${operation}`, data);
    }

    /**
     * Логирование успешного завершения
     */
    success(operation, data) {
        this.info(`✅ Завершено: ${operation}`, data);
    }

    /**
     * Логирование с таймером
     */
    time(operation, startTime) {
        const duration = Date.now() - startTime;
        this.info(`⏱️ ${operation} за ${duration}ms`);
    }

    /**
     * Создание лога с разделителем для наглядности
     */
    section(title) {
        const line = '='.repeat(50);
        this.info(`\n${line}\n${title}\n${line}`);
    }

    /**
     * Очистка старых лог-файлов
     */
    cleanup(daysToKeep = 7) {
        try {
            const files = fs.readdirSync(logsDir);
            const now = Date.now();
            const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
            
            files.forEach(file => {
                const filePath = path.join(logsDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    this.debug(`Удален старый лог-файл: ${file}`);
                }
            });
        } catch (error) {
            this.error('Ошибка очистки логов', { error: error.message });
        }
    }
}

module.exports = new Logger();