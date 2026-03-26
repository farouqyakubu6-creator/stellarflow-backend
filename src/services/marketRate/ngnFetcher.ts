import axios, { AxiosError } from "axios";
import {
  MarketRateFetcher,
  MarketRate,
  RateSource,
  RateFetchError,
  calculateMedian,
} from "./types";

/**
 * Binance Ticker Response Interface
 */
interface BinanceTickerResponse {
  symbol: string;
  lastPrice: string;
  [key: string]: unknown;
}

/**
 * Binance P2P Response Interface
 */
interface BinanceP2PResponse {
  data?: Array<{
    adv?: {
      price: string;
      asset: string;
      fiatUnit: string;
    };
    [key: string]: unknown;
  }>;
  success?: boolean;
}

/**
 * Circuit Breaker States
 */
enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

/**
 * Circuit Breaker Configuration
 */
interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

/**
 * Circuit Breaker Implementation
 */
class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime: Date | null = null;
  private halfOpenAttempts = 0;

  constructor(private readonly config: CircuitBreakerConfig) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptRecovery()) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenAttempts = 0;
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts > this.config.halfOpenMaxAttempts) {
        throw new Error("Circuit breaker half-open limit exceeded");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();
    if (this.state === CircuitState.HALF_OPEN || this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  private shouldAttemptRecovery(): boolean {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime.getTime() >= this.config.recoveryTimeoutMs;
  }

  getState(): CircuitState {
    return this.state;
  }
}

/**
 * Retry Configuration
 */
interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Retry with exponential backoff
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  operationName: string
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < config.maxAttempts) {
        const delay = Math.min(
          config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
          config.maxDelayMs
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error(`${operationName} failed`);
}

/**
 * NGN/XLM Rate Fetcher
 */
export class NGNRateFetcher implements MarketRateFetcher {
  private readonly circuitBreaker: CircuitBreaker;
  private readonly retryConfig: RetryConfig;
  private readonly BINANCE_P2P_URL = "https://p2p-api.binance.com/bapi/c2c/v2/public/c2c/adv/search";
  private readonly BINANCE_SPOT_URL = "https://api.binance.com/api/v3/ticker/price";
  private readonly COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ngn&include_last_updated_at=true";
  private readonly EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/USD";

  // Approximate fallback rate if everything else fails but we have USD price
  private readonly APPROXIMATE_NGN_USD_RATE = 1500; 

  constructor() {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeoutMs: 30000,
      halfOpenMaxAttempts: 3,
    });

    this.retryConfig = {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    };
  }

  getCurrency(): string {
    return "NGN";
  }

  async fetchRate(): Promise<MarketRate> {
    const prices: { rate: number; timestamp: Date; source: string }[] = [];
    const errors: RateFetchError[] = [];

    // Strategy 1: Binance P2P (Direct or via USDT)
    try {
      const binanceP2PRate = await this.circuitBreaker.execute(() =>
        withRetry(() => this.fetchBinanceP2PRate(), this.retryConfig, "Binance P2P")
      );
      if (binanceP2PRate) {
        prices.push({
          rate: binanceP2PRate.rate,
          timestamp: binanceP2PRate.timestamp,
          source: binanceP2PRate.source,
        });
      }
    } catch (error) {
      errors.push({ source: "Binance P2P", message: String(error), timestamp: new Date() });
    }

    // Strategy 2: CoinGecko XLM/NGN
    try {
      const coingeckoRate = await withRetry(() => this.fetchCoinGeckoRate(), this.retryConfig, "CoinGecko");
      if (coingeckoRate) {
        prices.push(coingeckoRate);
      }
    } catch (error) {
      errors.push({ source: "CoinGecko", message: String(error), timestamp: new Date() });
    }

    // Strategy 3: XLM/USD * USD/NGN (ExchangeRate API)
    try {
      const crossRate = await withRetry(() => this.fetchCrossRate(), this.retryConfig, "Cross Rate (USD)");
      if (crossRate) {
        prices.push(crossRate);
      }
    } catch (error) {
      errors.push({ source: "ExchangeRate API Cross", message: String(error), timestamp: new Date() });
    }

    if (prices.length > 0) {
      const rateValues = prices.map((p) => p.rate);
      const medianRate = calculateMedian(rateValues);
      const mostRecentTimestamp = prices.reduce(
        (latest, p) => (p.timestamp > latest ? p.timestamp : latest),
        prices[0]!.timestamp
      );

      return {
        currency: "NGN",
        rate: medianRate,
        timestamp: mostRecentTimestamp,
        source: `Median of ${prices.length} sources`,
      };
    }

    const errorMsg = errors.map((e) => `${e.source}: ${e.message}`).join("; ");
    throw new Error(`All NGN rate sources failed. Errors: ${errorMsg}`);
  }

  private async fetchBinanceP2PRate(): Promise<{ rate: number; timestamp: Date; source: string } | null> {
    try {
      // First try XLM/NGN P2P
      const response = await axios.post<BinanceP2PResponse>(
        this.BINANCE_P2P_URL,
        {
          fiat: "NGN",
          asset: "XLM",
          merchantCheck: false,
          rows: 5,
          page: 1,
          tradeType: "BUY",
        },
        { timeout: 8000 }
      );

      if (response.data?.data && response.data.data.length > 0) {
        const prices = response.data.data
          .map((item) => parseFloat(item.adv?.price || "0"))
          .filter((p) => p > 0);
        if (prices.length > 0) {
          return {
            rate: prices.reduce((a, b) => a + b, 0) / prices.length,
            timestamp: new Date(),
            source: "Binance P2P (XLM)",
          };
        }
      }

      // If XLM P2P is empty, try USDT/NGN * XLM/USDT
      const usdtNgnResponse = await axios.post<BinanceP2PResponse>(
        this.BINANCE_P2P_URL,
        {
          fiat: "NGN",
          asset: "USDT",
          merchantCheck: false,
          rows: 5,
          page: 1,
          tradeType: "BUY",
        },
        { timeout: 8000 }
      );

      const xlmUsdtResponse = await axios.get<BinanceTickerResponse>(this.BINANCE_SPOT_URL, {
        params: { symbol: "XLMUSDT" },
        timeout: 8000,
      });

      if (usdtNgnResponse.data?.data && usdtNgnResponse.data.data.length > 0 && xlmUsdtResponse.data?.lastPrice) {
        const usdtNgnPrices = usdtNgnResponse.data.data
          .map((item) => parseFloat(item.adv?.price || "0"))
          .filter((p) => p > 0);
        const xlmUsdtPrice = parseFloat(xlmUsdtResponse.data.lastPrice);

        if (usdtNgnPrices.length > 0 && xlmUsdtPrice > 0) {
          const avgUsdtNgn = usdtNgnPrices.reduce((a, b) => a + b, 0) / usdtNgnPrices.length;
          return {
            rate: avgUsdtNgn * xlmUsdtPrice,
            timestamp: new Date(),
            source: "Binance P2P (USDT Cross)",
          };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async fetchCoinGeckoRate(): Promise<{ rate: number; timestamp: Date; source: string } | null> {
    try {
      const response = await axios.get(this.COINGECKO_URL, { timeout: 8000 });
      if (response.data?.stellar?.ngn) {
        return {
          rate: response.data.stellar.ngn,
          timestamp: response.data.stellar.last_updated_at 
            ? new Date(response.data.stellar.last_updated_at * 1000) 
            : new Date(),
          source: "CoinGecko",
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchCrossRate(): Promise<{ rate: number; timestamp: Date; source: string } | null> {
    try {
      const fxResponse = await axios.get(this.EXCHANGE_RATE_URL, { timeout: 8000 });
      const xlmUsdResponse = await axios.get(this.BINANCE_SPOT_URL, {
        params: { symbol: "XLMUSDT" },
        timeout: 8000,
      });

      const usdNgnRate = fxResponse.data?.rates?.NGN;
      const xlmUsdPrice = parseFloat(xlmUsdResponse.data?.lastPrice || "0");

      if (usdNgnRate > 0 && xlmUsdPrice > 0) {
        return {
          rate: usdNgnRate * xlmUsdPrice,
          timestamp: new Date(),
          source: "Binance + ExchangeRate API",
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const rate = await this.fetchRate();
      return rate.rate > 0;
    } catch {
      return false;
    }
  }
}
