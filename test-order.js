// test-order.js
require('dotenv').config();
const mexcPrivate = require('./src/cex/mexcPrivate');

async function testOrder() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🧪 ТЕСТ РАЗМЕЩЕНИЯ ОРДЕРА НА MEXC');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const testMode = process.env.TEST_MODE === 'true';
    console.log(`📌 Режим: ${testMode ? 'ТЕСТОВЫЙ' : 'РЕАЛЬНЫЙ'}`);
    
    // 1. Проверка соединения
    console.log('\n🔌 1. Проверка соединения...');
    const account = await mexcPrivate.getAccountInfo();
    if (account && !account.error) {
        console.log('   ✅ Соединение установлено');
        console.log(`   Статус торговли: ${account.canTrade ? 'Разрешена' : 'Запрещена'}`);
    } else {
        console.log('   ❌ Ошибка соединения');
        return;
    }
    
    // 2. Баланс
    console.log('\n💰 2. Баланс USDT...');
    const balance = await mexcPrivate.getUSDTBalance();
    console.log(`   Баланс: ${balance} USDT`);
    
    // 3. Тестовый ордер
    console.log('\n📈 3. Размещение ордера...');
    const order = await mexcPrivate.placeOrder('SOL', 'BUY', 'LIMIT', 0.1, 85.5);
    
    if (order) {
        if (order.testMode) {
            console.log('   ✅ ОРДЕР ВАЛИДЕН (тестовый режим)');
        } else {
            console.log('   ✅ ОРДЕР РАЗМЕЩЕН');
            console.log(`   ID: ${order.orderId}`);
        }
    } else {
        console.log('   ❌ Ошибка размещения ордера');
    }
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🏁 ТЕСТ ЗАВЕРШЕН');
    console.log('═══════════════════════════════════════════════════════════\n');
}

testOrder().catch(console.error);