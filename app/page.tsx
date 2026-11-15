"use client";

import Link from "next/link";
import { useField } from "@/components/providers";
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
        <h2 className="text-2xl font-serif font-bold text-foreground">What you can do</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="h-full border-l-4 border-l-electric">
            <CardHeader>
              <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-electric/10">
                <CloudSun className="h-5 w-5 text-electric" />
              </div>
              <CardTitle>Climate Fingerprint</CardTitle>
              <CardDescription>
                See 20 years of temperature, rainfall, and growing-season trends
                from NASA POWER.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full border-l-4 border-l-cyan">
            <CardHeader>
              <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-cyan/10">
                <Layers className="h-5 w-5 text-cyan" />
              </div>
              <CardTitle>Soil Profile</CardTitle>
              <CardDescription>
                Review soil texture, drainage, and organic matter from USDA
                SSURGO or ISRIC SoilGrids.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full border-l-4 border-l-accent-red">
            <CardHeader>
              <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent-red/10">
                <RefreshCw className="h-5 w-5 text-accent-red" />
              </div>
              <CardTitle>Rotation Lab</CardTitle>
              <CardDescription>
                Compare rotation strategies side by side and adjust priorities to
                see what fits your farm.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full">
            <CardHeader>
              <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
              </div>
              <CardTitle>What-If Simulator</CardTitle>
              <CardDescription>
                Explore how hypothetical changes in rainfall and temperature
                affect rotation comparisons.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full">
            <CardHeader>
              <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                <CalendarDays className="h-5 w-5 text-muted-foreground" />
              </div>
              <CardTitle>Field Calendar</CardTitle>
              <CardDescription>
                View crop sequences, planting and harvesting periods, and
                relevant growing-season conditions.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="h-full">
            <CardHeader>
              <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                <GitCompare className="h-5 w-5 text-muted-foreground" />
              </div>
              <CardTitle>Climate Analogues</CardTitle>
              <CardDescription>
                Compare current or hypothetical conditions with historically
                similar growing seasons.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>
    </div>
  );
}
