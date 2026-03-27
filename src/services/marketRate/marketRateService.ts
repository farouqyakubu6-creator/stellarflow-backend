import {
  MarketRateFetcher,
  MarketRate,
  FetcherResponse,
  AggregatedFetcherResponse,
} from "./types";
import { KESRateFetcher } from "./kesFetcher";
import { GHSRateFetcher } from "./ghsFetcher";
import { NGNRateFetcher } from "./ngnFetcher";
import { StellarService } from "../stellarService";
import { getIO } from "../../lib/socket";
import prisma from "../../lib/prisma";

export class MarketRateService {
  private fetchers: Map<string, MarketRateFetcher> = new Map();
  private cache: Map<string, { rate: MarketRate; expiry: Date }> = new Map();
  private stellarService: StellarService;
  private readonly CACHE_DURATION_MS = 30000; // 30 seconds

  constructor() {
    this.stellarService = new StellarService();
    this.initializeFetchers();
  }

  private initializeFetchers(): void {
    const kesFetcher = new KESRateFetcher();
    const ghsFetcher = new GHSRateFetcher();
    const ngnFetcher = new NGNRateFetcher();

    this.fetchers.set("KES", kesFetcher);
    this.fetchers.set("GHS", ghsFetcher);
    this.fetchers.set("NGN", ngnFetcher);
  }

  async getRate(currency: string): Promise<FetcherResponse> {
    try {
      const normalizedCurrency = currency.toUpperCase();
      const fetcher = this.fetchers.get(normalizedCurrency);
      if (!fetcher) {
        return {
          success: false,
          error: `No fetcher available for currency: ${currency}`,
        };
      }

      const cached = this.cache.get(normalizedCurrency);
      if (cached && cached.expiry > new Date()) {
        return {
          success: true,
          data: cached.rate,
        };
      }

      const rate = await fetcher.fetchRate();
      const reviewAssessment = await priceReviewService.assessRate(rate);
      const enrichedRate: MarketRate = {
        ...rate,
        manualReviewRequired: reviewAssessment.manualReviewRequired,
        reviewId: reviewAssessment.reviewRecordId,
        contractSubmissionSkipped: reviewAssessment.manualReviewRequired,
        ...(reviewAssessment.reason !== undefined && {
          reviewReason: reviewAssessment.reason,
        }),
        ...(reviewAssessment.changePercent !== undefined && {
          reviewChangePercent: reviewAssessment.changePercent,
        }),
        ...(reviewAssessment.comparisonRate !== undefined && {
          comparisonRate: reviewAssessment.comparisonRate,
        }),
        ...(reviewAssessment.comparisonTimestamp !== undefined && {
          comparisonTimestamp: reviewAssessment.comparisonTimestamp,
        }),
      };

      if (!reviewAssessment.manualReviewRequired) {
        try {
          const memoId = this.stellarService.generateMemoId(normalizedCurrency);
          const txHash = await this.stellarService.submitPriceUpdate(
            normalizedCurrency,
            rate.rate,
            memoId,
          );
          await priceReviewService.markContractSubmitted(
            reviewAssessment.reviewRecordId,
            memoId,
            txHash,
          );
        } catch (stellarError) {
          console.error(
            "Failed to submit price update to Stellar network:",
            stellarError,
          );
        }
      } else {
        console.warn(
          `Manual review required for ${normalizedCurrency} rate ${rate.rate}. Skipping contract submission.`,
        );
      }

      this.cache.set(normalizedCurrency, {
        rate: enrichedRate,
        expiry: new Date(Date.now() + this.CACHE_DURATION_MS),
      });

      // Persist to price history for sparkline charts
      try {
        await prisma.priceHistory.upsert({
          where: {
            currency_source_timestamp: {
              currency: currency.toUpperCase(),
              source: rate.source,
              timestamp: rate.timestamp,
            },
          },
          update: {},
          create: {
            currency: currency.toUpperCase(),
            rate: rate.rate,
            source: rate.source,
            timestamp: rate.timestamp,
          },
        });
      } catch (dbError) {
        console.error("Failed to persist price history:", dbError);
      }

      // Broadcast fresh price to all connected dashboard clients
      try {
        getIO().emit("price:update", {
          currency: normalizedCurrency,
          rate: enrichedRate,
        });

        if (reviewAssessment.manualReviewRequired) {
          getIO().emit("price:review_required", {
            currency: normalizedCurrency,
            rate: enrichedRate,
          });
        }
      } catch {
        // Socket not initialized yet (e.g. during tests) - skip silently
      }

      return {
        success: true,
        data: enrichedRate,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  async getAllRates(): Promise<FetcherResponse[]> {
    const currencies = Array.from(this.fetchers.keys());
    const promises = currencies.map((currency) => this.getRate(currency));

    return Promise.all(promises);
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [currency, fetcher] of this.fetchers) {
      try {
        results[currency] = await fetcher.isHealthy();
      } catch {
        results[currency] = false;
      }
    }

    return results;
  }

  getSupportedCurrencies(): string[] {
    return Array.from(this.fetchers.keys());
  }

  async getLatestPrices(): Promise<AggregatedFetcherResponse> {
    const results = await this.getAllRates();

    const successfulRates = results
      .filter((result) => result.success && result.data)
      .map((result) => result.data as MarketRate);

    const errorMessages = results
      .filter((result) => !result.success)
      .map((result) => result.error)
      .filter((error): error is string => !!error);

    const allSuccessful =
      successfulRates.length > 0 && errorMessages.length === 0;

    return {
      success: allSuccessful,
      data: successfulRates,
      ...(errorMessages.length > 0 && { error: errorMessages[0] }),
      ...(errorMessages.length > 0 && { errors: errorMessages }),
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getPendingReviews(): Promise<PendingPriceReview[]> {
    return priceReviewService.getPendingReviews();
  }

  async approvePendingReview(
    reviewId: number,
    reviewedBy?: string,
    reviewNotes?: string,
  ): Promise<PendingPriceReview> {
    const pendingReview = await priceReviewService.getPendingReviewById(reviewId);
    if (!pendingReview) {
      throw new Error(`Pending review ${reviewId} was not found`);
    }

    const memoId = this.stellarService.generateMemoId(pendingReview.currency);
    const txHash = await this.stellarService.submitPriceUpdate(
      pendingReview.currency,
      pendingReview.rate,
      memoId,
    );

    const approvedReview = await priceReviewService.approveReview({
      reviewId,
      memoId,
      stellarTxHash: txHash,
      ...(reviewedBy !== undefined && { reviewedBy }),
      ...(reviewNotes !== undefined && { reviewNotes }),
    });

    this.cache.delete(pendingReview.currency.toUpperCase());

    try {
      getIO().emit("price:review_resolved", {
        action: "approved",
        review: approvedReview,
      });
    } catch {
      // Socket not initialized yet (e.g. during tests) - skip silently
    }

    return approvedReview;
  }

  async rejectPendingReview(
    reviewId: number,
    reviewedBy?: string,
    reviewNotes?: string,
  ): Promise<PendingPriceReview> {
    const rejectedReview = await priceReviewService.rejectReview({
      reviewId,
      ...(reviewedBy !== undefined && { reviewedBy }),
      ...(reviewNotes !== undefined && { reviewNotes }),
    });

    this.cache.delete(rejectedReview.currency.toUpperCase());

    try {
      getIO().emit("price:review_resolved", {
        action: "rejected",
        review: rejectedReview,
      });
    } catch {
      // Socket not initialized yet (e.g. during tests) - skip silently
    }

    return rejectedReview;
  }

  getCacheStatus(): Record<string, { cached: boolean; expiry?: Date }> {
    const status: Record<string, { cached: boolean; expiry?: Date }> = {};

    for (const currency of this.fetchers.keys()) {
      const cached = this.cache.get(currency);
      if (cached && cached.expiry > new Date()) {
        status[currency] = {
          cached: true,
          expiry: cached.expiry,
        };
      } else {
        status[currency] = {
          cached: false,
        };
      }
    }

    return status;
  }
}
