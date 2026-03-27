// Prisma Client Singleton
// Prevents multiple instances during development hot-reloading

import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

// Ensure environment variables are loaded
dotenv.config();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Use a fallback URL if DATABASE_URL is missing to prevent initialization errors in tests
const prismaOptions = process.env.DATABASE_URL 
  ? {} 
  : { datasources: { db: { url: "postgresql://undefined" } } };

export const prisma = globalForPrisma.prisma ?? new PrismaClient(prismaOptions);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
