const axios = require('axios');
const fs = require('fs');
const path = require('path');

class ContractResolver {
    constructor(options = {}) {
        this.baseURL = options.baseURL || 'https://api.gateio.ws/api/v4';
        this.delayMs = options.delayMs || 1000;
        this.timeout = options.timeout || 15000;
        this.client = null;
        this.requestCount = 0;
        this.maxRequestsPerClient = 6; // Пересоздаем после 6 запросов
        this.createClient();
    }

    static mapNetwork(networkName) {
        if (!networkName) return null;

        const map = {
            'ETH': 'ethereum',
            'SOL': 'solana',
            'BSC': 'bsc',
            'TRX': 'tron',
            'MATIC': 'polygon',
            'ARBEVM': 'arbitrum',
            'OPETH': 'optimism',
            'BASEEVM': 'base',
            'AVAX_C': 'avalanche',
            'APT': 'aptos',
            'SUI': 'sui',
            'NEAR': 'near',
            'MON': 'monad',
            'DOTSM': 'polkadot',
            'HBAR': 'hedera',
            'XDC': 'xdc',
            'WLD': 'worldchain',
            'ZKSERA': 'zksync',
            'S': 'sonic'
        };

        const upper = networkName.toUpperCase();
        return map[upper] || networkName.toLowerCase();
    }

    static readTokensFromFile(filePath) {
        const fullPath = path.resolve(filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Файл ${fullPath} не найден`);
        }

        const content = fs.readFileSync(fullPath, 'utf-8');

        const tokens = content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));

        if (tokens.length === 0) {
            throw new Error(`Файл ${fullPath} не содержит токенов`);
        }

        return tokens;
    }

    static readExistingTokens(filePath) {
        const fullPath = path.resolve(filePath);

        if (!fs.existsSync(fullPath)) {
            return [];
        }

        try {
            delete require.cache[require.resolve(fullPath)];
            const tokens = require(fullPath);
            return Array.isArray(tokens) ? tokens : [];
        } catch (error) {
            console.warn(`⚠️ Не удалось прочитать ${fullPath}: ${error.message}`);
            return [];
        }
    }

    // Создание нового клиента
    createClient() {
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: {
                'Accept': '*/*',
                'Connection': 'close'
            },
            httpAgent: false,
            httpsAgent: false
        });
        this.requestCount = 0;
    }

    // Проверка и пересоздание клиента при необходимости
    checkAndRotateClient() {
        if (this.requestCount >= this.maxRequestsPerClient) {
            console.log(`   🔄 Пересоздание клиента (${this.requestCount} запросов)`);
            this.createClient();
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async fetchCurrencyInfo(currency) {
        this.checkAndRotateClient();

        try {
            const response = await this.client.get(`/spot/currencies/${currency}`);
            this.requestCount++;
            return response.data;
        } catch (error) {
            if (error.response?.status === 404) {
                return { error: 'not_found', currency };
            }
            return { error: error.message, currency };
        }
    }

    extractAddresses(currencyInfo) {
        const addresses = {};

        if (!currencyInfo || currencyInfo.error || !currencyInfo.chains) {
            return addresses;
        }

        for (const chain of currencyInfo.chains) {
            const networkName = chain.name;
            const contractAddress = chain.addr;

            if (networkName && contractAddress) {
                const network = ContractResolver.mapNetwork(networkName);
                if (network && contractAddress !== '0x' && contractAddress !== '') {
                    addresses[network] = contractAddress;
                }
            }
        }

        return addresses;
    }

    async getContractAddresses(symbol) {
        const currencyInfo = await this.fetchCurrencyInfo(symbol);

        if (currencyInfo.error) {
            return {
                symbol,
                addresses: {},
                error: currencyInfo.error
            };
        }

        return {
            symbol,
            addresses: this.extractAddresses(currencyInfo)
        };
    }

    static formatTokenEntry(symbol, addresses, exchange) {
        let dexStr = '';
        if (Object.keys(addresses).length === 0) {
            dexStr = '{}';
        } else {
            const entries = Object.entries(addresses)
                .map(([key, value]) => `            ${key}: "${value}"`);
            dexStr = `{\n${entries.join(',\n')}\n        }`;
        }

        return `    {\n        symbol: "${symbol}",\n        dex: ${dexStr},\n        cex: "${symbol}/USDT"\n }`;
    }

    async updateFromFile(inputFile, outputPath, exchange) {
        const newTokensList = ContractResolver.readTokensFromFile(inputFile);
        const existingTokens = ContractResolver.readExistingTokens(outputPath);
        const existingSymbols = existingTokens.map(t => t.symbol);

        const newSymbols = newTokensList.filter(s => !existingSymbols.includes(s));

        console.log(`\n🔍 Обновление из файла: ${inputFile}`);
        console.log(`📊 Существующих токенов: ${existingSymbols.length}`);
        console.log(`📊 Всего в файле: ${newTokensList.length}`);
        console.log(`🆕 Новых для добавления: ${newSymbols.length}`);

        if (newSymbols.length === 0) {
            console.log('\n✅ Файл уже актуален, новых токенов нет');
            return existingTokens;
        }

        const newResults = [];

        console.log(`\n🔍 Сбор адресов для новых токенов`);
        console.log('='.repeat(55));

        for (let i = 0; i < newSymbols.length; i++) {
            const symbol = newSymbols[i];
            process.stdout.write(`[${i + 1}/${newSymbols.length}] ${symbol}... `);

            const result = await this.getContractAddresses(symbol);
            newResults.push(result);

            if (Object.keys(result.addresses).length > 0) {
                console.log('✅');
                const networks = Object.keys(result.addresses);
                console.log(`      сети: ${networks.join(', ')}`);
            } else if (result.error === 'not_found') {
                console.log('⚠️ не найден');
            } else {
                console.log('⚠️ нет адресов');
            }

            if (i < newSymbols.length - 1) {
                await this.delay(this.delayMs);
            }
        }

        const allTokens = [...existingTokens];

        for (const result of newResults) {
            allTokens.push({
                symbol: result.symbol,
                dex: result.addresses,
                cex: {
                    [exchange]: `${result.symbol}/USDT`
                }
            });
        }

        allTokens.sort((a, b) => a.symbol.localeCompare(b.symbol));

        const entries = allTokens
            .map(t => ContractResolver.formatTokenEntry(t.symbol, t.dex, exchange))
            .join(',\n\n');

        const fileContent = `// auto-generated by ContractResolver
// Generated: ${new Date().toISOString()}
// Total tokens: ${allTokens.length}

module.exports = [
${entries}
];\n`;

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, fileContent);

        const withAddresses = newResults.filter(r => Object.keys(r.addresses).length > 0).length;

        console.log('\n' + '='.repeat(55));
        console.log(`✅ Файл обновлен: ${outputPath}`);
        console.log(`📊 Всего токенов: ${allTokens.length}`);
        console.log(`🆕 Добавлено: ${newSymbols.length} (из них с адресами: ${withAddresses})`);

        return allTokens;
    }
}

module.exports = ContractResolver;