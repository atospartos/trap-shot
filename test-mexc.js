const ccxt = require('ccxt');

async function testMexc() {
    console.log('🔍 Тестирование MEXC...\n');
    
    try {
        // 1. Просто проверяем соединение
        console.log('1. Инициализация...');
        const exchange = new ccxt.mexc({
            enableRateLimit: true,
            timeout: 10000
        });
        
        console.log('2. Проверка времени...');
        const time = await exchange.fetchTime();
        console.log('✅ Время сервера:', new Date(time).toISOString());
        
        console.log('\n3. Загрузка markets...');
        await exchange.loadMarkets();
        console.log('✅ Markets загружены');
        
        console.log('\n4. Запрос тикера GF/USDT...');
        const ticker = await exchange.fetchTicker('GF/USDT');
        console.log('✅ Ответ:', {
            price: ticker.last,
            bid: ticker.bid,
            ask: ticker.ask,
            volume: ticker.quoteVolume
        });
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        
        // Пробуем альтернативный формат
        console.log('\n🔄 Пробуем GF_USDT...');
        try {
            const exchange = new ccxt.mexc();
            const ticker = await exchange.fetchTicker('GF_USDT');
            console.log('✅ Успех!', ticker.last);
        } catch (e) {
            console.error('❌ Тоже ошибка:', e.message);
        }
    }
}

testMexc();