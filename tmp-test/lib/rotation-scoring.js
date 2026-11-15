"use strict";
/**
 * Pure, testable rotation scoring engine for fallo.
 *
 * Design principles:
 * - No side effects; all functions are pure.
 * - Missing data = explicit nulls, never treated as zero silently.
 * - All scores are heuristics (0–100) with transparent rubrics and citations.
 * - Confidence levels reflect data coverage.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cropLibrary = exports.strategies = exports.FACTOR_LABELS = exports.DEFAULT_PRIORITIES = void 0;
exports.scoreStrategy = scoreStrategy;
exports.scoreAllStrategies = scoreAllStrategies;
exports.normalizePriorities = normalizePriorities;
const crops_json_1 = __importDefault(require("@/data/crops.json"));
const rotations_json_1 = __importDefault(require("@/data/rotations.json"));
exports.DEFAULT_PRIORITIES = {
    waterSuitability: 20,
    nitrogenContribution: 20,
    soilCoverage: 20,
    diversityPestBreak: 20,
    climateRiskResilience: 20,
};
exports.FACTOR_LABELS = {
    waterSuitability: "Water Suitability",
    nitrogenContribution: "Nitrogen Contribution",
    soilCoverage: "Soil Coverage",
    diversityPestBreak: "Diversity / Pest Break",
    climateRiskResilience: "Climate Risk Resilience",
};
// ─── Data accessors ───────────────────────────────────────────────────
const cropLibrary = Object.fromEntries(crops_json_1.default.crops.map((c) => [c.id, c]));
exports.cropLibrary = cropLibrary;
const strategies = rotations_json_1.default.strategies;
exports.strategies = strategies;
function getCrop(id) {
    return cropLibrary[id];
}
// ─── Utility ──────────────────────────────────────────────────────────
function clamp(n, min = 0, max = 100) {
    return Math.max(min, Math.min(max, n));
}
function avg(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function uniqueFamilies(cropIds) {
    return Array.from(new Set(cropIds
        .map((id) => getCrop(id)?.family)
        .filter((f) => typeof f === "string")));
}
// ─── Field condition helpers ──────────────────────────────────────────
function gsPrecipMm(climate) {
    return climate.stressMetrics.growingSeasonPrecip.avgTotalMm;
}
function avgMaxDryDays(climate) {
    return climate.stressMetrics.summerDrySpells.avgMaxConsecutiveDryDays;
}
function avgHeatDays(climate) {
    return climate.stressMetrics.summerHeatDays.avgDaysAboveThreshold;
}
function awcValue(soil) {
    return soil?.aggregated.depth0_30cm.awc ?? null;
}
function slopeValue(soil) {
    return soil?.aggregated.slope ?? null;
}
function soilConfidence(soil) {
    if (!soil)
        return { hasData: false, coveragePercent: null };
    const awcCov = soil.dataCoverage.depth0_30cm.awc;
    const slopeCov = soil.dataCoverage.slope;
    const total = soil.totalComponentPercent;
    const coverage = awcCov !== null ? awcCov : slopeCov;
    return { hasData: true, coveragePercent: coverage };
}
// ─── 1. Water Suitability ─────────────────────────────────────────────
function scoreWaterSuitability(strategy, climate, soil) {
    const gsPrecip = gsPrecipMm(climate);
    const dryDays = avgMaxDryDays(climate);
    const heatDays = avgHeatDays(climate);
    const awc = awcValue(soil);
    const { hasData: hasSoil, coveragePercent: soilCov } = soilConfidence(soil);
    const cashCrops = strategy.years
        .flatMap((y) => y.seasons)
        .filter((s) => s.crop !== "winter_fallow")
        .map((s) => getCrop(s.crop))
        .filter((c) => !!c && c.type === "cash");
    if (cashCrops.length === 0) {
        return {
            score: null,
            interpretation: "No cash crops found in this rotation.",
            inputsUsed: [],
            rubric: "Requires at least one defined cash crop for water-demand comparison.",
            positiveContributors: [],
            negativeContributors: [],
            dataCoverageLimitations: ["Rotation contains no recognized cash crops."],
            confidence: "Limited",
            citations: [],
        };
    }
    const inputsUsed = [];
    const positive = [];
    const negative = [];
    const limitations = [];
    const citations = ["NASA POWER Daily API — regional climate context"];
    if (gsPrecip !== null)
        inputsUsed.push(`Growing-season (May–Aug) precipitation: ${gsPrecip.toFixed(0)} mm`);
    else
        limitations.push("Growing-season precipitation data unavailable.");
    if (dryDays !== null)
        inputsUsed.push(`Avg max consecutive dry days (Jun–Aug, <1 mm): ${dryDays.toFixed(1)} days`);
    else
        limitations.push("Dry-spell data unavailable.");
    if (heatDays !== null)
        inputsUsed.push(`Avg heat-stress days (Jul–Aug, max temp >35 °C): ${heatDays.toFixed(1)} days`);
    else
        limitations.push("Heat-stress day count unavailable.");
    if (hasSoil) {
        if (awc !== null)
            inputsUsed.push(`Available water capacity (0–30 cm): ${awc.toFixed(3)} cm/cm`);
        else
            limitations.push("AWC data unavailable (0–30 cm only).");
        if (soilCov !== null && soilCov < 80)
            limitations.push(`Soil data coverage is ${soilCov.toFixed(0)}%; properties may not represent the full field.`);
        citations.push("USDA NRCS SSURGO — depth-weighted 0–30 cm averages");
    }
    else {
        limitations.push("No soil data available; AWC and slope not included in scoring.");
    }
    // Compute per-crop scores
    const cropScores = [];
    for (const crop of cashCrops) {
        let s = 55;
        // Field water availability
        if (gsPrecip !== null) {
            if (gsPrecip > 550)
                s += 15;
            else if (gsPrecip > 450)
                s += 10;
            else if (gsPrecip > 350)
                s += 5;
            else if (gsPrecip > 250)
                s -= 5;
            else
                s -= 15;
        }
        // Dry spell penalty
        if (dryDays !== null) {
            if (dryDays > 18)
                s -= 15;
            else if (dryDays > 12)
                s -= 10;
            else if (dryDays > 8)
                s -= 5;
            else
                s += 5;
        }
        // Heat stress during sensitive periods
        if (heatDays !== null && crop.sensitivePeriods) {
            const hasSummerSensitivity = Object.values(crop.sensitivePeriods).some((sp) => sp.months.some((m) => m >= 6 && m <= 8));
            if (hasSummerSensitivity) {
                if (heatDays > 12)
                    s -= 15;
                else if (heatDays > 7)
                    s -= 10;
                else if (heatDays > 3)
                    s -= 5;
                else
                    s += 5;
            }
        }
        // Crop drought tolerance
        if (crop.droughtTolerance === "high") {
            if (dryDays !== null && dryDays > 12)
                s += 10;
            else
                s += 5;
        }
        else if (crop.droughtTolerance === "moderate") {
            if (dryDays !== null && dryDays > 12)
                s -= 5;
        }
        else if (crop.droughtTolerance === "low") {
            if (dryDays !== null && dryDays > 8)
                s -= 5;
        }
        // Water demand
        if (crop.waterDemand === "high") {
            if (gsPrecip !== null && gsPrecip < 400)
                s -= 10;
        }
        else if (crop.waterDemand === "low" || crop.waterDemand === "low_to_moderate") {
            if (gsPrecip !== null && gsPrecip < 400)
                s += 5;
        }
        // AWC modifier
        if (awc !== null) {
            if (awc > 0.16)
                s += 8;
            else if (awc > 0.12)
                s += 4;
            else if (awc > 0.08)
                s += 0;
            else
                s -= 6;
        }
        cropScores.push(clamp(s));
    }
    const finalScore = Math.round(avg(cropScores));
    // Build contributors
    if (gsPrecip !== null && gsPrecip > 450)
        positive.push("Growing-season precipitation is relatively abundant.");
    if (gsPrecip !== null && gsPrecip < 350)
        negative.push("Growing-season precipitation is limited.");
    if (dryDays !== null && dryDays > 12)
        negative.push("Extended dry spells occur during the summer growing season.");
    if (dryDays !== null && dryDays <= 8)
        positive.push("Dry spells are typically short in this region.");
    if (heatDays !== null && heatDays > 7)
        negative.push("Frequent heat-stress days during summer sensitive periods.");
    if (heatDays !== null && heatDays <= 3)
        positive.push("Low frequency of extreme heat days.");
    if (awc !== null && awc > 0.14)
        positive.push("Soil available water capacity supports summer crops.");
    if (awc !== null && awc < 0.10)
        negative.push("Low soil available water capacity intensifies drought risk.");
    cashCrops.forEach((c) => {
        if (c.droughtTolerance === "high")
            positive.push(`${c.commonName} has high drought tolerance.`);
        if (c.waterDemand === "high")
            negative.push(`${c.commonName} has high water demand during peak summer.`);
    });
    const conf = limitations.length === 0 ? "High" : limitations.length <= 2 ? "Moderate" : "Limited";
    return {
        score: finalScore,
        interpretation: conf === "Limited"
            ? `Water suitability estimated at ${finalScore}/100 with limited data. See coverage notes.`
            : `This rotation scores ${finalScore}/100 for water suitability based on growing-season precipitation${dryDays !== null ? `, dry-spell frequency` : ""}${heatDays !== null ? `, and heat-stress exposure` : ""}.`,
        inputsUsed,
        rubric: "Each cash crop is scored against growing-season precipitation, average maximum consecutive dry days, heat-stress day frequency, soil AWC, crop water demand, and crop drought tolerance. The rotation score is the average across cash crops. Scores are heuristics, not calibrated water-balance models.",
        positiveContributors: positive,
        negativeContributors: negative,
        dataCoverageLimitations: limitations,
        confidence: conf,
        citations,
    };
}
// ─── 2. Nitrogen Contribution ─────────────────────────────────────────
function scoreNitrogen(strategy, _climate, soil) {
    const { hasData: hasSoil } = soilConfidence(soil);
    const allSeasons = strategy.years.flatMap((y) => y.seasons);
    const crops = allSeasons.map((s) => getCrop(s.crop)).filter((c) => !!c);
    const inputsUsed = [];
    const positive = [];
    const negative = [];
    const limitations = [];
    const citations = [];
    let score = 50;
    // Legume N credits (cover crops and cash)
    let legumeCount = 0;
    for (const crop of crops) {
        if (crop.family === "Fabaceae") {
            legumeCount++;
            const credit = crop.nitrogenBehavior.residualNcredit;
            if (credit) {
                inputsUsed.push(`${crop.commonName}: estimated ${credit.value}`);
                citations.push(`${credit.source}: ${credit.value}`);
                if (crop.id === "crimson_clover") {
                    score += 12;
                    positive.push(`Crimson clover can contribute ~60–75 lb N/acre (contextual estimate) to the following crop.`);
                }
                else if (crop.id === "hairy_vetch") {
                    score += 15;
                    positive.push(`Hairy vetch can contribute ~80–100 lb N/acre (contextual estimate) to the following crop.`);
                }
                else if (crop.id === "soybean") {
                    score += 5;
                    positive.push(`Soybean leaves a modest residual N credit (~15–30 lb N/acre, contextual estimate) but most fixed N is removed with grain.`);
                }
                else {
                    score += 6;
                    positive.push(`${crop.commonName} contributes nitrogen via biological fixation.`);
                }
            }
        }
    }
    if (legumeCount === 0) {
        negative.push("No legume crops or cover crops in this rotation to contribute nitrogen.");
    }
    // High N demand penalties
    for (const crop of crops) {
        if (crop.type === "cash" && crop.nitrogenBehavior.demand === "high") {
            score -= 10;
            negative.push(`${crop.commonName} has high nitrogen demand, requiring external N inputs.`);
        }
        else if (crop.type === "cash" && crop.nitrogenBehavior.demand === "moderate") {
            score -= 5;
            negative.push(`${crop.commonName} has moderate nitrogen demand.`);
        }
    }
    // Cereal rye immobilization risk
    const hasRye = crops.some((c) => c.id === "cereal_rye");
    if (hasRye) {
        const ryeCrop = getCrop("cereal_rye");
        if (ryeCrop?.nitrogenBehavior.immobilizationRisk) {
            score -= 8;
            negative.push("Cereal rye can temporarily immobilize available nitrogen if terminated late (high C:N ratio).");
            citations.push("NC State Extension Organic Grains — Cover Crops");
        }
    }
    // Residue persistence (organic matter return)
    const highResidueCrops = crops.filter((c) => c.residue.quantity === "high" && c.residue.persistence === "high");
    if (highResidueCrops.length >= 2) {
        score += 6;
        positive.push("High levels of persistent residue help maintain soil organic matter and nutrient pools.");
    }
    if (!hasSoil) {
        limitations.push("No soil organic matter data available for N-mineralization context.");
    }
    score = clamp(score);
    const conf = limitations.length > 1 ? "Moderate" : "High";
    return {
        score,
        interpretation: conf === "Moderate"
            ? `Nitrogen balance estimated at ${score}/100. Legume contributions and N demands are scored directionally.`
            : `Nitrogen contribution score: ${score}/100. Accounts for legume credits, crop N demands, and immobilization risks.`,
        inputsUsed,
        rubric: "Legume cover crops add directional N credit based on published estimates (crimson clover ~60–75 lb N/acre, hairy vetch ~80–100 lb N/acre, soybean ~15–30 lb N/acre). High-N-demand cash crops subtract points. Cereal rye late-termination immobilization risk subtracts points. Persistent residue adds modest points. Scores are planning heuristics, not guaranteed fertilizer savings.",
        positiveContributors: positive,
        negativeContributors: negative,
        dataCoverageLimitations: limitations,
        confidence: conf,
        citations: citations.length > 0 ? citations : ["NC State Extension Cover Crop and Soybean Production Guides"],
    };
}
// ─── 3. Soil Coverage ─────────────────────────────────────────────────
function scoreSoilCoverage(strategy, _climate, soil) {
    const allSeasons = strategy.years.flatMap((y) => y.seasons);
    const crops = allSeasons.map((s) => getCrop(s.crop)).filter((c) => !!c);
    const inputsUsed = [];
    const positive = [];
    const negative = [];
    const limitations = [];
    let livingCoverMonths = 0;
    const coveredMonths = new Set();
    for (const season of allSeasons) {
        for (const m of season.months) {
            const monthIndex = (m - 1) % 12;
            if (!coveredMonths.has(monthIndex)) {
                coveredMonths.add(monthIndex);
                if (season.crop !== "winter_fallow")
                    livingCoverMonths++;
            }
        }
    }
    // Count unique months covered (approximate, could overlap across years)
    // Better: count total month slots across the 3-year period
    const totalSlots = 36; // 3 years × 12 months
    const activeSlots = allSeasons.reduce((sum, s) => sum + s.months.length, 0);
    // Adjust for overlaps within same month across years
    const monthYearSlots = new Set(allSeasons.flatMap((s) => s.months.map((m) => `${s.season}-${m}`))).size;
    let score = 40;
    // Living cover percentage
    const coverRatio = Math.min(activeSlots / totalSlots, 1);
    if (coverRatio > 0.85)
        score += 20;
    else if (coverRatio > 0.7)
        score += 15;
    else if (coverRatio > 0.55)
        score += 10;
    else if (coverRatio > 0.4)
        score += 5;
    else
        score -= 5;
    inputsUsed.push(`Approximate living cover ratio: ${Math.round(coverRatio * 100)}% of the 3-year period`);
    // Residue persistence
    const highPersistCrops = crops.filter((c) => c.residue.persistence === "high");
    if (highPersistCrops.length >= 2) {
        score += 10;
        positive.push("Multiple crops with high-persistence residue maintain soil coverage between growing seasons.");
    }
    else if (highPersistCrops.length === 1) {
        score += 5;
        positive.push("One high-persistence residue crop (e.g., cereal rye) helps maintain surface cover.");
    }
    const lowResidueCrops = crops.filter((c) => c.residue.quantity === "low" && c.type === "cash");
    if (lowResidueCrops.length >= 2) {
        score -= 8;
        negative.push("Multiple low-residue cash crops leave the soil surface more exposed post-harvest.");
    }
    // Slope/erosion consideration
    const slope = slopeValue(soil);
    if (slope !== null) {
        inputsUsed.push(`Slope: ${slope.toFixed(1)}%`);
        if (slope > 8) {
            // High slope makes soil coverage more important
            if (coverRatio < 0.6) {
                score -= 10;
                negative.push(`Slope is ${slope.toFixed(0)}% — limited living cover increases erosion risk.`);
            }
            else {
                score += 5;
                positive.push(`Good soil coverage despite ${slope.toFixed(0)}% slope reduces erosion potential.`);
            }
        }
    }
    else {
        limitations.push("Slope data unavailable; erosion risk not included in coverage scoring.");
    }
    // Winter coverage gaps
    const winterMonths = [12, 1, 2];
    const hasWinterCover = allSeasons.some((s) => s.crop !== "winter_fallow" && s.months.some((m) => winterMonths.includes(m)));
    if (!hasWinterCover) {
        score -= 8;
        negative.push("No living winter cover; winter fallow period exposes soil to erosion and compaction.");
    }
    else {
        score += 5;
        positive.push("Living winter cover protects soil during vulnerable winter/spring transition.");
    }
    score = clamp(score);
    const conf = slope === null ? "Moderate" : "High";
    return {
        score,
        interpretation: `Soil coverage score: ${score}/100 based on months of living cover, residue persistence, and slope considerations.`,
        inputsUsed,
        rubric: "Soil coverage is scored from the proportion of the 3-year rotation with living plants or persistent residue, winter-cover presence, residue persistence categories, and slope (if available). Higher scores mean more months with physical soil protection.",
        positiveContributors: positive,
        negativeContributors: negative,
        dataCoverageLimitations: limitations,
        confidence: conf,
        citations: ["USDA NRCS Cover Crop and Soil Health guidance"],
    };
}
// ─── 4. Diversity / Pest Break ────────────────────────────────────────
function scoreDiversityPestBreak(strategy) {
    const allSeasons = strategy.years.flatMap((y) => y.seasons);
    const cropIds = allSeasons.map((s) => s.crop).filter((id) => id !== "winter_fallow");
    const crops = cropIds.map((id) => getCrop(id)).filter((c) => !!c);
    const inputsUsed = [];
    const positive = [];
    const negative = [];
    const limitations = [];
    if (crops.length === 0) {
        return {
            score: null,
            interpretation: "No recognized crops in rotation.",
            inputsUsed: [],
            rubric: "Requires defined crops to evaluate diversity.",
            positiveContributors: [],
            negativeContributors: [],
            dataCoverageLimitations: ["Rotation contains no recognized crops."],
            confidence: "Limited",
            citations: [],
        };
    }
    const families = uniqueFamilies(cropIds);
    inputsUsed.push(`Botanical families present: ${families.join(", ")}`);
    inputsUsed.push(`Cash and cover crops: ${crops.map((c) => c.commonName).join(", ")}`);
    let score = 40;
    // Family diversity
    if (families.length >= 4) {
        score += 20;
        positive.push("High botanical diversity (4+ families) supports broader pest and disease suppression.");
    }
    else if (families.length === 3) {
        score += 15;
        positive.push("Good botanical diversity (3 families).");
    }
    else if (families.length === 2) {
        score += 8;
        positive.push("Moderate diversity (2 families).");
    }
    else {
        score += 0;
        negative.push("Low botanical diversity (1 family) limits pest-break effectiveness.");
    }
    // Specific disease/pest sequence checks
    // Check for soybean followed by soybean or sunflower by soybean (Sclerotinia)
    const sequence = allSeasons.filter((s) => s.crop !== "winter_fallow").map((s) => s.crop);
    // Fusarium head blight: wheat immediately after corn or sorghum
    for (let i = 1; i < sequence.length; i++) {
        const prev = sequence[i - 1];
        const curr = sequence[i];
        if (curr === "soft_red_winter_wheat" && (prev === "field_corn" || prev === "grain_sorghum")) {
            score -= 15;
            negative.push(`Fusarium head blight risk: wheat follows ${getCrop(prev)?.commonName || prev}. Shared Fusarium inoculum in residue is a documented concern.`);
        }
    }
    // Sclerotinia: sunflower and soybean proximity
    const sclerotiniaHosts = ["soybean", "sunflower"];
    const hostIndices = sequence
        .map((id, idx) => (sclerotiniaHosts.includes(id) ? idx : -1))
        .filter((i) => i >= 0);
    if (hostIndices.length >= 2) {
        const minGap = hostIndices.reduce((min, curr, i) => {
            if (i === 0)
                return Infinity;
            return Math.min(min, curr - hostIndices[i - 1]);
        }, Infinity);
        if (minGap <= 3) {
            score -= 12;
            negative.push("Sclerotinia consideration: sunflower and soybean are both potential hosts. Short rotation intervals may not provide an adequate disease break.");
            limitations.push("Sclerotinia host-interval recommendations vary by region and field history.");
        }
    }
    // Soybean cyst nematode: repeated soybean without adequate break
    const soybeanCount = sequence.filter((id) => id === "soybean").length;
    if (soybeanCount >= 2) {
        const nonHostBreak = sequence.some((id) => id !== "soybean" && getCrop(id)?.family !== "Fabaceae");
        if (!nonHostBreak) {
            score -= 10;
            negative.push("Repeated soybean without a non-host break increases soybean cyst nematode risk.");
        }
        else {
            score -= 3;
            negative.push("Multiple soybean appearances in the sequence; SCN populations can build with frequent soybean.");
        }
    }
    // Cover crops as pest breaks
    const coverCrops = crops.filter((c) => c.type === "cover");
    if (coverCrops.length >= 2) {
        score += 8;
        positive.push("Multiple cover crops provide breaks from cash-crop pest and disease cycles.");
    }
    score = clamp(score);
    return {
        score,
        interpretation: `Diversity / pest-break score: ${score}/100. Evaluates botanical family diversity and known crop-sequence disease risks.`,
        inputsUsed,
        rubric: "Family diversity is rewarded (more families = better pest/disease breaks). Specific sequence penalties are applied for: wheat immediately after corn/sorghum (Fusarium head blight), sunflower close to soybean (Sclerotinia), and repeated soybean (SCN). Cover crops add modest bonuses as break crops. Scores are heuristics based on documented host relationships.",
        positiveContributors: positive,
        negativeContributors: negative,
        dataCoverageLimitations: limitations,
        confidence: "Moderate",
        citations: [
            "NC State Extension Small Grain Production Guide — Fusarium head blight",
            "NC State Extension Soybean Disease and Nematode Management",
            "NC State Extension Plant Pathology — Sclerotinia",
        ],
    };
}
// ─── 5. Climate Risk Resilience ───────────────────────────────────────
function scoreClimateRiskResilience(strategy, climate, soil) {
    const dryDays = avgMaxDryDays(climate);
    const heatDays = avgHeatDays(climate);
    const gsPrecip = gsPrecipMm(climate);
    const awc = awcValue(soil);
    const cashCrops = strategy.years
        .flatMap((y) => y.seasons)
        .filter((s) => s.crop !== "winter_fallow")
        .map((s) => getCrop(s.crop))
        .filter((c) => !!c && c.type === "cash");
    const inputsUsed = [];
    const positive = [];
    const negative = [];
    const limitations = [];
    if (dryDays !== null)
        inputsUsed.push(`Avg max consecutive dry days (Jun–Aug): ${dryDays.toFixed(1)} days`);
    else
        limitations.push("Dry-spell data unavailable.");
    if (heatDays !== null)
        inputsUsed.push(`Avg heat-stress days (Jul–Aug, >35 °C): ${heatDays.toFixed(1)} days`);
    else
        limitations.push("Heat-stress day count unavailable.");
    if (gsPrecip !== null)
        inputsUsed.push(`Growing-season precipitation (May–Aug): ${gsPrecip.toFixed(0)} mm`);
    else
        limitations.push("Growing-season precipitation data unavailable.");
    if (cashCrops.length === 0) {
        return {
            score: null,
            interpretation: "No cash crops found for climate resilience evaluation.",
            inputsUsed: [],
            rubric: "Requires cash crops with defined sensitive periods.",
            positiveContributors: [],
            negativeContributors: [],
            dataCoverageLimitations: ["Rotation contains no recognized cash crops."],
            confidence: "Limited",
            citations: [],
        };
    }
    let score = 55;
    for (const crop of cashCrops) {
        // Drought resilience
        if (crop.droughtTolerance === "high") {
            if (dryDays !== null && dryDays > 10) {
                score += 8;
                positive.push(`${crop.commonName} has high drought tolerance, an advantage in a region with summer dry spells.`);
            }
        }
        else if (crop.droughtTolerance === "low") {
            if (dryDays !== null && dryDays > 10) {
                score -= 8;
                negative.push(`${crop.commonName} has low drought tolerance and is vulnerable to summer dry spells.`);
            }
        }
        // Heat sensitivity during reproductive periods
        if (crop.sensitivePeriods) {
            for (const [period, info] of Object.entries(crop.sensitivePeriods)) {
                const isSummerSensitive = info.months.some((m) => m >= 6 && m <= 8);
                if (isSummerSensitive && heatDays !== null) {
                    if (heatDays > 10) {
                        score -= 8;
                        negative.push(`${crop.commonName} is sensitive to heat during ${period} (${info.months
                            .map((m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1])
                            .join("/")}), and this region averages ${heatDays.toFixed(0)} heat-stress days.`);
                    }
                    else if (heatDays < 3) {
                        score += 5;
                        positive.push(`${crop.commonName}'s ${period} period benefits from low heat-stress frequency.`);
                    }
                }
            }
        }
        // Water demand vs supply
        if (crop.waterDemand === "high" && gsPrecip !== null) {
            if (gsPrecip < 400) {
                score -= 6;
                negative.push(`${crop.commonName} demands abundant water, but growing-season precipitation is limited.`);
            }
        }
        // Deep root advantage
        if (crop.rootSystem.includes("deep taproot") && awc !== null && awc < 0.12) {
            score += 5;
            positive.push(`${crop.commonName}'s deep taproot can access water below the shallow profile.`);
        }
    }
    // Overall field resilience context
    if (gsPrecip !== null && gsPrecip > 500 && dryDays !== null && dryDays < 8) {
        score += 5;
        positive.push("This location has a relatively favorable water balance for summer cropping.");
    }
    if (heatDays !== null && heatDays > 15) {
        score -= 10;
        negative.push("Frequent extreme heat days (>15 per year) during July–August increase climate risk for heat-sensitive crops.");
    }
    score = clamp(score);
    const conf = limitations.length === 0 ? "High" : limitations.length <= 1 ? "Moderate" : "Limited";
    return {
        score,
        interpretation: conf === "Limited"
            ? `Climate risk resilience estimated at ${score}/100 with incomplete data.`
            : `Climate risk resilience: ${score}/100. Accounts for historical dry spells, heat-stress days, and crop tolerance traits.`,
        inputsUsed,
        rubric: "Each cash crop is evaluated against historical summer dry-spell frequency, heat-stress day counts during sensitive reproductive windows, growing-season precipitation, and crop-specific drought/heat tolerance. Deep-rooted crops receive modest bonuses in low-AWC soils. Scores describe historical exposure, not future weather forecasts.",
        positiveContributors: positive,
        negativeContributors: negative,
        dataCoverageLimitations: limitations,
        confidence: conf,
        citations: ["NASA POWER Daily API — historical daily records", "NC State Extension crop production guides"],
    };
}
// ─── Composite scoring ────────────────────────────────────────────────
function scoreStrategy(strategy, climate, soil, priorities) {
    const water = scoreWaterSuitability(strategy, climate, soil);
    const nitrogen = scoreNitrogen(strategy, climate, soil);
    const coverage = scoreSoilCoverage(strategy, climate, soil);
    const diversity = scoreDiversityPestBreak(strategy);
    const risk = scoreClimateRiskResilience(strategy, climate, soil);
    const factorScores = {
        waterSuitability: water,
        nitrogenContribution: nitrogen,
        soilCoverage: coverage,
        diversityPestBreak: diversity,
        climateRiskResilience: risk,
    };
    // Normalize weights and compute composite
    const totalWeight = Object.values(priorities).reduce((a, b) => a + b, 0);
    const keys = [
        "waterSuitability",
        "nitrogenContribution",
        "soilCoverage",
        "diversityPestBreak",
        "climateRiskResilience",
    ];
    let weightedSum = 0;
    let usedWeight = 0;
    let missingScoreCount = 0;
    for (const key of keys) {
        const score = factorScores[key].score;
        const weight = priorities[key];
        if (score !== null && totalWeight > 0) {
            const normalizedWeight = weight / totalWeight;
            weightedSum += score * normalizedWeight;
            usedWeight += normalizedWeight;
        }
        if (score === null)
            missingScoreCount++;
    }
    const overallScore = usedWeight > 0 ? Math.round(weightedSum / usedWeight) : null;
    const availableWeightPercent = usedWeight > 0 ? Math.round(usedWeight * 100) : 0;
    const confidenceLevels = [water.confidence, nitrogen.confidence, coverage.confidence, diversity.confidence, risk.confidence];
    const limitedCount = confidenceLevels.filter((c) => c === "Limited").length;
    const overallConfidence = limitedCount >= 2 || missingScoreCount >= 2 ? "Limited" : limitedCount >= 1 ? "Moderate" : "High";
    return {
        strategy,
        factorScores,
        overallScore,
        overallConfidence,
        rank: 0, // filled by caller after sorting
        availableWeightPercent,
    };
}
function scoreAllStrategies(climate, soil, priorities) {
    const results = strategies.map((s) => scoreStrategy(s, climate, soil, priorities));
    // Sort by overall score descending
    const sorted = [...results].sort((a, b) => {
        if (a.overallScore === null && b.overallScore === null)
            return 0;
        if (a.overallScore === null)
            return 1;
        if (b.overallScore === null)
            return -1;
        return b.overallScore - a.overallScore;
    });
    // Assign ranks
    sorted.forEach((r, i) => {
        r.rank = i + 1;
    });
    return sorted;
}
function normalizePriorities(p) {
    const total = Object.values(p).reduce((a, b) => a + b, 0);
    if (total <= 0)
        return { ...exports.DEFAULT_PRIORITIES };
    const keys = Object.keys(p);
    const normalized = {};
    for (const key of keys) {
        normalized[key] = Math.round((p[key] / total) * 100);
    }
    return normalized;
}
