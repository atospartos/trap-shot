const axios = require('axios');

async function testDexAPI() {
    try {
        // 1. Сначала поищем токен GF
        console.log('🔍 Поиск GF через search API...');
        const searchResponse = await axios.get('https://api.dexscreener.com/latest/dex/search?q=GF');
        
        console.log('Статус:', searchResponse.status);
        
        if (searchResponse.data.pairs && searchResponse.data.pairs.length > 0) {
            console.log(`✅ Найдено пулов: ${searchResponse.data.pairs.length}`);
            
            // Покажем первые 3 пула
            searchResponse.data.pairs.slice(0, 3).forEach((pair, i) => {
                console.log(`\n--- Пул ${i+1} ---`);
                console.log('DEX:', pair.dexId);
                console.log('Chain:', pair.chainId);
                console.log('Base Token:', pair.baseToken.symbol);
                console.log('Base Address:', pair.baseToken.address);
                console.log('Quote Token:', pair.quoteToken.symbol);
                console.log('Liquidity USD:', pair.liquidity?.usd || 0);
                console.log('Price USD:', pair.priceUsd);
            });
            
            // Возьмем адрес первого токена
            const firstToken = searchResponse.data.pairs[0].baseToken;
            console.log('\n🎯 Адрес токена GF:', firstToken.address);
            
            // 2. Теперь проверим получение пулов по адресу токена
            console.log(`\n🔍 Получение пулов по адресу ${firstToken.address}...`);
            const tokenResponse = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${firstToken.address}`
            );
            
            if (tokenResponse.data.pairs) {
                console.log(`✅ Найдено пулов: ${tokenResponse.data.pairs.length}`);
                tokenResponse.data.pairs.slice(0, 3).forEach((pair, i) => {
                    console.log(`\n--- Пул ${i+1} ---`);
                    console.log('DEX:', pair.dexId);
                    console.log('Quote:', pair.quoteToken.symbol);
                    console.log('Liquidity:', pair.liquidity?.usd || 0);
                });
            } else {
                console.log('❌ Пулы не найдены');
            }
            
        } else {
            console.log('❌ Токен GF не найден на DEX');
            
            // Попробуем другие варианты поиска
            console.log('\n🔍 Пробуем поиск с разными вариантами...');
            const variants = ['GF', 'Gf', 'gF', 'gf'];
            
            for (const variant of variants) {
                const resp = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${variant}`);
                if (resp.data.pairs && resp.data.pairs.length > 0) {
                    console.log(`✅ Найден по запросу "${variant}":`);
                    console.log('Первый пул:', resp.data.pairs[0].baseToken.symbol);
                    break;
                }
            }
        }
        
    } catch (error) {
        console.error('Ошибка:', error.message);
    }
}

testDexAPI();