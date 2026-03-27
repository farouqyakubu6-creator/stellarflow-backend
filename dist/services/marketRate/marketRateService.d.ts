import { FetcherResponse, AggregatedFetcherResponse } from "./types";
import { type PendingPriceReview } from "../priceReviewService";
export declare class MarketRateService {
    private fetchers;
    private cache;
    private stellarService;
    private readonly CACHE_DURATION_MS;
    constructor();
    private initializeFetchers;
    getRate(currency: string): Promise<FetcherResponse>;
    getAllRates(): Promise<FetcherResponse[]>;
    healthCheck(): Promise<Record<string, boolean>>;
    getSupportedCurrencies(): string[];
    getLatestPrices(): Promise<AggregatedFetcherResponse>;
    clearCache(): void;
    getPendingReviews(): Promise<PendingPriceReview[]>;
    approvePendingReview(reviewId: number, reviewedBy?: string, reviewNotes?: string): Promise<PendingPriceReview>;
    rejectPendingReview(reviewId: number, reviewedBy?: string, reviewNotes?: string): Promise<PendingPriceReview>;
    getCacheStatus(): Record<string, {
        cached: boolean;
        expiry?: Date;
    }>;
}
//# sourceMappingURL=marketRateService.d.ts.map