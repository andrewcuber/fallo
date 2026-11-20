import { strict as assert } from "assert";
import { reserveUsage, reconcileUsage, getRemainingGenerations } from "./lib/redis-usage";
import * as redisUsage from "./lib/redis-usage";

const store = new Map<string, string>();

const mockRedis = {
    eval: async (script: string, keys: string[], args: any[]) => {
        if (script.includes("Check IP limit")) {
            const ip_count = parseInt(store.get(keys[0]) || '0');
            if (ip_count >= parseInt(args[1])) return "ip_limit";

            const vis_conc = parseInt(store.get(keys[1]) || '0');
            if (vis_conc >= parseInt(args[2])) return "visitor_concurrent";

            const vis_count = parseInt(store.get(keys[2]) || '0');
            if (vis_count >= parseInt(args[3])) return "visitor_generations";

            const vis_budget = parseInt(store.get(keys[3]) || '0');
            if (vis_budget + parseInt(args[8]) > parseInt(args[4])) return "visitor_budget";

            const glob_count = parseInt(store.get(keys[4]) || '0');
            if (glob_count >= parseInt(args[5])) return "global_requests";

            const glob_day_budget = parseInt(store.get(keys[5]) || '0');
            if (glob_day_budget + parseInt(args[8]) > parseInt(args[6])) return "global_daily_budget";

            const glob_month_budget = parseInt(store.get(keys[6]) || '0');
            if (glob_month_budget + parseInt(args[8]) > parseInt(args[7])) return "global_monthly_budget";

            store.set(keys[0], (ip_count + 1).toString());
            store.set(keys[1], (vis_conc + 1).toString());
            store.set(keys[2], (vis_count + 1).toString());
            store.set(keys[3], (vis_budget + parseInt(args[8])).toString());
            store.set(keys[4], (glob_count + 1).toString());
            store.set(keys[5], (glob_day_budget + parseInt(args[8])).toString());
            store.set(keys[6], (glob_month_budget + parseInt(args[8])).toString());
            store.set(keys[7], args[8].toString());

            return (vis_count + 1).toString();
        } else {
            const vis_conc = parseInt(store.get(keys[0]) || '0');
            if (vis_conc > 0) store.set(keys[0], (vis_conc - 1).toString());

            const reserved_micros = parseInt(store.get(keys[6]) || '0');
            const actual_micros = parseInt(args[0]);
            const success = args[1] === "1";

            let diff = actual_micros - reserved_micros;

            if (!success) {
                const vis_count = parseInt(store.get(keys[1]) || '0');
                if (vis_count > 0) store.set(keys[1], (vis_count - 1).toString());

                const glob_count = parseInt(store.get(keys[3]) || '0');
                if (glob_count > 0) store.set(keys[3], (glob_count - 1).toString());

                diff = -reserved_micros;
            }

            if (diff !== 0) {
                store.set(keys[2], (parseInt(store.get(keys[2]) || '0') + diff).toString());
                store.set(keys[4], (parseInt(store.get(keys[4]) || '0') + diff).toString());
                store.set(keys[5], (parseInt(store.get(keys[5]) || '0') + diff).toString());
            }

            store.delete(keys[6]);
            return "OK";
        }
    },
    get: async (key: string) => store.get(key) || null,
    lpush: async () => 1
};

redisUsage.setMockRedis(mockRedis);

async function runTests() {
    console.log("Running Redis Usage Limits Tests...");
    store.clear();

    const visitorId = "visitor-1";
    const ip = "127.0.0.1";

    let res = await reserveUsage(visitorId, ip);
    assert.equal(res.allowed, true);
    assert.equal(res.remainingGenerations, 2);
    
    let concurrentRes = await reserveUsage(visitorId, ip);
    assert.equal(concurrentRes.allowed, false);
    assert.equal(concurrentRes.reason, "visitor_concurrent");

    await reconcileUsage(visitorId, res.reservationId!, 100, 100, "gemini-3.8-flash", true);

    res = await reserveUsage(visitorId, ip);
    assert.equal(res.allowed, true);
    assert.equal(res.remainingGenerations, 1);
    await reconcileUsage(visitorId, res.reservationId!, 100, 100, "gemini-3.8-flash", true);

    res = await reserveUsage(visitorId, ip);
    assert.equal(res.allowed, true);
    assert.equal(res.remainingGenerations, 0);
    await reconcileUsage(visitorId, res.reservationId!, 100, 100, "gemini-3.8-flash", true);

    res = await reserveUsage(visitorId, ip);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "visitor_generations");

    store.clear();
    for (let i = 0; i < 5; i++) {
        let r = await reserveUsage(`visitor-ip-${i}`, ip);
        assert.equal(r.allowed, true);
        await reconcileUsage(`visitor-ip-${i}`, r.reservationId!, 10, 10, "gemini-3.8-flash", true);
    }
    res = await reserveUsage("visitor-ip-6", ip);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "ip_limit");

    store.clear();
    for (let i = 0; i < 15; i++) {
        let r = await reserveUsage(`visitor-glob-${i}`, `10.0.0.${i}`);
        assert.equal(r.allowed, true);
        await reconcileUsage(`visitor-glob-${i}`, r.reservationId!, 10, 10, "gemini-3.8-flash", true);
    }
    res = await reserveUsage("visitor-glob-16", "10.0.0.16");
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "global_requests");

    store.clear();
    res = await reserveUsage("visitor-fail", "10.1.1.1");
    assert.equal(res.allowed, true);
    assert.equal(res.remainingGenerations, 2);
    await reconcileUsage("visitor-fail", res.reservationId!, 0, 0, "gemini-3.8-flash", false);
    
    res = await reserveUsage("visitor-fail", "10.1.1.1");
    assert.equal(res.allowed, true);
    assert.equal(res.remainingGenerations, 2); 

    const oldEval = mockRedis.eval;
    mockRedis.eval = async () => { throw new Error("Redis Down"); };
    res = await reserveUsage("visitor-fail", "10.1.1.1");
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "redis_unavailable");

    mockRedis.eval = oldEval;

    console.log("All Redis Usage Limits tests passed!");
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});