import { describe, expect, it } from "vitest";

import type { Measurement, Member } from "../src/eufy";
import {
  ToolInputError,
  UnknownMemberError,
  historyFor,
  historyResponse,
  isoUtc,
  latestFor,
  latestResponse,
  measurementToDict,
  resolveMember,
} from "../src/scale";

const ANN: Member = { id: "cust-ann", name: "Ann Lee", isDefault: true };
const BOB: Member = { id: "cust-bob", name: "Bob", isDefault: false };
const ANN_SMITH: Member = { id: "cust-ann-smith", name: "Ann Smith", isDefault: false };

function measurement(member: Member, time: number, weightTenths: number, id = `m-${time}`): Measurement {
  return {
    id,
    customerId: member.id,
    time,
    scaleData: {
      weight: weightTenths,
      bmi: 23.9,
      body_fat: 27.4,
      body_fat_mass: 17.9,
      subcutaneous_fat_rate: 24.1,
      visceral_fat: 6,
      muscle: 0,
      muscle_mass: 44.8,
      skeletal_muscle_mass: 25.3,
      fat_free_weight: 47.3,
      bone_mass: 2.5,
      water: 52.1,
      protein_ratio: 17.2,
      bmr: 1380,
      body_age: 34,
      heart_rate: 0,
    },
  };
}

describe("resolveMember", () => {
  it("returns the only member when nothing is given", () => {
    expect(resolveMember([BOB], undefined)).toBe(BOB);
    expect(resolveMember([BOB], "  ")).toBe(BOB);
  });

  it("falls back to the default member", () => {
    expect(resolveMember([ANN, BOB], null)).toBe(ANN);
  });

  it("refuses to guess between several non-default members", () => {
    expect(() => resolveMember([BOB, ANN_SMITH], "")).toThrow(/several members/);
  });

  it("matches id, full name, and first name, ignoring case and whitespace", () => {
    expect(resolveMember([ANN, BOB], "CUST-BOB")).toBe(BOB);
    expect(resolveMember([ANN, BOB], " ann   lee ")).toBe(ANN);
    expect(resolveMember([ANN, BOB], "bob")).toBe(BOB);
    expect(resolveMember([ANN_SMITH, BOB], "ann")).toBe(ANN_SMITH);
  });

  it("reports ambiguity and unknown members distinctly", () => {
    expect(() => resolveMember([ANN, ANN_SMITH], "Ann")).toThrow(/ambiguous/);
    try {
      resolveMember([ANN], "Zed");
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownMemberError);
      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as Error).message).toBe("No member matches 'Zed'. Members on this account: Ann Lee (cust-ann)");
    }
  });
});

describe("formatting", () => {
  it("formats timestamps like Python's isoformat", () => {
    expect(isoUtc(1790326800)).toBe("2026-09-25T09:00:00+00:00");
  });

  it("converts weight and drops unmeasured metrics", () => {
    const dict = measurementToDict(measurement(ANN, 1790326800, 652));
    expect(dict).toEqual({
      measurement_id: "m-1790326800",
      timestamp_utc: "2026-09-25T09:00:00+00:00",
      weight_kg: 65.2,
      weight_lb: 143.7,
      bmi: 23.9,
      body_fat_pct: 27.4,
      body_fat_mass_kg: 17.9,
      subcutaneous_fat_pct: 24.1,
      visceral_fat_level: 6,
      muscle_mass_kg: 44.8,
      skeletal_muscle_mass_kg: 25.3,
      fat_free_mass_kg: 47.3,
      bone_mass_kg: 2.5,
      water_pct: 52.1,
      protein_pct: 17.2,
      bmr_kcal: 1380,
      body_age_years: 34,
    });
    expect(dict).not.toHaveProperty("muscle_pct");
    expect(dict).not.toHaveProperty("heart_rate_bpm");
  });

  it("builds the latest response with age_hours", () => {
    const m = measurement(ANN, 1790326800, 652);
    const response = latestResponse(ANN, m, (1790326800 + 3 * 3600 + 59 * 60) * 1000);
    expect(response.member).toEqual({ member_id: "cust-ann", name: "Ann Lee", is_default: true });
    expect(response.measurement.age_hours).toBe(3);
  });

  it("orders history oldest first and counts it", () => {
    const newer = measurement(ANN, 2000, 650, "new");
    const older = measurement(ANN, 1000, 660, "old");
    const response = historyResponse(ANN, [newer, older], 30);
    expect(response.count).toBe(2);
    expect(response.days).toBe(30);
    expect(response.measurements.map((m) => m.measurement_id)).toEqual(["old", "new"]);
  });
});

describe("selection", () => {
  const records = [
    measurement(ANN, 3000, 650, "a3"),
    measurement(ANN, 2000, 658, "a2"),
    measurement(ANN, 100, 680, "a1"),
    measurement(BOB, 2500, 815, "b1"),
  ];

  it("picks the newest measurement of the member", () => {
    expect(latestFor(ANN, records)?.id).toBe("a3");
    expect(latestFor(BOB, records)?.id).toBe("b1");
    expect(latestFor(ANN_SMITH, records)).toBeNull();
  });

  it("filters history by member and cutoff", () => {
    expect(historyFor(ANN, records, 1500).map((m) => m.id)).toEqual(["a3", "a2"]);
    expect(historyFor(ANN, records, 3000)).toEqual([]);
  });
});
