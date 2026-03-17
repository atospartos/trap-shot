const ccxt = require('ccxt');

async function testGate() {
    console.log('🔍 Тестирование Gate.io API...\n');
    
    try {
        // 1. Инициализация с таймаутом
        const gate = new ccxt.gateio({
            enableRateLimit: true,
            timeout: 5000,  // 5 секунд таймаут
        });
        
        console.log('✅ Gate.io инициализирован');
        
        // 2. Пробуем прямой запрос без загрузки markets
        console.log('\n🔍 Прямой запрос тикера GF/USDT...');
        
        try {
            // Вариант A: стандартный формат
            const ticker = await Promise.race([
                gate.fetchTicker('GF/USDT'),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 5000)
                )
            ]);
            
            console.log('✅ Успех!', {
                price: ticker.last,
                bid: ticker.bid,
                ask: ticker.ask
            });
        } catch (error) {
            console.log('❌ Стандартный формат не работает:', error.message);
            
            // Вариант B: альтернативный формат
            try {
                console.log('🔄 Пробуем GF_USDT...');
                const ticker2 = await Promise.race([
                    gate.fetchTicker('GF_USDT'),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), 5000)
                    )
                ]);
                
                console.log('✅ Успех с GF_USDT!', {
                    price: ticker2.last
                });
            } catch (error2) {
                console.log('❌ Альтернативный формат тоже не работает:', error2.message);
            }
        }
        
        // 3. Пробуем через прямой HTTP API
        console.log('\n🌐 Пробуем прямой HTTP API Gate.io...');
        
        const axios = require('axios');
        try {
            const response = await axios.get(
                'https://api.gateio.ws/api/v4/spot/tickers',
                {
                    params: { currency_pair: 'GF_USDT' },
                    timeout: 5000
                }
            );
            
            if (response.data && response.data.length > 0) {
                console.log('✅ Прямой API работает!', {
                    price: response.data[0].last,
                    bid: response.data[0].highest_bid,
                    ask: response.data[0].lowest_ask
                });
            } else {
                console.log('❌ Прямой API вернул пустой ответ');
                
                // Покажем первые 5 доступных пар для примера
                const allResponse = await axios.get(
                    'https://api.gateio.ws/api/v4/spot/tickers',
                    { timeout: 5000 }
                );
                
                if (allResponse.data) {
                    const symbols = allResponse.data
                        .slice(0, 5)
                        .map(t => t.currency_pair);
                    console.log('Примеры доступных пар:', symbols);
                }
            }
        } catch (httpError) {
            console.log('❌ Прямой API не работает:', httpError.message);
        }
        
    } catch (error) {
        console.error('❌ Критическая ошибка:', error);
    }
}

testGate();