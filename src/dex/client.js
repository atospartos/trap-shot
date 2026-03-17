const axios = require('axios');
const logger = require('../core/logger');

const BASE_URL = 'https://api.dexscreener.com';

class DexClient {
    constructor() {
        this.client = axios.create({
            baseURL: BASE_URL,
            timeout: 1000, // 1 секунда
            headers: {
                "Accept": "*/*"
            }
        });
        
        // Для rate limiting
        this.requestCount = 0;
        this.lastReset = Date.now();
    }

    async get(endpoint) {
        try {
            // Простой rate limiting
            await this._checkRateLimit();
            
            const response = await this.client.get(endpoint);
            return response.data;
        } catch (error) {
            if (error.response) {
                // Сервер ответил с ошибкой
                logger.error(`DexScreener API error (${endpoint}): ${error.response.status}`, {
                    status: error.response.status,
                    data: error.response.data
                });
            } else if (error.request) {
                // Запрос был сделан, но нет ответа
                logger.error(`DexScreener API timeout (${endpoint}):`, { error: error.message });
            } else {
                // Ошибка при настройке запроса
                logger.error(`DexScreener API request error (${endpoint}):`, { error: error.message });
            }
            return null;
        }
    }

    async _checkRateLimit() {
        // Простой rate limiter - 300 запросов в минуту
        const now = Date.now();
        if (now - this.lastReset > 60000) {
            this.requestCount = 0;
            this.lastReset = now;
        }
        
        if (this.requestCount >= 280) { // Оставляем запас
            const waitTime = 60000 - (now - this.lastReset);
            logger.warn(`Rate limit approaching, waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.requestCount = 0;
            this.lastReset = Date.now();
        }
        
        this.requestCount++;
    }
}

module.exports = new DexClient();