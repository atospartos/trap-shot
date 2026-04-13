// test-executor.js
require('dotenv').config();
const eventEmitter = require('./src/core/eventEmitter');
const mexcExecutor = require('./src/cex/mexcExecutor');

// Устанавливаем тестовый режим
process.env.TEST_MODE = 'true';

// Цвета для вывода
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function logSuccess(msg) {
    console.log(`${colors.green}✅ ${msg}${colors.reset}`);
}

function logError(msg) {
    console.log(`${colors.red}❌ ${msg}${colors.reset}`);
}

function logInfo(msg) {
    console.log(`${colors.blue}📢 ${msg}${colors.reset}`);
}

function logTest(name) {
    console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.yellow}🧪 ТЕСТ: ${name}${colors.reset}`);
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
}

// Слушаем отчеты от Executor
eventEmitter.on('execution:report', (report) => {
    console.log(`\n📊 ОТЧЕТ: ${report.event} для ${report.symbol}`, report.data);
});

eventEmitter.on('position:closed', (data) => {
    console.log(`\n🔒 ПОЗИЦИЯ ЗАКРЫТА: ${data.symbol} (${data.reason}) прибыль: ${data.profit?.toFixed(2)}%`);
});

// Задержка
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== ТЕСТЫ ====================

async function testPlaceBuyLimitOrder() {
    logTest('placeBuyLimitOrder()');
    
    const result = await mexcExecutor.placeBuyLimitOrder('SOL', 85.50, 0.1);
    
    if (result && result.orderId) {
        logSuccess(`Ордер на покупку создан: ${result.orderId}`);
        return result.orderId;
    } else {
        logError('Не удалось создать ордер на покупку');
        return null;
    }
}

async function testPlaceSellLimitOrder() {
    logTest('placeSellLimitOrder()');
    
    const result = await mexcExecutor.placeSellLimitOrder('SOL', 90.00, 0.1);
    
    if (result && result.orderId) {
        logSuccess(`Ордер на продажу создан: ${result.orderId}`);
        return result.orderId;
    } else {
        logError('Не удалось создать ордер на продажу');
        return null;
    }
}

async function testCancelOrder(orderId) {
    logTest('cancelOrder()');
    
    if (!orderId) {
        logError('Нет orderId для отмены');
        return false;
    }
    
    const result = await mexcExecutor.cancelOrder('SOL', orderId);
    
    if (result) {
        logSuccess(`Ордер ${orderId} отменен`);
        return true;
    } else {
        logError(`Не удалось отменить ордер ${orderId}`);
        return false;
    }
}

async function testGetOrder(orderId) {
    logTest('getOrder()');
    
    if (!orderId) {
        logError('Нет orderId для получения');
        return null;
    }
    
    const result = await mexcExecutor.getOrder('SOL', orderId);
    
    if (result) {
        logSuccess(`Ордер получен: статус ${result.status}`);
        return result;
    } else {
        logError(`Не удалось получить ордер ${orderId}`);
        return null;
    }
}

async function testOnOpenSignal() {
    logTest('signal:open (полный цикл входа)');
    
    return new Promise((resolve) => {
        let resolved = false;
        
        // Слушаем отчет о входе
        const handler = (report) => {
            if (report.event === 'entry_filled' && report.symbol === 'SOL') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logSuccess(`Вход исполнен: ${report.data.filledPrice}`);
                    resolve(true);
                }
            }
            if (report.event === 'entry_failed') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logError('Вход не удался');
                    resolve(false);
                }
            }
        };
        
        eventEmitter.on('execution:report', handler);
        
        // Отправляем сигнал на открытие
        eventEmitter.emit('signal:open', {
            symbol: 'SOL',
            entryPrice: 85.50,
            takeProfit: 90.00,
            size: 0.1
        });
        
        // Таймаут
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                logError('Таймаут ожидания входа');
                resolve(false);
            }
        }, 10000);
    });
}

async function testOnCancelSignal() {
    logTest('signal:cancel_entry (отмена входа)');
    
    // Сначала создаем ордер
    const orderId = await testPlaceBuyLimitOrder();
    if (!orderId) {
        logError('Не удалось создать ордер для отмены');
        return false;
    }
    
    await delay(500);
    
    return new Promise((resolve) => {
        let resolved = false;
        
        const handler = (report) => {
            if (report.event === 'entry_cancelled' && report.symbol === 'SOL') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logSuccess('Ордер отменен по сигналу');
                    resolve(true);
                }
            }
        };
        
        eventEmitter.on('execution:report', handler);
        
        eventEmitter.emit('signal:cancel_entry', { symbol: 'SOL' });
        
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                logError('Таймаут ожидания отмены');
                resolve(false);
            }
        }, 5000);
    });
}

async function testOnStopSignal() {
    logTest('signal:stop (стоп-лосс)');
    
    // Сначала открываем позицию
    const opened = await testOnOpenSignal();
    if (!opened) {
        logError('Не удалось открыть позицию для теста стопа');
        return false;
    }
    
    await delay(1000);
    
    return new Promise((resolve) => {
        let resolved = false;
        
        const handler = (report) => {
            if (report.event === 'stop_loss' && report.symbol === 'SOL') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logSuccess(`Позиция закрыта по стопу: ${report.data.exitPrice}`);
                    resolve(true);
                }
            }
            if (report.event === 'take_profit' && report.symbol === 'SOL') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logError('Сработал тейк вместо стопа');
                    resolve(false);
                }
            }
        };
        
        eventEmitter.on('execution:report', handler);
        
        eventEmitter.emit('signal:stop', { symbol: 'SOL', stopPrice: 84.00 });
        
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                logError('Таймаут ожидания стопа');
                resolve(false);
            }
        }, 10000);
    });
}

async function testFullCycle() {
    logTest('Полный цикл: вход → тейк');
    
    return new Promise((resolve) => {
        let resolved = false;
        
        const handler = (report) => {
            if (report.event === 'take_profit' && report.symbol === 'SOL') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logSuccess(`Полный цикл завершен! Прибыль: ${report.data.profit?.toFixed(2)}%`);
                    resolve(true);
                }
            }
            if (report.event === 'stop_loss' && report.symbol === 'SOL') {
                eventEmitter.removeListener('execution:report', handler);
                if (!resolved) {
                    resolved = true;
                    logError('Цикл завершился стопом вместо тейка');
                    resolve(false);
                }
            }
        };
        
        eventEmitter.on('execution:report', handler);
        
        eventEmitter.emit('signal:open', {
            symbol: 'SOL',
            entryPrice: 85.50,
            takeProfit: 90.00,
            size: 0.1
        });
        
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                logError('Таймаут ожидания тейка');
                resolve(false);
            }
        }, 15000);
    });
}

async function testShutdown() {
    logTest('shutdown()');
    
    try {
        await mexcExecutor.shutdown();
        logSuccess('Executor успешно остановлен');
        return true;
    } catch (error) {
        logError(`Ошибка при остановке: ${error.message}`);
        return false;
    }
}

// ==================== ЗАПУСК ВСЕХ ТЕСТОВ ====================

async function runAllTests() {
    console.log(`${colors.cyan}\n╔════════════════════════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.cyan}║                    🧪 ЗАПУСК ТЕСТОВ EXECUTOR                      ║${colors.reset}`);
    console.log(`${colors.cyan}╚════════════════════════════════════════════════════════════════╝${colors.reset}`);
    console.log(`\n⚠️  Режим: ${process.env.TEST_MODE === 'true' ? 'ТЕСТОВЫЙ (order/test)' : 'РЕАЛЬНЫЙ'}`);
    console.log(`📈 Символ: SOL\n`);
    
    const results = [];
    
    // 1. Тест placeBuyLimitOrder
    const orderId = await testPlaceBuyLimitOrder();
    results.push({ name: 'placeBuyLimitOrder', passed: !!orderId });
    await delay(1000);
    
    // 2. Тест getOrder
    if (orderId) {
        const order = await testGetOrder(orderId);
        results.push({ name: 'getOrder', passed: !!order });
        await delay(500);
    }
    
    // 3. Тест cancelOrder
    if (orderId) {
        const cancelled = await testCancelOrder(orderId);
        results.push({ name: 'cancelOrder', passed: cancelled });
        await delay(500);
    }
    
    // 4. Тест placeSellLimitOrder
    const sellOrderId = await testPlaceSellLimitOrder();
    results.push({ name: 'placeSellLimitOrder', passed: !!sellOrderId });
    await delay(1000);
    
    // 5. Тест signal:cancel_entry
    const cancelSignal = await testOnCancelSignal();
    results.push({ name: 'signal:cancel_entry', passed: cancelSignal });
    await delay(1000);
    
    // 6. Тест signal:open
    const openSignal = await testOnOpenSignal();
    results.push({ name: 'signal:open', passed: openSignal });
    await delay(1000);
    
    // 7. Тест signal:stop
    const stopSignal = await testOnStopSignal();
    results.push({ name: 'signal:stop', passed: stopSignal });
    await delay(1000);
    
    // 8. Тест полного цикла
    const fullCycle = await testFullCycle();
    results.push({ name: 'Полный цикл (вход→тейк)', passed: fullCycle });
    await delay(1000);
    
    // 9. Тест shutdown
    const shutdown = await testShutdown();
    results.push({ name: 'shutdown', passed: shutdown });
    
    // ==================== РЕЗУЛЬТАТЫ ====================
    
    console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.yellow}📊 РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ:${colors.reset}`);
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    
    let passedCount = 0;
    for (const result of results) {
        const status = result.passed ? `${colors.green}✓ ПРОЙДЕН${colors.reset}` : `${colors.red}✗ НЕ ПРОЙДЕН${colors.reset}`;
        console.log(`   ${status} : ${result.name}`);
        if (result.passed) passedCount++;
    }
    
    console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.yellow}📈 ИТОГО: ${passedCount}/${results.length} тестов пройдено${colors.reset}`);
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${colors.reset}`);
    
    process.exit(passedCount === results.length ? 0 : 1);
}

// Запуск тестов
runAllTests().catch(console.error);