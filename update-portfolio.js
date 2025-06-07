const fs = require('fs');
const https = require('https');
const querystring = require('querystring');

// Configuration
const REFRESH_TOKEN = process.env.QUESTRADE_REFRESH_TOKEN;
const START_DATE = new Date(process.env.CHALLENGE_START_DATE || '2025-06-07');

function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`Response status: ${res.statusCode}`);
                console.log(`Response headers:`, res.headers);
                console.log(`Raw response data:`, data);
                
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }
                
                // Always return the raw data, let the caller decide how to parse it
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
    const postData = querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN
    });
    
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        },
        body: postData
    };
    
    console.log('Making token request to Questrade...');
    console.log('Refresh token (first 10 chars):', REFRESH_TOKEN?.substring(0, 10) + '...');
    
    try {
        const response = await httpsRequest('https://login.questrade.com/oauth2/token', options);
        console.log('Raw response received:', typeof response === 'string' ? response : JSON.stringify(response, null, 2));
        
        if (typeof response === 'string') {
            // If it's a string, try to parse it as JSON
            try {
                const parsed = JSON.parse(response);
                return parsed;
            } catch (e) {
                console.error('Response is not valid JSON:', response);
                throw new Error(`Invalid response from Questrade: ${response}`);
            }
        }
        
        if (response.error) {
            throw new Error(`Token error: ${response.error_description || response.error}`);
        }
        
        if (!response.api_server) {
            throw new Error('No api_server in token response');
        }
        
        return response;
    } catch (error) {
        console.error('Token request failed:', error.message);
        throw error;
    }
}

async function getPortfolioData(apiServer, accessToken) {
    console.log(`Using API server: ${apiServer}`);
    
    // Get accounts
    const accountsUrl = `${apiServer}/v1/accounts`;
    console.log(`Fetching accounts from: ${accountsUrl}`);
    
    const accounts = await httpsRequest(accountsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!accounts.accounts || accounts.accounts.length === 0) {
        throw new Error('No accounts found');
    }
    
    const accountId = accounts.accounts[0].number;
    console.log(`Using account ID: ${accountId}`);
    
    // Get positions
    const positionsUrl = `${apiServer}/v1/accounts/${accountId}/positions`;
    const positions = await httpsRequest(positionsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    // Get account balances
    const balancesUrl = `${apiServer}/v1/accounts/${accountId}/balances`;
    const balances = await httpsRequest(balancesUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
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
        
        console.log('Getting access token...');
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
        console.log(`Total invested: ${totalInvested}`);
        console.log(`Current value: ${currentValue.toFixed(2)}`);
        console.log(`Gains: ${grossGains.toFixed(2)}`);
        
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
