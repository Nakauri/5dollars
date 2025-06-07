const fs = require('fs');
const https = require('https');

// Configuration
const REFRESH_TOKEN = process.env.QUESTRADE_REFRESH_TOKEN;
const START_DATE = new Date(process.env.CHALLENGE_START_DATE || '2025-06-07');

function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
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
    const url = 'https://login.questrade.com/oauth2/token';
    const body = `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`;
    
    const response = await httpsRequest(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
        },
        body: body
    });
    
    return response;
}

async function getPortfolioData(apiServer, accessToken) {
    // Get accounts
    const accountsUrl = `${apiServer}/v1/accounts`;
    const accounts = await httpsRequest(accountsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const accountId = accounts.accounts[0].number;
    
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
    
    return { positions: positions.positions, balances: balances.combinedBalances };
}

function calculateTaxes(grossGains) {
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
        console.log('Getting access token...');
        const tokenData = await getAccessToken();
        
        if (tokenData.error) {
            throw new Error(`Token error: ${tokenData.error_description}`);
        }
        
        console.log('Fetching portfolio data...');
        const portfolioData = await getPortfolioData(tokenData.api_server, tokenData.access_token);
        
        // Calculate challenge metrics
        const now = new Date();
        const daysInvested = Math.floor((now - START_DATE) / (1000 * 60 * 60 * 24));
        const totalInvested = daysInvested * 5;
        
        // Find XEQT position
        const xeqtPosition = portfolioData.positions.find(p => p.symbol === 'XEQT') || {
            currentMarketValue: 0,
            openQuantity: 0,
            averageEntryPrice: 0
        };
        
        const currentValue = portfolioData.balances[0]?.totalEquity || xeqtPosition.currentMarketValue;
        const grossGains = currentValue - totalInvested;
        
        // Calculate taxes
        const taxes = grossGains > 0 ? calculateTaxes(grossGains) : { totalTax: 0, effectiveRate: 0 };
        const afterTaxValue = currentValue - taxes.totalTax;
        const afterTaxGains = afterTaxValue - totalInvested;
        
        // Prepare data for website
        const portfolioUpdate = {
            lastUpdated: now.toISOString(),
            daysInvested: daysInvested,
            totalInvested: totalInvested,
            currentValue: Math.round(currentValue),
            grossGains: Math.round(grossGains),
            afterTaxValue: Math.round(afterTaxValue),
            afterTaxGains: Math.round(afterTaxGains),
            effectiveTaxRate: Math.round(taxes.effectiveRate * 100) / 100,
            xeqtShares: xeqtPosition.openQuantity,
            xeqtAvgPrice: xeqtPosition.averageEntryPrice,
            progressToGoal: Math.min((afterTaxValue / 2500) * 100, 100)
        };
        
        // Write to JSON file
        fs.writeFileSync('portfolio-data.json', JSON.stringify(portfolioUpdate, null, 2));
        
        console.log('Portfolio data updated successfully!');
        console.log(`Days invested: ${daysInvested}`);
        console.log(`Current value: $${currentValue.toLocaleString()}`);
        console.log(`Gains: $${grossGains.toLocaleString()}`);
        
    } catch (error) {
        console.error('Error updating portfolio:', error);
        
        // Create fallback data if API fails
        const now = new Date();
        const daysInvested = Math.floor((now - START_DATE) / (1000 * 60 * 60 * 24));
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
