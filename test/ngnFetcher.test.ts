import assert from 'node:assert/strict';
import axios from 'axios';
import { NGNRateFetcher } from '../src/services/marketRate/ngnFetcher';

async function run() {
  const originalGet = axios.get;
  const originalPost = axios.post;

  try {
    const fetcher = new NGNRateFetcher();

    // Test Case 1: CoinGecko successful
    axios.get = (async (url: string) => {
      if (url.includes('api.coingecko.com')) {
        return {
          data: {
            stellar: {
              ngn: 250,
              last_updated_at: Math.floor(Date.now() / 1000)
            }
          }
        };
      }
      return { data: {} };
    }) as typeof axios.get;

    axios.post = (async () => ({ data: { data: [] } })) as typeof axios.post;

    const rateResult = await fetcher.fetchRate();
    assert.equal(rateResult.currency, 'NGN');
    assert.ok(rateResult.rate > 0);
    console.log('✅ CoinGecko strategy test passed');

    // Test Case 2: Binance P2P successful
    axios.post = (async (url: string, data: any) => {
      if (url.includes('p2p-api.binance.com')) {
        if (data.asset === 'XLM') {
          return {
            data: {
              success: true,
              data: [
                { adv: { price: '260' } },
                { adv: { price: '270' } }
              ]
            }
          };
        }
      }
      return { data: { data: [] } };
    }) as typeof axios.post;

    const p2pRateResult = await fetcher.fetchRate();
    assert.equal(p2pRateResult.currency, 'NGN');
    // Median of 250 (CoinGecko) and 265 (Binance P2P avg) is 257.5
    assert.equal(p2pRateResult.rate, 257.5);
    console.log('✅ Binance P2P strategy test passed');

    // Test Case 3: Cross Rate successful (USDT P2P + XLMUSDT Spot)
    axios.post = (async (url: string, data: any) => {
      if (url.includes('p2p-api.binance.com')) {
        if (data.asset === 'USDT') {
          return {
            data: {
              success: true,
              data: [{ adv: { price: '1500' } }]
            }
          };
        }
      }
      return { data: { data: [] } };
    }) as typeof axios.post;

    axios.get = (async (url: string, config: any) => {
      if (url.includes('api.binance.com') && config?.params?.symbol === 'XLMUSDT') {
        return { data: { lastPrice: '0.2' } };
      }
      if (url.includes('api.coingecko.com')) {
        return { data: { stellar: { ngn: 300 } } };
      }
      return { data: {} };
    }) as typeof axios.get;

    const crossRateResult = await fetcher.fetchRate();
    // Sources: CoinGecko (300), Binance USDT Cross (1500 * 0.2 = 300)
    // Median of [300, 300] is 300
    assert.equal(crossRateResult.rate, 300);
    console.log('✅ Cross rate strategy test passed');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
