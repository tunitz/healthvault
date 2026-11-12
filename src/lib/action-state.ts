import type { HistoryPreview } from "@/lib/services/food-history";

/** Result a form action reports back to the client, so validation never crashes the page. */
export type ActionState = {
  ok: boolean;
  error?: string;
  message?: string;
};

export const IDLE_ACTION: ActionState = { ok: true };

/**
 * Food form result. `foodId` and `mode` let the client show the "review past meals" toast only
 * after an edit, without guessing which branch the server action took.
 */
export type FoodFormState = ActionState & {
  foodId?: number;
  mode?: "create" | "update";
};

/** Recipe editor result; `recipeId`/`mode` let the client navigate after a create or edit. */
export type RecipeFormState = ActionState & {
  recipeId?: number;
  mode?: "create" | "update";
};

/** Delete result, reported honestly: a referenced recipe is archived, not destroyed. */
export type RecipeDeleteState = ActionState & {
  deleted?: boolean;
  archived?: boolean;
};

/**
 * Past-meal correction preview. Read-only: the service writes nothing, so this can be re-run
 * freely. `stale` marks the one failure the screen must answer by re-previewing rather than by
 * retrying the apply.
 */
export type CorrectionPreviewState =
  | { ok: true; preview: HistoryPreview }
  | { ok: false; error: string; stale?: boolean };

/** Applying a previewed correction: the service reports exactly what it changed. */
export type CorrectionApplyState = ActionState & {
  stale?: boolean;
  applied?: number;
  entriesTouched?: number;
  revisions?: number;
  skipped?: number;
};
