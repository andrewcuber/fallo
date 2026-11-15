"use client";

import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { useField } from "@/components/providers";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapPin, Loader2 } from "lucide-react";

export default function FieldLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { fields, activeField, setActiveField, isLoaded } = useField();

  const field = fields.find((f) => f.id === id) ?? null;

  // Automatically activate the URL field when loaded
  useEffect(() => {
    if (field && activeField?.id !== field.id) {
      setActiveField(field);
    }
  }, [field, activeField, setActiveField]);

  const tabs = [
    { label: "Climate", href: `/field/${id}/climate` },
    { label: "Soil", href: `/field/${id}/soil` },
    { label: "Rotation Lab", href: `/field/${id}/rotations` },
  ];

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-electric" />
      </div>
    );
  }

  if (!field) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <MapPin className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-serif font-bold text-foreground">
            Field not found
          </h2>
          <p className="mt-2 max-w-sm text-muted-foreground">
            This field may have been removed or the link is incorrect.
          </p>
          <div className="mt-6 flex gap-3">
            <Link href="/fields">
              <Button variant="outline">View My Fields</Button>
            </Link>
            <Link href="/fields/new">
              <Button className="bg-electric hover:bg-electric-dark">Add Field</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">
            {field.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {field.lat.toFixed(5)}, {field.lon.toFixed(5)}
          </p>
        </div>
        <Link
          href="/fields"
          className="text-sm text-muted-foreground hover:text-electric transition-colors"
        >
          ← Back to My Fields
        </Link>
      </div>

      <nav className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              pathname === tab.href
                ? "border-electric text-electric"
                : "border-transparent text-muted-foreground hover:text-electric"
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div>{children}</div>
    </div>
  );
}
