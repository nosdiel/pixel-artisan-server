import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/templates")({ component: () => (
  <div className="p-8 max-w-3xl">
    <h1 className="text-3xl font-bold">Templates</h1>
    <p className="text-muted-foreground mt-2">Coming next: design Square-bound templates that auto-update when prices change. The data model and Square integration are already wired in the backend.</p>
  </div>
) });