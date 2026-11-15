"use client";

import Link from "next/link";
import { useField } from "@/components/providers";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { MapPin, Trash2, ChevronRight, Plus, Loader2 } from "lucide-react";

export default function FieldsPage() {
  const { fields, activeField, setActiveField, removeField, isLoaded } = useField();

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">
            My Fields
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your saved field locations.
          </p>
        </div>
        <Link href="/fields/new">
          <Button className="bg-electric hover:bg-electric-dark">
            <Plus className="mr-2 h-4 w-4" />
            Add Field
          </Button>
        </Link>
      </div>

      {!isLoaded && <FieldsSkeleton />}

      {isLoaded && fields.length === 0 && (
        <Card className="bg-muted border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-electric/10">
              <MapPin className="h-6 w-6 text-electric" />
            </div>
            <h3 className="text-lg font-serif font-semibold text-foreground">No fields yet</h3>
            <p className="mt-1 max-w-sm text-muted-foreground">
              Add your first field to start exploring climate data and rotation strategies.
            </p>
            <Link href="/fields/new" className="mt-4">
              <Button className="bg-electric hover:bg-electric-dark">
                <Plus className="mr-2 h-4 w-4" />
                Add Your First Field
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {isLoaded && fields.length > 0 && (
        <div className="space-y-3">
          {fields.map((field) => {
            const isActive = activeField?.id === field.id;
            return (
              <Card
                key={field.id}
                className={
                  isActive
                    ? "border-electric/40 bg-electric/5"
                    : "hover:border-electric/30 transition-colors"
                }
              >
                <CardContent className="flex items-center justify-between py-4 px-5">
                  <div className="flex items-center gap-4">
                    <div
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-full ${
                        isActive ? "bg-electric text-white" : "bg-muted text-foreground"
                      }`}
                    >
                      <MapPin className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{field.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {field.lat.toFixed(4)}, {field.lon.toFixed(4)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isActive && (
                      <span className="hidden sm:inline-flex items-center rounded-full bg-electric/10 px-2.5 py-0.5 text-xs font-medium text-electric">
                        Active
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setActiveField(field)}
                      disabled={isActive}
                    >
                      {isActive ? "Active" : "Select"}
                    </Button>
                    <Link href={`/field/${field.id}/climate`}>
                      <Button variant="outline" size="sm">
                        Analyze
                        <ChevronRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeField(field.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FieldsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-electric" />
        Loading your fields…
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="animate-pulse">
          <CardContent className="flex items-center justify-between py-4 px-5">
            <div className="flex items-center gap-4">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-16 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
