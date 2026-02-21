
// This file can be used to test the Questrade connection independently
import { QuestradeService } from './questradeService.js';
import 'dotenv/config';

async function testQuestrade() {
    console.log("Initializing Questrade Service...");
    const qt = new QuestradeService({ 
        isPractice: true, // Change to false for real account
        // refreshToken: 'YOUR_TOKEN_HERE' // Or set via process.env.QUESTRADE_REFRESH_TOKEN
    });

    try {
        console.log("Authenticating...");
        await qt.authenticate();
        console.log("Authentication successful!");

        console.log("Fetching Accounts...");
        const accounts = await qt.getAccounts();
        console.log("Accounts:", JSON.stringify(accounts, null, 2));

        if (accounts.accounts && accounts.accounts.length > 0) {
            const accountId = accounts.accounts[0].number;
            console.log(`Fetching Balances for Account ${accountId}...`);
            const balances = await qt.getBalance(accountId);
            console.log("Balances:", JSON.stringify(balances, null, 2));
        }

    } catch (error) {
        console.error("Questrade Test Failed:", error.message);
    }
}

// Uncomment to run directly if you have a token
// testQuestrade();
