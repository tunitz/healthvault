import { describe, expect, test } from "bun:test";
import { parseGpxRoute } from "@/lib/gpx";
import { parseEcgCsv } from "@/lib/ecg";
import { addStrengthSets, deleteStrengthSet, updateStrengthSet } from "@/lib/services/strength";
import { addFood, copyDay, dayNutrition, logMeal } from "@/lib/services/nutrition";
import { cloneRecipe, createRecipe, deleteRecipe, getRecipe, unarchiveRecipe } from "@/lib/services/recipes";
import { logRecipe } from "@/lib/services/nutrition";

describe("Phase 5: GPX, ECG, strength edit/delete, recipe clone/unarchive, single-meal copy", () => {
  test("parseGpxRoute extracts distance, elevation, splits, and bounded polyline", () => {
    // 12 points heading north (~0.01 deg lat ≈ 1.11 km) over 6 minutes
    const pts = Array.from({ length: 12 }, (_, i) => {
      const lat = (37.77 + i * 0.001).toFixed(6);
      const ele = (10 + i * 3).toFixed(1);
      const sec = i * 30;
      const min = String(Math.floor(sec / 60)).padStart(2, "0");
      const rem = String(sec % 60).padStart(2, "0");
      return `<trkpt lon="-122.420000" lat="${lat}"><ele>${ele}</ele><time>2026-09-19T09:${min}:${rem}Z</time></trkpt>`;
    }).join("\n");
    const xml = `<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
    const parsed = parseGpxRoute(xml, "apple_health_export/workout-routes/route_2026-09-19_09.00am.gpx");
    expect(parsed).not.toBeNull();
    expect(parsed!.filename).toBe("route_2026-09-19_09.00am.gpx");
    expect(parsed!.day).toBe("2026-09-19");
    expect(parsed!.pointCount).toBe(12);
    expect(parsed!.distanceKm).toBeGreaterThan(1.1);
    expect(parsed!.distanceKm).toBeLessThan(1.3);
    expect(parsed!.elevationGainM).toBeGreaterThan(25);
    expect(parsed!.splits.length).toBe(1);
    expect(parsed!.splits[0].km).toBe(1);
  });

  test("parseEcgCsv parses metadata headers and downsamples waveform", () => {
    const samples: string[] = [];
    // Synthetic 512 Hz, 5 seconds, 60 bpm (spike every 512 samples)
    for (let i = 0; i < 512 * 5; i += 1) {
      samples.push(i % 512 === 256 ? "600.0" : "0.0");
    }
    const csv = [
      "Name,Test User",
      "Recorded Date,2026-05-26 09:00:00 +0000",
      "Classification,Sinus Rhythm",
      "Symptoms,",
      'Device,"Watch6,1"',
      "Sample Rate,512 hertz",
      "Lead,Lead I",
      "Unit,µV",
      "",
      ...samples,
    ].join("\n");
    const parsed = parseEcgCsv(csv, "apple_health_export/electrocardiograms/ecg_2026-05-26.csv");
    expect(parsed).not.toBeNull();
    expect(parsed!.day).toBe("2026-05-26");
    expect(parsed!.classification).toBe("Sinus Rhythm");
    expect(parsed!.device).toBe("Watch6,1");
    expect(parsed!.samplingHz).toBe(512);
    expect(parsed!.sampleCount).toBe(2560);
    expect(parsed!.samples.length).toBeLessThanOrEqual(600);
    expect(parsed!.avgHr).toBe(60);
  });

  test("updateStrengthSet and deleteStrengthSet mutate a single set cleanly", () => {
    const [created] = addStrengthSets({
      day: "2026-11-11",
      exercise: "Phase5 Squat",
      sets: [{ reps: 5, loadKg: 100 }],
    });
    const updated = updateStrengthSet(created.id, { reps: 6, loadKg: 105, note: "PR" });
    expect(updated.reps).toBe(6);
    expect(updated.loadKg).toBe(105);
    expect(updated.note).toBe("PR");
    expect(deleteStrengthSet(created.id)).toEqual({ deleted: true });
    expect(deleteStrengthSet(created.id)).toEqual({ deleted: false });
  });

  test("cloneRecipe scales ingredients and unarchiveRecipe restores an archived recipe", () => {
    const food = addFood({
      name: "Phase5 Chicken",
      per100g: { kcal: 120, proteinG: 23, carbsG: 0, fatG: 2.5 },
    });
    const recipe = createRecipe({
      name: "Phase5 Bowl",
      servings: 2,
      ingredients: [{ foodId: food.id, grams: 200 }],
    });
    const doubled = cloneRecipe(recipe.id, 2);
    expect(doubled.name).toContain("2×");
    expect(doubled.servingsTotal).toBe(4);
    expect(doubled.ingredients[0].grams).toBe(400);

    // Log a serving so deleteRecipe archives it, then unarchive it
    logRecipe({ recipeId: recipe.id, day: "2026-11-12", meal: "lunch" });
    const archived = deleteRecipe(recipe.id);
    expect(archived.archived).toBe(true);
    expect(getRecipe(recipe.id).archived).toBe(true);

    const restored = unarchiveRecipe(recipe.id);
    expect(restored.archived).toBe(false);
  });

  test("copyDay supports copying a single meal without copying other meals", () => {
    const food = addFood({
      name: "Phase5 Toast",
      per100g: { kcal: 250, proteinG: 8, carbsG: 48, fatG: 3 },
    });
    logMeal({ day: "2026-11-13", meal: "breakfast", entries: [{ foodId: food.id, grams: 60 }] });
    logMeal({ day: "2026-11-13", meal: "dinner", entries: [{ foodId: food.id, grams: 100 }] });

    const copied = copyDay("2026-11-13", "2026-11-14", { meal: "breakfast" });
    expect(copied.copied).toBe(1);
    const nextDay = dayNutrition("2026-11-14");
    expect(nextDay.meals.breakfast).toHaveLength(1);
    expect(nextDay.meals.dinner).toHaveLength(0);
  });
});
