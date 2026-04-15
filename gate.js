const axios = require('axios');

async function testGateManual() {
    console.log('🔍 Тестируем Gate.io (ручной парсинг)...\n');
    
    try {
        const response = await axios.get('https://data.gateapi.io/api2/1/pairs', {
            timeout: 15000,
            responseType: 'text',
            transformResponse: [data => data]
        });
        
        const textData = response.data;
        console.log(`Длина строки: ${textData.length} символов`);
        
        // Ручной парсинг
        const regex = /"([A-Z0-9]+)_USDT"/g;
        const tokens = new Set();
        let match;
        
        while ((match = regex.exec(textData)) !== null) {
            tokens.add(match[1]);
        }
        
        console.log(`\n✅ Найдено токенов: ${tokens.size}`);
        console.log(`Примеры: ${Array.from(tokens).slice(0, 20).join(', ')}`);
        
        return tokens;
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
    }
}

testGateManual();