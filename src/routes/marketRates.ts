
import { Router } from "express";
import { getRate, getAllRates } from "../controllers/marketRatesController";
import { MarketRateService } from "../services/marketRate";

const marketRateService = new MarketRateService();

const router = Router();

// Get rate for specific currency
router.get("/rate/:currency", getRate);

// Get all available rates
router.get("/rates", getAllRates);



// GET /api/market-rates/latest
router.get("/latest", async (req, res) => {
  try {
    const result = await marketRateService.getLatestPrices();

    if (result.success) {
      res.json({
        success: true,
        data: result.data,
        ...(result.errors && { errors: result.errors }),
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("Error fetching latest prices:", error);

    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch latest prices",
    });
  }
});

router.get("/reviews/pending", async (req, res) => {
  try {
    const reviews = await marketRateService.getPendingReviews();

    res.json({
      success: true,
      data: reviews,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch pending price reviews",
    });
  }
});

router.post("/reviews/:id/approve", async (req, res) => {
  try {
    const reviewId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(reviewId)) {
      res.status(400).json({
        success: false,
        error: "Review ID must be a valid number",
      });
      return;
    }

    const { reviewedBy, note } = req.body ?? {};
    const review = await marketRateService.approvePendingReview(
      reviewId,
      reviewedBy,
      note,
    );

    res.json({
      success: true,
      data: review,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to approve price review",
    });
  }
});

router.post("/reviews/:id/reject", async (req, res) => {
  try {
    const reviewId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(reviewId)) {
      res.status(400).json({
        success: false,
        error: "Review ID must be a valid number",
      });
      return;
    }

    const { reviewedBy, note } = req.body ?? {};
    const review = await marketRateService.rejectPendingReview(
      reviewId,
      reviewedBy,
      note,
    );

    res.json({
      success: true,
      data: review,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to reject price review",
    });
  }
});

// Health check for all fetchers
router.get("/health", async (req, res) => {
  try {
    const health = await marketRateService.healthCheck();

    res.json({
      success: true,
      data: health,
      overallHealthy: Object.values(health).every((status) => status),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// Get supported currencies
router.get("/currencies", (req, res) => {
  try {
    const currencies = marketRateService.getSupportedCurrencies();

    res.json({
      success: true,
      data: currencies,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// Get cache status
router.get("/cache", (req, res) => {
  try {
    const cacheStatus = marketRateService.getCacheStatus();

    res.json({
      success: true,
      data: cacheStatus,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// Clear cache
router.post("/cache/clear", (req, res) => {
  try {
    marketRateService.clearCache();

    res.json({
      success: true,
      message: "Cache cleared successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
