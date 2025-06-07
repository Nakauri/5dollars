const fs = require('fs');
const https = require('https');

// Configuration
const REFRESH_TOKEN = process.env.QUESTRADE_REFRESH_TOKEN;
const START_DATE = new Date(process.env.CHALLENGE_START_DATE || '2025-06-07');
const PROXY_URL = process.env.PROXY_URL || 'https://questrade-proxy.vercel.app';

function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }
                resolve(data);
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function getAccessToken() {
    console.log('Getting access token via proxy...');
    
    const requestBody = JSON.stringify({
        action: 'getToken',
        refreshToken: REFRESH_TOKEN
    });
    
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody)
        },
        body: requestBody
    };
    
    try {
        const response = await httpsRequest(`${PROXY_URL}/api/questrade-proxy`, options);
        const data = JSON.parse(response);
        
        if (data.error) {
            throw new Error(`Proxy error: ${data.error} - ${data.details}`);
        }
        
        console.log('Token received via proxy successfully');
        return data;
    } catch (error) {
        console.error('Proxy token request failed:', error.message);
        throw error;
    }
}

async function makeApiCall(apiServer, accessToken, endpoint) {
    console.log(`Making API call via proxy: ${endpoint}`);
    
    const requestBody = JSON.stringify({
        action: 'apiCall',
        apiServer: apiServer,
        accessToken: accessToken,
        endpoint: endpoint
    });
    
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody)
        },
        body: requestBody
    };
    
    try {
        const response = await httpsRequest(`${PROXY_URL}/api/questrade-proxy`, options);
        const data = JSON.parse(response);
        
        if (data.error) {
            throw new Error(`API call error: ${data.error} - ${data.details}`);
        }
        
        return data;
    } catch (error) {
        console.error(`API call failed for ${endpoint}:`, error.message);
        throw error;
    }
}

async function getPortfolioData(apiServer, accessToken) {
    // Get accounts
    const accounts = await makeApiCall(apiServer, accessToken, '/v1/accounts');
    
    if (!accounts.accounts || accounts.accounts.length === 0) {
        throw new Error('No accounts found');
    }
    
    const accountId = accounts.accounts[0].number;
    console.log(`Using account ID: ${accountId}`);
    
    // Get positions and balances
    const [positions, balances] = await Promise.all([
        makeApiCall(apiServer, accessToken, `/v1/accounts/${accountId}/positions`),
        makeApiCall(apiServer, accessToken, `/v1/accounts/${accountId}/balances`)
    ]);
    
    return { 
        positions: positions.positions || [], 
        balances: balances.combinedBalances || []
    };
}

function calculateTaxes(grossGains) {
    if (grossGains <= 0) return { totalTax: 0, effectiveRate: 0 };
    
    const capitalGainsRate = 0.2675; // 26.75%
    const dividendRate = 0.0581; // 5.81%
    
    const capitalGains = grossGains * 0.85;
    const dividends = grossGains * 0.15;
    
    const capitalGainsTax = capitalGains * capitalGainsRate;
    const dividendTax = dividends * dividendRate;
    
    return {
        totalTax: capitalGainsTax + dividendTax,
        effectiveRate: ((capitalGainsTax + dividendTax) / grossGains) * 100
    };
}

async function main() {
    try {
        if (!REFRESH_TOKEN) {
            throw new Error('QUESTRADE_REFRESH_TOKEN environment variable not set');
        }
        
        if (!PROXY_URL || PROXY_URL === 'YOUR_VERCEL_URL_HERE') {
            throw new Error('PROXY_URL environment variable not set');
        }
        
        console.log('Using proxy URL:', PROXY_URL);
        
        const tokenData = await getAccessToken();
        console.log('Fetching portfolio data...');
        const portfolioData = await getPortfolioData(tokenData.api_server, tokenData.access_token);
        
        // Calculate challenge metrics
        const now = new Date();
        const daysInvested = Math.max(0, Math.floor((now - START_DATE) / (1000 * 60 * 60 * 24)));
        const totalInvested = daysInvested * 5;
        
        // Find XEQT position
        const xeqtPosition = portfolioData.positions.find(p => p.symbol === 'XEQT') || {
            currentMarketValue: 0,
            openQuantity: 0,
            averageEntryPrice: 0
        };
        
        // Use total equity from balances, fallback to XEQT position value
        const currentValue = portfolioData.balances.length > 0 ? 
            portfolioData.balances[0].totalEquity || 0 : 
            xeqtPosition.currentMarketValue;
            
        const grossGains = currentValue - totalInvested;
        
        // Calculate taxes
        const taxes = calculateTaxes(grossGains);
        const afterTaxValue = currentValue - taxes.totalTax;
        const afterTaxGains = afterTaxValue - totalInvested;
        
        // Prepare data for website
        const portfolioUpdate = {
            lastUpdated: now.toISOString(),
            daysInvested: daysInvested,
            totalInvested: totalInvested,
            currentValue: Math.round(currentValue * 100) / 100,
            grossGains: Math.round(grossGains * 100) / 100,
            afterTaxValue: Math.round(afterTaxValue * 100) / 100,
            afterTaxGains: Math.round(afterTaxGains * 100) / 100,
            effectiveTaxRate: Math.round(taxes.effectiveRate * 100) / 100,
            xeqtShares: xeqtPosition.openQuantity,
            xeqtAvgPrice: xeqtPosition.averageEntryPrice,
            progressToGoal: Math.min((afterTaxValue / 2500) * 100, 100)
        };
        
        // Write to JSON file
        fs.writeFileSync('portfolio-data.json', JSON.stringify(portfolioUpdate, null, 2));
        
        console.log('Portfolio data updated successfully!');
        console.log(`Days invested: ${daysInvested}`);
        console.log(`Total invested: $${totalInvested}`);
        console.log(`Current value: $${currentValue.toFixed(2)}`);
        console.log(`Gains: $${grossGains.toFixed(2)}`);
        
    } catch (error) {
        console.error('Error updating portfolio:', error);
        
        // Create fallback data if API fails
        const now = new Date();
        const daysInvested = Math.max(0, Math.floor((now - START_DATE) / (1000 * 60 * 60 * 24)));
        const totalInvested = daysInvested * 5;
        
        const fallbackData = {
            lastUpdated: now.toISOString(),
            daysInvested: daysInvested,
            totalInvested: totalInvested,
            currentValue: totalInvested, // No gains if API fails
            grossGains: 0,
            afterTaxValue: totalInvested,
            afterTaxGains: 0,
            effectiveTaxRate: 0,
            xeqtShares: 0,
            xeqtAvgPrice: 0,
            progressToGoal: Math.min((totalInvested / 2500) * 100, 100),
            error: 'API connection failed - showing invested amount only'
        };
        
        fs.writeFileSync('portfolio-data.json', JSON.stringify(fallbackData, null, 2));
        process.exit(1);
    }
}

main();
