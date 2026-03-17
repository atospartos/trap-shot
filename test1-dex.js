const axios = require('axios');

async function debugContract() {
    console.log('🔍 Тестирование DexScreener API по адресу контракта\n');
    
    // Адрес контракта GF (нужно заменить на правильный, если вы его нашли)
    const contractAddress = '0x6Db461da03b8Ad06319fF2aF985E1C8dFcC004e0'; // ВСТАВЬТЕ АДРЕС СЮДА
    
    // Тест 1: Поиск по адресу через search endpoint
    console.log('Тест 1: Поиск через search?q=адрес');
    try {
        const searchByAddress = await axios.get(
            `https://api.dexscreener.com/latest/dex/search?q=${contractAddress}`
        );
        console.log('Статус:', searchByAddress.status);
        console.log('Найдено пар:', searchByAddress.data.pairs?.length || 0);
        if (searchByAddress.data.pairs?.length > 0) {
            console.log('\nПервые 3 найденные пары:');
            searchByAddress.data.pairs.slice(0, 3).forEach((pair, i) => {
                console.log(`\n--- Пул ${i+1} ---`);
                console.log('DEX:', pair.dexId);
                console.log('Chain:', pair.chainId);
                console.log('Base Token:', pair.baseToken.symbol);
                console.log('Base Address:', pair.baseToken.address);
                console.log('Quote Token:', pair.quoteToken.symbol);
                console.log('Liquidity USD:', pair.liquidity?.usd || 0);
            });
        }
    } catch (e) {
        console.log('Ошибка:', e.message);
    }
    
    console.log('\n-------------------\n');
    
    // Тест 2: Поиск по символу (для сравнения)
    console.log('Тест 2: Поиск по символу GF');
    try {
        const searchBySymbol = await axios.get(
            'https://api.dexscreener.com/latest/dex/search?q=GF'
        );
        console.log('Статус:', searchBySymbol.status);
        console.log('Найдено пар:', searchBySymbol.data.pairs?.length || 0);
        if (searchBySymbol.data.pairs?.length > 0) {
            console.log('\nПервые 3 найденные пары:');
            searchBySymbol.data.pairs.slice(0, 3).forEach((pair, i) => {
                console.log(`\n--- Пул ${i+1} ---`);
                console.log('DEX:', pair.dexId);
                console.log('Chain:', pair.chainId);
                console.log('Base Token:', pair.baseToken.symbol);
                console.log('Base Address:', pair.baseToken.address);
                console.log('Quote Token:', pair.quoteToken.symbol);
                console.log('Liquidity USD:', pair.liquidity?.usd || 0);
            });
        }
    } catch (e) {
        console.log('Ошибка:', e.message);
    }
    
    console.log('\n-------------------\n');
    
    // Тест 3: Прямой запрос к /tokens endpoint (если есть адрес)
    if (contractAddress !== '0x...') {
        console.log('Тест 3: Прямой запрос к /tokens/{address}');
        try {
            const tokenEndpoint = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`
            );
            console.log('Статус:', tokenEndpoint.status);
            console.log('Найдено пар:', tokenEndpoint.data.pairs?.length || 0);
        } catch (e) {
            console.log('Ошибка:', e.message);
        }
    }
}

debugContract();