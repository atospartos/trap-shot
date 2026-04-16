const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------- НАСТРОЙКИ ----------
const TIMEOUT = 15000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 2000;

// ---------- Утилита для повторных запросов ----------
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, {
                timeout: TIMEOUT,
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json',
                    ...options.headers
                }
            });
            return response;
        } catch (error) {
            const isLastAttempt = i === retries - 1;
            const isConnectionError = error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT';

            if (isConnectionError && !isLastAttempt) {
                console.log(`   ⏳ Повторная попытка ${i + 2}/${retries}...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
            }
            throw error;
        }
    }
}

// ---------- 1. MEXC ----------
async function getMexcTokens() {
    try {
        const response = await fetchWithRetry('https://api.mexc.com/api/v3/defaultSymbols');
        const data = response.data;

        const tokens = new Set();

        if (data && data.data && Array.isArray(data.data)) {
            for (const symbol of data.data) {
                if (symbol && symbol.endsWith('USDT')) {
                    const baseAsset = symbol.replace('USDT', '');
                    tokens.add(baseAsset);
                }
            }
            console.log(`📌 MEXC: ${tokens.size} токенов`);
        } else {
            console.error('❌ Неожиданный формат ответа MEXC');
            return new Set();
        }

        return tokens;
    } catch (error) {
        console.error('❌ Ошибка при получении MEXC:', error.message);
        return new Set();
    }
}

// ---------- 2. Binance ----------
async function getBinanceTokens() {
    try {
        const response = await fetchWithRetry('https://api.binance.com/api/v3/exchangeInfo');
        const tokens = new Set();
        for (const symbol of response.data.symbols) {
            if (symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING') {
                tokens.add(symbol.baseAsset);
            }
        }
        console.log(`📌 Binance: ${tokens.size} токенов`);
        return tokens;
    } catch (error) {
        console.error('❌ Ошибка при получении Binance:', error.message);
        return new Set();
    }
}

// ---------- 3. Gate.io (ручной парсинг) ----------
async function getGateTokens() {
    try {
        const response = await axios.get('https://data.gateapi.io/api2/1/pairs', {
            timeout: 15000,
            responseType: 'text',
            transformResponse: [data => data]
        });

        const textData = response.data;
        const tokens = new Set();

        // Ручной парсинг: ищем все "XXX_USDT"
        const regex = /"([A-Z0-9]+)_USDT"/g;
        let match;

        while ((match = regex.exec(textData)) !== null) {
            tokens.add(match[1]);
        }

        console.log(`📌 Gate.io: ${tokens.size} токенов`);
        return tokens;

    } catch (error) {
        console.log(`⚠️ Gate.io временно недоступен (${error.message}), пропускаем...`);
        return new Set();
    }
}

// ---------- 4. OKX ----------
async function getOKXTokens() {
    try {
        const response = await fetchWithRetry('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
        const tokens = new Set();
        if (response.data.data) {
            for (const instrument of response.data.data) {
                if (instrument.quoteCcy === 'USDT' && instrument.state === 'live') {
                    tokens.add(instrument.baseCcy);
                }
            }
        }
        console.log(`📌 OKX: ${tokens.size} токенов`);
        return tokens;
    } catch (error) {
        console.log(`⚠️ OKX временно недоступен (${error.message}), пропускаем...`);
        return new Set();
    }
}

// ---------- 5. Bybit ----------
async function getBybitTokens() {
    try {
        const response = await fetchWithRetry('https://api.bybit.com/v5/market/instruments-info?category=spot');
        const tokens = new Set();
        if (response.data.result?.list) {
            for (const instrument of response.data.result.list) {
                if (instrument.quoteCoin === 'USDT' && instrument.status === 'Trading') {
                    tokens.add(instrument.baseCoin);
                }
            }
        }
        console.log(`📌 Bybit: ${tokens.size} токенов`);
        return tokens;
    } catch (error) {
        console.log(`⚠️ Bybit временно недоступен (${error.message}), пропускаем...`);
        return new Set();
    }
}

// ---------- 6. Проверка DEX ликвидности ----------
async function hasDexLiquidity(tokenSymbol) {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${tokenSymbol}`;

    try {
        const response = await axios.get(url, { timeout: 10000 });
        const pairs = response.data.pairs;

        if (!pairs || pairs.length === 0) return false;

        for (const pair of pairs) {
            const liquidity = parseFloat(pair.liquidity?.usd);
            const volume24h = parseFloat(pair.volume?.h24);
            if (liquidity > 40000 || volume24h > 3000) {
                 console.log(` ${tokenSymbol}  liquidity: '${liquidity}$' volume:  '${volume24h}$'`);
                return true;
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

// ---------- 9. ГЛАВНАЯ ЛОГИКА ----------
async function findUniqueMexcTokens() {
    console.log('\n🔍 Поиск токенов на MEXC + DEX...\n');

    const mexcTokens = await getMexcTokens();

    if (mexcTokens.size === 0) {
        console.error('❌ Не удалось получить список токенов с MEXC.');
        return { pure: [], singleExchange: [] };
    }

    console.log('\n⏳ Получение списков с других бирж...\n');

    const [binanceTokens, gateTokens, okxTokens, bybitTokens] = await Promise.all([
        getBinanceTokens(),
        getGateTokens(),
        getOKXTokens(),
        getBybitTokens()
    ]);

    console.log(`\n📊 Статистика по биржам:`);
    console.log(`   Binance: ${binanceTokens.size}`);
    console.log(`   Gate.io: ${gateTokens.size}`);
    console.log(`   OKX: ${okxTokens.size}`);
    console.log(`   Bybit: ${bybitTokens.size}\n`);

    const pureResults = [];
    const tokenList = Array.from(mexcTokens);
    console.log(`⏳ Начинаем проверку ${tokenList.length} токенов...\n`);

    for (let i = 0; i < tokenList.length; i++) {
        const token = tokenList[i];

        if (i % 100 === 0 && i > 0) {
            console.log(`⏳ Прогресс: ${i}/${tokenList.length} (${Math.round(i / tokenList.length * 100)}%)`);
        }

        const onBinance = binanceTokens.has(token);
        const onGate = gateTokens.has(token);
        const onOKX = okxTokens.has(token);
        const onBybit = bybitTokens.has(token);

        const majorExchanges = [onBinance, onOKX, onBybit, onGate];
        const majorCount = majorExchanges.filter(Boolean).length;

        const hasDex = await hasDexLiquidity(token);

        if (!hasDex) continue;

        // Категория A: чистые (нет ни на одной крупной бирже)
        if (majorCount === 0) {
            pureResults.push({
                symbol: token,
                category: 'PURE',
                timestamp: new Date().toISOString()
            });
            console.log(`✅ [PURE] ${token}}`);
        }

        if (i % 20 === 0) {
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    }

    console.log(`\n📊 ИТОГО НАЙДЕНО:`);
    console.log(`   🟢 PURE (только MEXC + DEX): ${pureResults.length}`);

    return { pure: pureResults };
}

// ---------- 10. Запуск ----------
async function main() {
    console.log('🚀 Запуск сканера токенов MEXC\n');
    console.log('⏳ Это может занять несколько минут...\n');

    const startTime = Date.now();
    const { pure } = await findUniqueMexcTokens();
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // Сохраняем
    fs.writeFileSync(path.join(process.cwd(), 'data/tokens/pure_tokens.json'), JSON.stringify(pure, null, 2));

    console.log(`\n💾 Результаты сохранены:`);
    console.log(`   pure_tokens.json — ${pure.length} токенов`);
    console.log(`\n⏱️ Время выполнения: ${elapsedTime} сек.`);
}

main().catch(error => {
    console.error('❌ Критическая ошибка:', error.message);
    process.exit(1);
});