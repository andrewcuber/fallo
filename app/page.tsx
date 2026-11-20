"use client";

import Link from "next/link";
import { useField, useFieldEnvironmentalData } from "@/components/providers";
import { computeFieldDataCoverage } from "@/lib/data-coverage";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CloudSun,
  Layers,
  RefreshCw,
  MapPin,
  ChevronRight,
  SlidersHorizontal,
  CalendarDays,
  GitCompare,
} from "lucide-react";

export default function OverviewPage() {
  const { fields, activeField, isLoaded } = useField();
  const { climateRaw, soilRaw } = useFieldEnvironmentalData(activeField?.id ? activeField : null);
  const dataCoverage = computeFieldDataCoverage(climateRaw, soilRaw);

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="space-y-4 relative overflow-hidden rounded-2xl bg-space p-8 sm:p-10 text-offwhite">
        {/* Subtle constellation dots */}
        <div className="absolute inset-0 starfield opacity-60" />
        <div className="relative z-10">
          <h1 className="text-4xl sm:text-5xl font-serif font-bold tracking-tight text-offwhite">
            Understand your land.
            <br />
            <span className="text-electric">Explore its future.</span>
          </h1>
          <p className="max-w-xl text-lg text-offwhite/70 leading-relaxed mt-4">
            fallo helps you explore crop rotation strategies adapted to your local
            climate and soil. Use NASA Earth observations and research-based crop
            data to make informed decisions.
          </p>
          <div className="flex flex-wrap gap-3 pt-4">
            <Link href="/fields/new">
              <Button size="lg" className="bg-electric hover:bg-electric-dark text-white shadow-lg shadow-electric/20">
                <MapPin className="mr-2 h-4 w-4" />
                {isLoaded && fields.length > 0 ? "Add a Field" : "Add Your First Field"}
              </Button>
            </Link>
            {activeField && (
              <Link href={`/field/${activeField.id}/climate`}>
                <Button size="lg" variant="outline" className="border-offwhite/20 text-offwhite hover:bg-offwhite/10 bg-transparent">
                  View Active Field
                  <ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Saved Fields */}
      {!isLoaded && (
        <section className="space-y-4">
          <h2 className="text-2xl font-serif font-bold text-foreground">Your Fields</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse h-full">
                <CardHeader className="pb-3">
                  <div className="h-5 w-32 bg-muted rounded" />
                  <div className="h-3 w-48 bg-muted rounded mt-1" />
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      )}

      {isLoaded && fields.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-serif font-bold text-foreground">Your Fields</h2>
            <Link href="/fields">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                View All
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((field) => (
              <Link key={field.id} href={`/field/${field.id}/climate`}>
                <Card className="hover:border-electric/40 transition-colors cursor-pointer h-full group">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-foreground group-hover:text-electric transition-colors">
                      {field.name}
                    </CardTitle>
                    <CardDescription>
                      {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-1 text-xs font-medium text-electric">
                      <MapPin className="h-3.5 w-3.5" />
                      Open analysis
                      <ChevronRight className="h-3 w-3" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Feature Previews */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-2xl font-serif font-bold text-foreground">What you can do</h2>
          {activeField && (
            <p className="text-xs text-muted-foreground">
              Click any module to open <strong className="text-foreground">{activeField.name}</strong>
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href={activeField ? `/field/${activeField.id}/climate` : "/fields/new"}
            className="block h-full group"
          >
            <Card className="h-full border-l-4 border-l-electric hover:border-electric/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                  <CloudSun className="h-5 w-5 text-electric" />
                </div>
                <CardTitle className="group-hover:text-electric transition-colors">
                  Climate Fingerprint
                </CardTitle>
                <CardDescription>
                  See 20 years of temperature, rainfall, and growing-season trends
                  for your field.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            href={activeField ? `/field/${activeField.id}/soil` : "/fields/new"}
            className="block h-full group"
          >
            <Card className="h-full border-l-4 border-l-cyan hover:border-cyan/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-cyan/10">
                  <Layers className="h-5 w-5 text-cyan" />
                </div>
                <CardTitle className="group-hover:text-cyan transition-colors">
                  Soil Profile
                </CardTitle>
                <CardDescription>
                  Review topsoil texture, water-holding capacity, drainage, and
                  organic matter for your field location.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            href={activeField ? `/field/${activeField.id}/rotations` : "/fields/new"}
            className="block h-full group"
          >
            <Card className="h-full border-l-4 border-l-accent-red hover:border-accent-red/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent-red/10">
                  <RefreshCw className="h-5 w-5 text-accent-red" />
                </div>
                <CardTitle className="group-hover:text-accent-red transition-colors">
                  Crop Rotation Lab
                </CardTitle>
                <CardDescription>
                  Generate and compare Super Intelligence (SI)-assisted 3-year
                  crop rotation plans tailored to your farm&apos;s priorities.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            href={activeField ? `/field/${activeField.id}/simulator` : "/fields/new"}
            className="block h-full group"
          >
            <Card className="h-full border-l-4 border-l-amber-500 bg-gradient-to-br from-white via-white to-amber-50/40 hover:border-amber-500/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <SlidersHorizontal className="h-5 w-5 text-amber-600" />
                </div>
                <CardTitle className="group-hover:text-amber-700 transition-colors">
                  What-If Simulator
                </CardTitle>
                <CardDescription>
                  Explore how hypothetical changes in rainfall and temperature
                  affect crop suitability and rotation comparisons.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            href={activeField ? `/field/${activeField.id}/calendar` : "/fields/new"}
            className="block h-full group"
          >
            <Card className="h-full border-l-4 border-l-emerald-500 bg-gradient-to-br from-white via-white to-emerald-50/40 hover:border-emerald-500/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <CalendarDays className="h-5 w-5 text-emerald-600" />
                </div>
                <CardTitle className="group-hover:text-emerald-700 transition-colors">
                  Field Calendar
                </CardTitle>
                <CardDescription>
                  View crop sequences, planting and harvesting periods, and
                  relevant growing-season conditions across all 3 years.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            href={activeField ? `/field/${activeField.id}/analogues` : "/fields/new"}
            className="block h-full group"
          >
            <Card className="h-full border-l-4 border-l-indigo-500 bg-gradient-to-br from-white via-white to-indigo-50/40 hover:border-indigo-500/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                  <GitCompare className="h-5 w-5 text-indigo-600" />
                </div>
                <CardTitle className="group-hover:text-indigo-700 transition-colors">
                  Climate Analogues
                </CardTitle>
                <CardDescription>
                  Compare current or hypothetical conditions with historically
                  similar growing seasons in the 20-year record.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

        </div>


      </section>

    </div>
  );
}
