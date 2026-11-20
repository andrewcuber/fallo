import { Redis } from "@upstash/redis";
import crypto from "crypto";

// Fallback limits
const FALLO_AI_DAILY_GENERATIONS_PER_VISITOR = parseInt(process.env.FALLO_AI_DAILY_GENERATIONS_PER_VISITOR || "3");
const FALLO_AI_VISITOR_DAILY_BUDGET_USD = parseFloat(process.env.FALLO_AI_VISITOR_DAILY_BUDGET_USD || "0.10");
const FALLO_AI_VISITOR_CONCURRENT_REQUESTS = parseInt(process.env.FALLO_AI_VISITOR_CONCURRENT_REQUESTS || "1");
const FALLO_AI_IP_REQUEST_LIMIT = parseInt(process.env.FALLO_AI_IP_REQUEST_LIMIT || "5");
const FALLO_AI_IP_WINDOW_SECONDS = parseInt(process.env.FALLO_AI_IP_WINDOW_SECONDS || "600");
const FALLO_AI_GLOBAL_DAILY_REQUEST_LIMIT = parseInt(process.env.FALLO_AI_GLOBAL_DAILY_REQUEST_LIMIT || "15");
const FALLO_AI_GLOBAL_DAILY_BUDGET_USD = parseFloat(process.env.FALLO_AI_GLOBAL_DAILY_BUDGET_USD || "2.00");
const FALLO_AI_GLOBAL_MONTHLY_BUDGET_USD = parseFloat(process.env.FALLO_AI_GLOBAL_MONTHLY_BUDGET_USD || "30.00");

// Gemini pricing for shadow costs
export const GEMINI_MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "gemini-3.8-flash": { inputPer1M: 0.075, outputPer1M: 0.30 },
  "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.30 }, // example legacy
};

// Returns a singleton Redis instance or null if not configured
let _redis: Redis | null = null;
export let __mockRedis: any = null;
export function setMockRedis(mock: any) { __mockRedis = mock; }
export function getRedisClient(): Redis | null {
  if (__mockRedis) return __mockRedis;
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

export function getUtcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getUtcMonthString(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface ReservationResult {
  allowed: boolean;
  reason?: "ip_limit" | "visitor_concurrent" | "visitor_generations" | "visitor_budget" | "global_requests" | "global_daily_budget" | "global_monthly_budget" | "redis_unavailable";
  retryAfterSeconds?: number;
  remainingGenerations?: number;
  reservationId?: string;
}

export async function reserveUsage(visitorId: string, ip: string, expectedModel: string = "gemini-3.8-flash"): Promise<ReservationResult> {
  const redis = getRedisClient();
  if (!redis) {
    return { allowed: false, reason: "redis_unavailable" };
  }

  const dayStr = getUtcDayString();
  const monthStr = getUtcMonthString();
  const hashedIp = hashIp(ip);

  // We'll estimate the cost of a typical request to reserve budget.
  // Say, 1000 input tokens, 1000 output tokens.
  const pricing = GEMINI_MODEL_PRICING[expectedModel] || GEMINI_MODEL_PRICING["gemini-3.8-flash"];
  const estimatedCostUsd = (1000 * pricing.inputPer1M + 1000 * pricing.outputPer1M) / 1000000;
  const costMicros = Math.ceil(estimatedCostUsd * 1000000); // use integer math in lua

  const reservationId = crypto.randomUUID();

  const keys = [
    `fallo:ip:${hashedIp}:count`,                      // 1
    `fallo:visitor:${visitorId}:concurrent`,           // 2
    `fallo:visitor:${visitorId}:day:${dayStr}:count`,  // 3
    `fallo:visitor:${visitorId}:day:${dayStr}:budget`, // 4
    `fallo:global:day:${dayStr}:count`,                // 5
    `fallo:global:day:${dayStr}:budget`,               // 6
    `fallo:global:month:${monthStr}:budget`,           // 7
    `fallo:reservation:${reservationId}`               // 8
  ];

  const args = [
    FALLO_AI_IP_WINDOW_SECONDS,
    FALLO_AI_IP_REQUEST_LIMIT,
    FALLO_AI_VISITOR_CONCURRENT_REQUESTS,
    FALLO_AI_DAILY_GENERATIONS_PER_VISITOR,
    Math.floor(FALLO_AI_VISITOR_DAILY_BUDGET_USD * 1000000),
    FALLO_AI_GLOBAL_DAILY_REQUEST_LIMIT,
    Math.floor(FALLO_AI_GLOBAL_DAILY_BUDGET_USD * 1000000),
    Math.floor(FALLO_AI_GLOBAL_MONTHLY_BUDGET_USD * 1000000),
    costMicros
  ];

  // Lua script to atomically check and reserve budgets
  // KEYS: IP_count, Visitor_concurrent, Visitor_count, Visitor_budget, Global_count, Global_day_budget, Global_month_budget, Reservation
  // ARGV: IP_window, IP_limit, Vis_conc_limit, Vis_count_limit, Vis_budget_limit, Glob_count_limit, Glob_day_budget_limit, Glob_month_budget_limit, CostMicros
  const script = `
    -- 1. Check IP limit
    local ip_count = tonumber(redis.call('GET', KEYS[1]) or '0')
    if ip_count >= tonumber(ARGV[2]) then return "ip_limit" end

    -- 2. Check Visitor Concurrent
    local vis_conc = tonumber(redis.call('GET', KEYS[2]) or '0')
    if vis_conc >= tonumber(ARGV[3]) then return "visitor_concurrent" end

    -- 3. Check Visitor Daily Generations
    local vis_count = tonumber(redis.call('GET', KEYS[3]) or '0')
    if vis_count >= tonumber(ARGV[4]) then return "visitor_generations" end

    -- 4. Check Visitor Daily Budget
    local vis_budget = tonumber(redis.call('GET', KEYS[4]) or '0')
    if vis_budget + tonumber(ARGV[9]) > tonumber(ARGV[5]) then return "visitor_budget" end

    -- 5. Check Global Daily Requests
    local glob_count = tonumber(redis.call('GET', KEYS[5]) or '0')
    if glob_count >= tonumber(ARGV[6]) then return "global_requests" end

    -- 6. Check Global Daily Budget
    local glob_day_budget = tonumber(redis.call('GET', KEYS[6]) or '0')
    if glob_day_budget + tonumber(ARGV[9]) > tonumber(ARGV[7]) then return "global_daily_budget" end

    -- 7. Check Global Monthly Budget
    local glob_month_budget = tonumber(redis.call('GET', KEYS[7]) or '0')
    if glob_month_budget + tonumber(ARGV[9]) > tonumber(ARGV[8]) then return "global_monthly_budget" end

    -- All checks passed! Apply reservations.
    redis.call('INCR', KEYS[1])
    if ip_count == 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end

    redis.call('INCR', KEYS[2])
    redis.call('EXPIRE', KEYS[2], 180) -- 3 min safety TTL for concurrent lock

    redis.call('INCR', KEYS[3])
    redis.call('EXPIRE', KEYS[3], 86400 * 2)

    redis.call('INCRBY', KEYS[4], ARGV[9])
    redis.call('EXPIRE', KEYS[4], 86400 * 2)

    redis.call('INCR', KEYS[5])
    redis.call('EXPIRE', KEYS[5], 86400 * 2)

    redis.call('INCRBY', KEYS[6], ARGV[9])
    redis.call('EXPIRE', KEYS[6], 86400 * 2)

    redis.call('INCRBY', KEYS[7], ARGV[9])
    redis.call('EXPIRE', KEYS[7], 86400 * 32)
    
    -- Store reservation details so we can reconcile later
    redis.call('SET', KEYS[8], ARGV[9], 'EX', 180)

    return tostring(vis_count + 1)
  `;

  try {
    const result = await redis.eval(script, keys, args) as string;
    
    if (["ip_limit", "visitor_concurrent", "visitor_generations", "visitor_budget", "global_requests", "global_daily_budget", "global_monthly_budget"].includes(result)) {
      return {
        allowed: false,
        reason: result as any,
        retryAfterSeconds: result === "ip_limit" ? FALLO_AI_IP_WINDOW_SECONDS : undefined,
      };
    }

    const currentVisitorCount = parseInt(result);
    return {
      allowed: true,
      reservationId,
      remainingGenerations: Math.max(0, FALLO_AI_DAILY_GENERATIONS_PER_VISITOR - currentVisitorCount)
    };
  } catch (err) {
    console.error("Redis reservation failed:", err);
    return { allowed: false, reason: "redis_unavailable" };
  }
}

export async function reconcileUsage(visitorId: string, reservationId: string, actualInputTokens: number, actualOutputTokens: number, model: string = "gemini-3.8-flash", success: boolean): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const dayStr = getUtcDayString();
  const monthStr = getUtcMonthString();
  
  const pricing = GEMINI_MODEL_PRICING[model] || GEMINI_MODEL_PRICING["gemini-3.8-flash"];
  const actualCostUsd = (actualInputTokens * pricing.inputPer1M + actualOutputTokens * pricing.outputPer1M) / 1000000;
  const actualCostMicros = Math.ceil(actualCostUsd * 1000000);

  const keys = [
    `fallo:visitor:${visitorId}:concurrent`,           // 1
    `fallo:visitor:${visitorId}:day:${dayStr}:count`,  // 2
    `fallo:visitor:${visitorId}:day:${dayStr}:budget`, // 3
    `fallo:global:day:${dayStr}:count`,                // 4
    `fallo:global:day:${dayStr}:budget`,               // 5
    `fallo:global:month:${monthStr}:budget`,           // 6
    `fallo:reservation:${reservationId}`               // 7
  ];

  const args = [
    actualCostMicros,
    success ? "1" : "0"
  ];

  const script = `
    -- Decrease concurrent count safely
    local vis_conc = tonumber(redis.call('GET', KEYS[1]) or '0')
    if vis_conc > 0 then
      redis.call('DECR', KEYS[1])
    end

    local reserved_micros = tonumber(redis.call('GET', KEYS[7]) or '0')
    local actual_micros = tonumber(ARGV[1])
    local success = ARGV[2] == "1"

    -- If the request failed completely (e.g. timeout before hitting Gemini, or validation error),
    -- we might want to refund the count and the budget. 
    -- But to prevent abuse, we still charge for failures that consumed tokens.
    -- Assuming success=false means 0 tokens actually used if not reported.
    
    local diff = actual_micros - reserved_micros
    
    if not success then
      -- If failed, we refund the count and budget.
      local vis_count = tonumber(redis.call('GET', KEYS[2]) or '0')
      if vis_count > 0 then redis.call('DECR', KEYS[2]) end
      
      local glob_count = tonumber(redis.call('GET', KEYS[4]) or '0')
      if glob_count > 0 then redis.call('DECR', KEYS[4]) end
      
      -- refund reserved budget
      diff = -reserved_micros
    end

    if diff ~= 0 then
      redis.call('INCRBY', KEYS[3], diff)
      redis.call('INCRBY', KEYS[5], diff)
      redis.call('INCRBY', KEYS[6], diff)
    end
    
    redis.call('DEL', KEYS[7])
  `;

  try {
    await redis.eval(script, keys, args);
    // Optionally log the usage to a ledger stream or list
    if (success) {
       const record = {
         timestamp: new Date().toISOString(),
         visitorId,
         model,
         inputTokens: actualInputTokens,
         outputTokens: actualOutputTokens,
         estimatedCostUsd: actualCostUsd,
         reservationId
       };
       await redis.lpush(`fallo:usage_ledger`, JSON.stringify(record));
    }
  } catch (err) {
    console.error("Redis reconciliation failed:", err);
  }
}

export async function getRemainingGenerations(visitorId: string): Promise<number | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const dayStr = getUtcDayString();
  try {
    const count = parseInt(await redis.get(`fallo:visitor:${visitorId}:day:${dayStr}:count`) || "0");
    return Math.max(0, FALLO_AI_DAILY_GENERATIONS_PER_VISITOR - count);
  } catch {
    return null;
  }
}
