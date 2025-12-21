import 'dotenv/config';
import { HyperliquidAuth, HyperliquidRestClient } from '../src/hyperliquid';
import { Database } from '../src/data/database';
import { HistoricalDataFetcher } from '../src/data/historical-fetcher';

async function main() {
  console.log('Starting historical data fetch...');

  const privateKey = process.env.HL_PRIVATE_KEY;
  const databaseUrl = process.env.DATABASE_URL;

  if (!privateKey || !databaseUrl) {
    console.error('Missing required environment variables: HL_PRIVATE_KEY, DATABASE_URL');
    process.exit(1);
  }

  const auth = new HyperliquidAuth(privateKey);
  const client = new HyperliquidRestClient(auth);
  const db = new Database(databaseUrl);

  try {
    await db.connect();
    console.log('Connected to database');

    const fetcher = new HistoricalDataFetcher(client, db);

    console.log('Fetching all historical data...');
    await fetcher.fetchAllHistoricalData();

    // Verify
    const candleCount = await db.query<{ count: string }>('SELECT COUNT(*) FROM candles');
    const fundingCount = await db.query<{ count: string }>('SELECT COUNT(*) FROM funding_rates');

    console.log('\nData fetch complete:');
    console.log(`  Candles: ${candleCount.rows[0].count}`);
    console.log(`  Funding rates: ${fundingCount.rows[0].count}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await db.disconnect();
  }
}

main().catch(console.error);
