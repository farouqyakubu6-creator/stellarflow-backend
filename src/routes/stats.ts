import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";

const router = Router();

/**
 * GET /api/stats/relayers
 * 
 * Returns statistics for all relayers (oracle servers) including:
 * - Uptime percentage
 * - Average latency (time from request to signature)
 * - Number of successful pushes (submitted prices)
 */
router.get("/relayers", async (req: Request, res: Response) => {
  try {
    // Get all unique signers/relayers
    const signers = await prisma.multiSigSignature.groupBy({
      by: ["signerPublicKey", "signerName"],
      _count: {
        id: true,
      },
    });

    // Get all submitted multi-sig prices
    const submittedPrices = await prisma.multiSigPrice.findMany({
      where: {
        status: "APPROVED",
        submittedAt: { not: null },
      },
      include: {
        multiSigSignatures: {
          select: {
            signerPublicKey: true,
            signedAt: true,
          },
        },
      },
    });

    // Calculate statistics for each relayer
    const relayerStats = await Promise.all(
      signers.map(async (signer: { signerPublicKey: string; signerName: string; _count: { id: number } }) => {
        const { signerPublicKey, signerName, _count } = signer;

        // Get all signatures by this relayer
        const signatures = await prisma.multiSigSignature.findMany({
          where: { signerPublicKey },
          include: {
            multiSigPrice: {
              select: {
                requestedAt: true,
                submittedAt: true,
                status: true,
              },
            },
          },
          orderBy: {
            signedAt: "desc",
          },
        });

        // Calculate successful pushes (prices that were submitted to Stellar)
        const successfulPushes = signatures.filter(
          (sig: any) => sig.multiSigPrice.submittedAt !== null
        ).length;

        // Calculate total requests (number of multi-sig prices this relayer was asked to sign)
        const totalRequests = signatures.length;

        // Calculate uptime % (successful signatures / total requests * 100)
        const uptimePercentage =
          totalRequests > 0 ? (successfulPushes / totalRequests) * 100 : 0;

        // Calculate average latency (time from price request to signature)
        const latencies = signatures
          .filter((sig: any) => sig.multiSigPrice.requestedAt && sig.signedAt)
          .map((sig: any) => {
            const requestedAt = new Date(sig.multiSigPrice.requestedAt).getTime();
            const signedAt = new Date(sig.signedAt).getTime();
            return signedAt - requestedAt; // milliseconds
          });

        const averageLatencyMs =
          latencies.length > 0
            ? latencies.reduce((sum: number, latency: number) => sum + latency, 0) /
              latencies.length
            : 0;

        // Get last activity
        const lastActivity = signatures[0]?.signedAt || null;

        // Get failed signatures (signed but price not submitted)
        const failedSignatures = signatures.filter(
          (sig: any) => sig.multiSigPrice.submittedAt === null
        ).length;

        return {
          signerPublicKey,
          signerName,
          totalSignatures: _count.id,
          successfulPushes,
          failedSignatures,
          uptimePercentage: Math.round(uptimePercentage * 100) / 100,
          averageLatencyMs: Math.round(averageLatencyMs * 100) / 100,
          lastActivity,
        };
      })
    );

    // Sort by uptime percentage (descending)
    relayerStats.sort((a: { uptimePercentage: number }, b: { uptimePercentage: number }) => b.uptimePercentage - a.uptimePercentage);

    res.json({
      success: true,
      data: {
        totalRelayers: relayerStats.length,
        relayers: relayerStats,
      },
    });
  } catch (error) {
    console.error("[API] Relayer stats fetch failed:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch relayer statistics",
    });
  }
});

export default router;
