const path = require('path');
const ContractResolver = require('./contractResolver');

async function main() {
    const resolver = new ContractResolver({
        delayMs: 1000,
        timeout: 15000,
        maxRequestsPerClient: 100
    });

    const txtfile = path.join(process.cwd(), 'data/tokens/tokens.txt');
    const jsfile = path.join(process.cwd(), 'data/tokens/tokens.js');
    const exchangeName = 'gateio';

    await resolver.updateFromFile(
        txtfile,
        jsfile,
        exchangeName
    );
}

main().catch(console.error);